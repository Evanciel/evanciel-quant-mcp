/**
 * verify-kiwoom-mock-open-orders-e2e.ts — 키움 모의 미체결조회(getOpenOrders=ka10075) 머니패스 E2E. audit P1-10.
 *   지정가 매수(미체결) → getOpenOrders에 해당 주문 떠야 함(orderId 일치, pending, 잔량) → 취소 → 목록에서 사라져야 함.
 *   모의=가짜돈, 안전. getOpenOrders가 실서버에서 실제로 동작함을 증명(스펙만으론 못 잡는 런타임 버그 색출).
 * 실행: npx tsx scripts/verify-kiwoom-mock-open-orders-e2e.ts (KIWOOM_ENV=mock 필요)
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
if ((process.env.KIWOOM_ENV || "mock") !== "mock") { console.error("❌ KIWOOM_ENV=mock 아님 — 실거래 안전중단"); process.exit(1); }

const { getAdapter } = await import("../src/brokers/index.js");
const SYMBOL = "005930";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const got = getAdapter("kiwoom", "spot");
if (!got) { console.error("어댑터 없음"); process.exit(1); }
const a = got.adapter;

console.log("── 키움 모의 미체결조회 E2E (getOpenOrders / ka10075) ──");
let orderId = "";
try {
  // 1) 현재가 → -15% 지정가 매수(체결 안 됨, 호가 등록). 틱 100원 정렬.
  const px = await a.getPrice(SYMBOL);
  const limitPrice = Math.round((px.price * 0.85) / 100) * 100;
  const buy = await a.placeOrder({ symbol: SYMBOL, side: "buy", type: "limit", quantity: 1, price: limitPrice });
  orderId = buy.orderId;
  ok(!!orderId && buy.status !== "rejected", `지정가 매수 접수(orderId=${orderId} @${limitPrice})`);
  await sleep(2500);

  // 2) getOpenOrders에 방금 주문이 떠야 한다.
  if (!a.getOpenOrders) { ok(false, "getOpenOrders 미구현"); throw new Error("no getOpenOrders"); }
  const open = await a.getOpenOrders(SYMBOL);
  const mine = open.find((o) => o.orderId === orderId);
  ok(!!mine, `getOpenOrders에 내 주문 존재(${open.length}건 중 orderId=${orderId} 매칭)`);
  if (mine) {
    ok(mine.status === "pending", `상태 pending (실제=${mine.status})`);
    ok(mine.side === "buy", `방향 buy (실제=${mine.side})`);
    ok(mine.quantity >= 1, `미체결 잔량 ≥1 (실제=${mine.quantity})`);
    ok(mine.symbol === SYMBOL, `종목 ${SYMBOL} (실제=${mine.symbol})`);
  }
  await sleep(2500);

  // 3) 취소 → getOpenOrders에서 사라져야 한다.
  const cancelled = await a.cancelOrder(orderId, SYMBOL);
  ok(cancelled === true, `주문 취소: ${cancelled}`);
  orderId = cancelled ? "" : orderId; // 취소 성공 시 finally 재취소 불필요
  await sleep(2500);
  const after = await a.getOpenOrders(SYMBOL);
  ok(!after.find((o) => o.orderId === buy.orderId), `취소 후 목록에서 사라짐(잔여 ${after.length}건)`);
} catch (e) {
  console.log("🔴 예외:", e instanceof Error ? e.message : String(e)); fail++;
} finally {
  if (orderId) { try { await a.cancelOrder(orderId, SYMBOL); console.log(`정리: 주문 ${orderId} 취소`); } catch { /* best-effort */ } }
}

console.log(`\n${fail === 0 ? "🟢 PASS" : "🔴 FAIL"} — 키움 미체결조회 E2E: ${pass} pass / ${fail} fail. 실거래(메인넷) OFF.`);
process.exit(fail === 0 ? 0 : 1);
