/**
 * dashboard/server.ts — 로컬 실시간 HTML 대시보드(컴패니언 HTTP+SSE). 리서치 권장 (a)안.
 * 보안: 127.0.0.1 바인딩 / 부트스트랩 1회 ?token= → HttpOnly 세션쿠키(qm_sid_<port>, SameSite=Lax, 302로 주소창 토큰 제거) /
 *       `/`(HTML)는 쿠키 전용(무인증 토큰-임베드 서빙 구멍 폐쇄), API는 쿠키+쿼리토큰 듀얼 억셉트(스크립트·curl 호환) /
 *       Host 검증(DNS-rebinding 차단) + POST Origin 정밀검사(포트 포함, CSRF — SameSite는 포트를 무시하므로 보완) /
 *       차트 라이브러리 /vendor 셀프호스팅(서드파티 스크립트 0, unpkg 제거) / 시크릿·토큰 절대 미전송(포지션·플랜만) /
 *       /api/live 켜기=2단계 confirmToken(머니패스와 동일 safety.ts 재사용)+audit, 끄기=1샷(킬스위치 무마찰)+audit.
 *       수동주문(/api/order)은 live-handlers.placeOrder 안전경로만 경유
 *       (liveGate testnet/mock-only·메인넷 마스터스위치 / 노셔널캡·allowlist / 2단계 confirmToken / 감사로그).
 * 페이지가 Binance 공개 WS로 시세를 직접 받아 미실현손익을 클라이언트 계산(대문자 WS키 사용).
 * 잔여위험(문서화): 쿠키는 포트 비스코프 — 같은 127.0.0.1의 다른 포트 (악성)로컬 서버에 qm_sid가 전송될 수 있음.
 *   전제=로컬 공격자(이미 credentials.env 직접 읽기 가능 계층)이고 Origin 포트검사로 역방향 CSRF는 차단 → 수용.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as store from "../store/db.js";
import { BROKER_FIELDS, sanitizeCredentialPost, upsertCredentials, credentialStatus, credentialsPath, enableLive, disableLive, liveSettingsStatus, dataDir, type BrokerKey } from "../setup/credentials.js";
import { fetchKlines, fetchSpotSymbols } from "../data/binance-public.js";
import { marketOverview, portfolioAnalytics, scanUniverse, krMarketOverview, krScan } from "./market-data.js"; // 대시보드 패널: 마켓 오버뷰 / 포트폴리오 / 스캐너 (코인+주식)
import type { RankMetric } from "../core/scanner/rank.js";
import { getAdapter } from "../brokers/index.js";
import { placeOrder, placeProtective, cancelProtective, getProtective, getAccount, getOpenOrders, getOrderStatus, cancelOrderById, getQuote } from "../mcp-server/live-handlers.js"; // 수동주문·OCO보호주문·실계정조회·미체결조회/취소 — 안전경로 재사용
import { saveComposite, createBot, startBot } from "../mcp-server/bot-handlers.js"; // 지정가 봇 생성(검증·게이트·dup·로그 재사용). 순환import은 함수선언 호이스팅으로 안전(런타임 호출만).
import { computePositionDrift } from "../core/execution/reconcile.js"; // 페이퍼 vs 거래소 실보유 드리프트(정보용)
import { detectAlerts, Debouncer, AlertBuffer, type BotAlertView } from "../core/alerts/alerts.js"; // 봇 이벤트 알림 엔진(순수)
import { sendWebhook, validateWebhookUrl } from "../core/alerts/webhook.js"; // Slack/Discord 배달(SSRF 게이트)
import { alertSettingsStatus } from "../setup/credentials.js";
import { orderHash, mintToken, consumeToken, audit, auditFailureCount, lastAuditError, type Broker } from "../brokers/safety.js"; // /api/live 2단계 — 머니패스와 동일 토큰 골격 재사용(신규 안전로직 0)
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
let _server: ReturnType<typeof createServer> | null = null; // stopDashboard용(테스트·graceful)

// 실계정 응답 캐시(거래소 호출 코얼레싱) — /api/account가 매 요청마다 거래소를 때려 레이트리밋 밴나는 것 방지.
// broker별 TTL 캐시 + in-flight 공유(동시 요청 1회 호출). 읽기전용·시크릿 없음이라 캐싱 안전.
const _acctCache = new Map<string, { at: number; payload: string }>();
const _acctInflight = new Map<string, Promise<string>>();
const ACCT_TTL_MS = 15_000;

// ── 알림 엔진(서버 단일 인스턴스) ──────────────────────────────────────────
const _alertBuf = new AlertBuffer(200);
const _alertDebounce = new Debouncer();
let _prevBotViews: BotAlertView[] | null = null;
let _alertTimer: ReturnType<typeof setInterval> | null = null;
const ALERT_DEBOUNCE_MS = 60_000; // 같은 봇·같은 종류는 60s 내 1회만 웹훅(폭주 억제)

/** snapshot 봇 행 → 알림 비교용 뷰(필요 필드만). openCount=열린 포지션 수. */
function toBotViews(bots: ReturnType<typeof snapshot>["bots"]): BotAlertView[] {
  return bots.map((b) => ({
    id: b.id, name: b.name, symbol: b.symbol, status: b.status,
    closes: b.closes, realizedPnl: b.realizedPnl,
    openCount: Array.isArray(b.positions) ? b.positions.length : 0,
  }));
}

/** 5초마다 봇 상태를 비교해 알림 생성 → 버퍼 적재 + (활성 시)디바운스된 웹훅 발사. */
// ── 수동 주문 체결 추적(audit P1-20): /api/order 확정(pending=지정가 접수) 시 등록 → 30s 폴링 →
//    체결/취소를 알림 피드+웹훅으로 통지. 추적 미지원 브로커(KR — getOrderById 미구현)는 등록 시점에 제외.
interface ManualOrderTrack { broker: Broker; market: "spot" | "futures"; symbol: string; orderId: string; side: string; at: number }
const _manualOrders: ManualOrderTrack[] = [];
const MANUAL_MAX_AGE_MS = 48 * 3600_000; // 48h 지나면 추적 포기(메모리 누수 방지)
let _manualTimer: ReturnType<typeof setInterval> | null = null;

