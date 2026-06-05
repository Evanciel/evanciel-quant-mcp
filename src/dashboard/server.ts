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

function snapshot() {
  const positions = [];
  for (const b of store.listBots()) {
    const ps = b.position_state as { status?: string; entryAvg?: number; qty?: number } | null;
    if (!ps || ps.status !== "open" || !ps.entryAvg || !ps.qty) continue;
    positions.push({ id: b.id, name: b.name, symbol: b.symbol.toUpperCase(), side: "long", entryAvg: ps.entryAvg, qty: ps.qty, mode: b.mode });
  }
  return { positions, updatedAt: new Date().toISOString() };
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
</style></head><body><div class="wrap">
<h1>quant-mcp 라이브 대시보드 <span class="dot"></span></h1>
<div class="sub">봇이 지금 든 포지션 · 실시간 미실현손익(Binance WS) · <span class="mode">페이퍼</span></div>
<div class="hdr">
  <div class="card"><div class="k">오픈 포지션</div><div class="v" id="cnt">0</div></div>
  <div class="card"><div class="k">미실현 손익 (실시간)</div><div class="v" id="tot">+0.00</div></div>
  <div class="card"><div class="k">갱신</div><div class="v" id="upd" style="font-size:15px">—</div></div>
</div>
<div class="pos" id="pos"></div>
<div class="empty" id="empty">오픈 포지션이 없습니다. 봇이 진입 신호를 대기 중입니다.</div>
<script>
const TOKEN=${JSON.stringify(token)};
let positions=[];const prices=new Map();let ws=null;
function fmt(n,d=2){return Number(n).toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d})}
function subscribe(){const syms=[...new Set(positions.map(p=>p.symbol))];if(ws){try{ws.close()}catch(e){}}
 if(!syms.length)return;const streams=syms.map(s=>s.toLowerCase()+'@ticker').join('/');
 ws=new WebSocket('wss://stream.binance.com:9443/ws/'+streams);
 ws.onmessage=e=>{const d=JSON.parse(e.data);if(d.e==='24hrTicker'){prices.set(d.s,parseFloat(d.c));render()}}}
function render(){const pos=document.getElementById('pos');let tot=0,n=0;pos.innerHTML='';
 for(const p of positions){const cur=prices.get(p.symbol)??p.entryAvg;const up=(cur-p.entryAvg)/p.entryAvg*100;const abs=(cur-p.entryAvg)*p.qty;tot+=abs;n++;
  const el=document.createElement('div');el.className='card';
  el.innerHTML='<div class="row"><div><span class="sym">'+p.symbol+'</span><span class="badge">롱'+(p.mode==='paper'?' 페이퍼':'')+'</span></div>'+
   '<div class="pl '+(up>=0?'up':'dn')+'">'+(up>=0?'+':'')+fmt(up)+'%</div></div>'+
   '<div class="g3"><div><div class="k">진입가</div>'+fmt(p.entryAvg)+'</div><div><div class="k">현재가</div>'+fmt(cur)+'</div><div><div class="k">수량</div>'+p.qty+'</div></div>'+
   '<div class="row" style="margin-top:8px"><div class="k">'+p.name+'</div><div class="'+(abs>=0?'up':'dn')+'">'+(abs>=0?'+':'')+fmt(abs)+'</div></div>';
  pos.appendChild(el)}
 document.getElementById('cnt').textContent=n;
 const t=document.getElementById('tot');t.textContent=(tot>=0?'+':'')+fmt(tot);t.className='v '+(tot>=0?'up':'dn');
 document.getElementById('empty').style.display=n?'none':'block'}
const es=new EventSource('/events?token='+TOKEN);
es.onmessage=e=>{const s=JSON.parse(e.data);positions=s.positions;document.getElementById('upd').textContent=new Date(s.updatedAt).toLocaleTimeString();subscribe();render()};
render();
</script></div></body></html>`;
}
