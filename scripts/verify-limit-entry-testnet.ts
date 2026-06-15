/**
 * verify-limit-entry-testnet.ts — audit P1-5 라이브 지정가 진입 머니패스(Binance testnet). 가짜돈, 자동 정리.
 *   resolvePendingEntry가 매 틱 의존하는 실거래소 1차 동작을 확정:
 *   ① 시장가보다 한참 아래 지정가 매수 = 호가 등록(resting) ② getOrderByClientId(cid) = pending → classifyFillStatus "open"
 *   ③ cancelOrderByClientId(cid) = 취소(타임아웃 경로) ④ 취소 후 조회 = 사라짐(없음/취소).
 *   (pendingEntry 상태머신 로직은 test/pending-entry.test.ts. 이 스크립트는 실 testnet 1차 계약 검증.)
 * 실행: npx tsx scripts/verify-limit-entry-testnet.ts (.env.local 자동 로드).
 */
import { readFileSync } from "node:fs";
try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { console.error(".env.local 없음"); process.exit(1); }

const { getAdapter } = await import("../src/brokers/index.js");
const { liveGate } = await import("../src/brokers/safety.js");
const { classifyFillStatus } = await import("../src/core/execution/reconcile.js");

const SYMBOL = "BTCUSDT";
const NOTIONAL = 20;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)); // 인덱싱/취소 전파 대기(러너는 틱 간격이 흡수 — 실측 반영)
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

async function main() {
  const gate = liveGate("binance", "spot");
  if (!gate.allowed || gate.env === "live") { console.log(`❌ 게이트 차단/메인넷 — testnet 아님: ${gate.reason}`); process.exit(1); }
  const got = getAdapter("binance", "spot");
  if (!got) { console.log("❌ 어댑터 없음"); process.exit(1); }
  const a = got.adapter;
  if (!a.getOrderByClientId || !a.cancelOrderByClientId) { console.log("❌ getOrderByClientId/cancelOrderByClientId 미지원"); process.exit(1); }
  console.log("── Binance testnet 지정가 진입 머니패스 E2E (audit P1-5) ──");

  const px = (await a.getPrice(SYMBOL)).price;
  const limitPrice = Math.round(px * 0.9 * 100) / 100; // 현재가 -10% → 절대 즉시체결 안 됨(호가 등록)
  let qty = NOTIONAL / px;
  if (a.normalizeQuantity) qty = await a.normalizeQuantity(SYMBOL, qty, limitPrice);
  const cid = `verify-limit-${Date.now().toString(36)}`;

  // ① 지정가 매수 배치(resting)
  let placed = false;
  try {
    const r = await a.placeOrder({ symbol: SYMBOL, side: "buy", type: "limit", price: limitPrice, quantity: qty, clientOrderId: cid });
    placed = r.status !== "rejected";
    ok(placed, `지정가 매수 배치: status=${r.status} qty=${qty} @${limitPrice}(현재가 ${px} -10%) id=${r.orderId}`);
  } catch (e) { ok(false, `지정가 배치 실패: ${e instanceof Error ? e.message : e}`); }

  // ② cid 조회 → pending("open") 확인(resolvePendingEntry의 대기 판정 경로). 배치 직후 인덱싱 지연 → 잠시 대기(러너는 다음 틱).
  if (placed) {
    await sleep(3000);
    try {
      const o = await a.getOrderByClientId(SYMBOL, cid);
      const verdict = classifyFillStatus(o);
      ok(o != null && verdict === "open", `getOrderByClientId(cid) = status ${o?.status} → classifyFillStatus "${verdict}"(=open 대기)`);
    } catch (e) { ok(false, `cid 조회 실패: ${e instanceof Error ? e.message : e}`); }

    // ③ cid 취소(타임아웃 폴백의 취소 경로)
    try { const c = await a.cancelOrderByClientId(SYMBOL, cid); ok(c === true, `cancelOrderByClientId(cid) = ${c}`); }
    catch (e) { ok(false, `cid 취소 실패: ${e instanceof Error ? e.message : e}`); }

    // ④ 취소 후 조회 → 더 이상 open 아님(없음/취소). 취소 전파 대기.
    await sleep(3000);
    try {
      const o2 = await a.getOrderByClientId(SYMBOL, cid);
      const v2 = classifyFillStatus(o2);
      ok(v2 !== "open" && v2 !== "filled", `취소 후 조회: status ${o2?.status ?? "없음"} → "${v2}"(open/filled 아님 = 정리됨)`);
    } catch (e) { ok(false, `취소 후 조회 실패: ${e instanceof Error ? e.message : e}`); }
  }

  console.log(`\n${fail === 0 ? "🟢 PASS" : "🔴 FAIL"} — 지정가 진입 testnet 머니패스: ${pass} pass / ${fail} fail. 메인넷 OFF.`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("E2E 오류:", e); process.exit(1); });
