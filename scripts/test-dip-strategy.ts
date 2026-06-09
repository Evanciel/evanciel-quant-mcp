/**
 * test-dip-strategy.ts — "급락 역추세(dip-buy)" 전략 정직 백테스트 + 임계값 스윕.
 *   규칙: roc(p봉) < -d% (급락) → 자본 10% 매수, 손절 -3% / 익절 +5%, 반등(roc>+d) 청산.
 *   실 Binance 데이터(하락장 포함)로 검증. 미화 없이 진짜 수익/MDD/승률/OOS 출력.
 *   분봉 5%는 거의 안 터져(거래0) → 실제로 진입하는 임계값까지 스윕해 정직 비교.
 * 실행: npx tsx scripts/test-dip-strategy.ts
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-dip-${process.pid}`);
const H = await import("../src/mcp-server/handlers.js");
const now = new Date();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dipTree(symbol: string, rocPeriod: number, dropPct: number, sl = 3, tp = 5): any {
  return {
    id: "l", type: "leaf", name: "급락매수",
    strategy: {
      id: "s", userId: "u", name: `dip(roc${rocPeriod}<-${dropPct})`, description: "", symbol,
      rules: [
        { id: "b", action: "buy", conditions: [{ id: "cb", indicator: "roc", params: { period: rocPeriod }, operator: "lt", value: -dropPct }], quantityPercent: 10 },
        { id: "se", action: "sell", conditions: [{ id: "cs", indicator: "roc", params: { period: rocPeriod }, operator: "gt", value: dropPct }], quantityPercent: 100 },
      ],
      stopLossPercent: sl, takeProfitPercent: tp, isActive: true, createdAt: now, updatedAt: now,
    },
  };
}

// [interval, days(봉수), rocPeriod, dropPct] — 실제로 진입하는 수준으로 임계값 완화
const configs: [string, number, number, number][] = [
  ["5m", 5000, 3, 2],   // 15분 동안 2% 급락
  ["5m", 5000, 6, 3],   // 30분 동안 3% 급락
  ["15m", 3000, 3, 3],  // 45분 동안 3%
  ["1h", 2000, 4, 5],   // 4시간 동안 5%
  ["1d", 730, 3, 5],    // 3일 동안 5%(원안)
];
const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

async function main() {
  console.log("═══ 급락 역추세(dip-buy) 임계값 스윕 — 정직 백테스트 ═══");
  console.log("자본 10% 매수 / 손절 -3% / 익절 +5% / 반등 청산. 실 Binance 데이터(최근=하락장 포함).\n");
  console.log("규칙              심볼     봉수  | 수익%   MDD%   거래 승률% Sharpe | OOS강건");
  console.log("─".repeat(82));
  let robustPos = 0;
  for (const [iv, days, p, d] of configs) {
    for (const sym of symbols) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r: any = await H.backtest({ tree: dipTree(sym, p, d), symbol: sym, interval: iv, days });
        if (!r.ok) { console.log(`${iv} roc${p}<-${d}`.padEnd(17) + ` ${sym.padEnd(8)} ❌ ${r.error}`); continue; }
        const s = r.stats; const ret = Number(s.totalReturnPercent);
        const robust = r.verdict.oosRobust === true;
        if (robust && ret > 0) robustPos++;
        const tag = `${iv} roc${p}<-${d}`.padEnd(17);
        console.log(`${tag} ${sym.padEnd(8)} ${String(r.bars).padStart(5)} | ${String(ret).padStart(6)} ${String(s.maxDrawdownPercent).padStart(6)} ${String(s.totalTrades).padStart(4)} ${String(s.winRate).padStart(5)} ${String(s.sharpeRatio).padStart(6)} | ${robust ? "✅" : "✗"}`);
      } catch (e) { console.log(`${iv} roc${p}<-${d} ${sym}: 예외 ${e instanceof Error ? e.message : e}`); }
    }
    console.log("");
  }
  console.log("─".repeat(82));
  console.log(`\nOOS강건+수익 케이스: ${robustPos}건. (강건=훈련·검증 둘 다 +수익 → 과적합 아님)`);
  console.log("정직 결론: '하락장에서도 이긴다'를 신뢰하려면 OOS강건 케이스가 여러 심볼에서 일관돼야 함.");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
