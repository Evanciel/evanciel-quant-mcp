/**
 * verify-kiwoom-mock-order-e2e.ts — 키움 모의 주문 머니패스 E2E.
 *   현재가 조회 → 시장가보다 한참 아래 지정가 매수(체결 안 됨, 호가 등록) → 취소 → 보유 0 확인.
 *   검증: 매수주문 접수(kt10000 + 바디 포맷) + 취소(kt10003 + stk_cd 필수 수정). 모의=가짜돈, 안전.
 * 실행: npx tsx scripts/verify-kiwoom-mock-order-e2e.ts (KIWOOM_ENV=mock 필요)
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if ((process.env.KIWOOM_ENV || "mock") !== "mock") { console.error("❌ KIWOOM_ENV=mock 아님 — 실거래 안전중단"); process.exit(1); }

const { getAdapter } = await import("../src/brokers/index.js");
const SYMBOL = "005930"; // 삼성전자
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const got = getAdapter("kiwoom");
if (!got) { console.error("어댑터 없음"); process.exit(1); }
const a = got.adapter;

console.log("── 키움 모의 주문 E2E (지정가 매수→취소) ──");
try {
  // 1) 현재가
  const px = await a.getPrice(SYMBOL);
  ok(px.price > 0, `현재가 ${SYMBOL}: ${px.price}`);

  // 2) 시장가 -15% 지정가 매수(±30% 일일제한 내, 시장가보다 낮아 미체결 → 호가 등록). 틱 100원 정렬.
  const limitPrice = Math.round((px.price * 0.85) / 100) * 100;
  console.log(`  지정가 매수 시도: 1주 @${limitPrice} (현재가 대비 -15%, 미체결 예상)`);
  const buy = await a.placeOrder({ symbol: SYMBOL, side: "buy", type: "limit", quantity: 1, price: limitPrice });
  ok(buy.status !== "rejected" && !!buy.orderId, `매수주문 접수(orderId=${buy.orderId}, status=${buy.status})`);

  await sleep(1500);

  // 3) 취소 (kt10003 + stk_cd 필수)
  if (buy.orderId) {
    const cancelled = await a.cancelOrder(buy.orderId, SYMBOL);
    ok(cancelled === true, `주문 취소(kt10003+stk_cd): ${cancelled}`);
  } else {
    ok(false, "orderId 없어 취소 불가");
  }

  await sleep(1500);

  // 4) 보유 0 확인(미체결이라 포지션 없어야)
  const pos = await a.getPositions();
  ok(pos.filter((p) => p.symbol === SYMBOL).length === 0, `보유 ${SYMBOL} 0주(미체결 확인). 전체 보유 ${pos.length}개`);
} catch (e) {
  console.log("🔴 예외:", e instanceof Error ? e.message : String(e)); fail++;
}

console.log(`\n${fail === 0 ? "🟢 PASS" : "🔴 FAIL"} — 키움 모의 주문 E2E: ${pass} pass / ${fail} fail. 실거래(메인넷) OFF.`);
process.exit(fail === 0 ? 0 : 1);
