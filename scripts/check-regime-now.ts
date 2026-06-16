/** check-regime-now.ts — 지금 BTC/ETH 일봉 레짐 확인(봇 관망이 올바른 결정인지 검증). 실행: npx tsx scripts/check-regime-now.ts */
import { fetchKlines } from "../src/data/binance-public.js";
import { computeRegime } from "../src/core/backtest/regime.js";
for (const s of ["BTCUSDT", "ETHUSDT"]) {
  const d = await fetchKlines(s, "1d", 300);
  const r = computeRegime(d.map((b) => b.close), d.map((b) => b.high), d.map((b) => b.low));
  const act = r.label === "trend_up" ? "보유(매수)" : "관망(매수 안 함)";
  console.log(`${s}: 레짐=${r.label} → 봇 결정=${act}  [최신봉 ${d[d.length - 1].date} close=${d[d.length - 1].close}]`);
}
