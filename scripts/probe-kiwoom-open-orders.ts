/**
 * probe-kiwoom-open-orders.ts — 키움 모의 미체결요청(ka10075) 응답 구조 탐침. 읽기전용(주문은 미체결 1건 생성 후 취소).
 *   추측 대신 실서버 응답키(배열키 'oso'?, ord_no/oso_qty/side 필드명)를 확정해 getOpenOrders를 정확히 구현하려는 1회용 프로브.
 *   절차: 시장가 -15% 지정가 매수(체결 안 됨=호가 등록) → ka10075 경로/바디 후보 덤프 → 취소.
 * 실행: npx tsx scripts/probe-kiwoom-open-orders.ts (KIWOOM_ENV=mock + 키 .env.local 필요)
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
if ((process.env.KIWOOM_ENV || "mock") !== "mock") { console.error("❌ KIWOOM_ENV=mock 아님 — 실거래 안전중단"); process.exit(1); }

const { getAdapter } = await import("../src/brokers/index.js");
const SYMBOL = "005930"; // 삼성전자
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const got = getAdapter("kiwoom", "spot");
if (!got) { console.error("키움 어댑터 없음(키 확인)"); process.exit(1); }
const a = got.adapter as unknown as {
  getPrice: (s: string) => Promise<{ price: number }>;
  placeOrder: (o: Record<string, unknown>) => Promise<{ orderId: string; status: string }>;
  cancelOrder: (id: string, sym?: string) => Promise<boolean>;
  post: (p: string, id: string, b: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }>;
};

const dump = (label: string, data: Record<string, unknown>) => {
  const arrKey = Object.keys(data).find((k) => Array.isArray(data[k]));
  const arr = arrKey ? (data[arrKey] as Record<string, unknown>[]) : [];
  console.log(`\n=== ${label} ===`);
  console.log("return_code:", data.return_code, "| return_msg:", data.return_msg);
  console.log("top-level keys:", Object.keys(data).join(","));
  console.log("arrayKey:", arrKey, "| len:", arr.length);
  if (arr[0]) { console.log("row0 keys:", Object.keys(arr[0]).join(",")); console.log("row0:", JSON.stringify(arr[0])); }
};

let orderId = "";
try {
  // 1) 현재가 → 시장가 -15% 지정가 매수(미체결 1건 생성). 틱 100원 정렬.
  const px = await a.getPrice(SYMBOL);
  const limitPrice = Math.round((px.price * 0.85) / 100) * 100;
  console.log(`현재가 ${SYMBOL}=${px.price} → 지정가 매수 1주 @${limitPrice} (미체결 예상)`);
  const buy = await a.placeOrder({ symbol: SYMBOL, side: "buy", type: "limit", quantity: 1, price: limitPrice });
  orderId = buy.orderId;
  console.log(`매수 접수: orderId=${orderId}, status=${buy.status}`);
  await sleep(2500);

  // 2) ka10075 경로/바디 후보 덤프. stex_tp(숫자) = triple-confirmed(spec); dmst_stex_tp="KRX"는 fallback.
  const combos: [string, string, Record<string, unknown>][] = [
    ["acnt · stex_tp=0 · 종목지정", "/api/dostk/acnt", { all_stk_tp: "0", trde_tp: "0", stk_cd: SYMBOL, stex_tp: "0" }],
    ["acnt · stex_tp=0 · 전체", "/api/dostk/acnt", { all_stk_tp: "1", trde_tp: "0", stk_cd: "", stex_tp: "0" }],
    ["acnt · dmst_stex_tp=KRX(fallback)", "/api/dostk/acnt", { all_stk_tp: "0", trde_tp: "0", stk_cd: SYMBOL, dmst_stex_tp: "KRX" }],
    ["ordr(fallback path)", "/api/dostk/ordr", { all_stk_tp: "0", trde_tp: "0", stk_cd: SYMBOL, stex_tp: "0" }],
  ];
  for (const [label, path, body] of combos) {
    try { const { data } = await a.post(path, "ka10075", body); dump(label, data); }
    catch (e) { console.log(`\n=== ${label} ===\nERR`, e instanceof Error ? e.message : e); }
    await sleep(3500);
  }
} catch (e) {
  console.log("🔴 예외:", e instanceof Error ? e.message : String(e));
} finally {
  // 3) 정리 — 만든 미체결 주문 취소.
  if (orderId) {
    try { const c = await a.cancelOrder(orderId, SYMBOL); console.log(`\n정리: 주문 ${orderId} 취소 → ${c}`); }
    catch (e) { console.log("정리 취소 실패:", e instanceof Error ? e.message : e); }
  }
  process.exit(0);
}
