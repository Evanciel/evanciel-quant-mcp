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
      market, isScanner,
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
.strat{font-size:12px;color:#c9d2e3;background:#0e1320;border:1px solid #222838;border-radius:6px;padding:6px 8px;margin-top:8px;font-family:ui-monospace,monospace;word-break:break-all}
.strat b{color:#8a94a6;font-weight:600}
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
.gear{cursor:pointer;color:#7aa2f7;font-size:12px;margin-left:8px;user-select:none}.gear:hover{color:#a8c0ff}
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
</style></head><body><div class="wrap">
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
<script>
const TOKEN=${JSON.stringify(token)};
let bots=[];const prices=new Map();let ws=null;
function fmt(n,d=2){return Number(n).toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d})}
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function allSyms(){return [...new Set(bots.flatMap(b=>(b.positions||[]).map(p=>p.symbol)))]}
let subSig='';
function subscribe(){const syms=allSyms().sort();const sig=syms.join(',');
 if(sig===subSig&&ws&&ws.readyState<=1)return; // 심볼 동일 + 연결 살아있으면 재구독 안 함(churn 방지)
 subSig=sig;if(ws){try{ws.close()}catch(e){}}
 if(!syms.length){ws=null;return;}const streams=syms.map(s=>s.toLowerCase()+'@ticker').join('/');
 ws=new WebSocket('wss://stream.binance.com:9443/ws/'+streams);
 ws.onmessage=e=>{const d=JSON.parse(e.data);if(d.e==='24hrTicker'){prices.set(d.s,parseFloat(d.c));render()}}}
function tgl(el){const s=el.nextElementSibling;s.style.display=s.style.display==='block'?'none':'block';}
const ACT={buy:'🟢 샀어요',sell:'🔴 팔았어요',hold:'유지',create:'봇 생성',start:'시작',stop:'정지',gate:'안내',error:'⚠ 오류'};
function coin(s){return String(s).replace('USDT','').replace('USDC','')}
function posRow(p){const cur=prices.get(p.symbol)??p.entryAvg;const sign=p.side==='short'?-1:1;
 const up=sign*(cur-p.entryAvg)/p.entryAvg*100;const abs=sign*(cur-p.entryAvg)*p.qty;
 const dir=p.side==='short'?' <span class="qty">하락베팅</span>':'';
 const html='<div class="prow"><div class="row"><div><b>'+esc(coin(p.symbol))+'</b>'+dir+' <span class="qty">'+p.qty+'개 보유</span></div>'+
   '<span class="pl '+(up>=0?'up':'dn')+'">'+(up>=0?'+':'')+fmt(up)+'%</span></div>'+
   '<div class="pmeta">산 가격 '+fmt(p.entryAvg)+' → 지금 '+fmt(cur)+' · 평가 <span class="'+(abs>=0?'up':'dn')+'">'+(abs>=0?'+':'')+fmt(abs)+'</span></div></div>';
 return {html,abs};}
function statusPill(sum,hasPos){if(!hasPos)return '<span class="pill wait">⚪ 대기 중</span>';
 return sum>=0?'<span class="pill win">🟢 수익 중</span>':'<span class="pill lose">🔴 손실 중</span>';}
function render(){const pos=document.getElementById('pos');let tot=0,n=0,rtot=0;pos.innerHTML='';
 for(const b of bots){const live=b.mode==='live';const ps=b.positions||[];rtot+=b.realizedPnl||0;
  let body='',bsum=0;
  if(ps.length){for(const p of ps){const r=posRow(p);tot+=r.abs;bsum+=r.abs;n++;body+=r.html;}}
  else body='<div class="prow" style="color:#8a94a6">지금은 대기 중이에요 (가진 것 없음)</div>';
  const rp=b.realizedPnl||0;const wr=b.winRate!=null?', '+b.closes+'번 중 '+Math.round(b.winRate*b.closes/100)+'번 수익':'';
  const earn=b.closes>0?'<div class="earn '+(rp>=0?'up':'dn')+'">💰 지금까지 '+(rp>=0?'+':'')+fmt(rp)+' '+(rp>=0?'벌었어요':'잃었어요')+' <span class="hint">('+b.closes+'번 거래'+wr+')</span></div>':'';
  const tags=(live?'<span class="st live">실거래</span>':'<span class="st stop">모의</span>')+
    '<span class="st '+(b.status==='running'?'run':'stop')+'">'+(b.status==='running'?'작동중':'멈춤')+'</span>'+
    (b.isScanner?'<span class="st sc">자동선별</span>':'');
  const acts=b.activity.slice(0,2).map(a=>'<div><span class="a">'+(ACT[a.action]||esc(a.action))+'</span><span>'+esc((a.detail||'').replace(/\[페이퍼\]|\[실거래\]/g,''))+'</span></div>').join('');
  const el=document.createElement('div');el.className='card';
  el.innerHTML='<div class="row"><div><span class="sym">'+esc(b.name)+'</span> '+statusPill(bsum,ps.length)+'</div></div>'+
   '<div class="tags">'+tags+'</div>'+
   '<div class="plain">📋 '+esc(b.plain)+'</div>'+
   '<div class="plist">'+body+'</div>'+earn+
   (acts?'<div class="act">'+acts+'</div>':'')+
   '<div class="more" onclick="tgl(this)">전략 자세히 ▾</div>'+
   '<div class="strat" style="display:none"><b>전문 표기</b> '+esc(b.strategy)+'</div>';
  pos.appendChild(el)}
 document.getElementById('bcnt').textContent=bots.filter(b=>b.status==='running').length;
 document.getElementById('cnt').textContent=n;
 const t=document.getElementById('tot');t.textContent=(tot>=0?'+':'')+fmt(tot);t.className='v '+(tot>=0?'up':'dn');
 const rt=document.getElementById('rtot');rt.textContent=(rtot>=0?'+':'')+fmt(rtot);rt.className='v '+(rtot>=0?'up':'dn');
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
const es=new EventSource('/events?token='+TOKEN);
es.onmessage=e=>{const s=JSON.parse(e.data);bots=s.bots;document.getElementById('upd').textContent=new Date(s.updatedAt).toLocaleTimeString();subscribe();render()};
render();
</script></div></body></html>`;
}
