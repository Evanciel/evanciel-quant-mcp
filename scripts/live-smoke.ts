/**
 * live-smoke.ts — 실 Binance 공개 데이터로 네트워크 툴 E2E 스모크(수동 검증용, CI 제외).
 * 실행: npx tsx scripts/live-smoke.ts
 * 데이터 레이어(fetchKlines/fetchDerivatives) + 엔진 + OOS/사이징/레짐 전 경로가 실제로 도는지 확인.
 */
import { backtest, detectRegime, suggestPositionSize, derivativesSignal } from "../src/mcp-server/handlers.js";

const leaf = {
  id: "leaf", type: "leaf", name: "RSI",
  strategy: {
    id: "s", userId: "u", name: "RSI", description: "", symbol: "BTCUSDT",
    rules: [
      { id: "b", action: "buy", conditions: [{ id: "c1", indicator: "rsi", params: { period: 14 }, operator: "lt", value: 35 }], quantityPercent: 100 },
      { id: "s", action: "sell", conditions: [{ id: "c2", indicator: "rsi", params: { period: 14 }, operator: "gt", value: 65 }], quantityPercent: 100 },
    ],
    isActive: true, createdAt: new Date("2025-01-01"), updatedAt: new Date("2025-01-01"),
  },
};

async function main() {
  console.error("=== quant-mcp live smoke (real Binance public data) ===");

  const bt = await backtest({ tree: leaf as never, symbol: "BTCUSDT", interval: "1d", days: 300 });
  console.error("[backtest BTCUSDT 1d 300]", JSON.stringify(bt.ok ? { stats: (bt as { stats: unknown }).stats, oosRobust: (bt as { verdict: { oosRobust: unknown } }).verdict.oosRobust } : bt));

  const reg = await detectRegime({ symbol: "BTCUSDT", interval: "1d", days: 200 });
  console.error("[detect_regime]", JSON.stringify(reg.ok ? { label: (reg as { label: unknown }).label, adx: (reg as { adx: unknown }).adx } : reg));

  const sz = await suggestPositionSize({ symbol: "BTCUSDT", interval: "1d", days: 200, equity: 100_000, method: "vol_target", targetVolAnnual: 0.2 });
  console.error("[suggest_position_size volTarget]", JSON.stringify(sz.ok ? { price: (sz as { price: unknown }).price, notional: (sz as { notional: unknown }).notional, realizedVolAnnual: (sz as { realizedVolAnnual: unknown }).realizedVolAnnual } : sz));

  const dv = await derivativesSignal({ symbol: "BTCUSDT", period: "1h", lookback: 24 });
  console.error("[derivatives_signal]", JSON.stringify(dv.ok ? { fetched: (dv as { fetched: unknown }).fetched, fundingApr: (dv as { fundingApr: unknown }).fundingApr } : dv));

  const allOk = bt.ok && reg.ok && sz.ok && dv.ok;
  console.error(allOk ? "\n✅ LIVE SMOKE PASS — 전 경로 실데이터 동작" : "\n⚠️ 일부 실패(네트워크/지역차단 가능)");
  process.exit(allOk ? 0 : 1);
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
