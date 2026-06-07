/** testnet-status.ts — 현재 testnet 계정 상태(잔고/포지션/미체결) 읽기전용 조회. .env.local 자동 로드. */
import { readFileSync } from "node:fs";
try { for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch { console.error(".env.local 없음"); process.exit(1); }
const { getAdapter } = await import("../src/brokers/index.js");
for (const market of ["spot", "futures"] as const) {
  const got = getAdapter("binance", market); if (!got) { console.log(market, "어댑터X"); continue; }
  const a = got.adapter as { getBalance: () => Promise<unknown>; getPositions: () => Promise<Array<{ symbol: string; quantity: number }>>; getOpenOrders?: (s: string) => Promise<unknown[]> };
  console.log(`\n=== binance ${market} (testnet) ===`);
  try { console.log("잔고:", JSON.stringify(await a.getBalance())); } catch (e) { console.log("잔고 실패:", e instanceof Error ? e.message : e); }
  try { const p = await a.getPositions(); const nz = p.filter((x) => Math.abs(x.quantity) > 1e-9 && /^[A-Z]{2,}$/.test(x.symbol)); console.log(`포지션(비영, 정상심볼) ${nz.length}:`, JSON.stringify(nz.slice(0, 10))); } catch (e) { console.log("포지션 실패:", e instanceof Error ? e.message : e); }
  if (market === "spot" && a.getOpenOrders) { try { const o = await a.getOpenOrders("BTCUSDT"); console.log(`BTCUSDT 미체결 주문 ${o.length}:`, JSON.stringify(o)); } catch (e) { console.log("주문조회 실패:", e instanceof Error ? e.message : e); } }
}