function pushManualAlert(level: "info" | "warn", message: string): void {
  const ev = { id: `manual-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, ts: new Date().toISOString(), level, kind: "manual_order", message } as const;
  _alertBuf.push([ev]);
  const enabled = (process.env.ALERT_ENABLED ?? "").trim() === "true";
  const url = (process.env.ALERT_WEBHOOK_URL ?? "").trim();
  if (enabled && url) void sendWebhook(url, [ev]).catch(() => {});
}

async function manualOrderTick(): Promise<void> {
  for (const mo of [..._manualOrders]) {
    const drop = () => { const i = _manualOrders.indexOf(mo); if (i >= 0) _manualOrders.splice(i, 1); };
    if (Date.now() - mo.at > MANUAL_MAX_AGE_MS) { drop(); continue; }
    try {
      const r = await getOrderStatus({ broker: mo.broker, market: mo.market, symbol: mo.symbol, orderId: mo.orderId });
      if (!r.ok) { drop(); continue; }                 // 역쿼리 미지원/키 제거 → 추적 포기(스팸 방지)
      if (!("found" in r) || !r.found || !r.order) { drop(); continue; } // 거래소에 없음(만료 정리 등)
      const o = r.order as { status: string; price: number; executedQty?: number; quantity: number };
      if (o.status === "filled") { pushManualAlert("info", `✅ 수동 ${mo.side === "buy" ? "매수" : "매도"} 체결: ${mo.symbol} ${o.executedQty || o.quantity} @ ${o.price} (주문 ${mo.orderId})`); drop(); }
      else if (o.status === "rejected") { pushManualAlert("warn", `수동 주문 종료(취소/거부): ${mo.symbol} ${mo.side} 주문 ${mo.orderId}`); drop(); }
      // pending → 유지(다음 폴)
    } catch { /* 일시 오류 — 다음 폴 재시도 */ }
  }
}

async function alertTick(): Promise<void> {
  try {
    const views = toBotViews(snapshot().bots);
    const events = detectAlerts(_prevBotViews, views, Date.now(), new Date().toISOString());
    _prevBotViews = views;
    if (events.length === 0) return;
    _alertBuf.push(events); // 피드엔 모든 엣지 이벤트 적재(detectAlerts가 변화시에만 emit → 스팸 없음)
    const enabled = (process.env.ALERT_ENABLED ?? "").trim() === "true";
    const url = (process.env.ALERT_WEBHOOK_URL ?? "").trim();
    if (!enabled || !url) return;
    const now = Date.now();
    const toSend = events.filter((e) => _alertDebounce.shouldSend(`${e.kind}:${e.botId}`, now, ALERT_DEBOUNCE_MS));
    if (toSend.length > 0) await sendWebhook(url, toSend); // 실패는 흡수(로깅 0, URL 시크릿)
  } catch { /* 알림 엔진 장애가 대시보드를 죽이지 않음 */ }
}

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
  binance: "Binance 실시간 시세(WS)", kiwoom: "키움증권 일봉(ka10081) · 시세 지연 가능", kis: "한국투자증권 시세", toss: "토스증권 시세(일봉/분봉)",
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
type IndSpec = { ind: string; period: number; params: number[] }; // params[0]=period(하위호환), 이후=stddev/mult 등
function collectIndicatorSpecs(node: unknown, acc: IndSpec[] = []): IndSpec[] {
  const n = node as Record<string, unknown>;
  if (!n || typeof n !== "object") return acc;
  // 전략 조건의 지표 파라미터를 코어 indicators.ts와 동일 키·순서로 전부 수집 → 차트≡전략(stdDev/multiplier/MACD/stochastic 포함).
  const push = (ind?: string, params?: Record<string, number>) => {
    if (!ind) return; const k = ind.toLowerCase();
    let arr: number[];
    if (k === "bollinger" || k === "bollinger_bands") arr = [params?.period ?? 20, params?.stdDev ?? 2];
    else if (k === "supertrend") arr = [params?.period ?? 10, params?.multiplier ?? 3];
    else if (k === "macd") arr = [params?.fast ?? 12, params?.slow ?? 26, params?.signal ?? 9];
    else if (k === "stochastic") arr = [params?.period ?? 14, params?.dPeriod ?? 3];
    else arr = [params?.period ?? (IND_DEFAULT[k] ?? 14)];
    if (!acc.some((s) => s.ind === k && s.params.join(",") === arr.join(","))) acc.push({ ind: k, period: arr[0], params: arr });
  };
  const c = n.condition as { type?: string; indicator?: string; params?: Record<string, number> } | undefined;
  if (c?.type === "indicator") push(c.indicator, c.params);
  const s = (n.strategy ?? (n.type === "leaf" ? n : null)) as { rules?: { conditions?: { indicator?: string; params?: Record<string, number> }[] }[] } | null;
  for (const r of s?.rules ?? []) for (const cond of r.conditions ?? []) push(cond.indicator, cond.params);
  for (const k of ["thenNode", "elseNode", "then", "else"]) if (n[k]) collectIndicatorSpecs(n[k], acc);
  for (const ch of (Array.isArray(n.children) ? n.children : [])) collectIndicatorSpecs(ch, acc);
  return acc;
}
const seriesAt = (bars: { time: number }[], vals: number[]): ChartPt[] =>
  vals.map((v, i) => ({ time: bars[i].time, value: v })).filter((p) => Number.isFinite(p.value));
// 차트 토글로 켤 수 있는 지표 화이트리스트(임의 입력 차단). 키는 "ind" 또는 "ind:period".
const TOGGLE_INDS = new Set(["sma", "ema", "bollinger", "vwap", "supertrend", "parabolic_sar", "donchian", "ichimoku", "rsi", "macd", "stochastic", "stochastic_rsi", "adx", "atr", "cci", "mfi", "williams_r", "obv", "roc"]);
/** 클라이언트가 보낸 토글 지표 목록(["bollinger","sma:50",...])을 spec으로 파싱. 화이트리스트 외엔 무시. 최대 12개. */
function parseToggleInds(inds?: string[]): IndSpec[] {
  if (!Array.isArray(inds)) return [];
  const out: IndSpec[] = [];
  for (const raw of inds) {
    const parts = String(raw).toLowerCase().split(":");
    const name = parts[0];
    if (!TOGGLE_INDS.has(name)) continue; // 화이트리스트(volume 등 클라전용 키 제외)를 먼저 → 슬롯 낭비 방지
    const params = parts.slice(1).map((x) => Number(x) || 0); // 'ind:p1:p2' → [p1,p2], 빈/NaN=0(기본값 폴백)
    out.push({ ind: name, period: params[0] || 0, params });
    if (out.length >= 12) break; // 화이트 통과분 기준 최대 12개
  }
  return out;
}
// 지표별 기본 기간(buildIndicators의 `p||N` 폴백과 동일). 전략·토글 spec의 '실제 사용 기간' 정규화에 사용.
const IND_DEFAULT: Record<string, number> = { sma: 14, ema: 14, bollinger: 20, vwap: 20, supertrend: 10, donchian: 20, rsi: 14, stochastic: 14, adx: 14, atr: 14, cci: 20, mfi: 14, williams_r: 14, obv: 20, roc: 12 };
const normPeriod = (ind: string, p: number) => (p > 0 ? p : (IND_DEFAULT[ind] ?? 14));
// 멀티파라미터 지표 메타([기본,최소,최대] 배열). [0]=기간 외 추가 파라미터. 클라 IND_PARAM.fields와 값 일치 필수.
const IND_EXTRA: Record<string, { defaults: number[]; min: number[]; max: number[] }> = {
  bollinger: { defaults: [20, 2], min: [2, 0.5], max: [200, 5] },       // period, stdDev
  supertrend: { defaults: [10, 3], min: [2, 0.5], max: [100, 10] },     // period, multiplier
  macd: { defaults: [12, 26, 9], min: [2, 2, 1], max: [100, 200, 100] },// fast, slow, signal
  stochastic: { defaults: [14, 3], min: [2, 1], max: [100, 50] },       // kPeriod, dPeriod
};
// 클라가 보낸 [p1,p2,...]를 지표별 기본/범위로 정규화. 단일파라미터 지표는 [normPeriod] 1개.
function normParams(ind: string, params: number[]): number[] {
  const meta = IND_EXTRA[ind];
  if (!meta) return [Math.min(500, normPeriod(ind, params[0] ?? 0))]; // 단일 파라미터도 상한(500)으로 클램프(견고성/일관성)
  return meta.defaults.map((def, i) => {
    const v = params[i];
    if (typeof v !== "number" || !(v > 0)) return def;
    return Math.min(meta.max[i], Math.max(meta.min[i], v));
  });
}

/** 봉 + 지표 specs → 가격패널 오버레이 + 보조지표. 전략과 동일 core 함수로 계산(차트≡전략).
 *  거래량 지표(VWAP/MFI/OBV)는 bars.volume 필요. 차트 토글로 켠 지표도 같은 경로로 그림. */
function buildIndicators(bars: { time: number; open: number; high: number; low: number; close: number; volume?: number }[], specs: IndSpec[]) {
  const closes = bars.map((b) => b.close), highs = bars.map((b) => b.high), lows = bars.map((b) => b.low), vols = bars.map((b) => b.volume ?? 0);
  const overlays: { label: string; color: string; data: ChartPt[] }[] = [];
  // 오실레이터는 "그룹"(=지표 하나)당 별도 패널. 같은 그룹의 여러 선(MACD+Signal)은 한 패널에 함께.
  type OscSeries = { label: string; color: string; data: ChartPt[] };
  const oscGroups: { title: string; guides?: number[]; series: OscSeries[] }[] = [];
  const C = ["#eab308", "#38bdf8", "#a855f7", "#f97316", "#22d3ee"]; let ci = 0;
  const seen = new Set<string>();
  for (const sp of specs) {
    const np = normParams(sp.ind, sp.params && sp.params.length ? sp.params : [sp.period]); // 정규화 파라미터(기본/범위 적용)
    const key = `${sp.ind}:${np.join(":")}`; if (seen.has(key)) continue; seen.add(key); // 파라미터 전체로 dedup(stddev/mult 다르면 별도)
    const color = C[ci++ % C.length], p = np[0];
    switch (sp.ind) {
      // ── 가격패널 오버레이(pane 0) ──
      case "sma": overlays.push({ label: `SMA(${p})`, color, data: seriesAt(bars, sma(closes, p)) }); break;
      case "ema": overlays.push({ label: `EMA(${p})`, color, data: seriesAt(bars, ema(closes, p)) }); break;
      case "bollinger": case "bollinger_bands": { const sd = np[1]; const bb = bollingerBands(closes, p, sd); overlays.push({ label: `BB(${p},${sd})상`, color: "#64748b", data: seriesAt(bars, bb.upper) }, { label: "BB중", color, data: seriesAt(bars, bb.middle) }, { label: "BB하", color: "#64748b", data: seriesAt(bars, bb.lower) }); break; }
      case "vwap": overlays.push({ label: `VWAP(${p})`, color: "#f59e0b", data: seriesAt(bars, vwap(closes, highs, lows, vols, p)) }); break;
      case "supertrend": { const mult = np[1]; overlays.push({ label: `슈퍼트렌드(${p},${mult})`, color: "#34d399", data: seriesAt(bars, supertrend(closes, highs, lows, p, mult)) }); break; }
      case "parabolic_sar": case "parabolicsar": overlays.push({ label: "Parabolic SAR", color: "#c084fc", data: seriesAt(bars, parabolicSar(highs, lows)) }); break;
      case "donchian": { const dc = donchian(highs, lows, p); overlays.push({ label: `돈치안(${p})상`, color: "#64748b", data: seriesAt(bars, dc.upper) }, { label: "돈치안하", color: "#64748b", data: seriesAt(bars, dc.lower) }); break; }
      case "ichimoku": { const ic = ichimoku(highs, lows); overlays.push({ label: "전환선", color: "#38bdf8", data: seriesAt(bars, ic.tenkan) }, { label: "기준선", color: "#f43f5e", data: seriesAt(bars, ic.kijun) }, { label: "선행A", color: "#22c55e", data: seriesAt(bars, ic.senkouA) }, { label: "선행B", color: "#eab308", data: seriesAt(bars, ic.senkouB) }); break; }
      // ── 하단 보조지표(지표당 독립 패널) ──
      case "rsi": oscGroups.push({ title: `RSI(${p})`, guides: [30, 70], series: [{ label: `RSI(${p})`, color, data: seriesAt(bars, rsi(closes, p)) }] }); break;
      case "macd": { const m = macd(closes, np[0], np[1], np[2]); oscGroups.push({ title: `MACD(${np[0]},${np[1]},${np[2]})`, series: [{ label: "MACD", color, data: seriesAt(bars, m.macd) }, { label: "Signal", color: "#f97316", data: seriesAt(bars, m.signal) }] }); break; }
      case "stochastic": { const st = stochastic(closes, highs, lows, np[0], np[1]); oscGroups.push({ title: `Stoch(${np[0]},${np[1]})`, guides: [20, 80], series: [{ label: "Stoch %K", color, data: seriesAt(bars, st.k) }] }); break; }
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
// 캔들 원본(raw) 캐시 — 차트 열기/타임프레임 토글/20초 폴링이 매번 거래소 API를 때리지 않게. 짧은 TTL(현재 봉은 WS·폴링이
// 갱신하므로 약간 stale 허용). 동시 동일요청은 in-flight 공유(폴링+사용자 조작이 겹칠 때 중복 페치 방지). 지표는 캐시 안 함(매번 재계산=빠름).
type RawCandle = { date: string; datetime?: string; open: number; high: number; low: number; close: number; volume?: number };
const _candleCache = new Map<string, { at: number; raw: RawCandle[] }>();
const _candleInflight = new Map<string, Promise<RawCandle[]>>();
const CANDLE_TTL_MS = 8000;
async function cachedRawCandles(key: string, fetcher: () => Promise<RawCandle[]>): Promise<RawCandle[]> {
  const c = _candleCache.get(key);
  if (c && Date.now() - c.at < CANDLE_TTL_MS) return c.raw;
  let inf = _candleInflight.get(key);
  if (!inf) {
    inf = fetcher().then((raw) => { if (raw.length) _candleCache.set(key, { at: Date.now(), raw }); return raw; }).finally(() => _candleInflight.delete(key));
    _candleInflight.set(key, inf);
  }
  return inf;
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
      raw = await cachedRawCandles(`binance:${bot.symbol}:${iv}`, () => fetchKlines(bot.symbol, TF_BINANCE[iv] ?? "1d", iv === "1mo" ? 120 : 200));
    } else {
      const ad = getAdapter(bot.broker as Parameters<typeof getAdapter>[0], "spot")?.adapter as { getCandles?: (s: string, i: string, n: number) => Promise<{ date: string; datetime?: string; open: number; high: number; low: number; close: number; volume?: number }[]> } | undefined;
      if (!ad?.getCandles) return { ok: false, error: `${bot.broker} 차트 데이터 미지원(키 필요할 수 있음)` };
      raw = await cachedRawCandles(`${bot.broker}:${bot.symbol}:${iv}`, () => ad.getCandles!(bot.symbol, iv, 200));
    }
    const bars = raw
      .map((b) => ({ time: toUnix(b.datetime ?? b.date), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }))
      .filter((b) => Number.isFinite(b.time) && b.close > 0)
      .sort((a, b) => a.time - b.time)
      .filter((b, i, arr) => i === 0 || b.time !== arr[i - 1].time);
    const ccy = bot.broker === "binance" ? "USD" : (bot.broker === "toss" && !/^\d{6}$/.test(bot.symbol.trim()) ? "USD" : "KRW"); // 토스 US 티커=USD, 그 외 KRW
    const comp = store.getComposite(bot.composite_strategy_id);
    // 전략이 쓰는 지표(차트≡전략) + 사용자가 차트에서 토글로 켠 지표를 합쳐서 그림.
    const stratSpecs = collectIndicatorSpecs(comp?.root_node ?? {});
    // (종류, 정규화 파라미터) 단위 dedup — buildIndicators seen키와 동일 규약(INV-4). 전략 RSI(14)+토글 RSI(30)·
    // BB(20,2)+BB(20,3)은 다른 키라 둘 다 그림, 전략 RSI(14)+토글 RSI(14)만 1개로 합침.
    const keyOf = (s: IndSpec) => `${s.ind}:${normParams(s.ind, s.params && s.params.length ? s.params : [s.period]).join(":")}`;
    const stratKeys = new Set(stratSpecs.map(keyOf));
    const toggleSpecs = parseToggleInds(inds).filter((s) => !stratKeys.has(keyOf(s)));
    const ind = buildIndicators(bars, [...stratSpecs, ...toggleSpecs]);
    const priceLines = buildPriceLines(bot, comp, ccy);
    const markers = buildMarkers(bot, bars, ccy);
    return { ok: true, symbol: bot.symbol, broker: bot.broker, ccy, interval: iv, intraday, bars, overlays: ind.overlays, oscGroups: ind.oscGroups, priceLines, markers };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "candles 실패" };
  }
}

// 한글 종목명 → 키움 6자리 코드(주요 대형주). 검색창에 "삼성전자"라고 치면(드롭다운이 코인이어도) 자동으로 키움 주식 차트로
// 라우팅. 미수록 종목은 코드 직접입력 안내(정직). 전체 종목명 검색이 필요하면 키움 종목마스터 연동이 후속 과제.
const KR_STOCKS: Record<string, [string, string]> = {
  "삼성전자": ["005930", "삼성전자"], "samsung": ["005930", "삼성전자"], "sk하이닉스": ["000660", "SK하이닉스"], "하이닉스": ["000660", "SK하이닉스"],
  "naver": ["035420", "NAVER"], "네이버": ["035420", "NAVER"], "카카오": ["035720", "카카오"], "카카오뱅크": ["323410", "카카오뱅크"], "카카오페이": ["377300", "카카오페이"],
  "현대차": ["005380", "현대차"], "현대자동차": ["005380", "현대차"], "기아": ["000270", "기아"], "현대모비스": ["012330", "현대모비스"],
  "삼성바이오로직스": ["207940", "삼성바이오로직스"], "셀트리온": ["068270", "셀트리온"], "lg에너지솔루션": ["373220", "LG에너지솔루션"], "엘지에너지솔루션": ["373220", "LG에너지솔루션"],
  "posco홀딩스": ["005490", "POSCO홀딩스"], "포스코홀딩스": ["005490", "POSCO홀딩스"], "포스코": ["005490", "POSCO홀딩스"],
  "kb금융": ["105560", "KB금융"], "신한지주": ["055550", "신한지주"], "하나금융지주": ["086790", "하나금융지주"], "기업은행": ["024110", "기업은행"],
  "삼성sdi": ["006400", "삼성SDI"], "lg화학": ["051910", "LG화학"], "삼성물산": ["028260", "삼성물산"], "lg전자": ["066570", "LG전자"], "삼성전기": ["009150", "삼성전기"],
  "sk이노베이션": ["096770", "SK이노베이션"], "삼성생명": ["032830", "삼성생명"], "삼성화재": ["000810", "삼성화재"], "sk텔레콤": ["017670", "SK텔레콤"], "skt": ["017670", "SK텔레콤"],
  "kt": ["030200", "KT"], "한국전력": ["015760", "한국전력"], "한전": ["015760", "한국전력"], "엔씨소프트": ["036570", "엔씨소프트"], "넷마블": ["251270", "넷마블"],
  "하이브": ["352820", "하이브"], "hybe": ["352820", "하이브"], "크래프톤": ["259960", "크래프톤"], "kt&g": ["033780", "KT&G"], "삼성에스디에스": ["018260", "삼성SDS"], "삼성sds": ["018260", "삼성SDS"],
  "대한항공": ["003490", "대한항공"], "hmm": ["011200", "HMM"], "lg": ["003550", "LG"],
};
/** 입력이 한글 종목명이면 [코드, 표시명] 반환(공백제거+소문자 정규화). 코인 티커/숫자코드/미수록 한글은 null. */
function resolveKrStock(input: string): [string, string] | null {
  const norm = (input || "").trim().replace(/\s+/g, "").toLowerCase();
  if (!norm) return null;
  return KR_STOCKS[norm] ?? KR_STOCKS[(input || "").trim()] ?? null;
}

/** 임의 broker+symbol 차트(검색·워치리스트용). 봇/전략 무관 → 전략 오버레이·진입선·마커 없음, 차트 토글 지표만. 읽기전용.
 *  클라가 openChart("sym:BROKER:SYMBOL")로 호출 → /api/candles 핸들러가 이 함수로 분기(차트 기계 전체 재사용). */
async function candlesForSymbol(broker: string, symbol: string, tf?: string, inds?: string[]): Promise<{ ok: boolean; symbol?: string; name?: string; broker?: string; ccy?: string; interval?: string; intraday?: boolean; bars?: { time: number; open: number; high: number; low: number; close: number }[]; overlays?: unknown[]; oscGroups?: unknown[]; priceLines?: unknown[]; markers?: unknown[]; error?: string }> {
  // 한글 종목명 자동 해석: "삼성전자" → 키움 005930(드롭다운이 코인이어도 주식으로 라우팅). 미수록 한글은 코드 안내.
  const kr = resolveKrStock(symbol);
  let bkIn = broker, symIn = symbol; let krName: string | undefined;
  if (kr) { bkIn = "kiwoom"; symIn = kr[0]; krName = kr[1]; }
  else if (/[가-힣]/.test(symbol)) return { ok: false, error: `'${symbol.trim()}' 종목코드를 못 찾았어요 — 위 드롭다운에서 '키움(주식)' 선택 후 6자리 코드(예: 삼성전자=005930) 입력` };
  const bk = bkIn === "kiwoom" || bkIn === "kis" || bkIn === "toss" ? bkIn : "binance";
  const sym = bk === "binance" ? symIn.toUpperCase() : symIn.trim();
  if (!sym) return { ok: false, error: "종목을 입력하세요" };
  const toUnix = (s: string) => Math.floor(Date.parse(s.length === 10 ? s + "T00:00:00Z" : s) / 1000);
  try {
    const iv = (tf && /^(1m|5m|15m|30m|1h|4h|1d|1w|1mo)$/.test(tf)) ? tf : "1d";
    const intraday = /m$/.test(iv) || /h$/.test(iv);
    let raw: { date: string; datetime?: string; open: number; high: number; low: number; close: number; volume?: number }[] = [];
    if (bk === "binance") {
      raw = await cachedRawCandles(`binance:${sym}:${iv}`, () => fetchKlines(sym, TF_BINANCE[iv] ?? "1d", iv === "1mo" ? 120 : 200));
    } else {
      const ad = getAdapter(bk as Parameters<typeof getAdapter>[0], "spot")?.adapter as { getCandles?: (s: string, i: string, n: number) => Promise<{ date: string; datetime?: string; open: number; high: number; low: number; close: number; volume?: number }[]> } | undefined;
      if (!ad?.getCandles) return { ok: false, error: `${bk} 차트 데이터 미지원(키 필요할 수 있음)` };
      raw = await cachedRawCandles(`${bk}:${sym}:${iv}`, () => ad.getCandles!(sym, iv, 200));
    }
    const bars = raw
      .map((b) => ({ time: toUnix(b.datetime ?? b.date), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }))
      .filter((b) => Number.isFinite(b.time) && b.close > 0)
      .sort((a, b) => a.time - b.time)
      .filter((b, i, arr) => i === 0 || b.time !== arr[i - 1].time);
    if (!bars.length) return { ok: false, error: "차트 데이터 없음 — 종목코드를 확인하세요" };
    const ccy = bk === "binance" ? "USD" : (bk === "toss" && !/^\d{6}$/.test(sym.trim()) ? "USD" : "KRW"); // 토스 US 티커=USD, 그 외 KRW
    const ind = buildIndicators(bars, parseToggleInds(inds)); // 전략 없음 → 사용자가 켠 토글 지표만
    return { ok: true, symbol: sym, name: krName, broker: bk, ccy, interval: iv, intraday, bars, overlays: ind.overlays, oscGroups: ind.oscGroups, priceLines: [], markers: [] };
  } catch (e) {
    const m = e instanceof Error ? e.message : "candles 실패";
    if (bk === "binance" && /\b400\b/.test(m)) return { ok: false, error: `'${sym}'를 Binance에서 못 찾았어요 — 코인 티커(예: BTCUSDT)인지 확인하세요. 한국 주식이면 위 드롭다운에서 '키움(주식)' 선택.` };
    return { ok: false, error: m };
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
  return { bots, alerts: _alertBuf.recent(20), updatedAt: new Date().toISOString() };
}

function okHost(req: IncomingMessage): boolean {
  const h = (req.headers.host || "").split(":")[0];
  return h === "127.0.0.1" || h === "localhost";
}

/** 타이밍 안전 문자열 비교(길이 불일치=false, throw 없음). */
function safeEq(a: string, b: string): boolean {
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
}

/** Cookie 헤더에서 name 값 추출(의존성 0). 같은 키 중복 시 첫 값. */
function getCookie(req: IncomingMessage, name: string): string | null {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("="); if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** CSRF 보강: 브라우저가 보낸 Origin은 이 서버의 정확한 로컬 오리진(포트 포함)이어야 함.
 *  Origin 부재(curl/스크립트)는 통과 — 인증은 토큰/쿠키가 담당하므로 권한 상승 아님.
 *  포트까지 보는 이유: SameSite는 포트를 무시(same-site)하므로 127.0.0.1:다른포트 의 악성 로컬 페이지가
 *  Lax 쿠키가 첨부된 POST를 쏠 수 있음 → Origin 포트 불일치로 차단. */
function okOrigin(req: IncomingMessage, port: number): boolean {
  const o = req.headers.origin;
  if (!o) return true;
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
}

// lightweight-charts standalone 번들을 node_modules에서 1회 로드(메모리 캐시) — 외부 CDN 의존 0(공급망/토큰탈취 면 제거).
// exports 맵이 서브패스 resolve를 막으므로(ERR_PACKAGE_PATH_NOT_EXPORTED) package.json 경유로 디렉터리를 찾아 dist 파일을 직접 읽는다.
let _vendorJs: Buffer | null = null;
function vendorChartsJs(): Buffer | null {
  if (_vendorJs) return _vendorJs;
  try {
    const pkg = createRequire(import.meta.url).resolve("lightweight-charts/package.json");
    _vendorJs = readFileSync(join(dirname(pkg), "dist", "lightweight-charts.standalone.production.js"));
  } catch { _vendorJs = null; }
  return _vendorJs;
}

/** 대시보드 토큰·세션을 데이터 디렉터리에 영속화 → 데몬 재시작에도 URL 고정 + 열린 탭 유지(부팅마다 토큰 churn 제거).
 *  127.0.0.1 전용 로컬 대시보드라 영속 토큰이 합리적. chmod 600. 손상/부재 시 재생성. 로테이션=파일 삭제 후 재기동. */
function loadOrCreateDashboardAuth(): { token: string; sessionId: string } {
  const path = join(dataDir(), "dashboard-auth.json");
  try {
    if (existsSync(path)) {
      const j = JSON.parse(readFileSync(path, "utf8")) as { token?: unknown; sessionId?: unknown };
      if (typeof j.token === "string" && /^[0-9a-f]{32}$/.test(j.token) && typeof j.sessionId === "string" && /^[0-9a-f]{32}$/.test(j.sessionId)) return { token: j.token, sessionId: j.sessionId };
    }
  } catch { /* 손상 → 재생성 */ }
  const auth = { token: randomBytes(16).toString("hex"), sessionId: randomBytes(16).toString("hex") };
  try { writeFileSync(path, JSON.stringify(auth) + "\n", { encoding: "utf8" }); chmodSync(path, 0o600); } catch { /* 쓰기 실패 시 이번 세션 한정(비영속)으로라도 동작 */ }
  return auth;
}

export function startDashboard(port = 7788): Promise<{ url: string; port: number }> {
  if (_state) return Promise.resolve({ url: _state.url, port: _state.port });
  // 토큰·세션 분리 유지(토큰 유출≠세션). 영속(부팅마다 고정 = URL 안 바뀜, 열린 탭 유지).
  const { token, sessionId } = loadOrCreateDashboardAuth();
  let actualPort = port; // listen 후 실포트(port 0=에페메랄 지원). 요청은 listen 후에만 도착하므로 핸들러에서 참조 안전.

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!okHost(req)) { res.writeHead(403).end("forbidden host"); return; }
    if (req.method === "POST" && !okOrigin(req, actualPort)) { res.writeHead(403).end("forbidden origin"); return; } // CSRF: 교차출처 POST 차단(SameSite=Lax와 이중)
    const u = new URL(req.url || "/", "http://127.0.0.1");
    const cName = `qm_sid_${actualPort}`; // 포트별 쿠키 이름 — 같은 127.0.0.1 다중 인스턴스의 쿠키 덮어쓰기 방지
    const qTok = u.searchParams.get("token");
    const tokenOk = !!qTok && safeEq(qTok, token);
    const cVal = getCookie(req, cName);
    const cookieOk = !!cVal && safeEq(cVal, sessionId);
    const auth = cookieOk || tokenOk; // API는 듀얼 억셉트: 쿠키(브라우저) + 쿼리토큰(스크립트·curl 호환)

    if (u.pathname === "/") {
      // 부트스트랩: ?token= 제시 → 유효하면 HttpOnly 세션쿠키 발급 + 302로 주소창·이후 히스토리에서 토큰 제거.
      if (qTok !== null) {
        if (!tokenOk) { res.writeHead(401).end("unauthorized"); return; }
        res.writeHead(302, { "set-cookie": `${cName}=${sessionId}; HttpOnly; SameSite=Lax; Path=/`, location: "/", "cache-control": "no-store" });
        res.end(); return;
      }
      // HTML은 쿠키 세션 전용(쿼리토큰 폴백 없음) — 구버전의 '무인증 /가 토큰 임베드 HTML 서빙' 구멍 폐쇄.
      if (!cookieOk) { res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }); res.end("unauthorized — open_dashboard 도구가 알려준 URL(?token=…)로 접속하세요"); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(html()); return;
    }
    if (u.pathname === "/favicon.ico") { res.writeHead(204).end(); return; } // 토큰 불필요(콘솔 401 소거)
    if (u.pathname === "/healthz") {
      // 무인증 헬스체크(audit P0-2): Docker HEALTHCHECK/외부 워치독용. 시크릿·포지션·심볼 등 민감정보 0 —
      //   살아있음 + 가동 봇 수만. 127.0.0.1 바인딩이라 외부 노출 없음(컨테이너 내부/로컬 모니터 전용).
      let running = 0; try { running = store.listRunningBots().length; } catch { /* DB 장애 시에도 200은 내되 -1 */ running = -1; }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, uptimeSec: Math.floor(process.uptime()), runningBots: running }));
      return;
    }
    if (u.pathname === "/vendor/lightweight-charts.standalone.js") {
      // 공개 정적 차트 라이브러리(시크릿 0) — 무인증·고정 경로(트래버설 불가). unpkg 제거=서드파티 스크립트 0.
      const js = vendorChartsJs();
      if (!js) { res.writeHead(404).end("vendor not installed (npm i)"); return; }
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=86400" }); res.end(js); return;
    }
    if (!auth) { res.writeHead(401).end("unauthorized"); return; }

    if (u.pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(snapshot())); return;
    }
    if (u.pathname === "/api/market") { // 마켓 오버뷰. market=kr(키움 대형주, 기본) | crypto(바이낸스)
      const mk = (u.searchParams.get("market") || "kr").toLowerCase();
      const p = mk === "crypto" ? marketOverview().then((ov) => ({ ok: true, market: "crypto", ...ov })) : krMarketOverview().then((ov) => ({ ok: true, ...ov }));
      p.then((r) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(r)); })
        .catch((e) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "err" })); });
      return;
    }
    if (u.pathname === "/api/portfolio") { // 포트폴리오 분석(누적 실현손익 곡선 + 봇별 성과) — 로컬 스토어
      try { const snap = snapshot(); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, ...portfolioAnalytics(snap.bots) })); }
      catch (e) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "err" })); }
      return;
    }
    if (u.pathname === "/api/scan") { // 스캐너(유니버스 일봉 메트릭 랭킹). metric=gapPct|roc|relVolume|rangePct, market=kr|crypto
      const allowed = ["gapPct", "roc", "relVolume", "rangePct"];
      const m = (u.searchParams.get("metric") || "roc").trim();
      const metric = (allowed.includes(m) ? m : "roc") as RankMetric;
      const mk = (u.searchParams.get("market") || "kr").toLowerCase();
      const p = mk === "crypto" ? scanUniverse(metric, 8) : krScan(metric, 8);
      p.then((rows) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, metric, market: mk, rows })); })
        .catch((e) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "err" })); });
      return;
    }
    if (u.pathname === "/api/candles") {
      const indParam = u.searchParams.get("ind"); // 토글로 켠 지표(쉼표구분: "bollinger,vwap,sma:50")
      const indList = indParam ? indParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      const botParam = u.searchParams.get("bot") || "";
      const tf = u.searchParams.get("tf") || undefined;
      // 합성 ID "sym:BROKER:SYMBOL" → 임의 종목 차트(검색·워치리스트). 그 외 = 봇 차트(기존, 변경 없음).
      const symM = /^sym:([a-z]+):(.+)$/i.exec(botParam);
      const cp = symM ? candlesForSymbol(symM[1].toLowerCase(), symM[2], tf, indList) : candlesFor(botParam, tf, indList);
      cp.then((r) => {
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(r));
      }).catch((e) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "err" })); });
      return;
    }
    if (u.pathname === "/api/search") {
      // 종목 검색 자동완성(읽기전용). binance=거래소 심볼 매칭, KR=종목코드 직접입력(심볼마스터 없음).
      if (req.method !== "GET") { res.writeHead(405).end("method not allowed"); return; }
      const sbk = (u.searchParams.get("broker") || "binance").toLowerCase();
      const sq = (u.searchParams.get("q") || "").trim().toUpperCase();
      if (sbk !== "binance") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, symbols: [], note: "한국주식은 종목코드(6자리) 직접 입력" })); return; }
      fetchSpotSymbols().then((all) => {
        let out: string[];
        if (!sq) out = all.filter((s) => /USDT$/.test(s)).slice(0, 20);
        else { const starts = all.filter((s) => s.startsWith(sq)); const incl = all.filter((s) => !s.startsWith(sq) && s.includes(sq)); out = [...starts, ...incl].slice(0, 20); }
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, symbols: out }));
      }).catch((e) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, symbols: [], error: e instanceof Error ? e.message : "err" })); });
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
    if (u.pathname === "/api/account") {
      if (req.method !== "GET") { res.writeHead(405).end("method not allowed"); return; }
      // 거래소 실계정(읽기전용) — getAccount가 liveGate 경유·키/시크릿 미노출. 심볼은 서버가 봇에서만 수집(클라 주입 불가).
      const bk = (u.searchParams.get("broker") || "binance");
      const sendCached = (payload: string) => { res.writeHead(200, { "content-type": "application/json" }); res.end(payload); };
      const cached = _acctCache.get(bk);
      if (cached && Date.now() - cached.at < ACCT_TTL_MS) { sendCached(cached.payload); return; } // TTL 내 → 거래소 미호출
      let inflight = _acctInflight.get(bk); // 동시요청 코얼레싱(거래소 1회만)
      if (!inflight) {
        const accBots = store.listBots().filter((b) => b.broker === bk);
        const market = accBots.some((b) => (store.getComposite(b.composite_strategy_id) as { market?: string } | undefined)?.market === "futures") ? "futures" : "spot";
        const symbols = [...new Set(accBots.map((b) => b.symbol.toUpperCase()))];
        // 페이퍼 보유: base 자산별 합산 qty(position_state open). 드리프트 매칭용.
        const paperByBase = new Map<string, number>();
        for (const b of accBots) {
          const ps = b.position_state as { status?: string; qty?: number } | Record<string, { status?: string; qty?: number }> | null;
          if (!ps || typeof ps !== "object") continue;
          const base = b.symbol.toUpperCase().replace(/USDT$|USDC$|BUSD$/i, "");
          const add = (q?: number) => { if (q && q > 0) paperByBase.set(base, (paperByBase.get(base) || 0) + q); };
          if ((ps as { status?: string }).status === "open") add((ps as { qty?: number }).qty);
          else for (const v of Object.values(ps as Record<string, { status?: string; qty?: number }>)) if (v?.status === "open") add(v.qty);
        }
        // 봇이 실제 거래하는 종목의 base 자산만 — 거래소 실계정엔 무관한 자산이 많다(특히 Binance testnet은
        //   기본 지급 코인·더미 토큰 '这是测试币'·'456' 등을 다 들고 있어 패널이 지저분). 봇 종목만 남겨 깔끔히 + drift도 일관.
        const botBases = new Set(symbols.map((s) => s.replace(/USDT$|USDC$|BUSD$/i, "")));
        const baseOf = (sym: unknown) => String(sym).toUpperCase().replace(/USDT$|USDC$|BUSD$/i, "");
        inflight = getAccount({ broker: bk as Broker, market, symbols }).then((acc) => {
          const positions = acc.ok && Array.isArray(acc.positions) ? acc.positions.filter((p) => botBases.has(baseOf(p.symbol))) : acc.positions;
          let drift: { base: string; localQty: number; exchangeQty: number; severity: string; inSync: boolean }[] = [];
          if (acc.ok && Array.isArray(positions)) {
            const exByBase = new Map<string, number>();
            for (const p of positions) { const k = baseOf(p.symbol); exByBase.set(k, (exByBase.get(k) || 0) + (Number(p.quantity) || 0)); }
            const bases = new Set<string>([...paperByBase.keys(), ...exByBase.keys()]);
            drift = [...bases].map((base) => { const d = computePositionDrift(paperByBase.get(base) || 0, exByBase.get(base) || 0); return { base, localQty: d.localQty, exchangeQty: d.exchangeQty, severity: d.severity, inSync: d.inSync }; }).filter((d) => d.localQty > 0 || d.exchangeQty > 0);
          }
          const payload = JSON.stringify({ ...acc, positions, market, drift });
          _acctCache.set(bk, { at: Date.now(), payload }); // 성공만 캐시(실패는 즉시 재시도 허용)
          return payload;
        }).finally(() => { _acctInflight.delete(bk); });
        _acctInflight.set(bk, inflight);
      }
      inflight.then(sendCached).catch((e) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, configured: true, error: e instanceof Error ? e.message : "err" })); });
      return;
    }
    // 알림: GET=최근 피드 + 설정상태(웹훅 URL 마스킹) / POST=설정 갱신(검증) 또는 테스트 발사.
    if (u.pathname === "/api/alerts") {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, alerts: _alertBuf.recent(50), config: alertSettingsStatus() }));
        return;
      }
      if (req.method === "POST") {
        readJsonBody(req).then(async (body) => {
          // 테스트 발사: 현재 저장된 웹훅으로 샘플 1건(저장값 사용, 본문에 URL 안 받음).
          if (body.test === true) {
            const url = (process.env.ALERT_WEBHOOK_URL ?? "").trim();
            if (!url) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "웹훅 URL 미설정" })); return; }
            const r = await sendWebhook(url, [{ id: "test", ts: new Date().toISOString(), level: "info", kind: "test", message: "quant-mcp 알림 테스트 — 정상 연결" }]);
            res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: r.ok, status: r.status, error: r.error }));
            return;
          }
          // 설정 갱신: 웹훅 URL은 저장 전 SSRF 검증(실패 시 저장 안 함). enabled 토글.
          const updates: Record<string, string> = {};
          if (typeof body.webhookUrl === "string" && body.webhookUrl.trim()) {
            const v = validateWebhookUrl(body.webhookUrl);
            if (!v.ok) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: v.error })); return; }
            updates.ALERT_WEBHOOK_URL = v.url!;
          }
          if (typeof body.enabled === "boolean") updates.ALERT_ENABLED = body.enabled ? "true" : "false";
          if (Object.keys(updates).length > 0) upsertCredentials(updates); // 키 로깅/에코 0
          res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, config: alertSettingsStatus() }));
        }).catch((e) => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "bad request" })); });
        return;
      }
      res.writeHead(405).end("method not allowed"); return;
    }
    if (u.pathname === "/events") {
      if (req.method !== "GET") { res.writeHead(405).end("method not allowed"); return; }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      // SSE 드레인: res.write가 false(클라 백프레셔/느린 소비자)면 다음 틱 스킵 → 버퍼 폭증 방지. close 시 인터벌+드레인 리스너 정리.
      let _busy = false;
      const onDrain = () => { _busy = false; };
      const send = () => { if (_busy) return; const ok = res.write(`data: ${JSON.stringify(snapshot())}\n\n`); if (!ok) { _busy = true; res.once("drain", onDrain); } };
      send();
      const iv = setInterval(send, 5000);
      req.on("close", () => { clearInterval(iv); res.removeListener("drain", onDrain); });
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
          // 라이브 무장 키(LIVE_TRADING_ENABLED/캡/allowlist/일일손실)는 /api/credentials로 설정 금지 — 2단계 confirmToken+audit를
          //   강제하는 /api/live 전용(저권한 자격증명 POST로 메인넷 무장·캡 부풀리기 권한상승 차단, 적대검증). sanitizeCredentialPost가 드롭.
          const updates = sanitizeCredentialPost(body);
          const { written } = upsertCredentials(updates); // 키값 로깅/에코 안 함
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, written: written.length, status: credentialStatus(), live: liveSettingsStatus() })); // 마스킹 상태만 반환
        }).catch((e) => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "bad request" })); });
        return;
      }
      res.writeHead(405).end("method not allowed"); return;
    }
    // 라이브 모드: 켜기=머니패스와 동일 2단계 confirmToken(프리뷰→확정, 5분 TTL·단일사용·인자 해시 바인딩) / 끄기=긴급 정지라 1샷(킬스위치에 마찰 금지). 양쪽 audit.
    // 과거 fail-open(빈 바디=켜짐) 제거 — enable:true|false 명시 필수.
    if (u.pathname === "/api/live") {
      if (req.method !== "POST") { res.writeHead(405).end("method not allowed"); return; }
      readJsonBody(req).then((body) => {
        const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
        if (body.enable === false) {
          disableLive();
          audit({ event: "live_toggle", action: "disable", via: "dashboard" });
          send(200, { ok: true, phase: "executed", live: liveSettingsStatus() }); return;
        }
        if (body.enable !== true) { send(400, { ok: false, error: "enable:true|false 명시 필요(빈 바디로 켜지지 않음 — fail-closed)" }); return; }
        const maxNotional = typeof body.maxNotional === "string" ? body.maxNotional : "";
        const allowlist = typeof body.allowlist === "string" ? body.allowlist : "";
        const brokerAllowlist = typeof body.brokerAllowlist === "string" ? body.brokerAllowlist : ""; // #6 브로커별 옵트인(canary 격리)
        const hash = orderHash({ kind: "live_enable", maxNotional, allowlist, brokerAllowlist }); // 인자 해시 바인딩 — 프리뷰와 다른 인자로 확정 불가
        const ct = typeof body.confirmToken === "string" ? body.confirmToken : undefined;
        if (!ct) {
          send(200, {
            ok: true, phase: "preview", needConfirm: true, confirmToken: mintToken(hash),
            preview: { action: "enable_live", env: liveSettingsStatus().env, maxNotional: maxNotional || "(통화별 기본)", allowlist: allowlist || "(전체 허용)", brokerAllowlist: brokerAllowlist || "(전체 브로커)" },
            note: "⚠️ 실거래 마스터 ON 프리뷰. 동일 인자+confirmToken으로 재호출해야 실제 켜짐(5분 TTL, 단일사용).",
          }); return;
        }
        if (!consumeToken(ct, hash)) { send(200, { ok: false, error: "확인토큰 무효/만료/불일치 → 거절(fail-closed). 프리뷰부터 다시." }); return; }
        enableLive({ maxNotional: maxNotional || undefined, allowlist: allowlist || undefined, brokerAllowlist: brokerAllowlist || undefined });
        audit({ event: "live_toggle", action: "enable", maxNotional: maxNotional || "(default)", allowlist: allowlist || "(all)", brokerAllowlist: brokerAllowlist || "(all)", via: "dashboard" });
        send(200, { ok: true, phase: "executed", live: liveSettingsStatus() });
      }).catch((e) => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "bad request" })); });
      return;
    }
    if (u.pathname === "/api/order") {
      // 수동 주문 — 안전로직(liveGate/checkLimits/2단계토큰/audit)은 placeOrder 내부에서만 강제. 여기서 재구현·우회 금지.
      if (req.method !== "POST") { res.writeHead(405).end("method not allowed"); return; }
      readJsonBody(req).then(async (body) => {
        const symbol = typeof body.symbol === "string" ? body.symbol.trim() : "";
        const side = body.side === "buy" || body.side === "sell" ? body.side : null;
        const quantity = Number(body.quantity) > 0 ? Number(body.quantity) : undefined;
        const orderAmount = body.orderAmount != null && Number(body.orderAmount) > 0 ? Number(body.orderAmount) : undefined; // US 금액기반(달러)
        const broker = (typeof body.broker === "string" ? body.broker : "binance") as Broker;
        const market = body.market === "futures" ? "futures" : "spot";
        const type = body.type === "limit" ? "limit" : "market";
        const price = body.price != null && Number(body.price) > 0 ? Number(body.price) : undefined;
        const confirmToken = typeof body.confirmToken === "string" ? body.confirmToken : undefined;
        const fail = (code: number, error: string) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error })); };
        if (!symbol || !side || (!quantity && !orderAmount)) return fail(400, "입력 오류: symbol·side(buy/sell) + (quantity>0 또는 orderAmount>0) 필요");
        if (type === "limit" && !(price && price > 0)) return fail(400, "지정가 주문은 price>0 필요");
        // 서버는 클라가 보낸 가격/노셔널/env를 신뢰하지 않음 — placeOrder가 getPrice 재계산+checkLimits+게이트 강제.
        const r = await placeOrder({ broker, market, symbol, side, type, quantity, price, orderAmount, confirmToken });
        // 지정가 접수(pending) 확정 시 체결 추적 등록(P1-20) — 30s 폴링으로 체결/취소 알림.
        const rr = r as { ok?: boolean; phase?: string; result?: { orderId?: string; status?: string } };
        if (rr.ok && rr.phase === "executed" && rr.result?.orderId && rr.result.status === "pending") {
          _manualOrders.push({ broker, market, symbol, orderId: String(rr.result.orderId), side, at: Date.now() });
        }
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(r));
      }).catch((e) => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "bad request" })); });
      return;
    }
    if (u.pathname === "/api/bot/limit") {
      // 지정가 브래킷 봇 생성·가동(사용자 요구: 대시보드 검색→봇). saveComposite/createBot/startBot 재사용(검증·게이트·dup·로그).
      //   mode=live → start 시 liveGate가 통제(testnet/mock 키만 통과, 메인넷은 마스터스위치). 신규 안전로직 0.
      if (req.method !== "POST") { res.writeHead(405).end("method not allowed"); return; }
      readJsonBody(req).then((body) => {
        const broker = (typeof body.broker === "string" ? body.broker : "binance") as Broker;
        const rawSym = typeof body.symbol === "string" ? body.symbol.trim() : "";
        const symbol = broker === "binance" ? rawSym.toUpperCase() : rawSym;
        const buyPrice = Number(body.buyPrice);
        const qty = Number(body.quantity ?? body.qty);
        const sellPrice = body.sellPrice != null && Number(body.sellPrice) > 0 ? Number(body.sellPrice) : undefined;
        const fail = (code: number, error: string) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error })); };
        if (!symbol || !(buyPrice > 0) || !(qty > 0)) return fail(400, "입력 오류: symbol·buyPrice>0·quantity>0 필요");
        if (body.sellPrice != null && !(sellPrice && sellPrice > 0)) return fail(400, "매도가는 0보다 커야 합니다(비우면 매수전용)");
        const node = { id: `lb-${randomBytes(6).toString("hex")}`, type: "limit_bracket" as const, name: `${symbol} 지정가봇`, symbol, buyPrice, qty, ...(sellPrice ? { sellPrice } : {}) };
        const comp = saveComposite({ name: `${symbol} 지정가 브래킷`, tree: node, symbol, market: "spot" }) as { ok?: boolean; compositeStrategyId?: string; error?: string };
        if (!comp.ok || !comp.compositeStrategyId) return fail(400, comp.error || "전략 저장 실패");
        const bot = createBot({ name: node.name, compositeStrategyId: comp.compositeStrategyId, symbol, mode: "live", broker, intervalSeconds: 30 }) as { ok?: boolean; botId?: string; error?: string; note?: string };
        if (!bot.ok || !bot.botId) return fail(400, bot.error || "봇 생성 실패");
        const started = startBot({ botId: bot.botId }) as { ok?: boolean; note?: string; error?: string };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, botId: bot.botId, started: !!started.ok, note: (started.ok ? started.note : started.error) || bot.note }));
      }).catch((e) => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "bad request" })); });
      return;
    }
    if (u.pathname === "/api/audit-health") {
      // 감사로그 무결성 모니터(audit P1-24, 읽기전용). 시크릿 0 — 실패 카운트·마지막 에러만.
      if (req.method !== "GET") { res.writeHead(405).end("method not allowed"); return; }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, failures: auditFailureCount(), lastError: lastAuditError() || null, haltEnforced: (process.env.AUDIT_FAILURE_HALT || "").trim() === "true", timestamp: new Date().toISOString() }));
      return;
    }
    if (u.pathname === "/api/quote") {
      // 수동주문 입력 보조(현재가/가용잔고/보유) — 읽기전용. 잘못된 심볼은 에러 메시지로 검증 대체.
      if (req.method !== "GET") { res.writeHead(405).end("method not allowed"); return; }
      const qb = (u.searchParams.get("broker") || "binance") as Broker;
      const qs = (u.searchParams.get("symbol") || "").trim();
      if (!qs) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "symbol 필요" })); return; }
      getQuote({ broker: qb, market: "spot", symbol: qs }).then((r) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(r)); })
        .catch((e) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "err" })); });
      return;
    }
    if (u.pathname === "/api/trades") {
      // 전 봇 체결 내역(audit P1-18). 기간 필터: ?days=1|7|30 (미지정=전체, 최대 500건).
      if (req.method !== "GET") { res.writeHead(405).end("method not allowed"); return; }
      const days = parseInt(u.searchParams.get("days") || "", 10);
      const since = Number.isFinite(days) && days > 0 ? new Date(Date.now() - days * 86400_000).toISOString() : undefined;
      try {
        const trades = store.listTradesAll(500, since);
        res.writeHead(200, { "content-type": "application/json" });
        // 정직 고지: 수수료는 체결 응답에 미수집(거래소 명세서가 권위) — fee 열 없음.
        res.end(JSON.stringify({ ok: true, trades, note: "수수료는 미수집(거래소 명세서 참조). pnl=평단 대비 실현손익." }));
      } catch (e) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "err" })); }
      return;
    }
    if (u.pathname === "/api/orders") {
      // 미체결(상주) 주문 목록(audit P1-19). 봇 종목 + 수동주문 추적 종목을 합쳐 조회. 현재 Binance만(KR은 미지원 표기).
      if (req.method !== "GET") { res.writeHead(405).end("method not allowed"); return; }
      const bk = (u.searchParams.get("broker") || "binance") as Broker;
      (async () => {
        const market: "spot" | "futures" = "spot";
        const syms = new Set<string>(store.listBots().filter((b) => b.broker === bk && !((store.getComposite(b.composite_strategy_id)?.root_node as { type?: string })?.type === "scanner")).map((b) => b.symbol.toUpperCase()));
        for (const mo of _manualOrders) if (mo.broker === bk) syms.add(mo.symbol.toUpperCase());
        const orders: unknown[] = []; let unsupported: string | null = null;
        for (const sym of syms) {
          const r = await getOpenOrders({ broker: bk, market, symbol: sym });
          if (!r.ok) { unsupported = (r as { error?: string }).error ?? "조회 실패"; continue; }
          for (const o of (r as { orders: { orderId: string; side: string; quantity: number; price: number; status: string; timestamp: unknown }[] }).orders) {
            orders.push({ ...o, symbol: sym, broker: bk });
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, broker: bk, orders, tracking: _manualOrders.length, unsupported }));
      })().catch((e) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "err" })); });
      return;
    }
    if (u.pathname === "/api/orders/cancel") {
      // 미체결 주문 개별 취소(audit P1-19) — live-handlers.cancelOrderById(감사로그 포함) 경유.
      if (req.method !== "POST") { res.writeHead(405).end("method not allowed"); return; }
      readJsonBody(req).then(async (body) => {
        const broker = (typeof body.broker === "string" ? body.broker : "binance") as Broker;
        const symbol = typeof body.symbol === "string" ? body.symbol.trim() : "";
        const orderId = typeof body.orderId === "string" || typeof body.orderId === "number" ? String(body.orderId) : "";
        if (!symbol || !orderId) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "symbol·orderId 필요" })); return; }
        const r = await cancelOrderById({ broker, market: "spot", symbol, orderId });
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(r));
      }).catch((e) => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "bad request" })); });
      return;
    }
    if (u.pathname === "/api/protect") {
      // OCO 보호주문(익절+손절 묶음). 안전로직은 placeProtective 내부에서만 강제(우회·재구현 금지).
      // GET=심볼별 상주 OCO + 실보유 조회(세션 간 상태 복원·페이퍼봇 분기). POST=미리보기→확정.
      if (req.method === "GET") {
        const sym = (u.searchParams.get("symbol") || "").trim();
        const bk = (u.searchParams.get("broker") || "binance") as Broker;
        if (!sym) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, active: false })); return; }
        getProtective({ broker: bk, symbol: sym }).then((r) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(r)); })
          .catch((e) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, active: false, error: e instanceof Error ? e.message : "err" })); });
        return;
      }
      if (req.method !== "POST") { res.writeHead(405).end("method not allowed"); return; }
      readJsonBody(req).then(async (body) => {
        const symbol = typeof body.symbol === "string" ? body.symbol.trim() : "";
        const quantity = Number(body.quantity);
        const takeProfitPrice = Number(body.takeProfitPrice);
        const stopPrice = Number(body.stopPrice);
        const stopLimitPrice = body.stopLimitPrice != null && Number(body.stopLimitPrice) > 0 ? Number(body.stopLimitPrice) : undefined;
        const broker = (typeof body.broker === "string" ? body.broker : "binance") as Broker;
        const confirmToken = typeof body.confirmToken === "string" ? body.confirmToken : undefined;
        if (!symbol || !(quantity > 0) || !(takeProfitPrice > 0) || !(stopPrice > 0)) {
          res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "입력 오류: symbol·quantity>0·takeProfitPrice>0·stopPrice>0 필요" })); return;
        }
        // 서버는 클라 가격/수량/env 불신 — placeProtective가 getPositions(실보유)+getPrice(방향)+checkLimits 강제.
        const r = await placeProtective({ broker, symbol, quantity, takeProfitPrice, stopPrice, stopLimitPrice, confirmToken });
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(r));
      }).catch((e) => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "bad request" })); });
      return;
    }
    if (u.pathname === "/api/protect/cancel") {
      if (req.method !== "POST") { res.writeHead(405).end("method not allowed"); return; }
      readJsonBody(req).then(async (body) => {
        const symbol = typeof body.symbol === "string" ? body.symbol.trim() : "";
        const orderListId = typeof body.orderListId === "string" ? body.orderListId : String(body.orderListId ?? "");
        const broker = (typeof body.broker === "string" ? body.broker : "binance") as Broker;
        if (!symbol || !orderListId) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "symbol·orderListId 필요" })); return; }
        const r = await cancelProtective({ broker, symbol, orderListId });
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(r));
      }).catch((e) => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "bad request" })); });
      return;
    }
    res.writeHead(404).end("not found");
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      actualPort = addr && typeof addr === "object" ? addr.port : port; // port 0(에페메랄) 지원 — 쿠키 이름·Origin 검사도 실포트 기준
      const url = `http://127.0.0.1:${actualPort}/?token=${token}`;
      _state = { url, port: actualPort, token };
      _server = server;
      if (!_alertTimer) { _prevBotViews = toBotViews(snapshot().bots); _alertTimer = setInterval(() => { void alertTick(); }, 5000); _alertTimer.unref?.(); } // 알림 엔진 시동(기준선 선적재)
      if (!_manualTimer) { _manualTimer = setInterval(() => { void manualOrderTick(); }, 30_000); _manualTimer.unref?.(); } // 수동주문 체결 추적(P1-20)
      resolve({ url, port: actualPort });
    });
  });
}

