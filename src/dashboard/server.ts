/**
 * dashboard/server.ts — 로컬 실시간 HTML 대시보드(컴패니언 HTTP+SSE). 리서치 권장 (a)안.
 * 보안: 127.0.0.1 바인딩 / 런치별 랜덤 토큰(/api·/events 필수) / Host 검증(DNS-rebinding 차단) /
 *       시크릿 절대 미전송(포지션·플랜만) / 읽기전용(주문 엔드포인트 없음).
 * 페이지가 Binance 공개 WS로 시세를 직접 받아 미실현손익을 클라이언트 계산(대문자 WS키 사용).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import * as store from "../store/db.js";
import { BROKER_FIELDS, upsertCredentials, credentialStatus, credentialsPath, enableLive, disableLive, liveSettingsStatus, type BrokerKey } from "../setup/credentials.js";
import { fetchKlines } from "../data/binance-public.js";
import { getAdapter } from "../brokers/index.js";
import { sma, ema, rsi, macd, bollingerBands, stochastic, adx, atr, williamsR, stochasticRsi, cci, supertrend, vwap, mfi, parabolicSar, ichimoku, roc, obv, donchian } from "../core/strategy/indicators.js";

/** POST 본문을 안전하게 읽어 JSON 파싱(상한 64KB, 자격증명 폼은 작음). */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { n += c.length; if (n > 65536) { reject(new Error("body too large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

let _state: { url: string; port: number; token: string } | null = null;

const OPS: Record<string, string> = { lt: "<", gt: ">", lte: "≤", gte: "≥", cross_above: "↗상향돌파", cross_below: "↘하향돌파", eq: "=", in: "∈", between: "사이" };
/** 복합 전략 트리 → 사람이 읽는 한 줄 요약("어떤 무기로 짰는지"). */
function summarizeStrategy(node: unknown, depth = 0): string {
  const n = node as Record<string, unknown>;
  if (!n || depth > 4) return "?";
  if (n.type === "leaf" || n.strategy) {
    const s = (n.strategy ?? n) as { rules?: { action: string; conditions: { indicator: string; operator: string; value: unknown; params?: { period?: number } }[] }[] };
    const rules = (s.rules ?? []).map((r) => {
      const c = r.conditions?.[0];
      const ind = c ? `${String(c.indicator).toUpperCase()}${c.params?.period ? `(${c.params.period})` : ""} ${OPS[c.operator] ?? c.operator} ${typeof c.value === "string" ? String(c.value).toUpperCase() : c.value}` : "?";
      return `${ind}→${r.action === "buy" ? "매수" : "매도"}`;
    });
    return rules.join(" · ") || "규칙없음";
  }
  if (n.type === "composite") {
    const mode = n.mode === "weighted" ? "가중" : "우선순위";
    const kids = (n.children as unknown[] ?? []).map((c) => summarizeStrategy(c, depth + 1));
    return `복합[${mode}]: ${kids.join(" | ")}`;
  }
  if (n.type === "condition") {
    const cond = n.condition as Record<string, unknown>;
    const what = describeCondition(cond);
    return `IF ${what} THEN(${summarizeStrategy(n.thenNode, depth + 1)})${n.elseNode ? ` ELSE(${summarizeStrategy(n.elseNode, depth + 1)})` : ""}`;
  }
  if (n.type === "scanner") {
    const rk = (n.rank ?? {}) as { metric?: string; top?: number };
    const uni = Array.isArray(n.universe) ? (n.universe as string[]).length : 0;
    const sch = n.schedule ? ` @${((n.schedule as { hour?: number[] }).hour ?? []).join(",")}시` : "";
    return `스캐너[${rk.metric ?? "?"} 상위${rk.top ?? "?"}/${uni}종목${sch}] → ${summarizeStrategy(n.then, depth + 1)}`;
  }
  return "?";
}

/** 노드 조건 → 사람이 읽는 한 줄(신규 조건 타입 포함). */
function describeCondition(c: Record<string, unknown>): string {
  const op = (o: unknown) => OPS[String(o)] ?? String(o ?? "");
  switch (c?.type) {
    case "indicator": {
      const tf = c.timeframe ? `@${c.timeframe}` : "";
      const p = (c.params as { period?: number })?.period;
      return `${String(c.indicator).toUpperCase()}${p ? `(${p})` : ""}${tf} ${op(c.operator)} ${c.value}`;
    }
    case "time": return `시간 ${c.field} ${op(c.operator)} ${JSON.stringify(c.values)}${c.tz ? `(${c.tz})` : ""}`;
    case "regime": return `레짐 ∈ ${JSON.stringify(c.in)}`;
    case "anchor": return `가격 ${op(c.operator)} ${c.anchor}×${(c.multiplier as number) ?? 1}`;
    case "spread": return `${c.symbolB} 스프레드(${c.expr}) ${op(c.operator)} ${c.value}`;
    case "event": {
      const src = c.calendar ? String(c.calendar) : Array.isArray(c.times) ? `이벤트(${(c.times as unknown[]).length}건)` : "이벤트";
      return `${src} ±[${(c.hoursBefore as number) ?? 0}h,${(c.hoursAfter as number) ?? 0}h]`;
    }
    case "performance": return `성과 ${c.metric}(${c.lookbackDays}일) ${op(c.operator)} ${c.value}`;
    default: return `${c?.field || c?.metric || "조건"} ${op(c?.operator)} ${JSON.stringify(c?.values ?? c?.value ?? "")}`;
  }
}

interface PosView { symbol: string; side: "long" | "short"; entryAvg: number; qty: number }

/** position_state → 포지션 배열. 스캐너는 {심볼:포지션} 맵, 일반봇은 단일 포지션. (스캐너 버그 수정) */
function extractPositions(ps: unknown, botSymbol: string, market: string, isScanner: boolean): PosView[] {
  if (!ps || typeof ps !== "object") return [];
  const open = (p: unknown): p is { entryAvg: number; qty: number } => {
    const x = p as { status?: string; entryAvg?: number; qty?: number };
    return !!x && x.status === "open" && !!x.entryAvg && !!x.qty;
  };
  if (isScanner) {
    return Object.entries(ps as Record<string, unknown>).filter(([, p]) => open(p)).map(([sym, p]) => {
      const x = p as { entryAvg: number; qty: number };
      return { symbol: sym.toUpperCase(), side: "long" as const, entryAvg: x.entryAvg, qty: x.qty };
    });
  }
  return open(ps) ? [{ symbol: botSymbol.toUpperCase(), side: market === "futures" ? "short" : "long", entryAvg: (ps as { entryAvg: number }).entryAvg, qty: (ps as { qty: number }).qty }] : [];
}

// ── 일반인용 쉬운 말 번역 ──
const REGIME_KO: Record<string, string> = { trend_up: "상승 추세", trend_down: "하락 추세", range: "횡보장", high_vol: "변동성 큰 장" };
/** 노드 조건 → 일반인이 읽는 쉬운 한 구절. */
function plainCondition(c: Record<string, unknown>): string {
  const o = String(c?.operator ?? "");
  switch (c?.type) {
    case "indicator": {
      const ind = String(c.indicator).toLowerCase();
      const tf = c.timeframe ? `${c.timeframe} 흐름에서 ` : "";
      if (ind === "rsi" || ind === "stochastic" || ind === "stochastic_rsi" || ind === "mfi" || ind === "williams_r" || ind === "cci")
        return `${tf}${o.includes("lt") ? "가격이 많이 빠졌을 때(과매도)" : o.includes("gt") ? "가격이 많이 올랐을 때(과매수)" : "지표 조건일 때"}`;
      if (ind === "sma" || ind === "ema" || ind === "macd" || ind === "supertrend" || ind === "ichimoku")
        return `${tf}${o.includes("cross") ? "추세가 바뀔 때" : "추세 방향이 맞을 때"}`;
      if (ind === "volume") return `${tf}거래량이 터질 때`;
      return `${tf}${ind.toUpperCase()} 조건일 때`;
    }
    case "regime": return `시장이 ${(c.in as string[] ?? []).map((x) => REGIME_KO[x] ?? x).join("·")}일 때만`;
    case "event": return `${c.calendar ? String(c.calendar) : "주요"} 발표 시간대`;
    case "time": return "정해진 시간대에만";
    case "anchor": return "시초가 대비 급등락할 때";
    case "spread": return `${c.symbolB} 대비 가격차 기준`;
    case "performance": return "최근 성과 기준";
    default: return "특정 조건";
  }
}
/** 전략 트리 → 일반인이 읽는 한 문장("이 봇이 뭘 하는지"). */
function plainStrategy(node: unknown, depth = 0): string {
  const n = node as Record<string, unknown>;
  if (!n || depth > 4) return "";
  if (n.type === "scanner") {
    const rk = (n.rank ?? {}) as { metric?: string; top?: number };
    const m: Record<string, string> = { roc: "가장 많이 오른", gapPct: "갭이 큰", relVolume: "거래량 급증한", rangePct: "변동성 큰" };
    return `여러 종목 중 ${m[rk.metric ?? ""] ?? "조건에 맞는"} 상위 ${rk.top ?? "몇"}개를 자동으로 골라, ${plainStrategy(n.then, depth + 1)}`;
  }
  if (n.type === "condition") {
    const cond = plainCondition(n.condition as Record<string, unknown>);
    const then = plainStrategy(n.thenNode, depth + 1);
    const els = n.elseNode ? plainStrategy(n.elseNode, depth + 1) : "";
    // elseNode가 "거래 안 함"이면 회피 전략으로 읽기
    if (els && /매매하지|거래 안|쉬|관망/.test(then) && depth === 0) return `${cond}엔 쉬고, 평소엔 ${els}`;
    return els ? `${cond}이면 ${then}, 아니면 ${els}` : `${cond}, ${then}`;
  }
  if (n.type === "composite") {
    const kids = (n.children as unknown[] ?? []).map((c) => plainStrategy(c, depth + 1)).filter(Boolean);
    return `여러 전략을 ${n.mode === "weighted" ? "비중대로 섞어" : "우선순위로"} 운용`;
  }
  // leaf
  const s = (n.strategy ?? n) as { rules?: { action: string; conditions: { indicator?: string; operator?: string; value?: unknown }[] }[] };
  const rules = s.rules ?? [];
  const buy = rules.find((r) => r.action === "buy");
  const sell = rules.find((r) => r.action === "sell");
  // 매수 조건이 사실상 항상거짓(value 음수 큰값)이면 "거래 안 함"으로
  const neverBuy = buy && buy.conditions?.[0] && typeof buy.conditions[0].value === "number" && (buy.conditions[0].value as number) <= -100;
  if (neverBuy) return "매매하지 않고 쉼";
  const buyTxt = buy ? plainCondition({ type: "indicator", ...buy.conditions?.[0] }) : "";
  if (buy && sell) return `${buyTxt} 사고, 반대 신호엔 파는 전략`;
  if (buy) return `${buyTxt} 매수하는 전략`;
  return "전략 운용";
}

// ── 상세 부연설명: 트리에서 사용 지표 수집 + 한글 라벨 + 운용/리스크 요약 ──
const IND_KO: Record<string, string> = {
  rsi: "RSI", sma: "이동평균(SMA)", ema: "지수이동평균(EMA)", macd: "MACD",
  bollinger: "볼린저밴드", bollinger_bands: "볼린저밴드", stochastic: "스토캐스틱",
  stochastic_rsi: "스토캐스틱 RSI", mfi: "MFI", williams_r: "윌리엄스 %R", cci: "CCI",
  atr: "ATR", adx: "ADX", supertrend: "슈퍼트렌드", ichimoku: "일목균형표",
  volume: "거래량", obv: "OBV", vwap: "VWAP", roc: "ROC", momentum: "모멘텀",
};
function indLabel(ind: string, period?: number, tf?: string): string {
  return `${tf ? tf + " " : ""}${IND_KO[ind.toLowerCase()] ?? ind.toUpperCase()}${period ? `(${period})` : ""}`;
}
/** 전략 트리 순회 → 사용 지표 라벨 수집(중복 제거). condition.indicator + leaf rules 모두. */
function collectIndicators(node: unknown, acc: string[] = []): string[] {
  const n = node as Record<string, unknown>;
  if (!n || typeof n !== "object") return acc;
  const c = n.condition as { type?: string; indicator?: string; params?: { period?: number }; timeframe?: string } | undefined;
  if (c?.type === "indicator" && c.indicator) {
    const l = indLabel(c.indicator, c.params?.period, c.timeframe);
    if (!acc.includes(l)) acc.push(l);
  }
  const s = (n.strategy ?? (n.type === "leaf" ? n : null)) as { rules?: { conditions?: { indicator?: string; params?: { period?: number }; timeframe?: string }[] }[] } | null;
  for (const r of s?.rules ?? []) for (const cond of r.conditions ?? []) {
    if (cond.indicator) { const l = indLabel(cond.indicator, cond.params?.period, cond.timeframe); if (!acc.includes(l)) acc.push(l); }
  }
  for (const k of ["thenNode", "elseNode", "then", "else"]) if (n[k]) collectIndicators(n[k], acc);
  for (const ch of (Array.isArray(n.children) ? n.children : [])) collectIndicators(ch, acc);
  return acc;
}
const intervalKo = (sec?: number): string =>
  !sec ? "—" : sec >= 86400 ? `${Math.round(sec / 86400)}일봉` : sec >= 3600 ? `${Math.round(sec / 3600)}시간봉` : sec >= 60 ? `${Math.round(sec / 60)}분봉` : `${sec}초`;
const BROKER_DATA: Record<string, string> = {
  binance: "Binance 실시간 시세(WS)", kiwoom: "키움증권 일봉(ka10081) · 시세 지연 가능", kis: "한국투자증권 시세",
};
/** composite + bot → 상세 부연설명 객체(클라이언트가 패널에 렌더). */
function buildDetail(
  comp: { market?: string; leverage?: number; stop_loss_percent?: number | null; take_profit_percent?: number | null; trailing_stop_percent?: number | null; tp_ladder?: unknown; scale_in?: unknown; pyramid?: unknown; root_node?: unknown } | null | undefined,
  b: { interval_seconds?: number; capital?: number; broker?: string },
) {
  const risk: string[] = [];
  if (comp?.stop_loss_percent) risk.push(`손절 −${comp.stop_loss_percent}%`);
  if (comp?.take_profit_percent) risk.push(`익절 +${comp.take_profit_percent}%`);
  if (comp?.trailing_stop_percent) risk.push(`트레일링 스탑 ${comp.trailing_stop_percent}%`);
  if (comp?.tp_ladder) risk.push("분할익절(라더)");
  if (comp?.scale_in) risk.push("물타기(스케일인)");
  if (comp?.pyramid) risk.push("불타기(피라미딩)");
  return {
    indicators: collectIndicators(comp?.root_node ?? {}),
    market: comp?.market === "futures" ? `선물 ${comp?.leverage ?? 1}배 (하락에도 베팅=숏)` : "현물 (상승 베팅=롱)",
    risk: risk.length ? risk.join(" · ") : "별도 손절/익절 없음 — 전략 반대신호로만 청산",
    interval: intervalKo(b.interval_seconds),
    capital: b.capital ?? 0,
    data: BROKER_DATA[b.broker ?? ""] ?? b.broker ?? "—",
  };
}

type ChartPt = { time: number; value: number };
/** 전략 트리 → 사용 지표 {ind,period} 수집(중복 제거). 차트 오버레이 계산용. */
function collectIndicatorSpecs(node: unknown, acc: { ind: string; period: number }[] = []): { ind: string; period: number }[] {
  const n = node as Record<string, unknown>;
  if (!n || typeof n !== "object") return acc;
  const push = (ind?: string, period?: number) => {
    if (!ind) return; const k = ind.toLowerCase(); const p = period ?? 14;
    if (!acc.some((s) => s.ind === k && s.period === p)) acc.push({ ind: k, period: p });
  };
  const c = n.condition as { type?: string; indicator?: string; params?: { period?: number } } | undefined;
  if (c?.type === "indicator") push(c.indicator, c.params?.period);
  const s = (n.strategy ?? (n.type === "leaf" ? n : null)) as { rules?: { conditions?: { indicator?: string; params?: { period?: number } }[] }[] } | null;
  for (const r of s?.rules ?? []) for (const cond of r.conditions ?? []) push(cond.indicator, cond.params?.period);
  for (const k of ["thenNode", "elseNode", "then", "else"]) if (n[k]) collectIndicatorSpecs(n[k], acc);
  for (const ch of (Array.isArray(n.children) ? n.children : [])) collectIndicatorSpecs(ch, acc);
  return acc;
}
const seriesAt = (bars: { time: number }[], vals: number[]): ChartPt[] =>
  vals.map((v, i) => ({ time: bars[i].time, value: v })).filter((p) => Number.isFinite(p.value));
// 차트 토글로 켤 수 있는 지표 화이트리스트(임의 입력 차단). 키는 "ind" 또는 "ind:period".
const TOGGLE_INDS = new Set(["sma", "ema", "bollinger", "vwap", "supertrend", "parabolic_sar", "donchian", "ichimoku", "rsi", "macd", "stochastic", "stochastic_rsi", "adx", "atr", "cci", "mfi", "williams_r", "obv", "roc"]);
/** 클라이언트가 보낸 토글 지표 목록(["bollinger","sma:50",...])을 spec으로 파싱. 화이트리스트 외엔 무시. 최대 12개. */
function parseToggleInds(inds?: string[]): { ind: string; period: number }[] {
  if (!Array.isArray(inds)) return [];
  const out: { ind: string; period: number }[] = [];
  for (const raw of inds) {
    const [name, per] = String(raw).toLowerCase().split(":");
    if (!TOGGLE_INDS.has(name)) continue; // 화이트리스트(volume 등 클라전용 키 제외)를 먼저 → 슬롯 낭비 방지
    out.push({ ind: name, period: Number(per) || 0 });
    if (out.length >= 12) break; // 화이트 통과분 기준 최대 12개
  }
  return out;
}
// 지표별 기본 기간(buildIndicators의 `p||N` 폴백과 동일). 전략·토글 spec의 '실제 사용 기간' 정규화에 사용.
const IND_DEFAULT: Record<string, number> = { sma: 14, ema: 14, bollinger: 20, vwap: 20, supertrend: 10, donchian: 20, rsi: 14, stochastic: 14, adx: 14, atr: 14, cci: 20, mfi: 14, williams_r: 14, obv: 20, roc: 12 };
const normPeriod = (ind: string, p: number) => (p > 0 ? p : (IND_DEFAULT[ind] ?? 14));

/** 봉 + 지표 specs → 가격패널 오버레이 + 보조지표. 전략과 동일 core 함수로 계산(차트≡전략).
 *  거래량 지표(VWAP/MFI/OBV)는 bars.volume 필요. 차트 토글로 켠 지표도 같은 경로로 그림. */
function buildIndicators(bars: { time: number; open: number; high: number; low: number; close: number; volume?: number }[], specs: { ind: string; period: number }[]) {
  const closes = bars.map((b) => b.close), highs = bars.map((b) => b.high), lows = bars.map((b) => b.low), vols = bars.map((b) => b.volume ?? 0);
  const overlays: { label: string; color: string; data: ChartPt[] }[] = [];
  // 오실레이터는 "그룹"(=지표 하나)당 별도 패널. 같은 그룹의 여러 선(MACD+Signal)은 한 패널에 함께.
  type OscSeries = { label: string; color: string; data: ChartPt[] };
  const oscGroups: { title: string; guides?: number[]; series: OscSeries[] }[] = [];
  const C = ["#eab308", "#38bdf8", "#a855f7", "#f97316", "#22d3ee"]; let ci = 0;
  const seen = new Set<string>();
  for (const sp of specs) {
    const key = `${sp.ind}:${sp.period}`; if (seen.has(key)) continue; seen.add(key); // 전략+토글 중복 제거
    const color = C[ci++ % C.length], p = sp.period;
    switch (sp.ind) {
      // ── 가격패널 오버레이(pane 0) ──
      case "sma": overlays.push({ label: `SMA(${p})`, color, data: seriesAt(bars, sma(closes, p)) }); break;
      case "ema": overlays.push({ label: `EMA(${p})`, color, data: seriesAt(bars, ema(closes, p)) }); break;
      case "bollinger": case "bollinger_bands": { const bb = bollingerBands(closes, p || 20); overlays.push({ label: `BB(${p || 20})상`, color: "#64748b", data: seriesAt(bars, bb.upper) }, { label: "BB중", color, data: seriesAt(bars, bb.middle) }, { label: "BB하", color: "#64748b", data: seriesAt(bars, bb.lower) }); break; }
      case "vwap": overlays.push({ label: `VWAP(${p || 20})`, color: "#f59e0b", data: seriesAt(bars, vwap(closes, highs, lows, vols, p || 20)) }); break;
      case "supertrend": overlays.push({ label: "슈퍼트렌드", color: "#34d399", data: seriesAt(bars, supertrend(closes, highs, lows, p || 10, 3)) }); break;
      case "parabolic_sar": case "parabolicsar": overlays.push({ label: "Parabolic SAR", color: "#c084fc", data: seriesAt(bars, parabolicSar(highs, lows)) }); break;
      case "donchian": { const dc = donchian(highs, lows, p || 20); overlays.push({ label: `돈치안(${p || 20})상`, color: "#64748b", data: seriesAt(bars, dc.upper) }, { label: "돈치안하", color: "#64748b", data: seriesAt(bars, dc.lower) }); break; }
      case "ichimoku": { const ic = ichimoku(highs, lows); overlays.push({ label: "전환선", color: "#38bdf8", data: seriesAt(bars, ic.tenkan) }, { label: "기준선", color: "#f43f5e", data: seriesAt(bars, ic.kijun) }, { label: "선행A", color: "#22c55e", data: seriesAt(bars, ic.senkouA) }, { label: "선행B", color: "#eab308", data: seriesAt(bars, ic.senkouB) }); break; }
      // ── 하단 보조지표(지표당 독립 패널) ──
      case "rsi": oscGroups.push({ title: `RSI(${p || 14})`, guides: [30, 70], series: [{ label: `RSI(${p || 14})`, color, data: seriesAt(bars, rsi(closes, p || 14)) }] }); break;
      case "macd": { const m = macd(closes); oscGroups.push({ title: "MACD", series: [{ label: "MACD", color, data: seriesAt(bars, m.macd) }, { label: "Signal", color: "#f97316", data: seriesAt(bars, m.signal) }] }); break; }
      case "stochastic": { const st = stochastic(closes, highs, lows, p || 14); oscGroups.push({ title: "Stoch", guides: [20, 80], series: [{ label: "Stoch %K", color, data: seriesAt(bars, st.k) }] }); break; }
      case "stochastic_rsi": { const sr = stochasticRsi(closes); oscGroups.push({ title: "StochRSI", guides: [20, 80], series: [{ label: "StochRSI %K", color, data: seriesAt(bars, sr.k) }] }); break; }
      case "adx": oscGroups.push({ title: `ADX(${p || 14})`, guides: [25], series: [{ label: `ADX(${p || 14})`, color, data: seriesAt(bars, adx(closes, highs, lows, p || 14)) }] }); break;
      case "atr": oscGroups.push({ title: `ATR(${p || 14})`, series: [{ label: `ATR(${p || 14})`, color, data: seriesAt(bars, atr(closes, highs, lows, p || 14)) }] }); break;
      case "cci": oscGroups.push({ title: `CCI(${p || 20})`, guides: [-100, 100], series: [{ label: `CCI(${p || 20})`, color, data: seriesAt(bars, cci(closes, highs, lows, p || 20)) }] }); break;
      case "mfi": oscGroups.push({ title: `MFI(${p || 14})`, guides: [20, 80], series: [{ label: `MFI(${p || 14})`, color, data: seriesAt(bars, mfi(closes, highs, lows, vols, p || 14)) }] }); break;
      case "williams_r": case "williamsr": oscGroups.push({ title: `윌리엄스%R(${p || 14})`, guides: [-80, -20], series: [{ label: `윌리엄스%R(${p || 14})`, color, data: seriesAt(bars, williamsR(closes, highs, lows, p || 14)) }] }); break;
      case "obv": oscGroups.push({ title: "OBV", series: [{ label: "OBV", color, data: seriesAt(bars, obv(closes, vols, p || 20)) }] }); break;
      case "roc": oscGroups.push({ title: `ROC(${p || 12})`, guides: [0], series: [{ label: `ROC(${p || 12})`, color, data: seriesAt(bars, roc(closes, p || 12)) }] }); break;
      default: break; // 미지원 지표는 스킵(설명 패널엔 표기됨)
    }
  }
  return { overlays, oscGroups };
}
/** 봇 포지션 + composite 리스크 → 차트 수평선(진입가/손절/익절). */
function buildPriceLines(bot: { symbol: string; position_state?: unknown }, comp: { market?: string; stop_loss_percent?: number | null; take_profit_percent?: number | null } | null | undefined, ccy: string) {
  const lines: { price: number; title: string; color: string }[] = [];
  const ps = bot.position_state as Record<string, unknown> | null;
  let entry = 0;
  if (ps && typeof ps === "object") {
    if ((ps as { status?: string }).status === "open") entry = Number((ps as { entryAvg?: number }).entryAvg) || 0;
    else { const sub = (ps as Record<string, { status?: string; entryAvg?: number }>)[bot.symbol]; if (sub?.status === "open") entry = Number(sub.entryAvg) || 0; }
  }
  if (entry > 0) {
    const f = (x: number) => (ccy === "KRW" ? "₩" : "$") + Math.round(x).toLocaleString();
    const short = comp?.market === "futures";
    lines.push({ price: entry, title: `진입 ${f(entry)}`, color: "#eab308" });
    if (comp?.stop_loss_percent) { const sl = entry * (1 + (short ? 1 : -1) * comp.stop_loss_percent / 100); lines.push({ price: sl, title: `손절 ${f(sl)}`, color: "#f43f5e" }); }
    if (comp?.take_profit_percent) { const tp = entry * (1 + (short ? -1 : 1) * comp.take_profit_percent / 100); lines.push({ price: tp, title: `익절 ${f(tp)}`, color: "#10b981" }); }
  }
  return lines;
}
const secToInterval = (s?: number): string =>
  !s ? "1d" : s >= 86400 ? "1d" : s >= 14400 ? "4h" : s >= 3600 ? "1h" : s >= 900 ? "15m" : s >= 300 ? "5m" : "1m";
/** 차트용 캔들 — 주식=실제 키움 getCandles(일봉 ka10081), crypto=Binance 공개 klines. lightweight-charts {time(unix s),ohlc}. 읽기전용. */
const TF_BINANCE: Record<string, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w", "1mo": "1M" };
const secToTfToken = (s?: number): string => !s ? "1d" : s >= 2592000 ? "1mo" : s >= 604800 ? "1w" : s >= 86400 ? "1d" : s >= 3600 ? "1h" : s >= 1800 ? "30m" : s >= 300 ? "5m" : "1m";
const snapTime = (bars: { time: number }[], t: number): number => { if (!bars.length) return t; let best = bars[0].time, bd = Math.abs(bars[0].time - t); for (const b of bars) { const d = Math.abs(b.time - t); if (d < bd) { bd = d; best = b.time; } } return best; };
/** 진입(position_state.openedAt) + 거래(recentTrades) → 차트 시점 마커. 시각은 가장 가까운 봉에 스냅. */
function buildMarkers(bot: { id: string; position_state?: unknown }, bars: { time: number }[], ccy: string) {
  const f = (x: number) => (ccy === "KRW" ? "₩" : "$") + Math.round(x).toLocaleString();
  const toUnix = (s: unknown) => Math.floor(Date.parse(String(s).length === 10 ? String(s) + "T00:00:00Z" : String(s)) / 1000);
  const markers: { time: number; position: string; color: string; shape: string; text: string }[] = [];
  const addEntry = (entryAvg: number, openedAt: unknown) => { const u = toUnix(openedAt); if (entryAvg > 0 && Number.isFinite(u)) markers.push({ time: snapTime(bars, u), position: "belowBar", color: "#eab308", shape: "arrowUp", text: "진입 " + f(entryAvg) }); };
  const ps = bot.position_state as Record<string, unknown> | null;
  if (ps && typeof ps === "object") {
    if ((ps as { status?: string }).status === "open") addEntry(Number((ps as { entryAvg?: number }).entryAvg) || 0, (ps as { openedAt?: unknown }).openedAt);
    else for (const k of Object.keys(ps)) { const sub = ps[k] as { status?: string; entryAvg?: number; openedAt?: unknown } | undefined; if (sub?.status === "open") addEntry(Number(sub.entryAvg) || 0, sub.openedAt); }
  }
  for (const t of store.recentTrades(bot.id, 12)) {
    const u = toUnix(t.ts); if (!Number.isFinite(u)) continue;
    const sell = t.side === "sell";
    markers.push({ time: snapTime(bars, u), position: sell ? "aboveBar" : "belowBar", color: sell ? "#f43f5e" : "#10b981", shape: sell ? "arrowDown" : "arrowUp", text: (sell ? "매도" : "매수") + " " + f(t.price) });
  }
  markers.sort((a, b) => a.time - b.time);
  return markers;
}
/** 봇 보유 브로커별 실계좌 잔고(getBalance). 키 없으면 ok:false(페이퍼/미연동). */
async function accountBalances() {
  const brokers = [...new Set(store.listBots().map((b) => b.broker))];
  const out: { broker: string; ok: boolean; ccy?: string; totalAsset?: number; cashBalance?: number; error?: string }[] = [];
  for (const bk of brokers) {
    try {
      const ad = getAdapter(bk as Parameters<typeof getAdapter>[0], "spot")?.adapter;
      if (!ad) { out.push({ broker: bk, ok: false, error: "키 없음" }); continue; }
      const bal = await ad.getBalance();
      out.push({ broker: bk, ok: true, ccy: bal.currency, totalAsset: bal.totalAsset, cashBalance: bal.cashBalance });
    } catch (e) { out.push({ broker: bk, ok: false, error: e instanceof Error ? e.message : "잔고 조회 실패" }); }
  }
  return out;
}
/** 보유 KR 종목 현재가(차트와 동일 소스=getCandles 마지막 종가)로 카드 평가손익 갱신. crypto는 WS가 담당. */
async function livePrices() {
  const bots = store.listBots().filter((b) => b.broker !== "binance");
  const out: Record<string, number> = {};
  let first = true;
  for (const b of bots) {
    if (out[b.symbol] !== undefined) continue;
    if (!first) await new Promise((r) => setTimeout(r, 500)); // 키움 레이트리밋(429) 회피 — 종목 간 간격
    first = false;
    try {
      const ad = getAdapter(b.broker as Parameters<typeof getAdapter>[0], "spot")?.adapter as { getCandles?: (s: string, i: string, n: number) => Promise<{ close: number }[]> } | undefined;
      if (ad?.getCandles) { const bars = await ad.getCandles(b.symbol, "1d", 2); const last = bars[bars.length - 1]; if (last?.close) out[b.symbol] = last.close; }
    } catch { /* 키 없음/레이트리밋 → 스킵(카드는 진입가 유지) */ }
  }
  return out;
}
async function candlesFor(botId: string, tf?: string, inds?: string[]): Promise<{ ok: boolean; symbol?: string; broker?: string; ccy?: string; interval?: string; intraday?: boolean; bars?: { time: number; open: number; high: number; low: number; close: number }[]; overlays?: unknown[]; oscGroups?: unknown[]; priceLines?: unknown[]; markers?: unknown[]; error?: string }> {
  const bot = store.getBot(botId);
  if (!bot) return { ok: false, error: "봇 없음" };
  const toUnix = (s: string) => Math.floor(Date.parse(s.length === 10 ? s + "T00:00:00Z" : s) / 1000);
  try {
    const iv = (tf && /^(1m|5m|15m|30m|1h|4h|1d|1w|1mo)$/.test(tf)) ? tf : secToTfToken(bot.interval_seconds);
    const intraday = /m$/.test(iv) || /h$/.test(iv); // 분/시간봉이면 시각 표시
    let raw: { date: string; datetime?: string; open: number; high: number; low: number; close: number; volume?: number }[] = [];
    if (bot.broker === "binance") {
      raw = await fetchKlines(bot.symbol, TF_BINANCE[iv] ?? "1d", iv === "1mo" ? 120 : 200);
    } else {
      const ad = getAdapter(bot.broker as Parameters<typeof getAdapter>[0], "spot")?.adapter as { getCandles?: (s: string, i: string, n: number) => Promise<{ date: string; datetime?: string; open: number; high: number; low: number; close: number; volume?: number }[]> } | undefined;
      if (!ad?.getCandles) return { ok: false, error: `${bot.broker} 차트 데이터 미지원(키 필요할 수 있음)` };
      raw = await ad.getCandles(bot.symbol, iv, 200);
    }
    const bars = raw
      .map((b) => ({ time: toUnix(b.datetime ?? b.date), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }))
      .filter((b) => Number.isFinite(b.time) && b.close > 0)
      .sort((a, b) => a.time - b.time)
      .filter((b, i, arr) => i === 0 || b.time !== arr[i - 1].time);
    const ccy = bot.broker === "binance" ? "USD" : "KRW";
    const comp = store.getComposite(bot.composite_strategy_id);
    // 전략이 쓰는 지표(차트≡전략) + 사용자가 차트에서 토글로 켠 지표를 합쳐서 그림.
    const stratSpecs = collectIndicatorSpecs(comp?.root_node ?? {});
    // (종류, 정규화 기간) 단위 dedup: 전략 RSI(14)와 토글 RSI(30)은 다른 키라 둘 다 그림(기간 조정 반영),
    // 전략 RSI(14)와 토글 RSI(14)만 1개로 합침. (종류만 비교하면 기간 다른 토글이 통째 폐기되던 버그 수정)
    const stratKeys = new Set(stratSpecs.map((s) => `${s.ind}:${normPeriod(s.ind, s.period)}`));
    const toggleSpecs = parseToggleInds(inds).filter((s) => !stratKeys.has(`${s.ind}:${normPeriod(s.ind, s.period)}`));
    const ind = buildIndicators(bars, [...stratSpecs, ...toggleSpecs]);
    const priceLines = buildPriceLines(bot, comp, ccy);
    const markers = buildMarkers(bot, bars, ccy);
    return { ok: true, symbol: bot.symbol, broker: bot.broker, ccy, interval: iv, intraday, bars, overlays: ind.overlays, oscGroups: ind.oscGroups, priceLines, markers };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "candles 실패" };
  }
}

function snapshot() {
  const bots = store.listBots().map((b) => {
    const comp = store.getComposite(b.composite_strategy_id);
    const isScanner = (comp?.root_node as { type?: string })?.type === "scanner";
    const market = comp?.market ?? "spot";
    const st = store.tradeStats(b.id);
    return {
      id: b.id, name: b.name, symbol: b.symbol.toUpperCase(), mode: b.mode, status: b.status,
      strategy: comp ? summarizeStrategy(comp.root_node) : "(전략 없음)",
      plain: comp ? plainStrategy(comp.root_node) : "전략 없음",
      market, isScanner, broker: b.broker, detail: buildDetail(comp, b),
      positions: extractPositions(b.position_state, b.symbol, market, isScanner),
      realizedPnl: +st.realizedPnl.toFixed(2), closes: st.closes, winRate: st.closes > 0 ? +(st.wins / st.closes * 100).toFixed(0) : null,
      lastEvaluatedAt: b.last_evaluated_at, lastExecutedAt: b.last_executed_at,
      activity: store.recentLogs(b.id, 6).map((l) => ({ ts: l.ts, action: l.action, detail: l.detail })),
    };
  });
  return { bots, updatedAt: new Date().toISOString() };
}

function okHost(req: IncomingMessage): boolean {
  const h = (req.headers.host || "").split(":")[0];
  return h === "127.0.0.1" || h === "localhost";
}

export function startDashboard(port = 7788): Promise<{ url: string; port: number }> {
  if (_state) return Promise.resolve({ url: _state.url, port: _state.port });
  const token = randomBytes(16).toString("hex");

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!okHost(req)) { res.writeHead(403).end("forbidden host"); return; }
    const u = new URL(req.url || "/", "http://127.0.0.1");
    const auth = u.searchParams.get("token") === token;

    if (u.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html(token)); return; }
    if (u.pathname === "/favicon.ico") { res.writeHead(204).end(); return; } // 토큰 불필요(콘솔 401 소거)
    if (!auth) { res.writeHead(401).end("unauthorized"); return; }

    if (u.pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(snapshot())); return;
    }
    if (u.pathname === "/api/candles") {
      const indParam = u.searchParams.get("ind"); // 토글로 켠 지표(쉼표구분: "bollinger,vwap,sma:50")
      const indList = indParam ? indParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      candlesFor(u.searchParams.get("bot") || "", u.searchParams.get("tf") || undefined, indList).then((r) => {
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(r));
      }).catch((e) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "err" })); });
      return;
    }
    if (u.pathname === "/api/balances") {
      accountBalances().then((r) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ accounts: r })); })
        .catch((e) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ accounts: [], error: e instanceof Error ? e.message : "err" })); });
      return;
    }
    if (u.pathname === "/api/prices") {
      livePrices().then((p) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ prices: p })); })
        .catch((e) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ prices: {}, error: e instanceof Error ? e.message : "err" })); });
      return;
    }
    if (u.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const send = () => res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      send();
      const iv = setInterval(send, 5000);
      req.on("close", () => clearInterval(iv));
      return;
    }
    // 자격증명: GET=마스킹 상태(키값 미반환) / POST=upsert(화이트리스트, chmod 600, 응답도 마스킹만).
    if (u.pathname === "/api/credentials") {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, fields: BROKER_FIELDS, status: credentialStatus(), live: liveSettingsStatus(), path: credentialsPath() }));
        return;
      }
      if (req.method === "POST") {
        readJsonBody(req).then((body) => {
          const updates: Record<string, string> = {};
          for (const [k, v] of Object.entries(body)) if (typeof v === "string") updates[k] = v; // upsert가 화이트리스트로 재차 필터
          const { written } = upsertCredentials(updates); // 키값 로깅/에코 안 함
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, written: written.length, status: credentialStatus(), live: liveSettingsStatus() })); // 마스킹 상태만 반환
        }).catch((e) => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "bad request" })); });
        return;
      }
      res.writeHead(405).end("method not allowed"); return;
    }
    // 라이브 모드: POST {enable:true, maxNotional?, allowlist?} → 마스터 ON+안전기본값 / {enable:false} → 긴급 OFF(페이퍼 폴백).
    if (u.pathname === "/api/live") {
      if (req.method !== "POST") { res.writeHead(405).end("method not allowed"); return; }
      readJsonBody(req).then((body) => {
        if (body.enable === false) { disableLive(); }
        else { enableLive({ maxNotional: typeof body.maxNotional === "string" ? body.maxNotional : undefined, allowlist: typeof body.allowlist === "string" ? body.allowlist : undefined }); }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, live: liveSettingsStatus() }));
      }).catch((e) => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "bad request" })); });
      return;
    }
    res.writeHead(404).end("not found");
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${port}/?token=${token}`;
      _state = { url, port, token };
      resolve({ url, port });
    });
  });
}

function html(token: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>quant-mcp 대시보드</title>
<style>
:root{color-scheme:dark}body{margin:0;background:#0b0e14;color:#e6e6e6;font:14px/1.5 system-ui,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:24px}
h1{font-size:18px;margin:0 0 2px}.sub{color:#8a94a6;font-size:12px;margin-bottom:16px}
.hdr{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
.card{background:#121622;border:1px solid #222838;border-radius:12px;padding:16px}
.k{color:#8a94a6;font-size:12px}.v{font-size:22px;font-weight:700;margin-top:4px}
.pos{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.row{display:flex;justify-content:space-between;align-items:center}
.sym{font-weight:600}.badge{font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;background:rgba(16,185,129,.15);color:#10b981;margin-left:6px}
.pl{font-size:18px;font-weight:700}.up{color:#10b981}.dn{color:#f43f5e}
.g3{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px;font-size:12px}
.g3 .k{font-size:11px}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#10b981;animation:p 1.2s infinite}
@keyframes p{50%{opacity:.3}}.empty{color:#8a94a6;text-align:center;padding:32px}.mode{font-size:10px;color:#8a94a6}
.strat{font-size:12px;color:#c9d2e3;background:#0e1320;border:1px solid #222838;border-radius:6px;padding:8px 10px;margin-top:8px;line-height:1.55}
.strat .drow{padding:4px 0;border-top:1px solid #1a2030}.strat .drow:first-child{border-top:0;padding-top:0}
.strat b{color:#8a94a6;font-weight:600;display:inline-block;min-width:62px;margin-right:6px;vertical-align:top}
.strat code{font-family:ui-monospace,monospace;font-size:11px;color:#9fb2d4;word-break:break-all}
.strat .tag{display:inline-block;background:#1a2030;color:#c9d2e3;border-radius:4px;padding:1px 6px;margin:0 4px 4px 0;font-size:11px}
.act{margin-top:8px;font-size:11px;color:#8a94a6;max-height:96px;overflow:auto}
.act div{display:flex;gap:6px;padding:1px 0}.act .a{color:#7aa2f7;min-width:42px}
.st{font-size:10px;padding:1px 5px;border-radius:4px;margin-left:6px}.run{background:rgba(122,162,247,.15);color:#7aa2f7}.stop{background:#222838;color:#8a94a6}
.short{background:rgba(244,63,94,.15);color:#f43f5e}.live{background:rgba(245,158,11,.18);color:#f59e0b}
.sc{background:rgba(168,85,247,.18);color:#a855f7}
.plist{margin-top:8px}.prow{background:#0e1320;border:1px solid #222838;border-radius:8px;padding:9px 11px;margin-top:6px;font-size:13px}
.prow b{font-size:14px}.qty{font-size:11px;color:#8a94a6;background:#1a2030;padding:1px 6px;border-radius:4px;margin-left:4px}
.pmeta{margin-top:5px;font-size:12px;color:#8a94a6}
.hint{font-size:11px;color:#6b7588;font-weight:400}
.pill{font-size:12px;font-weight:700;padding:3px 9px;border-radius:999px;margin-left:8px;white-space:nowrap}
.pill.win{background:rgba(16,185,129,.16);color:#10b981}.pill.lose{background:rgba(244,63,94,.16);color:#f43f5e}.pill.wait{background:#222838;color:#8a94a6}
.tags{margin-top:7px;display:flex;gap:5px;flex-wrap:wrap}
.plain{margin-top:10px;font-size:14px;line-height:1.55;color:#dfe6f1}
.earn{margin-top:9px;font-size:13px;font-weight:600}
.more{margin-top:10px;font-size:11px;color:#6b7588;cursor:pointer;user-select:none}.more:hover{color:#8a94a6}
.cbtn{margin-top:8px;font-size:11px;color:#7aa2f7;cursor:pointer;user-select:none;display:inline-block}.cbtn:hover{color:#a8c0ff}
.cmodal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.66);z-index:50;align-items:center;justify-content:center;padding:16px}
.cmbox{background:#121622;border:1px solid #222838;border-radius:14px;padding:14px;width:min(900px,94vw)}
.cmhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.cmhead b{font-size:14px}.cmx{cursor:pointer;color:#8a94a6;font-size:13px;user-select:none}.cmx:hover{color:#e6e6e6}
.cmnote{font-size:11px;color:#6b7588;margin-top:8px}#chartBody{width:100%;height:380px}
.sect{grid-column:1/-1;display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin:8px 2px 0;padding-bottom:6px;border-bottom:1px solid #222838}
.sect-t{font-size:14px;font-weight:700}.sect-s{font-size:11px;color:#8a94a6;font-weight:400;margin-left:3px}
.sect-m{font-size:12px;color:#c9d2e3;text-align:right}
@media(max-width:560px){.sect{flex-direction:column;gap:2px;align-items:flex-start}.sect-m{text-align:left}}
.tfbar{display:flex;gap:6px;margin:2px 0 10px;flex-wrap:wrap}
.tfb{font-size:12px;color:#8a94a6;background:#0e1320;border:1px solid #222838;border-radius:6px;padding:4px 10px;cursor:pointer;user-select:none}
.tfb:hover{color:#e6e6e6}.tfb.on{background:#7aa2f7;color:#0b0e14;border-color:#7aa2f7;font-weight:700}
.indbar{display:flex;gap:5px;margin:0 0 10px;flex-wrap:wrap;align-items:center}
.indbar .indlbl{font-size:11px;color:#6b7588;margin-right:2px}
.ib{font-size:11px;color:#8a94a6;background:#0e1320;border:1px solid #222838;border-radius:5px;padding:3px 8px;cursor:pointer;user-select:none}
.ib:hover{color:#e6e6e6}.ib.on{background:#22d3ee;color:#0b0e14;border-color:#22d3ee;font-weight:700}
.gear{cursor:pointer;color:#7aa2f7;font-size:12px;margin-left:8px;user-select:none}.gear:hover{color:#a8c0ff}
/* 켜진 지표 기간 조정 행 */
.indparams{display:flex;gap:6px;margin:0 0 10px;flex-wrap:wrap;align-items:center}
.indparams:empty{display:none;margin:0}
.indparams .pplbl{font-size:11px;color:#6b7588;margin-right:2px}
.pchip{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#8a94a6;background:#0e1320;border:1px solid #222838;border-radius:5px;padding:2px 6px}
.pchip span{color:#22d3ee;font-weight:700}
.pchip input{width:46px;font-size:11px;color:#e6e6e6;background:#0b0e14;border:1px solid #2a3550;border-radius:4px;padding:2px 4px;text-align:center;outline:none}
.pchip input:focus{border-color:#22d3ee}
.setpanel{margin-bottom:16px}
.setnote{font-size:12px;color:#8a94a6;margin:8px 0 12px;line-height:1.5}.setnote code{background:#0e1320;padding:1px 5px;border-radius:4px;color:#c9d2e3}
.brk{border-top:1px solid #222838;padding-top:10px;margin-top:10px}.brk:first-child{border-top:0;padding-top:0;margin-top:0}
.brkh{display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:8px}
.brkh .ok{font-size:11px;color:#10b981}.brkh .no{font-size:11px;color:#8a94a6}
.fld{display:grid;grid-template-columns:140px 1fr;gap:8px;align-items:center;margin-bottom:7px}
.fld label{font-size:12px;color:#c9d2e3}.fld .cur{font-size:11px;color:#6b7588}
.fld input{background:#0e1320;border:1px solid #222838;border-radius:6px;color:#e6e6e6;padding:7px 9px;font:13px system-ui,sans-serif;width:100%;box-sizing:border-box}
.fld input:focus{outline:none;border-color:#7aa2f7}
.savebtn{background:#7aa2f7;color:#0b0e14;border:0;border-radius:8px;padding:8px 16px;font-weight:700;font-size:13px;cursor:pointer;margin-top:8px}.savebtn:hover{background:#a8c0ff}
.setmsg{font-size:12px;margin-top:10px;min-height:16px}.setmsg.ok{color:#10b981}.setmsg.err{color:#f43f5e}
.livebox{border-top:1px solid #222838;margin-top:14px;padding-top:12px}
.livebox .lh{display:flex;justify-content:space-between;align-items:center;font-weight:600}
.livebox .ld{font-size:12px;color:#8a94a6;margin:6px 0 10px;line-height:1.5}
.livebox .on{color:#f59e0b}.livebox .off{color:#8a94a6}
.livebtn{border:0;border-radius:8px;padding:8px 16px;font-weight:700;font-size:13px;cursor:pointer}
.livebtn.go{background:#f59e0b;color:#0b0e14}.livebtn.go:hover{background:#fbbf24}
.livebtn.stop{background:#f43f5e;color:#fff}.livebtn.stop:hover{background:#fb7185}
.lstat{font-size:12px;color:#c9d2e3;margin-top:8px;line-height:1.6}.lstat b{color:#e6e6e6}
@media(max-width:560px){.fld{grid-template-columns:1fr}}
@media(max-width:560px){.wrap{padding:14px}.hdr{grid-template-columns:1fr 1fr}.pos{grid-template-columns:1fr}.v{font-size:20px}.sym{font-size:14px}}
</style><script src="https://unpkg.com/lightweight-charts@5.2.0/dist/lightweight-charts.standalone.production.js"></script></head><body><div class="wrap">
<h1>내 자동매매 현황 <span class="dot"></span></h1>
<div class="sub">봇이 알아서 사고팔아요 · 실시간 시세 반영 <span id="upd" style="color:#8a94a6">—</span>
  <span class="gear" onclick="toggleSettings()">⚙️ API 키 설정</span></div>
<div class="card setpanel" id="setpanel" style="display:none">
  <div class="row"><div><b>거래소 API 키 입력</b> <span class="hint">실거래/모의거래를 하려면 키가 필요해요</span></div>
    <span class="gear" onclick="toggleSettings()">닫기 ✕</span></div>
  <div class="setnote">🔒 키는 이 컴퓨터의 <code id="credpath">~/.quant-mcp/credentials.env</code> 파일에만 저장돼요(소유자 전용). 화면·채팅·인터넷으로 절대 새어나가지 않고, 한 번 저장하면 다시 보이지 않아요(보안). 발급처는 거래소(예: Binance) 설정에서 받으세요.</div>
  <div id="setbody"></div>
  <div id="setlive" class="livebox"></div>
  <div id="setmsg" class="setmsg"></div>
</div>
<div class="hdr">
  <div class="card"><div class="k">작동 중인 봇 / 보유 중</div><div class="v"><span id="bcnt">0</span><span style="font-size:14px;color:#8a94a6"> / </span><span id="cnt">0</span></div></div>
  <div class="card"><div class="k">지금 손익 <span class="hint">(안 팔았을 때)</span></div><div class="v" id="tot">+0.00</div></div>
  <div class="card"><div class="k">확정 수익 <span class="hint">(이미 번 돈)</span></div><div class="v" id="rtot">+0.00</div></div>
</div>
<div class="pos" id="pos"></div>
<div class="empty" id="empty">아직 봇이 없어요. 자비스에게 "전략 만들어서 봇 돌려줘"라고 말해보세요.</div>
<div class="cmodal" id="chartModal"><div class="cmbox">
  <div class="cmhead"><b id="chartTitle">차트</b><span class="cmx" onclick="closeChart()">닫기 ✕</span></div>
  <div class="tfbar" id="chartTf"></div>
  <div class="indbar" id="chartInds"></div>
  <div class="indparams" id="chartIndParams"></div>
  <div class="indbar" id="chartDraw"></div>
  <div id="chartBody"></div>
  <div class="cmnote" id="chartNote"></div>
</div></div>
<script>
const TOKEN=${JSON.stringify(token)};
let bots=[];const prices=new Map();let ws=null;var accounts={};
function fmt(n,d=2){return Number(n).toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d})}
function ccyOf(broker){return broker==='binance'?'USD':'KRW'}
function csym(c){return c==='KRW'?'₩':'$'}
function money(n,c){return csym(c)+Math.round(Math.abs(Number(n)||0)).toLocaleString()}
function signed(n,c){var v=Math.round(Number(n)||0);return (v>=0?'+':'-')+csym(c)+Math.abs(v).toLocaleString()}
function plspan(n,c){var v=Math.round(Number(n)||0);return '<span class="'+(v>=0?'up':'dn')+'">'+signed(v,c)+'</span>'}
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function allSyms(){return [...new Set(bots.flatMap(b=>(b.positions||[]).map(p=>p.symbol)))]}
let subSig='';
function subscribe(){const syms=allSyms().filter(function(s){return /[a-z]/i.test(s)}).sort();const sig=syms.join(','); // crypto만 Binance WS(KR 종목코드=숫자 제외)
 if(sig===subSig&&ws&&ws.readyState<=1)return; // 심볼 동일 + 연결 살아있으면 재구독 안 함(churn 방지)
 subSig=sig;if(ws){try{ws.close()}catch(e){}}
 if(!syms.length){ws=null;return;}const streams=syms.map(s=>s.toLowerCase()+'@ticker').join('/');
 ws=new WebSocket('wss://stream.binance.com:9443/ws/'+streams);
 ws.onmessage=e=>{const d=JSON.parse(e.data);if(d.e==='24hrTicker'){prices.set(d.s,parseFloat(d.c));render()}}}
const expanded=new Set(); // 펼친 봇 id 보존 — WS 가격 틱마다 render()가 통째 재생성해도 안 닫히게(나오자마자 사라지던 버그 수정)
function tgl(el){const id=el.dataset.id;const open=!expanded.has(id);if(open)expanded.add(id);else expanded.delete(id);
 const s=el.nextElementSibling;s.style.display=open?'block':'none';el.textContent=open?'간단히 ▴':'전략 자세히 ▾';}
function detailHtml(b){const d=b.detail||{};
 const inds=(d.indicators&&d.indicators.length)?d.indicators.map(function(x){return '<span class="tag">'+esc(x)+'</span>'}).join(''):'<span class="hint">가격·조건 기반(별도 지표 없음)</span>';
 return '<div class="drow"><b>한 줄 요약</b>'+esc(b.plain)+'</div>'+
  '<div class="drow"><b>보는 지표</b>'+inds+'</div>'+
  '<div class="drow"><b>시장</b>'+esc(d.market||'—')+'</div>'+
  '<div class="drow"><b>리스크</b>'+esc(d.risk||'—')+'</div>'+
  '<div class="drow"><b>운용</b>'+esc(brokerLabel(b.broker))+' · '+esc(d.interval||'—')+'마다 평가 · 자본 '+fmt(d.capital||0,0)+' · '+(b.mode==='live'?'실거래/모의주문':'페이퍼(모의)')+'</div>'+
  '<div class="drow"><b>데이터</b>'+esc(d.data||'—')+'</div>'+
  '<div class="drow"><b>전문 표기</b><code>'+esc(b.strategy)+'</code></div>';}
const ACT={buy:'🟢 샀어요',sell:'🔴 팔았어요',hold:'유지',create:'봇 생성',start:'시작',stop:'정지',gate:'안내',error:'⚠ 오류'};
function coin(s){return String(s).replace('USDT','').replace('USDC','')}
function posRow(p,c){const px=prices.get(p.symbol)??p.entryAvg;const sign=p.side==='short'?-1:1;
 const up=sign*(px-p.entryAvg)/p.entryAvg*100;const abs=sign*(px-p.entryAvg)*p.qty;
 const dir=p.side==='short'?' <span class="qty">하락베팅</span>':'';const unit=c==='KRW'?'주':'개';
 const html='<div class="prow"><div class="row"><div><b>'+esc(coin(p.symbol))+'</b>'+dir+' <span class="qty">'+p.qty+unit+' 보유</span></div>'+
   '<span class="pl '+(up>=0?'up':'dn')+'">'+(up>=0?'+':'')+fmt(up,1)+'%</span></div>'+
   '<div class="pmeta">산 가격 '+money(p.entryAvg,c)+' → 지금 '+money(px,c)+' · 평가 '+plspan(abs,c)+'</div></div>';
 return {html,abs};}
function statusPill(sum,hasPos){if(!hasPos)return '<span class="pill wait">⚪ 대기 중</span>';
 return sum>=0?'<span class="pill win">🟢 수익 중</span>':'<span class="pill lose">🔴 손실 중</span>';}
let _chart=null,_chartId=null,_chartTf=null,_klineWs=null,_priceSeries=null,_ovSeries=[],_oscFlat=[],_markersPrim=null,_refreshing=false,_chartPoll=null,_volSeries=null;
// ── 드로잉툴 상태(차트당 세션 메모리, 영속 없음) ──
// _drawings: {kind:'trend',p1:{time,price},p2:{time,price},series} | {kind:'hline',price,line(=PriceLine)}
var _drawings=[],_drawMode='none',_pendingTrend=null,_clickHandler=null;
function drawColor(){return '#22d3ee';}
// ── 드로잉 영속(localStorage, 봇별) ──
// 키=botId만(tf 무관: 드로잉은 가격/시각 절대좌표라 tf 바뀌어도 같은 선이 유효). 모델만 직렬화(series/line 객체참조 제외).
var DRAW_NS='qmDraw:',DRAW_MAX=100; // 봇당 상한(용량/DoS 방어)
var _drawLoadedFor=null; // 현재 _drawings가 어느 봇의 것인지(봇 전환 시에만 저장소 재로드)
function drawKey(id){return DRAW_NS+String(id==null?'':id);}
// _drawings → 직렬화 가능한 순수 모델 배열({kind,price} | {kind,p1,p2}). 객체참조(line/series) 제외.
function serializeDrawings(){var out=[];for(var i=0;i<_drawings.length;i++){var d=_drawings[i];
  if(d.kind==='hline'&&isFinite(d.price))out.push({kind:'hline',price:d.price});
  else if(d.kind==='trend'&&d.p1&&d.p2)out.push({kind:'trend',p1:{time:d.p1.time,price:d.p1.price},p2:{time:d.p2.time,price:d.p2.price}});}
  return out;}
// 현재 _chartId 봇의 드로잉을 localStorage에 저장(그리기/지우개/전체삭제 후 호출).
function persistDrawings(){if(_chartId==null)return;try{var arr=serializeDrawings();
  if(arr.length)localStorage.setItem(drawKey(_chartId),JSON.stringify(arr.slice(0,DRAW_MAX)));
  else localStorage.removeItem(drawKey(_chartId));}catch(e){}}
// 손상 JSON/형식 방어하며 봇 드로잉 모델 로드. 좌표가 현재 윈도우 밖이어도 모델은 유지(off-screen).
function loadDrawings(id){var raw;try{raw=localStorage.getItem(drawKey(id))}catch(e){return [];}if(!raw)return [];
  var arr;try{arr=JSON.parse(raw)}catch(e){return [];}if(!Array.isArray(arr))return [];
  var out=[];for(var i=0;i<arr.length&&out.length<DRAW_MAX;i++){var d=arr[i];if(!d||typeof d!=='object')continue;
    if(d.kind==='hline'){if(typeof d.price==='number'&&isFinite(d.price))out.push({kind:'hline',price:d.price});}
    else if(d.kind==='trend'){var p1=d.p1,p2=d.p2;
      if(p1&&p2&&p1.time!=null&&p2.time!=null&&typeof p1.price==='number'&&typeof p2.price==='number'&&isFinite(p1.price)&&isFinite(p2.price))
        out.push({kind:'trend',p1:{time:p1.time,price:p1.price},p2:{time:p2.time,price:p2.price}});}}
  return out;}
function clearChartPoll(){if(_chartPoll){clearInterval(_chartPoll);_chartPoll=null;}}
function tfLabel(t){return {'1m':'1분','5m':'5분','30m':'30분','1h':'1시간','1d':'일','1w':'주','1mo':'월'}[t]||t;}
// 시각 표기 KST 통일: 데이터는 안 건드리고 표시만. KR 봉시각=KST벽시계가 UTC로 인코딩됨(shift 0),
// 코인 봉시각=실제 UTC(shift +9h) → 둘 다 (shift 적용 후) UTC 게터로 읽으면 KST 벽시계가 나옴.
function _p2(n){return n<10?'0'+n:''+n;}
function kstTime(t){var d=new Date(t*1000);return _p2(d.getUTCHours())+':'+_p2(d.getUTCMinutes());}
function kstDate(t){var d=new Date(t*1000);return (d.getUTCMonth()+1)+'/'+d.getUTCDate();}
function kstFull(t){var d=new Date(t*1000);return d.getUTCFullYear()+'-'+_p2(d.getUTCMonth()+1)+'-'+_p2(d.getUTCDate())+' '+_p2(d.getUTCHours())+':'+_p2(d.getUTCMinutes());}
// 실시간 차트(코인): 바이낸스 kline WS로 현재 봉 매 틱 갱신 + 봉 종료 시 지표 재계산(setData, 차트 재생성 없음=무깜빡).
function klineIv(t){return t==='1mo'?'1M':t;} // 우리 토큰→바이낸스 kline 인터벌(월만 1M)
function closeKline(){if(_klineWs){try{_klineWs.close()}catch(e){}_klineWs=null;}}
function setupKline(sym,tf){closeKline();
 if(!sym||!/usdt$/i.test(sym)||!window.WebSocket)return; // 바이낸스 USDT 심볼만(KR=폴링)
 try{var ws=new WebSocket('wss://stream.binance.com:9443/ws/'+sym.toLowerCase()+'@kline_'+klineIv(tf));_klineWs=ws;
  ws.onmessage=function(e){if(!_priceSeries||ws!==_klineWs)return;var k;try{k=JSON.parse(e.data).k}catch(err){return;}if(!k)return;
   try{_priceSeries.update({time:Math.floor(k.t/1000),open:+k.o,high:+k.h,low:+k.l,close:+k.c})}catch(err){}
   if(_volSeries){try{_volSeries.update({time:Math.floor(k.t/1000),value:Number(k.v)||0,color:(+k.c>=+k.o?'rgba(16,185,129,.45)':'rgba(244,63,94,.45)')})}catch(err){}} // 거래량 막대도 현재봉 동기(k.v=base거래량)
   if(k.x)refreshSeries();}; // 봉 마감 → 지표/마커 재계산
 }catch(e){}}
// 봉 마감 시 1회: 지표 다시 받아 기존 시리즈에 setData(차트/패널 유지 → 깜빡임·줌리셋 없음).
function refreshSeries(){if(_refreshing||!_priceSeries||!_chartId)return;_refreshing=true;
 var _q=Array.from(chartInds).filter(function(k){return k!=='volume'});var indQ=_q.length?'&ind='+encodeURIComponent(_q.join(',')):'';
 fetch('/api/candles?token='+TOKEN+'&bot='+encodeURIComponent(_chartId)+(_chartTf?'&tf='+_chartTf:'')+indQ).then(function(r){return r.json()}).then(function(d){_refreshing=false;if(!d.ok||!_priceSeries)return;
  try{_priceSeries.setData(d.bars||[]);}catch(e){}
  (d.overlays||[]).forEach(function(o,i){if(_ovSeries[i])try{_ovSeries[i].setData(o.data||[])}catch(e){}});
  var flat=(d.oscGroups||[]).reduce(function(a,g){return a.concat(g.series||[])},[]);
  flat.forEach(function(se,i){if(_oscFlat[i])try{_oscFlat[i].setData(se.data||[])}catch(e){}});
  if(_markersPrim)try{_markersPrim.setMarkers(d.markers||[])}catch(e){}
  if(_volSeries)try{_volSeries.setData(volData(d.bars||[]))}catch(e){}
 }).catch(function(){_refreshing=false;});}
// 클릭 좌표 → {time,price}. raw unix time 기준(tzShift는 표시전용이라 더하지 않음=캔들과 정합).
function clickToPoint(param){
  if(!_chart||!_priceSeries)return null;
  var t=param.time; // v5: subscribeClick param.time = 시리즈 시각(unix sec). 봉 위 클릭이면 존재.
  if(t==null&&param.point){try{t=_chart.timeScale().coordinateToTime(param.point.x)}catch(e){}}
  if(t==null||!param.point)return null;
  var price;try{price=_priceSeries.coordinateToPrice(param.point.y)}catch(e){}
  if(price==null||!isFinite(price))return null;
  return {time:t,price:price};
}
function onChartClick(param){
  if(_drawMode==='none'||!param||!param.point)return;
  if(_drawMode==='hline'){
    var pt=clickToPoint(param);if(!pt)return;
    var line=_priceSeries.createPriceLine({price:pt.price,color:drawColor(),lineWidth:1,lineStyle:0,axisLabelVisible:true,title:''});
    if(_drawings.length>=DRAW_MAX){removeDrawing({kind:'hline',price:pt.price,line:line});return;} // 상한 초과=무시
    _drawings.push({kind:'hline',price:pt.price,line:line});persistDrawings();
    return;
  }
  if(_drawMode==='trend'){
    var p=clickToPoint(param);if(!p)return;
    if(!_pendingTrend){_pendingTrend=p;return;} // 첫 점 보관
    var p1=_pendingTrend,p2=p;_pendingTrend=null;
    if(p1.time===p2.time)return; // 같은 봉 두번=선 안 그림(시간 단조 위반 방지)
    var a=p1.time<p2.time?p1:p2,b=p1.time<p2.time?p2:p1; // time 오름차순 정렬(setData 요구)
    var ls=_chart.addSeries(LightweightCharts.LineSeries,{color:drawColor(),lineWidth:2,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false},0);
    ls.setData([{time:a.time,value:a.price},{time:b.time,value:b.price}]);
    if(_drawings.length>=DRAW_MAX){try{_chart.removeSeries(ls)}catch(e){}return;} // 상한 초과=무시
    _drawings.push({kind:'trend',p1:a,p2:b,series:ls});persistDrawings();
    return;
  }
  if(_drawMode==='erase'){ // 클릭 근처(화면 픽셀 임계 내) 드로잉 1개만 삭제. 빈 영역 클릭=미삭제.
    var pt2=clickToPoint(param);if(!pt2)return;var best=-1,bd=1e18,cy=param.point.y,THRESH=8; // px
    for(var i=0;i<_drawings.length;i++){var dr=_drawings[i],yp;
      if(dr.kind==='hline')yp=dr.price;
      else{ // 추세선: 클릭 time에서 보간한 가격(범위 밖이면 엔드포인트 클램프)
        var s1=dr.p1,s2=dr.p2;
        if(pt2.time<=s1.time)yp=s1.price;else if(pt2.time>=s2.time)yp=s2.price;
        else yp=s1.price+(s2.price-s1.price)*((pt2.time-s1.time)/(s2.time-s1.time));}
      var yc;try{yc=_priceSeries.priceToCoordinate(yp)}catch(e){yc=null;}
      if(yc==null)continue;var dpx=Math.abs(yc-cy);
      if(dpx<bd){bd=dpx;best=i;}}
    if(best>=0&&bd<=THRESH){removeDrawing(_drawings[best]);_drawings.splice(best,1);persistDrawings();} // 임계 내일 때만 삭제
    return;
  }
}
function removeDrawing(dr){try{if(dr.kind==='trend'&&dr.series&&_chart)_chart.removeSeries(dr.series);else if(dr.kind==='hline'&&dr.line&&_priceSeries)_priceSeries.removePriceLine(dr.line);}catch(e){}}
function clearDrawings(){for(var i=0;i<_drawings.length;i++)removeDrawing(_drawings[i]);_drawings=[];_pendingTrend=null;}
// openChart가 차트를 통째 재생성하므로(tf변경/지표토글) 모델만 남기고 시리즈/라인 참조를 새로 만들어 복원.
function redrawDrawings(){if(!_chart||!_priceSeries)return;
 for(var i=0;i<_drawings.length;i++){var dr=_drawings[i];
  if(dr.kind==='hline'){dr.line=_priceSeries.createPriceLine({price:dr.price,color:drawColor(),lineWidth:1,lineStyle:0,axisLabelVisible:true,title:''});}
  else{var ls=_chart.addSeries(LightweightCharts.LineSeries,{color:drawColor(),lineWidth:2,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false},0);ls.setData([{time:dr.p1.time,value:dr.p1.price},{time:dr.p2.time,value:dr.p2.price}]);dr.series=ls;}}}
var DRAW_TOOLS=[{k:'trend',n:'추세선'},{k:'hline',n:'수평선'},{k:'erase',n:'지우개'}];
function renderDrawButtons(){var el=document.getElementById('chartDraw');if(!el)return;
 el.innerHTML='<span class="indlbl">그리기</span>'+DRAW_TOOLS.map(function(t){return '<span class="ib'+(_drawMode===t.k?' on':'')+'" data-dk="'+t.k+'" onclick="setDrawMode(this.dataset.dk)">'+t.n+'</span>';}).join('')+'<span class="ib" onclick="clearAllDrawings()">전체삭제</span>';}
function setDrawMode(k){_drawMode=(_drawMode===k)?'none':k;_pendingTrend=null;renderDrawButtons();}
function clearAllDrawings(){clearDrawings();persistDrawings();renderDrawButtons();} // 모델 비움 → 저장소도 제거
function renderTfButtons(cur){var tfs=['1m','5m','30m','1h','1d','1w','1mo'];
 document.getElementById('chartTf').innerHTML=tfs.map(function(t){return '<span class="tfb'+(t===cur?' on':'')+'" data-tf="'+t+'" onclick="openChart(_chartId,this.dataset.tf)">'+tfLabel(t)+'</span>';}).join('');}
// 트뷰처럼 켜고끄는 지표 메뉴. 가격 위 오버레이 + 하단 보조지표. 선택은 localStorage 보존(틱 재렌더에도 유지).
var IND_MENU=[{k:'volume',n:'거래량'},{k:'bollinger',n:'볼린저'},{k:'vwap',n:'VWAP'},{k:'supertrend',n:'슈퍼트렌드'},{k:'ichimoku',n:'일목'},{k:'sma:50',n:'SMA50'},{k:'ema:200',n:'EMA200'},{k:'parabolic_sar',n:'SAR'},{k:'donchian',n:'돈치안'},{k:'rsi',n:'RSI'},{k:'macd',n:'MACD'},{k:'stochastic',n:'스토캐스틱'},{k:'adx',n:'ADX'},{k:'atr',n:'ATR'},{k:'cci',n:'CCI'},{k:'mfi',n:'MFI'},{k:'williams_r',n:'윌리엄스%R'},{k:'obv',n:'OBV'},{k:'roc',n:'ROC'}];
var chartInds=new Set();try{chartInds=new Set(JSON.parse(localStorage.getItem('qmInds')||'[]'))}catch(e){}
// 기간을 갖는 지표만 인라인 숫자조정 노출(서버 buildIndicators 기본값과 일치). 없는 지표=복합/고정(macd·일목·SAR·StochRSI)→조정 안함.
var IND_PARAM={sma:{n:'SMA',d:50,min:2,max:400},ema:{n:'EMA',d:200,min:2,max:400},bollinger:{n:'볼린저',d:20,min:2,max:200},vwap:{n:'VWAP',d:20,min:2,max:200},supertrend:{n:'슈퍼트렌드',d:10,min:2,max:100},donchian:{n:'돈치안',d:20,min:2,max:200},rsi:{n:'RSI',d:14,min:2,max:100},stochastic:{n:'스토캐스틱',d:14,min:2,max:100},adx:{n:'ADX',d:14,min:2,max:100},atr:{n:'ATR',d:14,min:2,max:100},cci:{n:'CCI',d:20,min:2,max:200},mfi:{n:'MFI',d:14,min:2,max:100},williams_r:{n:'윌리엄스%R',d:14,min:2,max:100},obv:{n:'OBV',d:20,min:2,max:200},roc:{n:'ROC',d:12,min:2,max:200}};
// 토글키('ind' 또는 'ind:period') → {base, period}. period 미지정 시 IND_PARAM 기본값. 기간 없는 지표는 null.
function splitIndKey(k){var a=String(k).split(':');var base=a[0];var per=parseInt(a[1],10);var meta=IND_PARAM[base];if(!meta)return null;return {base:base,period:(per>0?per:meta.d),meta:meta};}
// 켜진 지표의 기간만 칩으로 렌더. 기간 없는/복합 지표는 자동 제외(splitIndKey=null).
function renderIndParams(){var el=document.getElementById('chartIndParams');if(!el)return;var chips=[];Array.from(chartInds).forEach(function(k){var s=splitIndKey(k);if(!s)return;chips.push('<span class="pchip" title="'+s.base+' 기간">'+s.meta.n+'('+s.period+') <span>기간</span> <input type="number" min="'+s.meta.min+'" max="'+s.meta.max+'" value="'+s.period+'" data-base="'+s.base+'" data-old="'+k+'" onchange="setIndPeriod(this)" onkeydown="if(event.key===&quot;Enter&quot;)this.blur()"></span>');});el.innerHTML=chips.length?'<span class="pplbl">기간 조정</span>'+chips.join(''):'';}
// 숫자입력 변경 → chartInds에서 옛 키 제거 후 'base:newperiod'로 교체 → 저장 → 차트 재요청.
function setIndPeriod(inp){var base=inp.dataset.base,oldKey=inp.dataset.old,meta=IND_PARAM[base];if(!meta)return;var v=parseInt(inp.value,10);if(!(v>0))v=meta.d;if(v<meta.min)v=meta.min;if(v>meta.max)v=meta.max;var newKey=base+':'+v;if(newKey===oldKey){inp.value=v;return;}chartInds.delete(oldKey);chartInds.add(newKey);saveInds();openChart(_chartId,_chartTf);}
function saveInds(){try{localStorage.setItem('qmInds',JSON.stringify(Array.from(chartInds)))}catch(e){}}
function renderIndButtons(){document.getElementById('chartInds').innerHTML='<span class="indlbl">지표 추가</span>'+IND_MENU.map(function(m){return '<span class="ib'+(chartInds.has(m.k)?' on':'')+'" data-k="'+m.k+'" onclick="toggleInd(this.dataset.k)">'+m.n+'</span>'}).join('');renderIndParams();}
function toggleInd(k){if(chartInds.has(k))chartInds.delete(k);else chartInds.add(k);saveInds();openChart(_chartId,_chartTf);}
// 거래량 히스토그램 데이터: 봉 상승/하락에 따라 색(가격패널 캔들색과 동일·반투명). bars[].volume는 서버가 이미 실어 보냄.
function volData(bars){return (bars||[]).map(function(b){return {time:b.time,value:Number(b.volume)||0,color:(b.close>=b.open?'rgba(16,185,129,.45)':'rgba(244,63,94,.45)')};});}
function openChart(id,tf){
 // 새 봇(또는 닫힌 뒤 재오픈) 진입 시 저장된 드로잉 로드. tf변경/지표토글로 같은 봇 재오픈은 메모리 _drawings 유지(이미 저장과 동기).
 if(String(id)!==String(_drawLoadedFor)){_drawings=[];_pendingTrend=null;_drawLoadedFor=String(id);try{_drawings=loadDrawings(id)}catch(e){_drawings=[];}}
 _chartId=id;var modal=document.getElementById('chartModal'),body=document.getElementById('chartBody');
 document.getElementById('chartTitle').textContent='차트 불러오는 중…';modal.style.display='flex';
 var _oq=Array.from(chartInds).filter(function(k){return k!=='volume'});var indQ=_oq.length?'&ind='+encodeURIComponent(_oq.join(',')):''; // volume=클라전용(refreshSeries와 일관)
 fetch('/api/candles?token='+TOKEN+'&bot='+encodeURIComponent(id)+(tf?'&tf='+tf:'')+indQ).then(function(r){return r.json()}).then(function(d){
  if(!d.ok){document.getElementById('chartTitle').textContent='차트 오류: '+(d.error||'불러오기 실패');document.getElementById('chartTf').innerHTML='';return;}
  var isC=d.broker==='binance';
  _chartTf=d.interval;
  renderTfButtons(d.interval);renderIndButtons();renderDrawButtons();
  var oscGroups=d.oscGroups||[];
  var names=[].concat((d.overlays||[]).map(function(o){return o.label}),oscGroups.reduce(function(a,g){return a.concat((g.series||[]).map(function(s){return s.label}))},[]));
  document.getElementById('chartTitle').textContent=(isC?coin(d.symbol):d.symbol)+' · '+(isC?'Binance':'키움증권')+' '+tfLabel(d.interval)+(names.length?'  ·  '+names.join(' '):'');
  document.getElementById('chartNote').textContent=(isC?'데이터: Binance 공개 시세 · 실시간(WS)':'데이터: 키움증권 실제 차트(모의) · 실시간(20초 폴링)')+'  ·  시각 KST'+((d.priceLines||[]).length?'  ·  노랑=진입 빨강=손절 초록=익절':'')+((d.markers||[]).length?'  ·  ▲진입/매수 ▼청산':'')+(oscGroups.length?'  ·  보조지표 '+oscGroups.length+'개 패널 분리':'');
  body.innerHTML='';if(_chart){try{_chart.remove()}catch(e){}_chart=null;}
  if(!window.LightweightCharts||!LightweightCharts.CandlestickSeries){document.getElementById('chartTitle').textContent='차트 라이브러리 로드 실패(오프라인?)';return;}
  var nOsc=oscGroups.length;
  var volOn=chartInds.has('volume');
  var nSub=nOsc+(volOn?1:0); // 보조 패널 총수(오실레이터 + 거래량)
  var H=Math.min(820,360+nSub*120); body.style.height=H+'px'; // 보조지표·거래량 패널 수만큼 세로 확장
  var tzShift=isC?32400:0; // 코인=실제 UTC라 +9h 보정, KR=이미 KST벽시계 → 둘 다 KST로 표시
  var chart=LightweightCharts.createChart(body,{width:body.clientWidth,height:H,
    layout:{background:{color:'#0e1320'},textColor:'#c9d2e3',panes:{separatorColor:'#222838',separatorHoverColor:'#3a4254',enableResize:true}},
    grid:{vertLines:{color:'#1a2030'},horzLines:{color:'#1a2030'}},
    localization:{timeFormatter:function(t){return kstFull(t+tzShift)+' KST';}}, // 크로스헤어 시각
    timeScale:{timeVisible:!!d.intraday,borderColor:'#222838',tickMarkFormatter:function(t,type){return type>=3?kstTime(t+tzShift):kstDate(t+tzShift);}}, // 축 눈금(type>=3=시간)
    rightPriceScale:{borderColor:'#222838'}});
  // pane 0 = 가격(캔들 + 오버레이). 시리즈 참조 보관(실시간 갱신용).
  _ovSeries=[];_oscFlat=[];
  var s=chart.addSeries(LightweightCharts.CandlestickSeries,{upColor:'#10b981',downColor:'#f43f5e',borderVisible:false,wickUpColor:'#10b981',wickDownColor:'#f43f5e'},0);
  s.setData(d.bars||[]);
  (d.overlays||[]).forEach(function(o){var ls=chart.addSeries(LightweightCharts.LineSeries,{color:o.color,lineWidth:2,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false},0);ls.setData(o.data||[]);_ovSeries.push(ls);});
  // 보조지표: 그룹(지표)당 별도 패널(pane 1,2,…). 같은 그룹의 선들은 한 패널.
  oscGroups.forEach(function(g,gi){var pane=gi+1;
   (g.series||[]).forEach(function(se,si){var ls=chart.addSeries(LightweightCharts.LineSeries,{color:se.color,lineWidth:1.5,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false},pane);ls.setData(se.data||[]);_oscFlat.push(ls);
    if(si===0&&g.guides)g.guides.forEach(function(gv){ls.createPriceLine({price:gv,color:'#3a4254',lineWidth:1,lineStyle:1,axisLabelVisible:false});});});});
  // 거래량 패널: 오실레이터 다음 마지막 pane에 HistogramSeries(봉색=상승/하락). bars.volume 직접 렌더(서버 변경 없음).
  _volSeries=null;
  if(volOn){var vpane=oscGroups.length+1;try{var vs=chart.addSeries(LightweightCharts.HistogramSeries,{priceFormat:{type:'volume'},priceLineVisible:false,lastValueVisible:false},vpane);vs.priceScale().applyOptions({scaleMargins:{top:0.8,bottom:0}});vs.setData(volData(d.bars||[]));_volSeries=vs;}catch(e){_volSeries=null;}}
  // 패널 높이 비율: 가격 패널을 크게(3), 보조 패널은 각 1.
  try{var panes=chart.panes();if(panes&&panes.length){panes[0].setStretchFactor(3);for(var pi=1;pi<panes.length;pi++)panes[pi].setStretchFactor(1);}}catch(e){}
  (d.priceLines||[]).forEach(function(pl){s.createPriceLine({price:pl.price,color:pl.color,lineWidth:1,lineStyle:2,axisLabelVisible:true,title:pl.title});});
  _markersPrim=null;try{_markersPrim=LightweightCharts.createSeriesMarkers(s,d.markers||[])}catch(e){}
  chart.timeScale().fitContent();_chart=chart;_priceSeries=s;
  _clickHandler=onChartClick;chart.subscribeClick(_clickHandler); // 클릭→드로잉(모드 none이면 무시)
  _pendingTrend=null;redrawDrawings(); // 재생성된 차트에 기존 드로잉 복원
  // 실시간: 코인=바이낸스 kline WS, KR(키움/한투)=getCandles 폴링(WS 없음). 둘 다 refreshSeries로 갱신(무깜빡).
  closeKline();clearChartPoll();
  if(isC)setupKline(d.symbol,d.interval);
  else _chartPoll=setInterval(refreshSeries,20000); // KR 실시간 근사(20초마다 키움 차트 재요청). 429 회피용 간격.
 }).catch(function(){document.getElementById('chartTitle').textContent='차트 오류(네트워크)';});}
function closeChart(){document.getElementById('chartModal').style.display='none';closeKline();clearChartPoll();if(_chart&&_clickHandler){try{_chart.unsubscribeClick(_clickHandler)}catch(e){}}_clickHandler=null;_drawings=[];_pendingTrend=null;_drawLoadedFor=null;_drawMode='none';_priceSeries=null;_ovSeries=[];_oscFlat=[];_markersPrim=null;_volSeries=null;if(_chart){try{_chart.remove()}catch(e){}_chart=null;}document.getElementById('chartBody').innerHTML='';}
function card(r){var b=r.b,live=b.mode==='live',open=expanded.has(b.id),rp=r.rp;
 var wr=b.winRate!=null?', '+b.closes+'번 중 '+Math.round(b.winRate*b.closes/100)+'번 수익':'';
 var earn=b.closes>0?'<div class="earn '+(rp>=0?'up':'dn')+'">💰 지금까지 '+signed(rp,r.ccy)+' '+(rp>=0?'벌었어요':'잃었어요')+' <span class="hint">('+b.closes+'번 거래'+wr+')</span></div>':'';
 var tags=(live?'<span class="st live">실거래</span>':'<span class="st stop">모의</span>')+
   '<span class="st '+(b.status==='running'?'run':'stop')+'">'+(b.status==='running'?'작동중':'멈춤')+'</span>'+
   (b.isScanner?'<span class="st sc">자동선별</span>':'');
 var acts=b.activity.slice(0,2).map(function(a){return '<div><span class="a">'+(ACT[a.action]||esc(a.action))+'</span><span>'+esc((a.detail||'').replace(/\[페이퍼\]|\[실거래\]/g,''))+'</span></div>'}).join('');
 var el=document.createElement('div');el.className='card';
 el.innerHTML='<div class="row"><div><span class="sym">'+esc(b.name)+'</span> '+statusPill(r.bsum,r.ps.length)+'</div></div>'+
  '<div class="tags">'+tags+'</div>'+
  '<div class="plain">📋 '+esc(b.plain)+'</div>'+
  '<div class="plist">'+r.body+'</div>'+earn+
  (acts?'<div class="act">'+acts+'</div>':'')+
  '<div class="cbtn" data-id="'+esc(b.id)+'" onclick="openChart(this.dataset.id)">📈 차트 보기</div>'+
  '<div class="more" data-id="'+esc(b.id)+'" onclick="tgl(this)">'+(open?'간단히 ▴':'전략 자세히 ▾')+'</div>'+
  '<div class="strat" style="display:'+(open?'block':'none')+'">'+detailHtml(b)+'</div>';
 return el;}
function render(){var pos=document.getElementById('pos');pos.innerHTML='';
 var rows=bots.map(function(b){var ccy=ccyOf(b.broker);var ps=b.positions||[];var body='',bsum=0,n=0;
  if(ps.length){for(const p of ps){var r=posRow(p,ccy);bsum+=r.abs;n++;body+=r.html;}}
  else body='<div class="prow" style="color:#8a94a6">지금은 대기 중이에요 (가진 것 없음)</div>';
  return {b:b,ccy:ccy,ps:ps,body:body,bsum:bsum,n:n,rp:b.realizedPnl||0,cap:(b.detail&&b.detail.capital)||0};});
 var acc={USD:{cap:0,unr:0,real:0,n:0},KRW:{cap:0,unr:0,real:0,n:0}};
 rows.forEach(function(r){var a=acc[r.ccy];a.cap+=r.cap;a.unr+=r.bsum;a.real+=r.rp;a.n++;});
 var BK={binance:{label:'💰 Binance',sub:'암호화폐·USDT'},kiwoom:{label:'🏦 키움증권',sub:'주식·KRW(모의)'},kis:{label:'🏦 한국투자증권',sub:'주식·KRW'}};
 var brokers=[];rows.forEach(function(r){if(brokers.indexOf(r.b.broker)<0)brokers.push(r.b.broker);});
 var posCount=0;
 for(const bk of brokers){var gr=rows.filter(function(r){return r.b.broker===bk});if(!gr.length)continue;
  var ccy=gr[0].ccy,meta=BK[bk]||{label:bk,sub:''},ac=accounts[bk];
  var unr=0,real=0,cap=0;gr.forEach(function(r){unr+=r.bsum;real+=r.rp;cap+=r.cap;});
  var balHtml;
  if(ac&&ac.ok){balHtml='잔고 <b>'+money(ac.cashBalance||ac.totalAsset,ccy)+'</b> <span class="hint">예수금'+(ac.totalAsset?'+평가 '+money((ac.cashBalance||0)+(ac.totalAsset||0),ccy):'')+'</span>';}
  else{balHtml='<span class="hint">잔고 미연동('+((ac&&ac.error)||'키 없음')+') · 투입자본 '+money(cap,ccy)+'</span>';}
  var hd=document.createElement('div');hd.className='sect';
  hd.innerHTML='<span class="sect-t">'+meta.label+' <span class="sect-s">'+meta.sub+'</span></span>'+
   '<span class="sect-m">'+balHtml+' · 평가손익 '+plspan(unr,ccy)+' · 확정 '+plspan(real,ccy)+'</span>';
  pos.appendChild(hd);
  for(const r of gr){posCount+=r.n;pos.appendChild(card(r));}}
 var hasU=acc.USD.n>0,hasK=acc.KRW.n>0;
 var heads=function(u,k){var o=[];if(hasU)o.push(plspan(u,'USD'));if(hasK)o.push(plspan(k,'KRW'));return o.join(' <span class="hint">·</span> ')||'—';};
 document.getElementById('bcnt').textContent=bots.filter(function(b){return b.status==='running'}).length;
 document.getElementById('cnt').textContent=posCount;
 document.getElementById('tot').innerHTML=heads(acc.USD.unr,acc.KRW.unr);
 document.getElementById('rtot').innerHTML=heads(acc.USD.real,acc.KRW.real);
 document.getElementById('empty').style.display=bots.length?'none':'block'}
// ── API 키 설정 패널 (시크릿은 type=password·autocomplete=off, 저장 후 마스킹만 표시·재조회 불가) ──
let setLoaded=false;
function toggleSettings(){const p=document.getElementById('setpanel');const show=p.style.display!=='block';p.style.display=show?'block':'none';if(show&&!setLoaded){loadSettings();}}
function brokerLabel(b){return {binance:'Binance (암호화폐)',kis:'한국투자증권',kiwoom:'키움증권'}[b]||b;}
function loadSettings(){fetch('/api/credentials?token='+TOKEN).then(r=>r.json()).then(d=>{if(!d.ok)return;setLoaded=true;
 document.getElementById('credpath').textContent=d.path;
 const body=document.getElementById('setbody');body.innerHTML='';
 for(const b of Object.keys(d.fields)){const st=d.status[b];
  const sec=document.createElement('div');sec.className='brk';
  const okTxt=st.configured?'<span class="ok">✓ 설정됨</span>':'<span class="no">미설정</span>';
  let h='<div class="brkh"><span>'+esc(brokerLabel(b))+'</span>'+okTxt+'</div>';
  for(const f of d.fields[b]){const cur=st.fields[f.key];const isSet=cur&&cur!=='(none)';
   const ph=f.secret?(isSet?'저장됨: '+esc(cur)+' (바꾸려면 입력)':'입력 안 함'):(isSet?esc(cur):(f.optional?'선택':'입력'));
   h+='<div class="fld"><label>'+esc(f.label)+'</label>'+
      '<input data-key="'+esc(f.key)+'" type="'+(f.secret?'password':'text')+'" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="'+ph+'"></div>';}
  h+='<button class="savebtn" data-broker="'+esc(b)+'">저장</button>';
  sec.innerHTML=h;body.appendChild(sec);
  sec.querySelector('.savebtn').addEventListener('click',()=>saveBroker(b,sec));}
 renderLive(d.live);
});}
function renderLive(live){const box=document.getElementById('setlive');if(!box)return;
 const on=live&&live.masterOn;
 let h='<div class="lh"><span>💸 실거래 모드</span><span class="'+(on?'on':'off')+'">'+(on?'🟢 켜짐(실돈)':'⚪ 꺼짐(연습/페이퍼)')+'</span></div>';
 if(on){
  h+='<div class="lstat">환경 <b>'+esc(live.env)+'</b> · 주문당 최대 <b>'+esc(live.maxNotional)+' USDT</b> · 허용종목 <b>'+esc(live.allowlist)+'</b> · 일일손실 서킷 <b>'+esc(live.dailyLossLimit)+' USDT</b></div>';
  h+='<div class="ld">자비스에게 "실거래 봇 돌려줘"라고 하면 바로 실매매가 나갑니다. 위 한도가 안전장치예요.</div>';
  h+='<button class="livebtn stop" id="livestop">🛑 실거래 끄기(긴급 — 페이퍼로 전환)</button>';
 }else{
  h+='<div class="ld">키를 넣었다면, 아래에서 실거래를 켜면 바로 매매가 시작됩니다. 안전을 위해 한도를 정하세요(비우면 기본 50 USDT).</div>';
  h+='<div class="fld"><label>주문당 최대(USDT)</label><input id="livecap" type="text" inputmode="numeric" autocomplete="off" placeholder="50"></div>';
  h+='<div class="fld"><label>허용 종목</label><input id="liveallow" type="text" autocomplete="off" placeholder="비우면 전체 / 예: BTCUSDT,ETHUSDT"></div>';
  h+='<label class="ld" style="display:flex;gap:7px;align-items:center;cursor:pointer"><input type="checkbox" id="livewd"> 거래소에서 이 키의 <b style="color:#c9d2e3">출금 권한을 껐습니다</b>(거래 권한만). 키 유출 시 자금 보호.</label>';
  h+='<button class="livebtn go" id="livego">💸 실거래 켜기</button>';
 }
 box.innerHTML=h;
 if(on){box.querySelector('#livestop').addEventListener('click',()=>saveLive(false));}
 else{box.querySelector('#livego').addEventListener('click',()=>{
   if(!document.getElementById('livewd').checked){const m=document.getElementById('setmsg');m.className='setmsg err';m.textContent='먼저 거래소에서 출금 권한을 끄고 체크해주세요(실돈 안전).';return;}
   saveLive(true,document.getElementById('livecap').value.trim(),document.getElementById('liveallow').value.trim());});}
}
function saveLive(enable,cap,allow){const msg=document.getElementById('setmsg');msg.className='setmsg';msg.textContent=enable?'실거래 켜는 중…':'페이퍼로 전환 중…';
 const body=enable?{enable:true,maxNotional:cap||'',allowlist:allow||''}:{enable:false};
 fetch('/api/live?token='+TOKEN,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  .then(r=>r.json()).then(d=>{if(d.ok){msg.className='setmsg ok';msg.textContent=enable?'🟢 실거래 ON — 이제 봇이 실매매합니다(한도 보호 적용).':'⚪ 페이퍼로 전환됨(실주문 중단).';renderLive(d.live);}
   else{msg.className='setmsg err';msg.textContent='실패: '+(d.error||'알 수 없음');}})
  .catch(e=>{msg.className='setmsg err';msg.textContent='실패: '+e.message;});}
function saveBroker(b,sec){const updates={};sec.querySelectorAll('input[data-key]').forEach(i=>{const v=i.value.trim();if(v)updates[i.getAttribute('data-key')]=v;});
 const msg=document.getElementById('setmsg');
 if(!Object.keys(updates).length){msg.className='setmsg err';msg.textContent='입력한 값이 없어요.';return;}
 msg.className='setmsg';msg.textContent='저장 중…';
 fetch('/api/credentials?token='+TOKEN,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(updates)})
  .then(r=>r.json()).then(d=>{if(d.ok){msg.className='setmsg ok';msg.textContent='✅ '+d.written+'개 저장 완료. 키는 안전하게 보관돼요(다시 표시 안 됨).';
   sec.querySelectorAll('input[data-key]').forEach(i=>i.value='');setLoaded=false;loadSettings();}
   else{msg.className='setmsg err';msg.textContent='저장 실패: '+(d.error||'알 수 없음');}})
  .catch(e=>{msg.className='setmsg err';msg.textContent='저장 실패: '+e.message;});}
function loadBalances(){fetch('/api/balances?token='+TOKEN).then(function(r){return r.json()}).then(function(d){if(d&&d.accounts){d.accounts.forEach(function(a){accounts[a.broker]=a});render();}}).catch(function(){});}
function loadPrices(){fetch('/api/prices?token='+TOKEN).then(function(r){return r.json()}).then(function(d){if(d&&d.prices){for(const k in d.prices)prices.set(k,d.prices[k]);render();}}).catch(function(){});} // KR 현재가 폴링(~45s) → 카드 평가손익 실값
const es=new EventSource('/events?token='+TOKEN);
es.onmessage=e=>{const s=JSON.parse(e.data);bots=s.bots;document.getElementById('upd').textContent=new Date(s.updatedAt).toLocaleTimeString();subscribe();render()};
render();loadBalances();setTimeout(loadPrices,2500);setInterval(loadBalances,60000);setInterval(loadPrices,45000);
</script></div></body></html>`;
}
