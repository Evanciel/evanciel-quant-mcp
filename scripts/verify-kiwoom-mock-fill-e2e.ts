/**
 * verify-kiwoom-mock-fill-e2e.ts — 키움 모의 "실제 체결" 왕복 머니패스 E2E.
 *   장중(09:00~15:30 평일)에 실행해야 함. 호가를 넘기는 공격적 지정가로 즉시 체결을 유도한다.
 *   ① 시세 → ② 잔고/보유 스냅샷 → ③ 공격적 지정가 매수(현재가 +1%, 즉시 체결) → 보유 +1 확인
 *   → ④ 공격적 지정가 매도(현재가 -1%, 즉시 체결) → 보유 원복 확인 → ⑤ 실현손익(잔고 델타) 보고.
 *   ※ 왕복 비용(스프레드+수수료)으로 실현손익은 소폭 마이너스가 정상 — 이건 "체결·정산이 실제로 된다"는
 *     증명이지 "수익"의 증명이 아니다(이 시스템 정체성: risk filter, not alpha source).
 * 실행: npx tsx scripts/verify-kiwoom-mock-fill-e2e.ts  (KIWOOM_ENV=mock 필요)
 * 안전: KIWOOM_ENV가 mock이 아니면 즉시 중단. 모의=가짜돈.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if ((process.env.KIWOOM_ENV || "mock") !== "mock") { console.error("❌ KIWOOM_ENV=mock 아님 — 실거래 안전중단"); process.exit(1); }

// KRX 정규장 개장 여부(평일 09:00~15:30 KST). 공휴일은 미반영(주문 거부로 자연 차단).
function krxRegularOpen(): { open: boolean; nowKst: string } {
  // Date.now()=UTC epoch(TZ 무관). +9h 후 getUTC*로 읽으면 KST 벽시계(머신 TZ 영향 없음).
  const kst = new Date(Date.now() + 9 * 60 * 60_000);
  const day = kst.getUTCDay(); // 0=일 6=토
  const mins = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const hhmm = `${String(kst.getUTCHours()).padStart(2, "0")}:${String(kst.getUTCMinutes()).padStart(2, "0")}`;
  const open = day >= 1 && day <= 5 && mins >= 9 * 60 && mins <= 15 * 60 + 30;
  return { open, nowKst: `${["일","월","화","수","목","금","토"][day]} ${hhmm}` };
}

const { getAdapter } = await import("../src/brokers/index.js");
const { roundToKrxTick } = await import("../src/brokers/krx-tick.js");
const SYMBOL = "005930"; // 삼성전자(유동성 높아 공격적 지정가 즉시 체결)
const QTY = 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const got = getAdapter("kiwoom");
if (!got) { console.error("어댑터 없음(키 로드 실패)"); process.exit(1); }
const a = got.adapter;

const { open, nowKst } = krxRegularOpen();
console.log(`── 키움 모의 "실제 체결" 왕복 E2E [env=${got.env}] (현재 ${nowKst} KST) ──`);
if (!open) {
  console.log(`⏸  KRX 정규장 시간이 아님(평일 09:00~15:30). 지금 주문하면 모의서버가 'RC4058 모의투자 장종료'로 거부함.`);
  console.log(`   → 장중(평일 09:00 이후)에 다시 실행하세요. 코드/연결은 정상이며, 시세·보유 조회는 아래에서 확인.`);
  try {
    const px = await a.getPrice(SYMBOL); console.log(`   참고 시세 ${SYMBOL}: ${px.price.toLocaleString()}원`);
    const held = (await a.getPositions()).filter((p) => p.symbol === SYMBOL).reduce((s, p) => s + p.quantity, 0);
    console.log(`   참고 보유 ${SYMBOL}: ${held}주`);
  } catch (e) { console.log(`   (조회 예외: ${e instanceof Error ? e.message : e})`); }
  process.exit(2); // 2 = 장외(실패 아님, 미실행)
}

// 보유 수량 헬퍼 + 폴링(키움 체결은 비동기 → 잠시 대기하며 보유 변화를 본다)
const heldOf = (ps: { symbol: string; quantity: number }[]) => ps.filter((p) => p.symbol === SYMBOL).reduce((s, p) => s + p.quantity, 0);
async function waitHeld(target: number, label: string, timeoutMs = 12_000): Promise<number> {
  const t0 = Date.now();
  let cur = heldOf(await a.getPositions());
  while (cur !== target && Date.now() - t0 < timeoutMs) { await sleep(1500); cur = heldOf(await a.getPositions()); }
  console.log(`     (${label}: 보유 ${cur}주 / 목표 ${target}주, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return cur;
}

console.log("");
try {
  // ① 시세
  const px = await a.getPrice(SYMBOL);
  ok(px.price > 0, `현재가 ${SYMBOL}: ${px.price.toLocaleString()}원`);

  // ② 잔고/보유 스냅샷
  const balBefore = await a.getBalance();
  const before = heldOf(await a.getPositions());
  ok(balBefore.cashBalance >= 0, `매수 전 예수금 ${balBefore.cashBalance.toLocaleString()}원, 보유 ${before}주`);

  const buyLimit = roundToKrxTick(Math.round(px.price * 1.01)); // +1% 넘겨 즉시 체결 유도
  if (balBefore.cashBalance < buyLimit * QTY) {
    console.log(`  ⚠️ 예수금 부족(${balBefore.cashBalance} < ${buyLimit * QTY}) — 매수 스킵`);
    process.exit(2);
  }

  // ③ 공격적 지정가 매수 → 체결 대기 → 보유 +QTY
  console.log(`  매수: ${QTY}주 @${buyLimit.toLocaleString()} (현재가 +1%, 즉시 체결 기대)`);
  const buy = await a.placeOrder({ symbol: SYMBOL, side: "buy", type: "limit", quantity: QTY, price: buyLimit });
  ok(buy.status !== "rejected" && !!buy.orderId, `매수 접수(orderId=${buy.orderId}, status=${buy.status})`);
  const afterBuy = await waitHeld(before + QTY, "매수 체결 대기");
  ok(afterBuy === before + QTY, `매수 체결 확인: 보유 ${before} → ${afterBuy}주 (+${QTY})`);

  // ④ 공격적 지정가 매도 → 체결 대기 → 보유 원복
  const px2 = await a.getPrice(SYMBOL);
  const sellLimit = roundToKrxTick(Math.round(px2.price * 0.99)); // -1% 낮춰 즉시 체결 유도
  console.log(`  매도: ${QTY}주 @${sellLimit.toLocaleString()} (현재가 -1%, 즉시 체결 기대)`);
  const sell = await a.placeOrder({ symbol: SYMBOL, side: "sell", type: "limit", quantity: QTY, price: sellLimit });
  ok(sell.status !== "rejected" && !!sell.orderId, `매도 접수(orderId=${sell.orderId}, status=${sell.status})`);
  const afterSell = await waitHeld(before, "매도 체결 대기");
  ok(afterSell === before, `매도 체결 확인: 보유 ${afterBuy} → ${afterSell}주 (원복)`);

  // ⑤ 실현손익(잔고 델타) — 왕복 비용으로 소폭 마이너스가 정상
  await sleep(1500);
  const balAfter = await a.getBalance();
  const realized = balAfter.cashBalance - balBefore.cashBalance;
  console.log(`\n  💰 왕복 실현손익(예수금 델타): ${realized >= 0 ? "+" : ""}${realized.toLocaleString()}원`);
  console.log(`     예수금 ${balBefore.cashBalance.toLocaleString()} → ${balAfter.cashBalance.toLocaleString()}원`);
  console.log(`     ※ 스프레드+수수료로 소폭 마이너스가 정상. 이건 "체결·정산이 실제로 된다"는 증명이지 수익 증명이 아님.`);
  ok(afterSell === before, "보유 원복(왕복 머니패스 무결)");
} catch (e) {
  console.log("🔴 예외:", e instanceof Error ? e.message : String(e)); fail++;
}

console.log(`\n${fail === 0 ? "🟢 PASS" : "🔴 FAIL"} — 키움 모의 실체결 왕복 E2E: ${pass} pass / ${fail} fail. 실거래(메인넷) OFF.`);
process.exit(fail === 0 ? 0 : 1);
