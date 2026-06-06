/**
 * verify-scanner-e2e.ts — 실 Binance 데이터로 scan_universe + 스프레드/레짐/앵커 backtest 스모크.
 * 키 불필요(공개 REST). 네트워크 차단(451) 시 부분 degrade 출력.
 */
import { scanUniverse, backtest } from "../src/mcp-server/handlers.js";

const UNIVERSE = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];

async function main() {
  console.log("== scan_universe (roc 상위 3, 1h) ==");
  const scan = await scanUniverse({ universe: UNIVERSE, metric: "roc", top: 3, interval: "1h", period: 24, bars: 60 });
  console.log(JSON.stringify(scan, null, 2));

  console.log("\n== scan_universe (relVolume 상위 3, 5m) ==");
  const scanVol = await scanUniverse({ universe: UNIVERSE, metric: "relVolume", top: 3, interval: "5m", period: 20, bars: 60 });
  console.log(JSON.stringify({ ok: scanVol.ok, ranked: (scanVol as { ranked?: unknown }).ranked, skipped: (scanVol as { skipped?: unknown }).skipped }, null, 2));

  console.log("\n== spread 조건 backtest (ETH/BTC ratio) ==");
  const spreadTree = {
    id: "cn", type: "condition", name: "ETH/BTC 강세",
    condition: { type: "spread", symbolB: "BTCUSDT", expr: "zscore", lookback: 20, operator: "gt", value: 0 },
    thenNode: { id: "l", type: "leaf", name: "buy", strategy: { id: "s", userId: "u", name: "s", description: "", symbol: "ETHUSDT", rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 14 }, operator: "lt", value: 70 }], quantityPercent: 100 }, { id: "se", action: "sell", conditions: [{ id: "c2", indicator: "rsi", params: { period: 14 }, operator: "gt", value: 70 }], quantityPercent: 100 }], isActive: true, createdAt: new Date(), updatedAt: new Date() } },
  };
  const sres = await backtest({ tree: spreadTree as never, symbol: "ETHUSDT", interval: "4h", days: 200 });
  console.log(JSON.stringify({ ok: sres.ok, stats: (sres as { stats?: unknown }).stats, oosRobust: (sres as { verdict?: { oosRobust?: unknown } }).verdict?.oosRobust }, null, 2));

  console.log("\n== regime 조건 backtest (추세장만 RSI) ==");
  const regimeTree = {
    id: "cn", type: "condition", name: "추세장 게이트",
    condition: { type: "regime", in: ["trend_up", "trend_down"] },
    thenNode: { id: "l", type: "leaf", name: "rsi", strategy: { id: "s", userId: "u", name: "s", description: "", symbol: "BTCUSDT", rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 14 }, operator: "lt", value: 35 }], quantityPercent: 100 }, { id: "se", action: "sell", conditions: [{ id: "c2", indicator: "rsi", params: { period: 14 }, operator: "gt", value: 65 }], quantityPercent: 100 }], isActive: true, createdAt: new Date(), updatedAt: new Date() } },
  };
  const rres = await backtest({ tree: regimeTree as never, symbol: "BTCUSDT", interval: "1d", days: 300 });
  console.log(JSON.stringify({ ok: rres.ok, stats: (rres as { stats?: unknown }).stats }, null, 2));

  console.log("\n== MTF 조건 backtest (4h 추세 + 15m 진입) ==");
  const mtfTree = {
    id: "cn", type: "condition", name: "4h SMA 추세 필터",
    condition: { type: "indicator", indicator: "sma", params: { period: 50 }, operator: "gt", value: 0, timeframe: "4h" }, // 4h sma>0(항상참, MTF 페치·정렬 경로 검증)
    thenNode: { id: "l", type: "leaf", name: "rsi", strategy: { id: "s", userId: "u", name: "s", description: "", symbol: "BTCUSDT", rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 14 }, operator: "lt", value: 35 }], quantityPercent: 100 }, { id: "se", action: "sell", conditions: [{ id: "c2", indicator: "rsi", params: { period: 14 }, operator: "gt", value: 65 }], quantityPercent: 100 }], isActive: true, createdAt: new Date(), updatedAt: new Date() } },
  };
  const mres = await backtest({ tree: mtfTree as never, symbol: "BTCUSDT", interval: "15m", days: 500 });
  console.log(JSON.stringify({ ok: mres.ok, stats: (mres as { stats?: unknown }).stats }, null, 2));

  const pass = scan.ok && sres.ok && rres.ok && mres.ok;
  console.log(`\n${pass ? "✅ E2E PASS" : "⚠️ 부분 실패(네트워크/지역차단 가능)"}`);
}
main().catch((e) => { console.error("E2E error:", e); process.exit(1); });
