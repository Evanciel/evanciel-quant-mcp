/**
 * verify-limit-bot-smoke.ts — 지정가 봇 생성 엔드포인트(/api/bot/limit) + 검증 스모크.
 *   대시보드 임시포트 기동 → POST로 limit_bracket 봇 생성 → 스토어에 limit_bracket·running 확인 → 즉시 정지.
 *   첫 틱은 재시작 그레이스(관측만)라 실주문 0. 정지 시 잔존주문 취소(그레이스라 no-op). 안전.
 * 실행: npx tsx scripts/verify-limit-bot-smoke.ts
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), "quant-mcp-lb-smoke");
const { startDashboard } = await import("../src/dashboard/server.js");
const store = await import("../src/store/db.js");
const { stopBot } = await import("../src/mcp-server/bot-handlers.js");

const { url, port } = await startDashboard(0);
const token = new URL(url).searchParams.get("token") || "";
const base = `http://127.0.0.1:${port}`;
const q = `token=${encodeURIComponent(token)}`;
const post = async (path: string, body: unknown) => (await fetch(`${base}${path}?${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

console.log(`── 지정가 봇 생성 스모크 (port ${port}) ──`);
try {
  // 1) 정상 생성: 매수가 far-below(미체결), 매도가 far-above. (binance=페이퍼/testnet, 첫 틱 그레이스라 실주문 0)
  const r = await post("/api/bot/limit", { broker: "binance", symbol: "btcusdt", buyPrice: 1000, quantity: 0.001, sellPrice: 900000 });
  ok(r.ok === true && typeof r.botId === "string", `봇 생성: ok=${r.ok}, botId=${r.botId}`);
  if (r.botId) {
    const b = store.getBot(r.botId);
    const comp = b ? store.getComposite(b.composite_strategy_id) : null;
    const root = comp?.root_node as { type?: string; buyPrice?: number; sellPrice?: number } | undefined;
    ok(!!b && b.status === "running", `봇 running: ${b?.status}`);
    ok(root?.type === "limit_bracket", `root_node 타입 limit_bracket: ${root?.type}`);
    ok(root?.buyPrice === 1000 && root?.sellPrice === 900000, `매수가/매도가 영속: ${root?.buyPrice}/${root?.sellPrice}`);
    // 즉시 정지(첫 틱 그레이스라 실주문 0, 잔존주문 취소 no-op)
    const st = await stopBot({ botId: r.botId });
    ok(st.ok === true, `정지: ${st.ok}`);
    const after = store.getBot(r.botId);
    ok(after?.status === "stopped", `정지 확인: ${after?.status}`);
  }

  // 2) 검증 reject: 수량 0
  const bad1 = await post("/api/bot/limit", { broker: "binance", symbol: "BTCUSDT", buyPrice: 1000, quantity: 0 });
  ok(bad1.ok === false, `수량 0 거부: ${bad1.error}`);
  // 3) 검증 reject: 매수가 음수
  const bad2 = await post("/api/bot/limit", { broker: "binance", symbol: "BTCUSDT", buyPrice: -5, quantity: 1 });
  ok(bad2.ok === false, `매수가 음수 거부: ${bad2.error}`);
  // 4) 검증 reject: 종목 없음
  const bad3 = await post("/api/bot/limit", { broker: "binance", symbol: "", buyPrice: 1000, quantity: 1 });
  ok(bad3.ok === false, `종목 없음 거부: ${bad3.error}`);
} catch (e) {
  fail++; console.log("🔴 예외:", e instanceof Error ? e.message : String(e));
}

console.log(`\n${fail === 0 ? "🟢 PASS" : "🔴 FAIL"} — 지정가 봇 생성 스모크: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
