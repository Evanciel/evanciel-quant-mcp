/**
 * verify-testnet-order-e2e.ts — testnet 소액 주문 + 상주 스톱 검증(자동 정리). 머니패스 계약 확인.
 * 검증: ① 시장가 매수 체결 ② getOrderByClientId reconcile ③ 상주 STOP 주문이 거래소에 걸리는지(스톱 매핑 검증) ④ 취소 ⑤ 청산.
 * 실행: npx tsx scripts/verify-testnet-order-e2e.ts (.env.local 자동 로드). 가짜돈(testnet).
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
const { planProtectiveOrders } = await import("../src/core/execution/protective.js");

const SYMBOL = "BTCUSDT";
const NOTIONAL = 20; // ~$20어치(캡 $50 이내)
const log = (s: string) => console.log(s);

async function main() {
  const gate = liveGate("binance", "spot");
  if (!gate.allowed || gate.env === "live") { log(`❌ 게이트 차단/메인넷: ${gate.reason}`); return; }
  const got = getAdapter("binance", "spot");
  if (!got) { log("❌ 어댑터 없음"); return; }
  const a = got.adapter;

  // 0) 가격 + 수량 정규화
  const px = (await a.getPrice(SYMBOL)).price;
  let qty = NOTIONAL / px;
  if (a.normalizeQuantity) qty = await a.normalizeQuantity(SYMBOL, qty, px);
  log(`가격 ${px} · 매수 수량 ${qty} (≈$${(qty * px).toFixed(2)})`);

  // 1) 시장가 매수
  const buyCid = `verify-${SYMBOL}-buy`;
  let entryQty = qty, entryPx = px;
  try {
    const r = await a.placeOrder({ symbol: SYMBOL, side: "buy", type: "market", quantity: qty, clientOrderId: buyCid });
    entryQty = r.quantity || qty; entryPx = r.price || px;
    log(`① 매수 체결: status=${r.status} qty=${entryQty} @ ${entryPx} (id=${r.orderId})`);
  } catch (e) { log(`① ❌ 매수 실패: ${e instanceof Error ? e.message : e}`); return; }

  // 2) reconcile (clientOrderId 조회)
  try {
    const o = a.getOrderByClientId ? await a.getOrderByClientId(SYMBOL, buyCid) : null;
    log(`② reconcile: ${o ? `status=${o.status} qty=${o.quantity}` : "조회불가/없음"}`);
  } catch (e) { log(`② reconcile 실패: ${e instanceof Error ? e.message : e}`); }

  // 3) 상주 보호주문(스톱) — planProtectiveOrders로 스펙 생성 → 실제 배치(스톱 매핑 검증)
  const prot = planProtectiveOrders({ botId: "verify", symbol: SYMBOL, positionSide: "long", qty: entryQty, entryAvg: entryPx, stopLossPercent: 10 });
  const sl = prot.find((p) => p.kind === "stop_loss")!;
  log(`③ 상주 스톱 시도: ${sl.type} ${sl.side} qty=${sl.quantity} stopPrice=${sl.stopPrice} (진입가 대비 -10%)`);
  let stopOrderId: string | null = null;
  try {
    const r = await a.placeOrder({ symbol: SYMBOL, side: sl.side, type: sl.type, quantity: sl.quantity, stopPrice: sl.stopPrice, reduceOnly: sl.reduceOnly, clientOrderId: sl.clientOrderId });
    stopOrderId = r.orderId;
    log(`③ ✅ 스톱 주문 수락됨: status=${r.status} (id=${r.orderId}) → 거래소에 상주(스톱 매핑 OK!)`);
  } catch (e) { log(`③ ⚠️ 스톱 주문 거부: ${e instanceof Error ? e.message : e} → 어댑터 스톱 파라미터 수정 필요`); }

  // 4) 스톱 취소(정리)
  if (stopOrderId) {
    try { const ok = await a.cancelOrder(stopOrderId, SYMBOL); log(`④ 스톱 취소: ${ok}`); }
    catch (e) { log(`④ 스톱 취소 실패: ${e instanceof Error ? e.message : e}`); }
  }

  // 5) 청산(정리) — 보유 수량 시장가 매도
  try {
    const r = await a.placeOrder({ symbol: SYMBOL, side: "sell", type: "market", quantity: entryQty, clientOrderId: `verify-${SYMBOL}-sell` });
    log(`⑤ 청산 체결: status=${r.status} qty=${r.quantity} @ ${r.price}`);
  } catch (e) { log(`⑤ ❌ 청산 실패(수동 정리 필요): ${e instanceof Error ? e.message : e}`); }

  log("\n검증 완료. 스톱 매핑 ③ 결과가 핵심(✅면 머니패스 계약 OK).");
}
main().catch((e) => { console.error("E2E 오류:", e); process.exit(1); });