/** 대시보드 정지(테스트·graceful 용). SSE 등 활성 연결도 끊고 닫는다. 프로덕션 경로에선 호출되지 않음. */
export async function stopDashboard(): Promise<void> {
  if (_alertTimer) { clearInterval(_alertTimer); _alertTimer = null; }
  _prevBotViews = null;
  const srv = _server;
  _server = null; _state = null;
  if (srv) { srv.closeAllConnections?.(); await new Promise<void>((resolve) => { srv.close(() => resolve()); }); }
}

function html(): string {
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
.obar{display:flex;gap:8px;margin-top:8px}.obtn{flex:1;text-align:center;font-size:12px;font-weight:700;padding:7px 0;border-radius:8px;cursor:pointer;user-select:none}
.obtn.buy{background:rgba(16,185,129,.16);color:#10b981;border:1px solid #1c5a44}.obtn.buy:hover{background:rgba(16,185,129,.28)}
.obtn.sell{background:rgba(244,63,94,.16);color:#f43f5e;border:1px solid #6b2333}.obtn.sell:hover{background:rgba(244,63,94,.28)}
.envb{font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;margin-left:6px}
.envb.safe{background:rgba(122,162,247,.18);color:#7aa2f7}.envb.live{background:rgba(244,63,94,.22);color:#f43f5e}
.obig{background:#7aa2f7;color:#0b0e14;border:0;border-radius:8px;padding:9px 16px;font-weight:700;font-size:13px;cursor:pointer;margin-top:10px}.obig.danger{background:#f43f5e;color:#fff}
.acctpanel{grid-column:1/-1;margin-top:4px;border-color:#2a3550}.acctpanel .k{font-size:13px}
.alertfeed{margin-top:14px}.alertrow{display:flex;gap:8px;align-items:baseline;padding:5px 0;border-top:1px solid #1c2433;font-size:13px}.alertrow:first-child{border-top:0}.alertrow .at{color:#6b7689;font-size:11px;flex:0 0 auto;min-width:58px}.alertrow .am{color:#cfd6e4;flex:1}.alertrow.critical .am{color:#ff6b6b}.alertrow.warn .am{color:#ffc24b}.alertrow .ad{font-size:14px;flex:0 0 auto}.alertempty{color:#6b7689;font-size:13px;padding:6px 0}
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
.htbl{width:100%;border-collapse:collapse;font-size:12px}.htbl th{color:#8a94a6;font-weight:600;text-align:left;padding:6px 8px;border-bottom:1px solid #222838;position:sticky;top:0;background:#141925}.htbl td{padding:6px 8px;border-bottom:1px solid #1a2030}
.hsel{margin-left:auto;background:#0e1320;border:1px solid #222838;border-radius:6px;color:#e6e6e6;padding:4px 8px;font:12px system-ui,sans-serif}
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
.fld input,.fld select{background:#0e1320;border:1px solid #222838;border-radius:6px;color:#e6e6e6;padding:7px 9px;font:13px system-ui,sans-serif;width:100%;box-sizing:border-box}
.fld input:focus,.fld select:focus{outline:none;border-color:#7aa2f7}
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
.searchbar{display:flex;gap:8px;align-items:center;margin:10px 0 8px;flex-wrap:wrap}
.searchbar select,.searchbar input{background:#0e1320;border:1px solid #222838;border-radius:6px;color:#e6e6e6;padding:8px 10px;font:13px system-ui,sans-serif}
.searchbar input{flex:1;min-width:170px}
.searchbar input:focus,.searchbar select:focus{outline:none;border-color:#7aa2f7}
.searchbar .sbtn{background:#22d3ee;color:#0b0e14;border:0;border-radius:6px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer;white-space:nowrap}.searchbar .sbtn:hover{background:#67e8f9}
.watchstrip{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0 0 14px}
.watchstrip .wlbl{font-size:11px;color:#6b7588;margin-right:2px}
.wchip{display:inline-flex;align-items:center;gap:5px;background:#0e1320;border:1px solid #222838;border-radius:6px;padding:3px 7px}
.wchip .wsym{font-size:12px;color:#c9d2e3;cursor:pointer;font-weight:600}.wchip .wsym:hover{color:#22d3ee}
.wchip .wx{font-size:13px;color:#6b7588;cursor:pointer;line-height:1}.wchip .wx:hover{color:#f43f5e}
#chartTrade{gap:8px;align-items:center}
/* ── 업그레이드: 비주얼 폴리시 + 패널 ── */
body{background:radial-gradient(1200px 600px at 20% -10%,#131a2b 0%,#0b0e14 55%),#0b0e14;min-height:100vh}
.wrap{max-width:1100px}
.card{transition:transform .15s ease,border-color .15s ease,box-shadow .15s ease}
.card:hover{border-color:#2c3650}
h1{font-size:20px;letter-spacing:.2px;background:linear-gradient(90deg,#e6e6e6,#9fb2d4);-webkit-background-clip:text;background-clip:text}
@keyframes fadein{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.panel{animation:fadein .4s ease both}
.ph{font-size:13px;font-weight:700;color:#dfe6f1;margin-bottom:10px;display:flex;align-items:center;gap:8px}
.ph .hint{font-weight:400}
/* 마켓 오버뷰 스트립 */
.mstrip{display:flex;gap:8px;flex-wrap:wrap;align-items:stretch;margin:2px 0 14px}
.mchip{flex:1;min-width:120px;background:#121622;border:1px solid #222838;border-radius:10px;padding:9px 11px;cursor:pointer;transition:transform .12s,border-color .12s}
.mchip:hover{transform:translateY(-2px);border-color:#2c3650}
.mchip .ms{font-size:12px;color:#c9d2e3;font-weight:700}
.mchip .mp{font-size:15px;font-weight:700;margin-top:2px}
.mchip .mc{font-size:11px;font-weight:700;margin-top:1px}
.regbadge{display:inline-flex;align-items:center;gap:6px;background:#121622;border:1px solid #222838;border-radius:10px;padding:9px 13px;font-size:12px;font-weight:700;white-space:nowrap}
.regbadge .rl{font-size:13px}
.reg-trend_up{color:#10b981;border-color:#1c5a44}.reg-trend_down{color:#f43f5e;border-color:#6b2333}.reg-range{color:#22d3ee;border-color:#1f4e57}.reg-high_vol{color:#f59e0b;border-color:#6b4a16}
/* 히어로 차트 */
.herocard{margin-bottom:14px;padding:14px 16px}
.herohead{display:flex;align-items:baseline;gap:10px;margin-bottom:8px;flex-wrap:wrap}
.herohead b{font-size:16px}.heropx{font-size:20px;font-weight:800}.herochg{font-size:13px;font-weight:700}
.herotf{margin-left:auto;display:flex;gap:5px}
.herochart{width:100%;height:300px}
/* 2-컬럼 패널 행 */
.prow2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}
@media(max-width:760px){.prow2{grid-template-columns:1fr}}
.lrow{display:flex;justify-content:space-between;align-items:center;padding:8px 8px;border-radius:8px;cursor:pointer;transition:background .12s;border-top:1px solid #1a2030}
.lrow:first-child{border-top:0}.lrow:hover{background:#0e1320}
.lrow .ls{font-weight:700;font-size:13px}.lrow .lsub{font-size:11px;color:#8a94a6;margin-top:1px}
.lrow .lr{text-align:right;font-size:13px;font-weight:700}
.rank{display:inline-block;width:18px;height:18px;line-height:18px;text-align:center;border-radius:5px;background:#1a2030;color:#9fb2d4;font-size:11px;font-weight:700;margin-right:8px}
.scantabs{margin-left:auto;display:flex;gap:4px}
.scantab{font-size:11px;color:#8a94a6;background:#0e1320;border:1px solid #222838;border-radius:5px;padding:2px 7px;cursor:pointer}
.scantab.on{background:#a855f7;color:#0b0e14;border-color:#a855f7;font-weight:700}
.scantab:hover{color:#e6e6e6}
/* KPI 폴리시 */
.hdr .card{position:relative;overflow:hidden}
.hdr .card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:linear-gradient(#7aa2f7,#22d3ee)}
.hdr .card .v{font-variant-numeric:tabular-nums}
/* 자기자본 곡선 */
.eqcard{margin-bottom:14px}.eqchart{width:100%;height:170px}
/* 봇 성과 미니카드 */
.botperf{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:14px}
.bpc{background:#0e1320;border:1px solid #222838;border-radius:9px;padding:9px 11px}
.bpc .bn{font-size:12px;font-weight:700;color:#c9d2e3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bpc .bv{font-size:15px;font-weight:800;margin-top:3px}.bpc .bm{font-size:10px;color:#8a94a6;margin-top:2px}
.skel{color:#6b7588;font-size:12px;padding:10px}
.mktoggle{display:inline-flex;gap:4px;background:#0e1320;border:1px solid #222838;border-radius:8px;padding:3px;margin-right:4px}
.mkt{font-size:12px;font-weight:700;color:#8a94a6;padding:5px 11px;border-radius:6px;cursor:pointer;user-select:none}
.mkt:hover{color:#e6e6e6}.mkt.on{background:#7aa2f7;color:#0b0e14}
.mstrip{align-items:center}
</style><script src="/vendor/lightweight-charts.standalone.js"></script></head><body><div class="wrap">
<h1>내 자동매매 현황 <span class="dot"></span></h1>
<div class="sub">봇이 알아서 사고팔아요 · 실시간 시세 반영 <span id="upd" style="color:#8a94a6">—</span>
  <span class="gear" onclick="openManualOrder()">✋ 수동 주문</span>
  <span class="gear" onclick="openHist()">📋 주문/체결</span>
  <span class="gear" onclick="toggleSettings()">⚙️ API 키 설정</span></div>
<div class="searchbar">
  <select id="qbroker" onchange="onQBroker()"><option value="binance">Binance(코인)</option><option value="kiwoom">키움(주식)</option><option value="kis">한투(주식)</option><option value="toss">토스(주식)</option></select>
  <input id="qsym" type="text" autocomplete="off" list="qsymlist" placeholder="종목 검색 — 예: BTCUSDT" oninput="qSuggest()" onkeydown="if(event.key==='Enter')searchChart()">
  <datalist id="qsymlist"></datalist>
  <button class="sbtn" onclick="searchChart()">🔍 차트 보기</button>
</div>
<div class="mstrip panel" id="mstrip"><span class="skel">마켓 불러오는 중…</span></div>
<div class="card herocard panel">
  <div class="herohead"><b id="heroSym">BTCUSDT</b><span class="heropx" id="heroPx">—</span><span class="herochg" id="heroChg"></span>
    <span class="herotf" id="heroTf"></span></div>
  <div class="herochart" id="heroChart"></div>
</div>
<div class="prow2">
  <div class="card panel"><div class="ph">🔥 거래대금 Top 5 <span class="hint">24시간</span></div><div id="topvol"><span class="skel">불러오는 중…</span></div></div>
  <div class="card panel"><div class="ph">🔎 스캐너 <span class="hint">유니버스 일봉 랭킹</span><span class="scantabs" id="scantabs"></span></div><div id="scanbody"><span class="skel">불러오는 중…</span></div></div>
</div>
<div class="watchstrip" id="watchstrip" style="display:none"></div>
<div class="card setpanel" id="setpanel" style="display:none">
  <div class="row"><div><b>거래소 API 키 입력</b> <span class="hint">실거래/모의거래를 하려면 키가 필요해요</span></div>
    <span class="gear" onclick="toggleSettings()">닫기 ✕</span></div>
  <div class="setnote">🔒 키는 이 컴퓨터의 <code id="credpath">~/.quant-mcp/credentials.env</code> 파일에만 저장돼요(소유자 전용). 화면·채팅·인터넷으로 절대 새어나가지 않고, 한 번 저장하면 다시 보이지 않아요(보안). 발급처는 거래소(예: Binance) 설정에서 받으세요.</div>
  <div id="setbody"></div>
  <div id="setlive" class="livebox"></div>
  <div id="setalert" class="livebox"></div>
  <div id="setmsg" class="setmsg"></div>
</div>
<div class="hdr">
  <div class="card"><div class="k">작동 중인 봇 / 보유 중</div><div class="v"><span id="bcnt">0</span><span style="font-size:14px;color:#8a94a6"> / </span><span id="cnt">0</span></div></div>
  <div class="card"><div class="k">지금 손익 <span class="hint">(안 팔았을 때)</span></div><div class="v" id="tot">+0.00</div></div>
  <div class="card"><div class="k">확정 수익 <span class="hint">(이미 번 돈)</span></div><div class="v" id="rtot">+0.00</div></div>
</div>
<div class="card eqcard panel"><div class="ph">📈 누적 실현손익 <span class="hint">전 봇 합산 · 청산 실현 기준</span></div>
  <div class="eqchart" id="eqChart"></div>
  <div class="hint" id="eqEmpty" style="display:none;padding:18px;text-align:center">아직 청산 내역이 없어요 — 봇이 매매를 마치면 곡선이 그려져요.</div></div>
<div class="botperf panel" id="botperf"></div>
<div class="pos" id="pos"></div>
<div class="empty" id="empty">아직 봇이 없어요. 자비스에게 "전략 만들어서 봇 돌려줘"라고 말해보세요.</div>
<div class="card alertfeed" id="alertfeed" style="display:none"><div class="row"><div><b>🔔 알림</b> <span class="hint">봇 이벤트(진입·청산·오류) 실시간</span></div></div><div id="alertlist"></div></div>
<div class="cmodal" id="chartModal"><div class="cmbox">
  <div class="cmhead"><b id="chartTitle">차트</b><span class="cmx" onclick="closeChart()">닫기 ✕</span></div>
  <div class="indbar" id="chartTrade"></div>
  <div class="tfbar" id="chartTf"></div>
  <div class="indbar" id="chartInds"></div>
  <div class="indparams" id="chartIndParams"></div>
  <div class="indbar" id="chartDraw"></div>
  <div class="indbar" id="chartProtect" style="display:none"></div>
  <div id="chartBody"></div>
  <div class="cmnote" id="chartNote"></div>
  <div class="cmnote" id="protectMsg"></div>
</div></div>
<div class="cmodal" id="orderModal"><div class="cmbox" style="width:min(440px,94vw)">
  <div class="cmhead"><b id="orderTitle">주문</b><span class="cmx" onclick="closeOrder()">닫기 ✕</span></div>
  <div id="orderBody"></div>
  <div class="setmsg" id="orderMsg"></div>
</div></div>
<div class="cmodal" id="histModal"><div class="cmbox" style="width:min(720px,96vw)">
  <div class="cmhead"><b>📋 주문/체결</b><span class="cmx" onclick="closeHist()">닫기 ✕</span></div>
  <div class="tfbar" id="histTabs"></div>
  <div id="histBody" style="max-height:62vh;overflow:auto"></div>
  <div class="setmsg" id="histMsg"></div>
</div></div>
<script>
let bots=[];const prices=new Map();let ws=null;var accounts={};var realAccounts={}; // realAccounts[broker]=거래소 실계정 스냅샷(getAccount)
function fmt(n,d=2){return Number(n).toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d})}
function ccyOf(broker,symbol){if(broker==='binance')return 'USD';if(broker==='toss')return (symbol&&!/^[0-9]{6}$/.test(String(symbol).trim()))?'USD':'KRW';return 'KRW'}
function csym(c){return c==='KRW'?'₩':'$'}
function money(n,c){return csym(c)+Math.round(Math.abs(Number(n)||0)).toLocaleString()}
function signed(n,c){var v=Math.round(Number(n)||0);return (v>=0?'+':'-')+csym(c)+Math.abs(v).toLocaleString()}
function plspan(n,c){var v=Math.round(Number(n)||0);return '<span class="'+(v>=0?'up':'dn')+'">'+signed(v,c)+'</span>'}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))} // &<> + 따옴표("·')까지 이스케이프 — 속성 컨텍스트(data-broker 등) 브레이크아웃→저장형 XSS 차단(불신 입력은 모두 esc 경유)
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
// ── 보호주문(OCO) 상태: 차트당. _protect=null이면 비활성(포지션 없음/현물 아님). 클라는 입력·표시만, 안전판정은 서버.
var _protect=null; // {sym,broker,market,ccy,qty,entry,side,tpPrice,slPrice,tpLine,slLine,confirmToken,active,orderListId}
var _protDrag=null; // 'tp'|'sl' 드래그 중이면 해당, 아니면 null
var PROT_TP_PCT=5,PROT_SL_PCT=3; // 기본 익절/손절 %(드래그/입력 전 초기값)
var PROT_HIT_PX=7; // 선 근처 판정 픽셀 임계
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
 fetch('/api/candles?bot='+encodeURIComponent(_chartId)+(_chartTf?'&tf='+_chartTf:'')+indQ).then(function(r){if(r.status===401){sessionLost();throw new Error('session');}return r.json()}).then(function(d){_refreshing=false;if(!d.ok||!_priceSeries)return;
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
// 파라미터를 갖는 지표만 인라인 조정 노출(서버 normParams/IND_EXTRA와 값 일치). fields[i]=i번째 파라미터(0=기간).
// 멀티파라미터: 볼린저(기간+표준편차)·슈퍼트렌드(기간+배수)·MACD(단/장/시그널)·스토캐스틱(K/D). 일목·SAR·StochRSI=고정→조정 안함.
var IND_PARAM={
  sma:{n:'SMA',fields:[{l:'기간',d:50,min:2,max:400}]},
  ema:{n:'EMA',fields:[{l:'기간',d:200,min:2,max:400}]},
  bollinger:{n:'볼린저',fields:[{l:'기간',d:20,min:2,max:200},{l:'표준편차',d:2,min:0.5,max:5,step:0.5}]},
  vwap:{n:'VWAP',fields:[{l:'기간',d:20,min:2,max:200}]},
  supertrend:{n:'슈퍼트렌드',fields:[{l:'기간',d:10,min:2,max:100},{l:'배수',d:3,min:0.5,max:10,step:0.5}]},
  donchian:{n:'돈치안',fields:[{l:'기간',d:20,min:2,max:200}]},
  rsi:{n:'RSI',fields:[{l:'기간',d:14,min:2,max:100}]},
  stochastic:{n:'스토캐스틱',fields:[{l:'K기간',d:14,min:2,max:100},{l:'D기간',d:3,min:1,max:50}]},
  macd:{n:'MACD',fields:[{l:'단기',d:12,min:2,max:100},{l:'장기',d:26,min:2,max:200},{l:'시그널',d:9,min:1,max:100}]},
  adx:{n:'ADX',fields:[{l:'기간',d:14,min:2,max:100}]},
  atr:{n:'ATR',fields:[{l:'기간',d:14,min:2,max:100}]},
  cci:{n:'CCI',fields:[{l:'기간',d:20,min:2,max:200}]},
  mfi:{n:'MFI',fields:[{l:'기간',d:14,min:2,max:100}]},
  williams_r:{n:'윌리엄스%R',fields:[{l:'기간',d:14,min:2,max:100}]},
  obv:{n:'OBV',fields:[{l:'기간',d:20,min:2,max:200}]},
  roc:{n:'ROC',fields:[{l:'기간',d:12,min:2,max:200}]}
};
// 토글키('ind' 또는 'ind:p1:p2:...') → {base, params[], meta}. 누락/0 파라미터는 fields[i].d 기본값. 미지원 지표=null.
function splitIndKey(k){var a=String(k).split(':');var base=a[0];var meta=IND_PARAM[base];if(!meta)return null;
 var params=meta.fields.map(function(f,i){var v=parseFloat(a[i+1]);return (v>0)?v:f.d;});
 return {base:base,params:params,meta:meta};}
// 켜진 지표마다 fields 길이만큼 input 렌더(파라미터 여러개). 미지원/복합 지표는 자동 제외(splitIndKey=null).
function renderIndParams(){var el=document.getElementById('chartIndParams');if(!el)return;var chips=[];
 Array.from(chartInds).forEach(function(k){var s=splitIndKey(k);if(!s)return;
  var inputs=s.meta.fields.map(function(f,i){return f.l+' <input type="number" min="'+f.min+'" max="'+f.max+'" step="'+(f.step||1)+'" value="'+s.params[i]+'" data-base="'+s.base+'" data-idx="'+i+'" data-old="'+k+'" onchange="setIndParams(this)" onkeydown="if(event.key===&quot;Enter&quot;)this.blur()">';}).join(' ');
  chips.push('<span class="pchip" title="'+s.base+' 파라미터"><span>'+s.meta.n+'</span> '+inputs+'</span>');});
 el.innerHTML=chips.length?'<span class="pplbl">파라미터 조정</span>'+chips.join(''):'';}
// 입력 변경 → 옛 키의 전체 파라미터를 읽어 변경된 idx만 교체→정규화 키 'base:p0:p1:...' 재조립→chartInds 교체→저장→차트 재요청.
function setIndParams(inp){var base=inp.dataset.base,oldKey=inp.dataset.old,idx=parseInt(inp.dataset.idx,10),meta=IND_PARAM[base];if(!meta)return;
 var s=splitIndKey(oldKey);if(!s)return;var params=s.params.slice();var f=meta.fields[idx];
 var v=parseFloat(inp.value);if(!(v>0))v=f.d;if(v<f.min)v=f.min;if(v>f.max)v=f.max;params[idx]=v;
 var newKey=base+':'+params.join(':'); // 단일필드면 'base:p0'(하위호환), 멀티면 'base:p0:p1:...'
 if(newKey===oldKey){inp.value=v;return;}
 chartInds.delete(oldKey);chartInds.add(newKey);saveInds();openChart(_chartId,_chartTf);}
function saveInds(){try{localStorage.setItem('qmInds',JSON.stringify(Array.from(chartInds)))}catch(e){}}
// on 판정은 base(콜론 앞) 기준 — 파라미터 조정으로 키가 'sma:80' 등으로 바뀌어도 메뉴 버튼이 켜진 상태 유지.
function indBase(k){return String(k).split(':')[0];}
function indOn(base){return Array.from(chartInds).some(function(x){return indBase(x)===base});}
function renderIndButtons(){document.getElementById('chartInds').innerHTML='<span class="indlbl">지표 추가</span>'+IND_MENU.map(function(m){return '<span class="ib'+(indOn(indBase(m.k))?' on':'')+'" data-k="'+m.k+'" onclick="toggleInd(this.dataset.k)">'+m.n+'</span>'}).join('');renderIndParams();}
// 같은 base가 켜져 있으면(파라미터 변형 포함) 전부 끔, 아니면 메뉴 기본키 추가 → 재클릭 중복 방지.
function toggleInd(k){var base=indBase(k);
 if(indOn(base)){Array.from(chartInds).forEach(function(x){if(indBase(x)===base)chartInds.delete(x);});}
 else{chartInds.add(k);}
 saveInds();openChart(_chartId,_chartTf);}
// 거래량 히스토그램 데이터: 봉 상승/하락에 따라 색(가격패널 캔들색과 동일·반투명). bars[].volume는 서버가 이미 실어 보냄.
function volData(bars){return (bars||[]).map(function(b){return {time:b.time,value:Number(b.volume)||0,color:(b.close>=b.open?'rgba(16,185,129,.45)':'rgba(244,63,94,.45)')};});}
// ── 종목 검색 + 관심종목(워치리스트) + 차트 주문바 ──
var _chartMeta=null,_qTimer=null;
function onQBroker(){var bk=document.getElementById('qbroker').value;document.getElementById('qsymlist').innerHTML='';document.getElementById('qsym').placeholder=bk==='binance'?'종목 검색 — 예: BTCUSDT':'종목코드 — 예: 005930';}
function qSuggest(){var bk=document.getElementById('qbroker').value;if(bk!=='binance')return;var q=document.getElementById('qsym').value.trim();if(_qTimer)clearTimeout(_qTimer);
 _qTimer=setTimeout(function(){fetch('/api/search?broker=binance&q='+encodeURIComponent(q)).then(function(r){return r.json()}).then(function(d){if(!d||!d.ok)return;document.getElementById('qsymlist').innerHTML=(d.symbols||[]).map(function(s){return '<option value="'+esc(s)+'"></option>';}).join('');}).catch(function(){});},200);}
function searchChart(){var bk=document.getElementById('qbroker').value;var sym=document.getElementById('qsym').value.trim();if(bk==='binance')sym=sym.toUpperCase();if(!sym)return;openChart('sym:'+bk+':'+sym);}
function getWatch(){try{return JSON.parse(localStorage.getItem('qmWatch')||'[]')}catch(e){return [];}}
function setWatch(w){try{localStorage.setItem('qmWatch',JSON.stringify(w))}catch(e){}}
function isWatched(b,s){return getWatch().some(function(x){return x.b===b&&x.s===s;});}
function toggleWatch(b,s){var w=getWatch();var i=-1;for(var k=0;k<w.length;k++)if(w[k].b===b&&w[k].s===s){i=k;break;}if(i>=0)w.splice(i,1);else w.push({b:b,s:s});setWatch(w);renderWatch();if(_chartMeta)renderChartTrade(_chartMeta.broker,_chartMeta.symbol,_chartMeta.ccy);}
function renderWatch(){var el=document.getElementById('watchstrip');if(!el)return;var w=getWatch();if(!w.length){el.style.display='none';el.innerHTML='';return;}el.style.display='flex';
 el.innerHTML='<span class="wlbl">⭐ 관심종목</span>'+w.map(function(x){return '<span class="wchip"><span class="wsym" data-b="'+esc(x.b)+'" data-s="'+esc(x.s)+'" onclick="openWatch(this)">'+esc(coin(x.s))+'</span><span class="wx" data-b="'+esc(x.b)+'" data-s="'+esc(x.s)+'" onclick="rmWatch(this)">×</span></span>';}).join('');}
function openWatch(el){openChart('sym:'+el.dataset.b+':'+el.dataset.s);}
function rmWatch(el){toggleWatch(el.dataset.b,el.dataset.s);}
// 차트 상단 주문바: 현재 차트 종목으로 즉시 매수/매도(기존 주문모달·안전게이트 재사용) + 관심종목 토글. 봇·검색 차트 공용.
function renderChartTrade(broker,symbol,ccy){_chartMeta=(broker&&symbol)?{broker:broker,symbol:symbol,ccy:ccy}:null;var bar=document.getElementById('chartTrade');if(!bar)return;
 if(!broker||!symbol){bar.style.display='none';bar.innerHTML='';return;}
 var w=isWatched(broker,symbol);bar.style.display='flex';
 bar.innerHTML='<span class="obtn buy" data-side="buy" data-broker="'+esc(broker)+'" data-market="spot" data-sym="'+esc(symbol)+'" data-ccy="'+esc(ccy||'')+'" onclick="openOrder(this)">매수</span>'+
  '<span class="obtn sell" data-side="sell" data-broker="'+esc(broker)+'" data-market="spot" data-sym="'+esc(symbol)+'" data-ccy="'+esc(ccy||'')+'" onclick="openOrder(this)">매도</span>'+
  '<span class="ib'+(w?' on':'')+'" data-b="'+esc(broker)+'" data-s="'+esc(symbol)+'" onclick="toggleWatch(this.dataset.b,this.dataset.s)">'+(w?'★ 관심종목':'☆ 관심추가')+'</span>'+
  '<span class="ib" data-b="'+esc(broker)+'" data-s="'+esc(symbol)+'" data-c="'+esc(ccy||'')+'" onclick="openLimitBot(this.dataset.b,this.dataset.s,this.dataset.c)">🤖 지정가봇</span>';}
// 지정가 봇 만들기 — 매수가 도달 시 자동 매수 →(매도가 입력 시) 자동 매도. 장 열릴 때마다 미체결 재주문, 매도 완료 시 자동 종료. (모의/testnet)
function openLimitBot(broker,symbol){var m=document.getElementById('orderModal');var msg=document.getElementById('orderMsg');msg.textContent='';msg.className='setmsg';
 document.getElementById('orderTitle').innerHTML='🤖 '+esc(coin(symbol))+' 지정가 봇';
 document.getElementById('orderBody').innerHTML=
  '<div class="hint" style="margin:2px 0 8px">매수가에 도달하면 <b>자동 매수</b> →(매도가 입력 시) <b>자동 매도</b>. 장 열릴 때마다 미체결분 재주문, 매도 완료 시 자동 종료. <b>모의/테스트넷</b>.</div>'+
  '<div class="fld"><label>매수 지정가</label><input id="lbBuy" type="text" inputmode="decimal" autocomplete="off" placeholder="이 가격이 되면 매수"></div>'+
  '<div class="fld"><label>수량</label><input id="lbQty" type="text" inputmode="decimal" autocomplete="off" placeholder="주식=정수 / 코인=소수"></div>'+
  '<div class="fld"><label>매도 지정가 <span class="hint">(선택)</span></label><input id="lbSell" type="text" inputmode="decimal" autocomplete="off" placeholder="비우면 매수만(보유 유지)"></div>'+
  '<button class="obig" data-b="'+esc(broker)+'" data-s="'+esc(symbol)+'" onclick="submitLimitBot(this.dataset.b,this.dataset.s)">🤖 지정가 봇 만들기</button>';
 m.style.display='flex';}
function submitLimitBot(broker,symbol){var msg=document.getElementById('orderMsg');
 var buy=Number(document.getElementById('lbBuy').value),qty=Number(document.getElementById('lbQty').value);
 var sellRaw=document.getElementById('lbSell').value.trim(),sell=sellRaw?Number(sellRaw):undefined;
 if(!(buy>0)){msg.className='setmsg err';msg.textContent='매수 지정가를 입력하세요.';return;}
 if(!(qty>0)){msg.className='setmsg err';msg.textContent='수량을 0보다 크게 입력하세요.';return;}
 if(sellRaw&&!(sell>0)){msg.className='setmsg err';msg.textContent='매도가가 올바르지 않아요(비우면 매수전용).';return;}
 msg.className='setmsg';msg.textContent='지정가 봇 생성 중…';
 fetch('/api/bot/limit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({broker:broker,symbol:symbol,buyPrice:buy,quantity:qty,sellPrice:sell})})
  .then(function(r){return r.json()}).then(function(d){
   if(!d.ok){msg.className='setmsg err';msg.textContent='실패: '+(d.error||'알 수 없음');return;}
   msg.className='setmsg ok';msg.textContent='✅ 지정가 봇 생성·가동! '+esc(d.note||'')+' (봇 '+esc(String(d.botId||''))+')';
  }).catch(function(e){msg.className='setmsg err';msg.textContent='실패: '+e.message;});}
function openChart(id,tf){
 // 새 봇(또는 닫힌 뒤 재오픈) 진입 시 저장된 드로잉 로드. tf변경/지표토글로 같은 봇 재오픈은 메모리 _drawings 유지(이미 저장과 동기).
 if(String(id)!==String(_drawLoadedFor)){_drawings=[];_pendingTrend=null;_drawLoadedFor=String(id);try{_drawings=loadDrawings(id)}catch(e){_drawings=[];}}
 _chartId=id;var modal=document.getElementById('chartModal'),body=document.getElementById('chartBody');
 document.getElementById('chartTitle').textContent='차트 불러오는 중…';modal.style.display='flex';
 var _oq=Array.from(chartInds).filter(function(k){return k!=='volume'});var indQ=_oq.length?'&ind='+encodeURIComponent(_oq.join(',')):''; // volume=클라전용(refreshSeries와 일관)
 fetch('/api/candles?bot='+encodeURIComponent(id)+(tf?'&tf='+tf:'')+indQ).then(function(r){if(r.status===401){sessionLost();throw new Error('session');}return r.json()}).then(function(d){
  if(!d.ok){document.getElementById('chartTitle').textContent='차트 오류: '+(d.error||'불러오기 실패');document.getElementById('chartTf').innerHTML='';return;}
  var isC=d.broker==='binance';
  _chartTf=d.interval;
  renderTfButtons(d.interval);renderIndButtons();renderDrawButtons();
  var oscGroups=d.oscGroups||[];
  var names=[].concat((d.overlays||[]).map(function(o){return o.label}),oscGroups.reduce(function(a,g){return a.concat((g.series||[]).map(function(s){return s.label}))},[]));
  document.getElementById('chartTitle').textContent=(isC?coin(d.symbol):(d.name?d.name+' ('+d.symbol+')':d.symbol))+' · '+(isC?'Binance':'키움증권')+' '+tfLabel(d.interval)+(names.length?'  ·  '+names.join(' '):'');
  document.getElementById('chartNote').textContent=(isC?'데이터: Binance 공개 시세 · 실시간(WS)':'데이터: 키움증권 실제 차트(모의) · 실시간(20초 폴링)')+'  ·  시각 KST'+((d.priceLines||[]).length?'  ·  노랑=진입 빨강=손절 초록=익절':'')+((d.markers||[]).length?'  ·  ▲진입/매수 ▼청산':'')+(oscGroups.length?'  ·  보조지표 '+oscGroups.length+'개 패널 분리':'');
  renderChartTrade(d.broker,d.symbol,d.ccy); // 봇·검색 차트 모두 상단에 종목 매수/매도/관심 바 노출
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
  initProtect(id); // 봇 포지션(현물 롱 qty>0) 기반 익절/손절선 표시 + 드래그 배선(포지션 없으면 내부에서 숨김)
  // 실시간: 코인=바이낸스 kline WS, KR(키움/한투)=getCandles 폴링(WS 없음). 둘 다 refreshSeries로 갱신(무깜빡).
  closeKline();clearChartPoll();
  if(isC)setupKline(d.symbol,d.interval);
  else _chartPoll=setInterval(refreshSeries,20000); // KR 실시간 근사(20초마다 키움 차트 재요청). 429 회피용 간격.
 }).catch(function(e){document.getElementById('chartTitle').textContent=(e&&e.message==='session')?'세션 만료 — 위 빨간 안내대로 새 URL(?token=…)로 다시 접속하세요':'차트 오류(네트워크)';});}
function closeChart(){document.getElementById('chartModal').style.display='none';closeKline();clearChartPoll();if(_chart&&_clickHandler){try{_chart.unsubscribeClick(_clickHandler)}catch(e){}}_clickHandler=null;_drawings=[];_pendingTrend=null;_drawLoadedFor=null;_drawMode='none';
 unbindProtectDrag();_protect=null;_protDrag=null;var _cp=document.getElementById('chartProtect');if(_cp){_cp.style.display='none';_cp.innerHTML='';}var _pm=document.getElementById('protectMsg');if(_pm)_pm.textContent=''; // 보호주문 정리(리스너 누수 방지)
 var _ct=document.getElementById('chartTrade');if(_ct){_ct.style.display='none';_ct.innerHTML='';}_chartMeta=null; // 차트 주문바 정리
 _priceSeries=null;_ovSeries=[];_oscFlat=[];_markersPrim=null;_volSeries=null;if(_chart){try{_chart.remove()}catch(e){}_chart=null;}document.getElementById('chartBody').innerHTML='';}
// ── 보호주문(OCO) — 차트에서 익절/손절선 드래그 + 진짜 OCO. 모든 안전판정은 서버(placeProtective)가 강제. ──
function findBot(id){for(var i=0;i<bots.length;i++)if(String(bots[i].id)===String(id))return bots[i];return null;}
function initProtect(id){var bar=document.getElementById('chartProtect');var b=findBot(id);
 var pos=b&&!b.isScanner&&(b.positions||[]).filter(function(p){return p.side==='long'&&p.qty>0;})[0]; // 현물 롱만(OCO SELL)
 if(!pos||!_priceSeries||(b.broker!=='binance')){_protect=null;if(bar)bar.style.display='none';var pm0=document.getElementById('protectMsg');
  // KR(키움/KIS)은 거래소 상주 OCO 미지원 — 조용히 숨기지 않고 정직하게 고지(audit P0-3). 봇 폴링 손절만 동작.
  if(pm0)pm0.textContent=(pos&&b&&(b.broker==='kis'||b.broker==='kiwoom'||b.broker==='toss'))?'ℹ️ 한국주식은 거래소 상주 OCO 보호주문 미지원 — 봇이 켜져 있을 때만 손절/익절이 동작해요.':'';return;}
 var entry=pos.entryAvg;
 _protect={sym:pos.symbol,broker:b.broker,market:b.market||'spot',ccy:ccyOf(b.broker,pos.symbol),qty:pos.qty,entry:entry,side:'long',
   tpPrice:entry*(1+PROT_TP_PCT/100),slPrice:entry*(1-PROT_SL_PCT/100),tpLine:null,slLine:null,confirmToken:null,active:false,orderListId:null};
 drawProtectLines();renderProtectBar();bindProtectDrag();loadActiveProtect(id);
}
function drawProtectLines(){if(!_protect||!_priceSeries)return;
 if(_protect.tpLine){try{_priceSeries.removePriceLine(_protect.tpLine)}catch(e){}}
 if(_protect.slLine){try{_priceSeries.removePriceLine(_protect.slLine)}catch(e){}}
 var f=function(x){return money(x,_protect.ccy)};
 _protect.tpLine=_priceSeries.createPriceLine({price:_protect.tpPrice,color:'#10b981',lineWidth:2,lineStyle:0,axisLabelVisible:true,title:'익절 '+f(_protect.tpPrice)});
 _protect.slLine=_priceSeries.createPriceLine({price:_protect.slPrice,color:'#f43f5e',lineWidth:2,lineStyle:0,axisLabelVisible:true,title:'손절 '+f(_protect.slPrice)});
}
function pctFromEntry(price){return ((price-_protect.entry)/_protect.entry*100);}
function renderProtectBar(){var bar=document.getElementById('chartProtect');if(!bar||!_protect)return;bar.style.display='flex';
 var actTxt=_protect.active?'<span class="ib on">상주 OCO 작동중</span><span class="ib" onclick="cancelProtect()">취소</span>':'';
 bar.innerHTML='<span class="indlbl">보호주문</span>'+
  '익절 <input type="number" id="ptp" step="any" value="'+(+_protect.tpPrice.toFixed(2))+'" onchange="setProtectInput(this,&quot;tp&quot;)" style="width:96px"> <span class="hint">'+(pctFromEntry(_protect.tpPrice)>=0?'+':'')+pctFromEntry(_protect.tpPrice).toFixed(1)+'%</span> '+
  '손절 <input type="number" id="psl" step="any" value="'+(+_protect.slPrice.toFixed(2))+'" onchange="setProtectInput(this,&quot;sl&quot;)" style="width:96px"> <span class="hint">'+pctFromEntry(_protect.slPrice).toFixed(1)+'%</span> '+
  '<span class="hint">수량 '+_protect.qty+'</span>'+
  (_protect.active?'':'<span class="ib on" onclick="submitProtect()">보호주문 걸기</span>')+actTxt;
}
function setProtectInput(inp,which){var v=Number(inp.value);if(!(v>0)){inp.value=(which==='tp'?_protect.tpPrice:_protect.slPrice).toFixed(2);return;}
 if(which==='tp')_protect.tpPrice=v;else _protect.slPrice=v;invalidateProtPreview();drawProtectLines();renderProtectBar();}
function lineY(price){try{return _priceSeries.priceToCoordinate(price)}catch(e){return null;}}
function onProtMouseDown(ev){if(!_protect||_drawMode!=='none'||_protect.active)return; // 드로잉 모드/상주중엔 드래그 안 함
 var rect=document.getElementById('chartBody').getBoundingClientRect();var y=ev.clientY-rect.top;
 var ytp=lineY(_protect.tpPrice),ysl=lineY(_protect.slPrice);var hit=null,bd=PROT_HIT_PX+1;
 if(ytp!=null&&Math.abs(y-ytp)<bd){bd=Math.abs(y-ytp);hit='tp';}
 if(ysl!=null&&Math.abs(y-ysl)<bd){hit='sl';}
 if(!hit)return;_protDrag=hit;try{_chart.applyOptions({handleScroll:false,handleScale:false})}catch(e){}ev.preventDefault();}
function onProtMouseMove(ev){if(_protDrag&&ev.buttons===0){onProtMouseUp();return;} // 창 밖에서 뗀 경우 복귀 첫 이동에 복원
 if(!_protDrag||!_protect)return;
 var rect=document.getElementById('chartBody').getBoundingClientRect();var y=ev.clientY-rect.top;
 var price;try{price=_priceSeries.coordinateToPrice(y)}catch(e){return;}if(price==null||!isFinite(price)||price<=0)return;
 if(_protDrag==='tp')_protect.tpPrice=price;else _protect.slPrice=price;invalidateProtPreview();drawProtectLines();renderProtectBar();}
function onProtMouseUp(){if(!_protDrag)return;_protDrag=null;try{_chart.applyOptions({handleScroll:true,handleScale:true})}catch(e){}} // pan/zoom 복원
function bindProtectDrag(){var body=document.getElementById('chartBody');if(!body)return;unbindProtectDrag();
 body.addEventListener('mousedown',onProtMouseDown);window.addEventListener('mousemove',onProtMouseMove);window.addEventListener('mouseup',onProtMouseUp);window.addEventListener('blur',onProtMouseUp);}
function unbindProtectDrag(){var body=document.getElementById('chartBody');if(body)body.removeEventListener('mousedown',onProtMouseDown);window.removeEventListener('mousemove',onProtMouseMove);window.removeEventListener('mouseup',onProtMouseUp);window.removeEventListener('blur',onProtMouseUp);}
function loadActiveProtect(id){if(!_protect)return;fetch('/api/protect?symbol='+encodeURIComponent(_protect.sym)+'&broker='+encodeURIComponent(_protect.broker)).then(function(r){return r.json()}).then(function(d){if(!_protect||String(_chartId)!==String(id))return;
 if(d&&d.ok&&typeof d.held==='number'&&!(d.held>0)){var bar=document.getElementById('chartProtect');if(bar)bar.style.display='none';var pm=document.getElementById('protectMsg');if(pm){pm.style.color='#8a94a6';pm.textContent='실거래 계정 보유가 없어 OCO 보호주문 불가(페이퍼 포지션).';}return;} // 페이퍼봇 죽은버튼 방지
 if(d&&d.ok&&d.active){_protect.active=true;_protect.orderListId=d.orderListId;if(typeof d.tpPrice==='number'&&d.tpPrice>0)_protect.tpPrice=d.tpPrice;if(typeof d.slPrice==='number'&&d.slPrice>0)_protect.slPrice=d.slPrice;drawProtectLines();renderProtectBar();}}).catch(function(){});}
function invalidateProtPreview(){if(_protect&&_protect.confirmToken){_protect.confirmToken=null;var pm=document.getElementById('protectMsg');if(pm){pm.style.color='';pm.textContent='값이 바뀌었어요 — 다시 미리보기하세요.';}}}
function submitProtect(){if(!_protect)return;var msg=document.getElementById('protectMsg');
 if(!(_protect.tpPrice>_protect.entry)){msg.style.color='#f43f5e';msg.textContent='익절가는 진입가보다 높아야 해요.';return;}
 if(!(_protect.slPrice<_protect.entry)){msg.style.color='#f43f5e';msg.textContent='손절가는 진입가보다 낮아야 해요.';return;}
 msg.style.color='';msg.textContent='보호주문 미리보기 불러오는 중…';
 fetch('/api/protect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bot:_chartId,broker:_protect.broker,market:_protect.market,symbol:_protect.sym,side:'sell',quantity:_protect.qty,takeProfitPrice:_protect.tpPrice,stopPrice:_protect.slPrice})})
  .then(function(r){return r.json()}).then(function(d){
   if(!d.ok){msg.style.color='#f43f5e';msg.textContent='차단/오류: '+(d.error||'알 수 없음');return;}
   if(d.phase==='preview'){_protect.confirmToken=d.confirmToken;var p=d.preview||{};
    msg.style.color='';msg.innerHTML='OCO 미리보기 — 익절 '+money(p.takeProfitPrice,_protect.ccy)+' / 손절 '+money(p.stopPrice,_protect.ccy)+' · 수량 '+esc(p.quantity)+' · '+esc(String(p.env).toUpperCase())+' <span class="ib on" onclick="confirmProtect()">확정</span> <span class="ib" onclick="document.getElementById(&quot;protectMsg&quot;).textContent=&quot;&quot;">닫기</span>';return;}
   msg.style.color='#f43f5e';msg.textContent='예상치 못한 응답';
  }).catch(function(e){msg.style.color='#f43f5e';msg.textContent='실패: '+e.message;});}
function confirmProtect(){if(!_protect||!_protect.confirmToken)return;var msg=document.getElementById('protectMsg');msg.style.color='';msg.textContent='OCO 전송 중…';
 fetch('/api/protect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bot:_chartId,broker:_protect.broker,market:_protect.market,symbol:_protect.sym,side:'sell',quantity:_protect.qty,takeProfitPrice:_protect.tpPrice,stopPrice:_protect.slPrice,confirmToken:_protect.confirmToken})})
  .then(function(r){return r.json()}).then(function(d){_protect.confirmToken=null;
   if(d.ok&&d.phase==='executed'){_protect.active=true;_protect.orderListId=(d.result&&d.result.orderListId)||d.orderListId;msg.style.color='#10b981';msg.textContent='✅ OCO 보호주문 등록됨 ('+esc(d.env||'')+')';renderProtectBar();}
   else{msg.style.color='#f43f5e';msg.textContent='실패: '+(d.error||'알 수 없음')+' — 다시 시도하세요.';}
  }).catch(function(e){msg.style.color='#f43f5e';msg.textContent='실패: '+e.message;});}
function cancelProtect(){if(!_protect)return;var msg=document.getElementById('protectMsg');msg.style.color='';msg.textContent='보호주문 취소 중…';
 fetch('/api/protect/cancel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bot:_chartId,broker:_protect.broker,market:_protect.market,symbol:_protect.sym,orderListId:_protect.orderListId})})
  .then(function(r){return r.json()}).then(function(d){
   if(d.ok){_protect.active=false;_protect.orderListId=null;msg.style.color='#10b981';msg.textContent='보호주문이 취소됐어요.';renderProtectBar();}
   else{msg.style.color='#f43f5e';msg.textContent='취소 실패: '+(d.error||'알 수 없음');}
  }).catch(function(e){msg.style.color='#f43f5e';msg.textContent='실패: '+e.message;});}
// ── 주문/체결 내역 모달(audit P1-18/19): 체결 내역(전 봇) + 미체결 주문(조회·취소) ──
var _histTab='trades';var _histDays=7;var _histBroker='binance';
function openHist(){document.getElementById('histModal').style.display='flex';renderHistTabs();loadHist();}
function closeHist(){document.getElementById('histModal').style.display='none';}
function setHistTab(t){_histTab=t;renderHistTabs();loadHist();}
function renderHistTabs(){var el=document.getElementById('histTabs');
 el.innerHTML='<span class="tfb'+(_histTab==='trades'?' on':'')+'" data-t="trades" onclick="setHistTab(this.dataset.t)">체결 내역</span>'+
  '<span class="tfb'+(_histTab==='orders'?' on':'')+'" data-t="orders" onclick="setHistTab(this.dataset.t)">미체결 주문</span>'+
  (_histTab==='trades'
   ?'<select class="hsel" onchange="_histDays=Number(this.value);loadHist()">'+[[1,'오늘'],[7,'7일'],[30,'30일'],[0,'전체']].map(function(o){return '<option value="'+o[0]+'"'+(_histDays===o[0]?' selected':'')+'>'+o[1]+'</option>'}).join('')+'</select>'
   :'<select class="hsel" onchange="_histBroker=this.value;loadHist()">'+['binance','kiwoom','kis','toss'].map(function(b){return '<option value="'+b+'"'+(_histBroker===b?' selected':'')+'>'+esc(brokerLabel(b))+'</option>'}).join('')+'</select>');}
function loadHist(){var body=document.getElementById('histBody');var msg=document.getElementById('histMsg');msg.textContent='';body.innerHTML='<div class="hint" style="padding:12px">불러오는 중…</div>';
 if(_histTab==='trades'){
  fetch('/api/trades'+(_histDays>0?'?days='+_histDays:'')).then(function(r){return r.json()}).then(function(d){
   if(!d.ok){body.innerHTML='';msg.className='setmsg err';msg.textContent='오류: '+(d.error||'');return;}
   if(!d.trades.length){body.innerHTML='<div class="hint" style="padding:12px">기간 내 체결 없음</div>';return;}
   var rows=d.trades.map(function(t){var ccy=/^[0-9]{6}$/.test(String(t.symbol||''))?'KRW':'USD';
    return '<tr><td>'+esc(String(t.ts).slice(0,16).replace('T',' '))+'</td><td>'+esc(t.bot_name||'-')+'</td><td>'+esc(coin(t.symbol||''))+'</td>'+
     '<td class="'+(t.side==='buy'?'up':'dn')+'">'+(t.side==='buy'?'매수':'매도')+(t.is_paper?'':' <b>실</b>')+'</td>'+
     '<td style="text-align:right">'+fmt(t.qty,4)+'</td><td style="text-align:right">'+fmt(t.price,ccy==='KRW'?0:2)+'</td>'+
     '<td style="text-align:right" class="'+(t.pnl>=0?'up':'dn')+'">'+(t.side==='sell'?signed(t.pnl,ccy):'-')+'</td><td class="hint">'+esc(t.reason||'')+'</td></tr>';}).join('');
   body.innerHTML='<table class="htbl"><thead><tr><th>시각</th><th>봇</th><th>종목</th><th>방향</th><th>수량</th><th>가격</th><th>실현손익</th><th>사유</th></tr></thead><tbody>'+rows+'</tbody></table>'+
    '<div class="hint" style="padding:8px 12px">'+esc(d.note||'')+' 수동 주문 체결은 🔔 알림으로 통지돼요(봇 체결만 이 표에 기록).</div>';
  }).catch(function(e){body.innerHTML='';msg.className='setmsg err';msg.textContent='실패: '+e.message;});
 }else{
  fetch('/api/orders?broker='+encodeURIComponent(_histBroker)).then(function(r){return r.json()}).then(function(d){
   if(!d.ok){body.innerHTML='';msg.className='setmsg err';msg.textContent='오류: '+(d.error||'');return;}
   var un=d.unsupported?'<div class="setmsg err" style="padding:8px 12px">'+esc(d.unsupported)+'</div>':'';
   if(!d.orders.length){body.innerHTML=un+'<div class="hint" style="padding:12px">미체결 주문 없음'+(d.tracking?' · 체결 추적 중 '+d.tracking+'건':'')+'</div>';return;}
   var rows=d.orders.map(function(o){
    return '<tr><td>'+esc(coin(o.symbol))+'</td><td class="'+(o.side==='buy'?'up':'dn')+'">'+(o.side==='buy'?'매수':'매도')+'</td>'+
     '<td style="text-align:right">'+fmt(o.quantity,4)+'</td><td style="text-align:right">'+fmt(o.price,2)+'</td><td>'+esc(o.status)+'</td>'+
     '<td><span class="obtn sell" data-sym="'+esc(o.symbol)+'" data-oid="'+esc(o.orderId)+'" onclick="cancelOpenOrder(this)">취소</span></td></tr>';}).join('');
   body.innerHTML=un+'<table class="htbl"><thead><tr><th>종목</th><th>방향</th><th>수량</th><th>가격</th><th>상태</th><th></th></tr></thead><tbody>'+rows+'</tbody></table>';
  }).catch(function(e){body.innerHTML='';msg.className='setmsg err';msg.textContent='실패: '+e.message;});
 }}
function cancelOpenOrder(el){var msg=document.getElementById('histMsg');msg.className='setmsg';msg.textContent='취소 중…';
 fetch('/api/orders/cancel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({broker:_histBroker,symbol:el.dataset.sym,orderId:el.dataset.oid})})
  .then(function(r){return r.json()}).then(function(d){
   if(d.ok&&d.cancelled){msg.className='setmsg ok';msg.textContent='취소됐어요.';loadHist();}
   else{msg.className='setmsg err';msg.textContent='취소 실패: '+(d.error||d.note||'이미 체결/취소됐을 수 있어요');loadHist();}
  }).catch(function(e){msg.className='setmsg err';msg.textContent='실패: '+e.message;});}
// ── 수동 주문(2단계: 미리보기→확정). 모든 안전판정은 서버 placeOrder가 수행, 클라는 입력·표시만. ──
var _order=null; // {broker,market,symbol,ccy,side,quantity,type,price,confirmToken}
function envBadge(env){var live=env==='live';return '<span class="envb '+(live?'live':'safe')+'">'+(live?'⚠ 실거래(LIVE)':String(env||'testnet').toUpperCase()+' 모의')+'</span>';}
function toggleLimit(on){var w=document.getElementById('olimitwrap');if(w)w.style.display=on?'block':'none';}
// 입력 폼 HTML(수량/지정가/미리보기 버튼). 최초 진입과 확정 실패 후 재시도 양쪽에서 재사용.
function orderFormBody(side,qty){return '<div class="fld"><label>수량</label><input id="oqty" type="text" inputmode="decimal" autocomplete="off" placeholder="예: 0.01" value="'+(qty?esc(qty):'')+'"></div>'+
  '<label style="display:flex;gap:7px;align-items:center;cursor:pointer;margin:6px 0;font-size:12px;color:#8a94a6"><input type="checkbox" id="olimit" onchange="toggleLimit(this.checked)"> 지정가로 주문</label>'+
  '<div class="fld" id="olimitwrap" style="display:none"><label>지정가</label><input id="oprice" type="text" inputmode="decimal" autocomplete="off" placeholder="한 주 가격"></div>'+
  '<button class="obig'+(side==='sell'?' danger':'')+'" onclick="submitOrder()">주문 미리보기 →</button>';}
// 자유 수동주문 폼 — 브로커·종목·방향까지 직접 선택(봇 카드와 무관). o={broker,symbol,side,quantity} 프리필(확정 실패 후 복원용).
function manualFormBody(o){o=o||{};var sel=function(v){return o.broker===v?' selected':''};var ss=function(v){return (o.side||'buy')===v?' selected':''};
 return '<div class="fld"><label>거래소/증권사</label><select id="obroker"><option value="binance"'+sel('binance')+'>Binance (암호화폐)</option><option value="kiwoom"'+sel('kiwoom')+'>키움증권 (주식)</option><option value="kis"'+sel('kis')+'>한국투자증권 (주식)</option><option value="toss"'+sel('toss')+'>토스증권 (주식)</option></select></div>'+
  '<div class="fld"><label>종목</label><input id="osym" type="text" autocomplete="off" placeholder="예: BTCUSDT 또는 005930" value="'+(o.symbol?esc(o.symbol):'')+'"></div>'+
  '<div class="fld"><label>시세/잔고</label><div style="display:flex;gap:8px;align-items:center;min-width:0"><span class="tfb" onclick="quoteManual()">조회</span><span id="oquote" class="hint" style="overflow:hidden;text-overflow:ellipsis">종목 입력 후 조회 — 현재가·가용잔고·보유 확인</span></div></div>'+
  '<div class="fld"><label>방향</label><select id="oside"><option value="buy"'+ss('buy')+'>매수 (사기)</option><option value="sell"'+ss('sell')+'>매도 (팔기)</option></select></div>'+
  '<div class="fld"><label>수량</label><input id="oqty" type="text" inputmode="decimal" autocomplete="off" placeholder="코인: 0.01 / 주식: 1" value="'+(o.quantity?esc(o.quantity):'')+'"></div>'+
  '<div class="fld"><label></label><div style="display:flex;gap:6px"><span class="tfb" data-p="25" onclick="applyPreset(this.dataset.p)">25%</span><span class="tfb" data-p="50" onclick="applyPreset(this.dataset.p)">50%</span><span class="tfb" data-p="max" onclick="applyPreset(this.dataset.p)">Max</span><span class="hint" style="align-self:center">매수=가용잔고, 매도=보유 기준</span></div></div>'+
  '<label style="display:flex;gap:7px;align-items:center;cursor:pointer;margin:6px 0;font-size:12px;color:#8a94a6"><input type="checkbox" id="olimit" onchange="toggleLimit(this.checked)"'+(o.price?' checked':'')+'> 지정가로 주문 <span class="hint">(체크 안 하면 시장가)</span></label>'+
  '<div class="fld" id="olimitwrap" style="display:'+(o.price?'block':'none')+'"><label>지정가</label><input id="oprice" type="text" inputmode="decimal" autocomplete="off" placeholder="한 주(개) 가격" value="'+(o.price?esc(o.price):'')+'"></div>'+
  '<div class="hint" style="margin:4px 0 8px">미리보기에서 서버가 현재가·예상금액을 다시 계산해 보여드려요. 거기서 한 번 더 확인 후 확정됩니다.</div>'+
  '<button class="obig" onclick="submitOrder()">주문 미리보기 →</button>';}
var _quote=null; // 수동주문 보조 시세(현재가/가용/보유) — 프리셋·매도초과 경고용
function quoteManual(){var b=document.getElementById('obroker').value;var sym=document.getElementById('osym').value.trim();if(/[a-z]/i.test(sym))sym=sym.toUpperCase();var out=document.getElementById('oquote');if(!sym){out.textContent='종목을 입력하세요';return;}out.textContent='조회 중…';
 fetch('/api/quote?broker='+encodeURIComponent(b)+'&symbol='+encodeURIComponent(sym)).then(function(r){return r.json()}).then(function(d){
  if(!d.ok){_quote=null;out.textContent='⚠ '+(d.error||'조회 실패');return;}
  _quote=d;var ccy=ccyOf(b);out.innerHTML='현재가 <b>'+fmt(d.price,ccy==='KRW'?0:2)+'</b> · 가용 '+money(d.cashBalance,ccy)+' · 보유 '+fmt(d.held,4);
 }).catch(function(){_quote=null;out.textContent='조회 실패';});}
function applyPreset(p){var out=document.getElementById('oquote');if(!_quote){if(out)out.textContent='먼저 [조회]로 시세/잔고를 불러오세요';return;}
 var side=document.getElementById('oside').value;var pct=p==='max'?100:Number(p);var qty;
 if(side==='sell'){qty=_quote.held*pct/100;}else{qty=(_quote.cashBalance*pct/100)/_quote.price*0.99;} // 수수료 여유 1%
 var kr=/^[0-9]{6}$/.test(String(_quote.symbol||''));qty=kr?Math.floor(qty):Math.floor(qty*1e8)/1e8;
 document.getElementById('oqty').value=qty>0?String(qty):'0';
 if(side==='sell'&&!(qty>0)&&out)out.textContent='매도할 보유 수량이 없어요';}
function openManualOrder(){_quote=null;_order={manual:true,market:'spot',side:'buy'};
 var m=document.getElementById('orderModal');document.getElementById('orderMsg').textContent='';document.getElementById('orderMsg').className='setmsg';
 document.getElementById('orderTitle').textContent='✋ 수동 주문';
 document.getElementById('orderBody').innerHTML=manualFormBody(_order);
 m.style.display='flex';}
function openOrder(el){var side=el.dataset.side;_order={broker:el.dataset.broker,market:el.dataset.market||'spot',symbol:el.dataset.sym,ccy:el.dataset.ccy,side:side};
 var m=document.getElementById('orderModal');document.getElementById('orderMsg').textContent='';document.getElementById('orderMsg').className='setmsg';
 document.getElementById('orderTitle').innerHTML=esc(coin(_order.symbol))+' · '+(side==='buy'?'<span style="color:#10b981">매수</span>':'<span style="color:#f43f5e">매도</span>');
 document.getElementById('orderBody').innerHTML=orderFormBody(side,el.dataset.qty||'');
 m.style.display='flex';}
function closeOrder(){document.getElementById('orderModal').style.display='none';_order=null;}
function submitOrder(){if(!_order)return;var msg=document.getElementById('orderMsg');
 if(_order.manual){ // 자유 주문 — 브로커·종목·방향을 폼에서 수집(서버 placeOrder가 심볼 실재·가격·한도 전부 재검증)
  _order.broker=document.getElementById('obroker').value;_order.ccy=ccyOf(_order.broker);
  var sym=document.getElementById('osym').value.trim();if(/[a-z]/i.test(sym))sym=sym.toUpperCase(); // 코인 심볼은 대문자 정규화, KR 종목코드(숫자)는 그대로
  if(!sym){msg.className='setmsg err';msg.textContent='종목을 입력하세요. (예: BTCUSDT, 005930)';return;}
  _order.symbol=sym;_order.side=document.getElementById('oside').value;
  document.getElementById('orderTitle').innerHTML=esc(coin(sym))+' · '+(_order.side==='buy'?'<span style="color:#10b981">매수</span>':'<span style="color:#f43f5e">매도</span>');}
 var qty=Number(document.getElementById('oqty').value);if(!(qty>0)){msg.className='setmsg err';msg.textContent='수량을 0보다 크게 입력하세요.';return;}
 if(_order.manual&&_quote&&_quote.symbol===_order.symbol&&_order.side==='sell'&&qty>_quote.held*1.0000001){msg.className='setmsg err';msg.textContent='매도 수량('+qty+')이 보유('+_quote.held+')를 초과해요.';return;}
 _order.quantity=qty;var limit=document.getElementById('olimit').checked;
 if(limit){var pr=Number(document.getElementById('oprice').value);if(!(pr>0)){msg.className='setmsg err';msg.textContent='지정가를 입력하세요.';return;}_order.type='limit';_order.price=pr;}else{_order.type='market';_order.price=undefined;}
 msg.className='setmsg';msg.textContent='미리보기 불러오는 중…';
 fetch('/api/order',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({broker:_order.broker,market:_order.market,symbol:_order.symbol,side:_order.side,type:_order.type,quantity:_order.quantity,price:_order.price})})
  .then(function(r){return r.json()}).then(function(d){
   if(!d.ok){msg.className='setmsg err';msg.textContent='차단/오류: '+(d.error||'알 수 없음');return;}
   if(d.phase==='preview'){_order.confirmToken=d.confirmToken;var p=d.preview||{};var live=p.env==='live';
    document.getElementById('orderBody').innerHTML='<div class="strat"><div class="drow"><b>심볼</b>'+esc(p.symbol)+envBadge(p.env)+'</div>'+
     '<div class="drow"><b>방향</b>'+(p.side==='buy'?'매수':'매도')+' · '+esc(p.type)+'</div>'+
     '<div class="drow"><b>수량</b>'+esc(p.quantity)+'</div>'+
     '<div class="drow"><b>가격</b>'+esc(p.price)+'</div>'+
     '<div class="drow"><b>예상금액</b>'+esc(p.notional)+' '+esc(_order.ccy||'')+'</div></div>'+
     (live?'<div class="setmsg err" style="margin-top:8px">⚠ 실거래(LIVE) — 실제 자금이 사용됩니다. 한 번 더 확인하세요.</div>':'<div class="hint" style="margin-top:8px">모의(가짜돈) 환경입니다.</div>')+
     '<button class="obig'+(live?' danger':'')+'" onclick="confirmOrder()">'+(live?'⚠ 실주문 확정':'주문 확정')+'</button>';
    msg.textContent='';return;}
   msg.className='setmsg err';msg.textContent='예상치 못한 응답';
  }).catch(function(e){msg.className='setmsg err';msg.textContent='실패: '+e.message;});}
function confirmOrder(){if(!_order||!_order.confirmToken)return;var msg=document.getElementById('orderMsg');msg.className='setmsg';msg.textContent='주문 전송 중…';
 fetch('/api/order',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({broker:_order.broker,market:_order.market,symbol:_order.symbol,side:_order.side,type:_order.type,quantity:_order.quantity,price:_order.price,confirmToken:_order.confirmToken})})
  .then(function(r){return r.json()}).then(function(d){
   if(d.ok&&d.phase==='executed'){msg.className='setmsg ok';var pend=d.result&&d.result.status==='pending';msg.textContent='✅ 주문 '+(pend?'접수':'완료')+' ('+esc(d.env)+') · 주문번호 '+esc((d.result&&d.result.orderId)||'-')+(pend?' — 미체결 지정가는 📋 주문/체결에서 확인·취소, 체결되면 🔔 알림':'');loadBalances();}
   else{msg.className='setmsg err';msg.textContent='실패: '+(d.error||'알 수 없음')+' — 미리보기부터 다시 하세요.';_order.confirmToken=null;
    document.getElementById('orderBody').innerHTML=_order.manual?manualFormBody(_order):orderFormBody(_order.side,_order.quantity);} // 입력 폼 복원(막다른 골목 방지) — 수동주문은 브로커·종목까지 프리필
  }).catch(function(e){msg.className='setmsg err';msg.textContent='실패: '+e.message;});}
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
  (b.isScanner?'':( // 스캐너 봇은 b.symbol이 명목 라벨(런타임 유니버스 선별)이라 수동주문 대상 아님 → 버튼 숨김
   '<div class="obar"><span class="obtn buy" data-side="buy" data-broker="'+esc(b.broker)+'" data-market="'+esc(b.market||'spot')+'" data-sym="'+esc(b.symbol)+'" data-ccy="'+esc(r.ccy)+'" onclick="openOrder(this)">매수</span>'+
    '<span class="obtn sell" data-side="sell" data-broker="'+esc(b.broker)+'" data-market="'+esc(b.market||'spot')+'" data-sym="'+esc(b.symbol)+'" data-ccy="'+esc(r.ccy)+'" onclick="openOrder(this)">매도</span>'+
    (r.bsum>0||r.ps.some(function(p){return p.side==='long'&&p.qty>0})?'<span class="obtn sell" data-side="sell" data-qty="'+esc(r.ps.filter(function(p){return p.side==='long'}).reduce(function(a,p){return a+p.qty},0))+'" data-broker="'+esc(b.broker)+'" data-market="'+esc(b.market||'spot')+'" data-sym="'+esc(b.symbol)+'" data-ccy="'+esc(r.ccy)+'" onclick="openOrder(this)">전량매도</span>':'')+'</div>'))+
  '<div class="more" data-id="'+esc(b.id)+'" onclick="tgl(this)">'+(open?'간단히 ▴':'전략 자세히 ▾')+'</div>'+
  '<div class="strat" style="display:'+(open?'block':'none')+'">'+detailHtml(b)+'</div>';
 return el;}
function render(){var pos=document.getElementById('pos');pos.innerHTML='';
 var rows=bots.map(function(b){var ccy=ccyOf(b.broker,b.symbol);var ps=b.positions||[];var body='',bsum=0,n=0;
  if(ps.length){for(const p of ps){var r=posRow(p,ccy);bsum+=r.abs;n++;body+=r.html;}}
  else body='<div class="prow" style="color:#8a94a6">지금은 대기 중이에요 (가진 것 없음)</div>';
  return {b:b,ccy:ccy,ps:ps,body:body,bsum:bsum,n:n,rp:b.realizedPnl||0,cap:(b.detail&&b.detail.capital)||0};});
 var acc={USD:{cap:0,unr:0,real:0,n:0},KRW:{cap:0,unr:0,real:0,n:0}};
 rows.forEach(function(r){var a=acc[r.ccy];a.cap+=r.cap;a.unr+=r.bsum;a.real+=r.rp;a.n++;});
 var BK={binance:{label:'💰 Binance',sub:'암호화폐·USDT'},kiwoom:{label:'🏦 키움증권',sub:'주식·KRW(모의)'},kis:{label:'🏦 한국투자증권',sub:'주식·KRW'},toss:{label:'🏦 토스증권',sub:'주식·KR/US'}};
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
  var ra=realAccounts[bk];if(ra){var ap=document.createElement('div');ap.className='card acctpanel';ap.innerHTML=acctPanelHtml(bk,ccy,ra);pos.appendChild(ap);} // 거래소 실계정 패널(읽기전용)
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
function brokerLabel(b){return {binance:'Binance (암호화폐)',kis:'한국투자증권',kiwoom:'키움증권',toss:'토스증권'}[b]||b;}
function loadSettings(){fetch('/api/credentials').then(r=>r.json()).then(d=>{if(!d.ok)return;setLoaded=true;
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
 renderLive(d.live);loadAlertConfig();
});}
// 알림 설정(Slack/Discord 웹훅). URL은 SSRF 검증 후에만 저장, 화면엔 마스킹만 표시.
function loadAlertConfig(){fetch('/api/alerts').then(function(r){return r.json()}).then(function(d){if(d&&d.config)renderAlertCfg(d.config);}).catch(function(){});}
function renderAlertCfg(c){var box=document.getElementById('setalert');if(!box)return;
 var on=c.enabled;
 var h='<div class="lh"><span>🔔 알림(웹훅)</span><span class="'+(on?'on':'off')+'">'+(on?'🟢 켜짐':'⚪ 꺼짐')+'</span></div>';
 h+='<div class="ld">봇 진입·청산·오류를 Slack/Discord로 받아요. 웹훅 URL은 이 컴퓨터에만 저장(마스킹), Slack·Discord 호스트만 허용(SSRF 차단).</div>';
 h+='<div class="fld"><label>웹훅 URL</label><input id="alurl" type="password" autocomplete="off" spellcheck="false" placeholder="'+(c.webhookSet?'저장됨: '+esc(c.webhookMasked)+' (바꾸려면 입력)':'https://hooks.slack.com/services/… 또는 discord.com/api/webhooks/…')+'"></div>';
 h+='<label class="ld" style="display:flex;gap:7px;align-items:center;cursor:pointer"><input type="checkbox" id="alon"'+(on?' checked':'')+'> 알림 보내기 켜기</label>';
 h+='<div style="display:flex;gap:8px;margin-top:6px"><button class="savebtn" id="alsave">저장</button><button class="savebtn" id="altest" style="background:#26344d">테스트 발사</button></div>';
 box.innerHTML=h;
 box.querySelector('#alsave').addEventListener('click',saveAlertCfg);
 box.querySelector('#altest').addEventListener('click',testAlert);
}
function saveAlertCfg(){var msg=document.getElementById('setmsg');var url=document.getElementById('alurl').value.trim();var en=document.getElementById('alon').checked;
 var body={enabled:en};if(url)body.webhookUrl=url;
 msg.className='setmsg';msg.textContent='알림 설정 저장 중…';
 fetch('/api/alerts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  .then(function(r){return r.json()}).then(function(d){if(d.ok){msg.className='setmsg ok';msg.textContent='✅ 알림 설정 저장됨.';renderAlertCfg(d.config);}
   else{msg.className='setmsg err';msg.textContent='저장 실패: '+(d.error||'알 수 없음');}})
  .catch(function(e){msg.className='setmsg err';msg.textContent='저장 실패: '+e.message;});}
function testAlert(){var msg=document.getElementById('setmsg');msg.className='setmsg';msg.textContent='테스트 발사 중…';
 fetch('/api/alerts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({test:true})})
  .then(function(r){return r.json()}).then(function(d){if(d.ok){msg.className='setmsg ok';msg.textContent='✅ 테스트 알림 전송됨(채널 확인).';}
   else{msg.className='setmsg err';msg.textContent='전송 실패: '+(d.error||'알 수 없음');}})
  .catch(function(e){msg.className='setmsg err';msg.textContent='전송 실패: '+e.message;});}
function renderLive(live){const box=document.getElementById('setlive');if(!box)return;
 const on=live&&live.masterOn;
 let h='<div class="lh"><span>💸 실거래 모드</span><span class="'+(on?'on':'off')+'">'+(on?'🟢 켜짐(실돈)':'⚪ 꺼짐(연습/페이퍼)')+'</span></div>';
 if(on){
  h+='<div class="lstat">환경 <b>'+esc(live.env)+'</b> · 주문당 최대 <b>'+esc(live.maxNotional)+'</b> · 허용종목 <b>'+esc(live.allowlist)+'</b> · 일일손실 서킷 <b>'+esc(live.dailyLossLimit)+'</b></div>';
  h+='<div class="ld">자비스에게 "실거래 봇 돌려줘"라고 하면 바로 실매매가 나갑니다. 위 한도가 안전장치예요.</div>';
  h+='<button class="livebtn stop" id="livestop">🛑 실거래 끄기(긴급 — 페이퍼로 전환)</button>';
 }else{
  h+='<div class="ld">키를 넣었다면, 아래에서 실거래를 켜면 바로 매매가 시작됩니다. 안전을 위해 한도를 정하세요(비우면 기본 100 USDT; 첫 파일럿은 20~50 권장).</div>';
  h+='<div class="fld"><label>주문당 최대(USDT)</label><input id="livecap" type="text" inputmode="numeric" autocomplete="off" placeholder="100"></div>';
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
// 실거래 켜기 = 2단계(프리뷰→확정). _liveConfirm에 프리뷰 토큰+당시 입력 보관 — 서버 해시 바인딩이라 확정은 프리뷰 당시 값으로만 성립. 끄기=1샷(킬스위치).
var _liveConfirm=null;
function saveLive(enable,cap,allow,confirmToken){const msg=document.getElementById('setmsg');msg.className='setmsg';msg.textContent=enable?(confirmToken?'실거래 켜는 중…':'실거래 켜기 확인 요청 중…'):'페이퍼로 전환 중…';
 const body=enable?{enable:true,maxNotional:cap||'',allowlist:allow||''}:{enable:false};
 if(enable&&confirmToken)body.confirmToken=confirmToken;
 fetch('/api/live',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  .then(r=>r.json()).then(d=>{
   if(d.ok&&d.phase==='preview'){_liveConfirm={token:d.confirmToken,cap:cap||'',allow:allow||''};
    msg.className='setmsg err';
    msg.innerHTML='⚠ 실거래(실돈) 켜기 — 주문당 최대 '+esc((d.preview&&d.preview.maxNotional)||'기본')+' · 허용 '+esc((d.preview&&d.preview.allowlist)||'전체')+' <span class="ib on" onclick="confirmLive()">정말 켜기(확정)</span> <span class="ib" onclick="cancelLiveConfirm()">취소</span>';return;}
   if(d.ok){msg.className='setmsg ok';msg.textContent=enable?'🟢 실거래 ON — 이제 봇이 실매매합니다(한도 보호 적용).':'⚪ 페이퍼로 전환됨(실주문 중단).';_liveConfirm=null;renderLive(d.live);}
   else{msg.className='setmsg err';msg.textContent='실패: '+(d.error||'알 수 없음');_liveConfirm=null;}})
  .catch(e=>{msg.className='setmsg err';msg.textContent='실패: '+e.message;});}
function cancelLiveConfirm(){_liveConfirm=null;var m=document.getElementById('setmsg');m.className='setmsg';m.textContent='';}
function confirmLive(){if(!_liveConfirm)return;var c=_liveConfirm;_liveConfirm=null;saveLive(true,c.cap,c.allow,c.token);}
function saveBroker(b,sec){const updates={};sec.querySelectorAll('input[data-key]').forEach(i=>{const v=i.value.trim();if(v)updates[i.getAttribute('data-key')]=v;});
 const msg=document.getElementById('setmsg');
 if(!Object.keys(updates).length){msg.className='setmsg err';msg.textContent='입력한 값이 없어요.';return;}
 msg.className='setmsg';msg.textContent='저장 중…';
 fetch('/api/credentials',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(updates)})
  .then(r=>r.json()).then(d=>{if(d.ok){msg.className='setmsg ok';msg.textContent='✅ '+d.written+'개 저장 완료. 키는 안전하게 보관돼요(다시 표시 안 됨).';
   sec.querySelectorAll('input[data-key]').forEach(i=>i.value='');setLoaded=false;loadSettings();}
   else{msg.className='setmsg err';msg.textContent='저장 실패: '+(d.error||'알 수 없음');}})
  .catch(e=>{msg.className='setmsg err';msg.textContent='저장 실패: '+e.message;});}
function loadBalances(){fetch('/api/balances').then(function(r){return r.json()}).then(function(d){if(d&&d.accounts){d.accounts.forEach(function(a){accounts[a.broker]=a});render();}}).catch(function(){});}
// 거래소 실계정 패널(읽기전용). 브로커별 getAccount 폴링(60s). 주문/취소는 기존 안전경로만.
function loadRealAccounts(){var bks=[];bots.forEach(function(b){if(bks.indexOf(b.broker)<0)bks.push(b.broker);});
 bks.forEach(function(bk){fetch('/api/account?broker='+encodeURIComponent(bk)).then(function(r){return r.json()}).then(function(d){realAccounts[bk]=d;render();}).catch(function(){});});}
function acctPanelHtml(bk,ccy,ra){
 if(!ra.configured)return '<div class="k">🔑 거래소 실계정</div><div class="hint" style="margin-top:6px">키 미연동 — ⚙️에서 API 키를 넣으면 실잔고·실포지션이 보여요.</div>';
 if(ra.ok===false)return '<div class="k">🔑 거래소 실계정 <span class="envb safe">'+esc(String(ra.env||'').toUpperCase())+'</span></div><div class="hint" style="margin-top:6px">'+esc(ra.reason||ra.error||'조회 불가')+'</div>';
 var bal=ra.balance||{};var balLine=bal.currency?('잔고 <b>'+money(bal.cashBalance||0,ccy)+'</b> <span class="hint">총평가 '+money(bal.totalAsset||0,ccy)+'</span>'):'<span class="hint">잔고 조회 실패'+(ra.balErr?': '+esc(ra.balErr):'')+'</span>';
 var bad=(ra.drift||[]).filter(function(x){return x.severity&&x.severity!=='ok'});
 var driftBadge=bad.length?'<span class="pill lose" title="봇 장부와 거래소 실보유가 달라요(페이퍼봇은 별개=정상, 정보용)">⚠ 페이퍼 vs 실계정 차이 '+bad.length+'</span>':'<span class="pill win">실계정 동기화 OK</span>';
 var posH=(ra.positions||[]).filter(function(p){return (Number(p.quantity)||0)>0}).map(function(p){var base=String(p.symbol).toUpperCase();var unit=ccy==='KRW'?'주':'개';
   var pnl=(Number(p.pnl)||0)!==0?(' · 미실현 '+plspan(p.pnl,ccy)):(' <span class="hint">(현물=시세로 평가)</span>');
   return '<div class="prow"><div class="row"><div><b>'+esc(coin(base))+'</b> <span class="qty">'+fmt(p.quantity,4)+unit+'</span></div></div><div class="pmeta">'+(p.avgPrice>0?'평단 '+money(p.avgPrice,ccy)+' · 현재 '+money(p.currentPrice,ccy):'거래소 실보유')+pnl+'</div></div>';}).join('');
 var protH=(ra.protective||[]).filter(function(x){return x.active}).map(function(x){
   return '<div class="prow"><div class="row"><div><b>'+esc(coin(x.symbol))+'</b> <span class="st run">상주 OCO</span></div><span class="ib" onclick="cancelAcctProtect(&quot;'+esc(bk)+'&quot;,&quot;'+esc(x.symbol)+'&quot;,&quot;'+esc(x.orderListId||'')+'&quot;)">취소</span></div><div class="pmeta">익절 '+money(x.tpPrice||0,ccy)+' · 손절 '+money(x.slPrice||0,ccy)+' · 보유 '+fmt(x.held||0,4)+'</div></div>';}).join('');
 return '<div class="row"><div class="k">🔑 거래소 실계정 <span class="envb '+(ra.env==='live'?'live':'safe')+'">'+esc(String(ra.env||'').toUpperCase())+'</span></div>'+driftBadge+'</div>'+
   '<div class="sect-m" style="text-align:left;margin-top:6px">'+balLine+'</div>'+
   (posH?'<div class="plist">'+posH+'</div>':'<div class="hint" style="margin-top:6px">거래소 실보유 없음</div>')+
   (protH?'<div class="plist">'+protH+'</div>':'');
}
// OCO 취소 — 기존 안전경로(/api/protect/cancel → cancelProtective)만 경유. 신규 쓰기로직 없음.
function cancelAcctProtect(bk,sym,olid){if(!olid){alert('orderListId 없음');return;}
 fetch('/api/protect/cancel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({broker:bk,symbol:sym,orderListId:olid})}).then(function(r){return r.json()}).then(function(){loadRealAccounts();}).catch(function(){});}
function loadPrices(){fetch('/api/prices').then(function(r){return r.json()}).then(function(d){if(d&&d.prices){for(const k in d.prices)prices.set(k,d.prices[k]);render();}}).catch(function(){});} // KR 현재가 폴링(~45s) → 카드 평가손익 실값
function renderAlerts(list){var el=document.getElementById('alertfeed');if(!el)return;var arr=list||[];
 if(!arr.length){el.style.display='none';return;}
 el.style.display='block';
 var icon=function(l){return l==='critical'?'🔴':l==='warn'?'🟡':'🟢';};
 document.getElementById('alertlist').innerHTML=arr.slice(0,12).map(function(a){
   var t=new Date(a.ts);var hh=('0'+t.getHours()).slice(-2)+':'+('0'+t.getMinutes()).slice(-2)+':'+('0'+t.getSeconds()).slice(-2);
   return '<div class="alertrow '+esc(a.level)+'"><span class="ad">'+icon(a.level)+'</span><span class="at">'+hh+'</span><span class="am">'+esc(a.message)+'</span></div>';
 }).join('');}
// 세션 만료(데몬 재시작 → token·sessionId 갱신 → 옛 쿠키 무효) 전역 안내. "네트워크 오류"로 오표시 금지 — 원인·해법을 정직하게.
function sessionLost(){var b=document.getElementById('sessbar');if(!b){b=document.createElement('div');b.id='sessbar';b.style.cssText='position:fixed;top:0;left:0;right:0;z-index:9999;background:#7f1d1d;color:#fff;padding:10px 14px;text-align:center;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,.4)';document.body.appendChild(b);}b.innerHTML='⚠️ 세션 만료 — 데몬이 재시작됐어요. 터미널/스크립트가 알려준 새 대시보드 URL(<b>?token=…</b>)로 다시 접속하세요.';}
/* ── 업그레이드 패널: 마켓 오버뷰 / 히어로 차트 / 스캐너 / 포트폴리오 (주식 위주, 코인 토글) ── */
var market='kr'; // 'kr'(키움 대형주, 기본) | 'crypto'(바이낸스)
var HERO_DEFAULT={kr:['kiwoom','005930','삼성전자'],crypto:['binance','BTCUSDT','BTC']};
function pctSpan(v){v=Number(v)||0;return '<span class="'+(v>=0?'up':'dn')+'">'+(v>=0?'+':'')+v.toFixed(2)+'%</span>';}
function pxStr(p){p=Number(p)||0;return market==='kr'?('₩'+Math.round(p).toLocaleString()):('$'+fmt(p,p<1?5:2));}
function fmtValue(n){n=Number(n)||0;if(market==='kr'){if(n>=1e12)return '₩'+(n/1e12).toFixed(1)+'조';if(n>=1e8)return '₩'+Math.round(n/1e8).toLocaleString()+'억';if(n>=1e4)return '₩'+Math.round(n/1e4).toLocaleString()+'만';return '₩'+Math.round(n);}if(n>=1e9)return '$'+(n/1e9).toFixed(1)+'B';if(n>=1e6)return '$'+(n/1e6).toFixed(1)+'M';if(n>=1e3)return '$'+(n/1e3).toFixed(0)+'K';return '$'+Math.round(n);}
function nameOf(it){return market==='kr'?(it.name||it.symbol):coin(it.symbol);}
function itBroker(it){return it.broker||(market==='kr'?'kiwoom':'binance');}
// 히어로 차트(메인) — 자체 상태(모달 차트와 분리), 브로커 인식
var heroChart=null,heroSeries=null,heroWs=null,heroPoll=null,heroBroker='kiwoom',heroSym='005930',heroTf='1d';
function heroIv(tf){return ({'1h':'1h','4h':'4h','1d':'1d','1w':'1w'})[tf]||'1d';}
function ensureHero(){if(heroChart)return;var el=document.getElementById('heroChart');if(!window.LightweightCharts||!LightweightCharts.createChart){el.innerHTML='<div class="skel">차트 라이브러리 로드 실패(오프라인?)</div>';return;}
 heroChart=LightweightCharts.createChart(el,{width:el.clientWidth,height:300,layout:{background:{color:'transparent'},textColor:'#8a94a6',fontSize:11},grid:{vertLines:{color:'#161c2a'},horzLines:{color:'#161c2a'}},rightPriceScale:{borderColor:'#222838'},timeScale:{borderColor:'#222838',timeVisible:heroTf!=='1d'&&heroTf!=='1w'},crosshair:{mode:0}});
 heroSeries=heroChart.addSeries(LightweightCharts.CandlestickSeries,{upColor:'#10b981',downColor:'#f43f5e',borderVisible:false,wickUpColor:'#10b981',wickDownColor:'#f43f5e'});
 window.addEventListener('resize',function(){if(heroChart)heroChart.applyOptions({width:el.clientWidth});});}
function heroTfBar(){var tfs=market==='kr'?[['1d','일']]:[['1h','1시간'],['1d','일'],['1w','주']];document.getElementById('heroTf').innerHTML=tfs.map(function(t){return '<span class="tfb '+(t[0]===heroTf?'on':'')+'" onclick="setHeroTf(&quot;'+t[0]+'&quot;)">'+t[1]+'</span>';}).join('');}
function setHeroTf(tf){heroTf=tf;if(heroChart)heroChart.applyOptions({timeScale:{timeVisible:tf!=='1d'&&tf!=='1w'}});heroTfBar();heroLoad(heroBroker,heroSym,document.getElementById('heroSym').textContent);}
function heroStopLive(){try{if(heroWs)heroWs.close();}catch(e){}heroWs=null;if(heroPoll){clearInterval(heroPoll);heroPoll=null;}}
function heroLoad(broker,sym,label,_tries){heroBroker=broker;heroSym=sym;ensureHero();if(!heroSeries)return;document.getElementById('heroSym').textContent=label||sym;heroTfBar();heroStopLive();
 var tries=_tries||0;
 var retry=function(){if(tries<4&&heroBroker===broker&&heroSym===sym)setTimeout(function(){heroLoad(broker,sym,label,tries+1);},2000);}; // 콜드스타트/일시 429로 첫 fetch 실패 시 자동 재시도(심볼 안 바뀐 동안만) → 빈 차트 자가복구
 fetch('/api/candles?bot=sym:'+encodeURIComponent(broker)+':'+encodeURIComponent(sym)+'&tf='+heroTf).then(function(r){return r.json()}).then(function(d){if(!d.ok||!d.bars){document.getElementById('heroPx').textContent='—';retry();return;}
  heroSeries.setData(d.bars);heroChart.timeScale().fitContent();var last=d.bars[d.bars.length-1];if(last)document.getElementById('heroPx').textContent=pxStr(last.close);heroLiveOn(broker,sym,last);}).catch(function(e){console.error('heroLoad 실패',e);document.getElementById('heroPx').textContent='—';retry();});}
function heroLiveOn(broker,sym,lastBar){
 if(broker==='binance'){try{heroWs=new WebSocket('wss://stream.binance.com:9443/ws/'+sym.toLowerCase()+'@kline_'+heroIv(heroTf));}catch(e){return;}
  heroWs.onmessage=function(e){if(!heroSeries)return;var k;try{k=JSON.parse(e.data).k}catch(err){return;}if(!k)return;try{heroSeries.update({time:Math.floor(k.t/1000),open:+k.o,high:+k.h,low:+k.l,close:+k.c});}catch(err){}document.getElementById('heroPx').textContent='$'+fmt(+k.c,+k.c<1?5:2);};}
 else{ // KR: WS 없음 → 현재가 폴링(15s)으로 헤드라인 가격만 갱신
  heroPoll=setInterval(function(){fetch('/api/quote?broker='+encodeURIComponent(broker)+'&symbol='+encodeURIComponent(sym)).then(function(r){return r.json()}).then(function(q){var p=q&&(q.price||q.last||q.currentPrice);if(p)document.getElementById('heroPx').textContent='₩'+Math.round(p).toLocaleString();}).catch(function(){});},15000);}}
// 마켓 오버뷰 + 코인/주식 토글
var REGLBL={trend_up:'📈 상승추세',trend_down:'📉 하락추세',range:'↔️ 횡보',high_vol:'⚡ 고변동'};
function mktToggleHtml(){return '<div class="mktoggle"><span class="mkt '+(market==='kr'?'on':'')+'" onclick="setMarket(&quot;kr&quot;)">📈 주식</span><span class="mkt '+(market==='crypto'?'on':'')+'" onclick="setMarket(&quot;crypto&quot;)">₿ 코인</span></div>';}
function setMarket(m){if(market===m)return;market=m;heroTf='1d';var hd=HERO_DEFAULT[m];document.getElementById('mstrip').innerHTML='<span class="skel">불러오는 중…</span>';document.getElementById('topvol').innerHTML='<span class="skel">불러오는 중…</span>';document.getElementById('scanbody').innerHTML='<span class="skel">불러오는 중…</span>';heroLoad(hd[0],hd[1],hd[2]);loadMarket();loadScan();}
function loadMarket(){var reqMarket=market;fetch('/api/market?market='+reqMarket).then(function(r){return r.json()}).then(function(d){if(reqMarket!==market)return;if(!d.ok){document.getElementById('mstrip').innerHTML=mktToggleHtml()+'<span class="skel">'+esc(d.error||'실패')+'</span>';return;}
 var chips=(d.majors||[]).map(function(m){return '<div class="mchip" onclick="heroLoad(&quot;'+esc(itBroker(m))+'&quot;,&quot;'+esc(m.symbol)+'&quot;,&quot;'+esc(nameOf(m))+'&quot;)"><div class="ms">'+esc(nameOf(m))+'</div><div class="mp">'+pxStr(m.price)+'</div><div class="mc">'+pctSpan(m.changePct)+'</div></div>';}).join('');
 var regsrc=market==='kr'?'삼성전자':'BTC';
 var reg=d.regime?'<div class="regbadge reg-'+esc(d.regime.label)+'"><span class="rl">'+(REGLBL[d.regime.label]||esc(d.regime.label))+'</span><span class="hint" style="font-weight:400">'+regsrc+'레짐 · ADX '+Math.round(d.regime.adx)+'</span></div>':'';
 document.getElementById('mstrip').innerHTML=mktToggleHtml()+chips+reg;
 document.getElementById('topvol').innerHTML=(d.topVolume||[]).map(function(t,i){return '<div class="lrow" onclick="heroLoad(&quot;'+esc(itBroker(t))+'&quot;,&quot;'+esc(t.symbol)+'&quot;,&quot;'+esc(nameOf(t))+'&quot;)"><div><span class="rank">'+(i+1)+'</span><span class="ls">'+esc(nameOf(t))+'</span><div class="lsub" style="margin-left:26px">거래대금 '+fmtValue(market==='kr'?t.value:t.quoteVolume)+'</div></div><div class="lr">'+pxStr(t.price)+'<div class="lsub">'+pctSpan(t.changePct)+'</div></div></div>';}).join('')||'<span class="skel">데이터 없음</span>';
 }).catch(function(e){console.error('loadMarket 실패',e);var ms=document.getElementById('mstrip');if(ms)ms.innerHTML=mktToggleHtml()+'<span class="skel">불러오기 실패</span>';var tv=document.getElementById('topvol');if(tv)tv.innerHTML='<span class="skel">불러오기 실패</span>';});}
// 스캐너
var SCANM=[['roc','모멘텀'],['relVolume','거래량급증'],['gapPct','갭'],['rangePct','변동성']];var scanMetric='roc';
function scanTabs(){document.getElementById('scantabs').innerHTML=SCANM.map(function(m){return '<span class="scantab '+(m[0]===scanMetric?'on':'')+'" onclick="setScan(&quot;'+m[0]+'&quot;)">'+esc(m[1])+'</span>';}).join('');}
function setScan(m){scanMetric=m;scanTabs();loadScan();}
function loadScan(){var b=document.getElementById('scanbody');b.innerHTML='<span class="skel">스캔 중…</span>';
 var reqMarket=market;fetch('/api/scan?metric='+scanMetric+'&market='+reqMarket).then(function(r){return r.json()}).then(function(d){if(reqMarket!==market)return;if(!d.ok){b.innerHTML='<span class="skel">'+esc(d.error||'실패')+'</span>';return;}
  var unit=scanMetric==='relVolume'?'x':'%';var signed=(scanMetric==='roc'||scanMetric==='gapPct'); // 부호·색은 등락 의미가 있는 모멘텀/갭만. relVolume(비율)·rangePct(변동성)은 항상 양수라 중립 표기
  b.innerHTML=(d.rows||[]).map(function(r,i){var cls=signed?(r.score>=0?'up':'dn'):'';var sign=(signed&&r.score>=0)?'+':'';return '<div class="lrow" onclick="heroLoad(&quot;'+esc(itBroker(r))+'&quot;,&quot;'+esc(r.symbol)+'&quot;,&quot;'+esc(nameOf(r))+'&quot;)"><div><span class="rank">'+(i+1)+'</span><span class="ls">'+esc(nameOf(r))+'</span></div><div class="lr"><span class="'+cls+'">'+sign+fmt(r.score,2)+unit+'</span><div class="lsub">'+pxStr(r.price)+'</div></div></div>';}).join('')||'<span class="skel">결과 없음</span>';
 }).catch(function(){b.innerHTML='<span class="skel">스캔 실패</span>';});}
// 포트폴리오(누적 실현손익 곡선 + 봇 성과)
var eqChart=null,eqSeries=null;
function loadPortfolio(){fetch('/api/portfolio').then(function(r){return r.json()}).then(function(d){if(!d.ok)return;
 var el=document.getElementById('eqChart'),em=document.getElementById('eqEmpty'),pts=d.curve||[];
 if(!pts.length){el.style.display='none';em.style.display='block';}
 else{el.style.display='block';em.style.display='none';
  if(!eqChart&&window.LightweightCharts){eqChart=LightweightCharts.createChart(el,{width:el.clientWidth,height:170,layout:{background:{color:'transparent'},textColor:'#8a94a6',fontSize:11},grid:{vertLines:{color:'#161c2a'},horzLines:{color:'#161c2a'}},rightPriceScale:{borderColor:'#222838'},timeScale:{borderColor:'#222838',timeVisible:false}});eqSeries=eqChart.addSeries(LightweightCharts.AreaSeries,{lineColor:'#7aa2f7',topColor:'rgba(122,162,247,.35)',bottomColor:'rgba(122,162,247,.02)',lineWidth:2,priceLineVisible:false});window.addEventListener('resize',function(){if(eqChart)eqChart.applyOptions({width:el.clientWidth});});}
  if(eqSeries){var seen={},data=[];for(var i=0;i<pts.length;i++){var t=pts[i].t;while(seen[t])t++;seen[t]=1;data.push({time:t,value:pts[i].cum});}eqSeries.setData(data);eqChart.timeScale().fitContent();}}
 var arr=(d.perBot||[]).filter(function(b){return b.closes>0||b.running;});
 document.getElementById('botperf').innerHTML=arr.slice(0,8).map(function(b){var v=b.realizedPnl;return '<div class="bpc"><div class="bn">'+(b.running?'🟢 ':'⚪ ')+esc(b.name)+'</div><div class="bv '+(v>=0?'up':'dn')+'">'+(v>=0?'+':'')+fmt(v,2)+'</div><div class="bm">승률 '+b.winRate+'% · '+b.closes+'청산 · '+esc(coin(b.symbol))+'</div></div>';}).join('');
 }).catch(function(e){console.error('loadPortfolio 실패',e);});}
(function(){var hd=HERO_DEFAULT[market];heroTfBar();heroLoad(hd[0],hd[1],hd[2]);scanTabs();loadMarket();loadScan();loadPortfolio();})();
setInterval(loadMarket,30000);setInterval(loadScan,60000);setInterval(loadPortfolio,30000);
const es=new EventSource('/events'); // same-origin SSE — 세션쿠키 자동 첨부
es.onmessage=e=>{const s=JSON.parse(e.data);bots=s.bots;document.getElementById('upd').textContent=new Date(s.updatedAt).toLocaleTimeString();subscribe();render();renderAlerts(s.alerts)};
es.onerror=function(){if(es.readyState===2)sessionLost();}; // readyState 2=CLOSED=재연결 불가(보통 세션만료/데몬재시작) → 정직 안내
render();renderWatch();loadBalances();setTimeout(loadPrices,2500);setInterval(loadBalances,60000);setInterval(loadPrices,45000);
setTimeout(loadRealAccounts,1500);setInterval(loadRealAccounts,60000); // 거래소 실계정 패널 폴링
</script></div></body></html>`;
}
