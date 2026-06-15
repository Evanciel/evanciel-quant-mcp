/**
 * verify-kis-e2e.ts — KIS(한투) 모의서버(openapivts:29443) 주문 머니패스 E2E. (audit P0-4 완료 기준)
 *   ① 토큰 → ② 잔고 → ③ 시세 → ④ 미정렬 지정가 매수(어댑터가 KRX 틱 정렬해 접수돼야 함, -15%라 미체결)
 *   → ⑤ 취소 → 보유 불변 확인. 모의=가짜돈, 안전.
 * 실행: npx tsx scripts/verify-kis-e2e.ts
 * 필요 키(.env.local): KIS_ENV=mock / KIS_APPKEY / KIS_APPSECRET / KIS_ACCOUNT(예: 12345678-01)
 *   — 모의투자 앱키는 KIS 개발자센터(apiportal.koreainvestment.com)에서 발급.
 * 안전: KIS_ENV가 mock이 아니면 즉시 중단(실계좌 오발사 차단).
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if ((process.env.KIS_ENV || "mock") !== "mock") { console.error("❌ KIS_ENV=mock 아님 — 실거래 안전중단"); process.exit(1); }
if (!(process.env.KIS_APPKEY || process.env.KIS_APP_KEY) || !(process.env.KIS_APPSECRET || process.env.KIS_APP_SECRET) || !(process.env.KIS_ACCOUNT || process.env.KIS_ACCOUNT_NO)) {
  console.error("❌ KIS 모의투자 키 미설정(KIS_APPKEY/KIS_APPSECRET/KIS_ACCOUNT 또는 변형 _APP_KEY/_APP_SECRET/_ACCOUNT_NO) — E2E 실행 불가");
  process.exit(1);
}

const { getAdapter } = await import("../src/brokers/index.js");
const { roundToKrxTick } = await import("../src/brokers/krx-tick.js");
const SYMBOL = "005930"; // 삼성전자
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const got = getAdapter("kis");
if (!got) { console.error("어댑터 없음(키 로드 실패)"); process.exit(1); }
const a = got.adapter;

console.log(`── KIS 모의 주문 E2E (토큰→잔고→시세→지정가 매수→취소) [env=${got.env}] ──`);
try {
  // ①+② 잔고(토큰 발급 포함 — 첫 호출이 OAuth 경유)
  const bal = await a.getBalance();
  ok(bal.cashBalance >= 0, `잔고 조회: 예수금 ${bal.cashBalance.toLocaleString()}원`);

  // 보유 스냅샷(취소 후 불변 검증용)
  const heldOf = (ps: { symbol: string; quantity: number }[]) => ps.filter((p) => p.symbol === SYMBOL).reduce((s, p) => s + p.quantity, 0);
  const before = heldOf(await a.getPositions());
  ok(true, `테스트 전 보유 ${SYMBOL}: ${before}주`);

  // ③ 시세
  const px = await a.getPrice(SYMBOL);
  ok(px.price > 0, `현재가 ${SYMBOL}: ${px.price.toLocaleString()}원`);

  // ④ 미정렬 지정가 매수: -15% 후 일부러 +7원 비틀어 어댑터 틱 정렬을 실서버로 검증(±30% 일일제한 내, 미체결 예상).
  const rawLimit = Math.floor(px.price * 0.85) + 7;
  const expected = roundToKrxTick(rawLimit);
  console.log(`  지정가 매수 시도: 1주 @${rawLimit}(미정렬) → 어댑터 정렬 기대 ${expected}`);
  const buy = await a.placeOrder({ symbol: SYMBOL, side: "buy", type: "limit", quantity: 1, price: rawLimit });
  ok(buy.status !== "rejected" && !!buy.orderId, `매수주문 접수(orderId=${buy.orderId}, status=${buy.status}) — 틱 미정렬이면 여기서 거부됐어야 함`);
  ok(buy.price === expected, `OrderResult.price=전송 정렬가 ${buy.price} (기대 ${expected})`);

  await sleep(1500);

  // ⑤ 취소 → 보유 불변
  const cancelled = await a.cancelOrder(buy.orderId, SYMBOL);
  ok(cancelled, `주문 취소(${buy.orderId})`);
  await sleep(1500);
  const after = heldOf(await a.getPositions());
  ok(after === before, `보유 불변(${before} → ${after})`);
} catch (e) {
  fail++;
  console.error(`  ❌ 예외: ${e instanceof Error ? e.message : e}`);
}

console.log(`\n결과: ${pass} PASS / ${fail} FAIL ${fail === 0 ? "🟢" : "🔴"}`);
process.exit(fail === 0 ? 0 : 1);
