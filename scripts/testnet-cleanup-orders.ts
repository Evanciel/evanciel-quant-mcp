/**
 * testnet-cleanup-orders.ts — 심볼의 미체결(상주) 주문 조회 + 전부 취소(고아주문 정리/운영 점검).
 * 실행: npx tsx scripts/testnet-cleanup-orders.ts [SYMBOL] (기본 BTCUSDT). .env.local 자동 로드.
 */
import { readFileSync } from "node:fs";
try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { console.error(".env.local 없음"); process.exit(1); }

const { getAdapter } = await import("../src/brokers/index.js");
const SYMBOL = process.argv[2] || "BTCUSDT";

for (const market of ["spot"] as const) {
  const got = getAdapter("binance", market);
  if (!got) { console.log(`${market} 어댑터 없음`); continue; }
  const a = got.adapter as { getOpenOrders?: (s: string) => Promise<Array<{ orderId: string; side: string; quantity: number; price: number }>>; cancelOrder: (id: string, s?: string) => Promise<boolean> };
  if (!a.getOpenOrders) { console.log("getOpenOrders 미지원"); continue; }
  const open = await a.getOpenOrders(SYMBOL);
  console.log(`\n=== ${SYMBOL} (${market}) 미체결 주문 ${open.length}건 ===`);
  for (const o of open) {
    console.log(`  ${o.orderId} ${o.side} qty=${o.quantity} @${o.price}`);
    try { const ok = await a.cancelOrder(o.orderId, SYMBOL); console.log(`    → 취소 ${ok}`); }
    catch (e) { console.log(`    → 취소 실패: ${e instanceof Error ? e.message : e}`); }
  }
  console.log(open.length ? "정리 완료." : "고아 주문 없음(깨끗).");
}
