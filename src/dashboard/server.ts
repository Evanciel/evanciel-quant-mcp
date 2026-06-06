/**
 * dashboard/server.ts — 로컬 실시간 HTML 대시보드(컴패니언 HTTP+SSE). 리서치 권장 (a)안.
 * 보안: 127.0.0.1 바인딩 / 런치별 랜덤 토큰(/api·/events 필수) / Host 검증(DNS-rebinding 차단) /
 *       시크릿 절대 미전송(포지션·플랜만) / 읽기전용(주문 엔드포인트 없음).
 * 페이지가 Binance 공개 WS로 시세를 직접 받아 미실현손익을 클라이언트 계산(대문자 WS키 사용).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import * as store from "../store/db.js";

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

function snapshot() {
  const bots = store.listBots().map((b) => {
    const comp = store.getComposite(b.composite_strategy_id);
    const isScanner = (comp?.root_node as { type?: string })?.type === "scanner";
    const market = comp?.market ?? "spot";
    const st = store.tradeStats(b.id);
    return {
      id: b.id, name: b.name, symbol: b.symbol.toUpperCase(), mode: b.mode, status: b.status,
      strategy: comp ? summarizeStrategy(comp.root_node) : "(전략 없음)",
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
.plist{margin-top:8px}.prow{background:#0e1320;border:1px solid #222838;border-radius:8px;padding:8px 10px;margin-top:6px;font-size:12px}
.psym{font-weight:600;font-size:13px}.prow .g3{margin-top:6px}
@media(max-width:560px){.wrap{padding:14px}.hdr{grid-template-columns:1fr 1fr}.pos{grid-template-columns:1fr}.v{font-size:20px}}
</style></head><body><div class="wrap">
<h1>quant-mcp 라이브 대시보드 <span class="dot"></span></h1>
<div class="sub">봇별 전략 · 포지션 · 실시간 미실현손익(Binance WS) · 움직임 로그</div>
<div class="hdr">
  <div class="card"><div class="k">봇 / 오픈 포지션</div><div class="v"><span id="bcnt">0</span><span style="font-size:14px;color:#8a94a6"> / </span><span id="cnt">0</span></div></div>
  <div class="card"><div class="k">미실현 손익 (실시간)</div><div class="v" id="tot">+0.00</div></div>
  <div class="card"><div class="k">실현 손익 (누적) <span id="upd" style="font-size:10px;color:#8a94a6;font-weight:400">—</span></div><div class="v" id="rtot">+0.00</div></div>
</div>
<div class="pos" id="pos"></div>
<div class="empty" id="empty">봇이 없습니다. create_bot으로 봇을 만들고 start_bot으로 가동하세요.</div>
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
function posRow(p){const cur=prices.get(p.symbol)??p.entryAvg;const sign=p.side==='short'?-1:1;
 const up=sign*(cur-p.entryAvg)/p.entryAvg*100;const abs=sign*(cur-p.entryAvg)*p.qty;
 const badge='<span class="badge '+(p.side==='short'?'short':'')+'">'+(p.side==='short'?'숏':'롱')+'</span>';
 const html='<div class="prow"><div class="row"><div><span class="psym">'+esc(p.symbol)+'</span>'+badge+'</div>'+
   '<span class="pl '+(up>=0?'up':'dn')+'">'+(up>=0?'+':'')+fmt(up)+'%</span></div>'+
   '<div class="g3"><div><div class="k">진입</div>'+fmt(p.entryAvg)+'</div><div><div class="k">현재</div>'+fmt(cur)+'</div>'+
   '<div><div class="k">미실현</div><span class="'+(abs>=0?'up':'dn')+'">'+(abs>=0?'+':'')+fmt(abs)+'</span></div></div></div>';
 return {html,abs};}
function render(){const pos=document.getElementById('pos');let tot=0,n=0,rtot=0;pos.innerHTML='';
 for(const b of bots){const live=b.mode==='live';const ps=b.positions||[];rtot+=b.realizedPnl||0;
  let body='';
  if(ps.length){for(const p of ps){const r=posRow(p);tot+=r.abs;n++;body+=r.html;}}
  else body='<div class="prow" style="color:#8a94a6">관망 중 (포지션 없음)</div>';
  const rp=b.realizedPnl||0;const wr=b.winRate!=null?' · 승률 '+b.winRate+'%':'';
  const statBadge=b.closes>0?'<span class="st '+(rp>=0?'run':'stop')+'" title="누적 실현손익">실현 '+(rp>=0?'+':'')+fmt(rp)+' ('+b.closes+'회'+wr+')</span>':'';
  const scBadge=b.isScanner?'<span class="st sc">스캐너</span>':'';
  const el=document.createElement('div');el.className='card';
  el.innerHTML='<div class="row"><div><span class="sym">'+esc(b.name)+'</span>'+scBadge+
    '<span class="st '+(b.status==='running'?'run':'stop')+'">'+(b.status==='running'?'가동중':'중지')+'</span>'+
    (live?'<span class="st live">실거래</span>':'<span class="st stop">페이퍼</span>')+'</div>'+
    (ps.length?'<span class="mode">'+ps.length+'개 포지션</span>':'')+'</div>'+
   '<div class="strat"><b>전략</b> '+esc(b.strategy)+'</div>'+
   (statBadge?'<div style="margin-top:6px">'+statBadge+'</div>':'')+
   '<div class="plist">'+body+'</div>'+
   '<div class="act">'+(b.activity.length?b.activity.map(a=>'<div><span class="a">'+esc(a.action)+'</span><span>'+esc(a.detail||'')+'</span></div>').join(''):'<div>아직 활동 없음</div>')+'</div>';
  pos.appendChild(el)}
 document.getElementById('bcnt').textContent=bots.length;
 document.getElementById('cnt').textContent=n;
 const t=document.getElementById('tot');t.textContent=(tot>=0?'+':'')+fmt(tot);t.className='v '+(tot>=0?'up':'dn');
 const rt=document.getElementById('rtot');rt.textContent=(rtot>=0?'+':'')+fmt(rtot);rt.className='v '+(rtot>=0?'up':'dn');
 document.getElementById('empty').style.display=bots.length?'none':'block'}
const es=new EventSource('/events?token='+TOKEN);
es.onmessage=e=>{const s=JSON.parse(e.data);bots=s.bots;document.getElementById('upd').textContent=new Date(s.updatedAt).toLocaleTimeString();subscribe();render()};
render();
</script></div></body></html>`;
}
