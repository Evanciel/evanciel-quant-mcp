/**
 * sweep-strategies.ts — 전략 그리드 백테스트 탐색(정직). "승률 90%+"만 보지 않고 OOS·DSR·거래수·MDD 동시 평가.
 *   목적: 승률만 높은 함정(좁은 TP+무손절=고승률·꼬리붕괴)을 드러내고, OOS 강건+표본충분까지 통과한 게 있는지 검증.
 *   ⚠️ 데이터마이닝 경고: N개를 뒤지면 우연히 고승률 1개는 나옴 → 다중검정 보정(생존수/시도수) 함께 보고.
 * 실행: npx tsx scripts/sweep-strategies.ts
 */
import { fetchKlines, type Bar } from "../src/data/binance-public.js";
import { runCompositeBacktest } from "../src/core/backtest/engine.js";
import { calcReturnMoments } from "../src/core/backtest/metrics.js";
import { probabilisticSharpe } from "../src/core/backtest/deflated-sharpe.js";

const now = new Date().toISOString();
const SYMBOLS = (process.env.SWEEP_SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,LINKUSDT,MATICUSDT").split(",");
const TFS = (process.env.SWEEP_TFS || "1h,4h,1d").split(",");
const leaf = (symbol: string, rules: unknown[]) => ({ id: "r", type: "leaf", name: "s", strategy: { id: "s", userId: "u", name: "s", description: "", symbol, rules, isActive: true, createdAt: now, updatedAt: now } });
const rsi = (p: number, action: string, op: string, v: number) => ({ id: action, action, conditions: [{ id: "c", indicator: "rsi", params: { period: p }, operator: op, value: v }], quantityPercent: 100 });

interface Cand { name: string; tree: unknown; risk: Record<string, unknown> }
function buildConfigs(symbol: string): Cand[] {
  const out: Cand[] = [];
  for (const p of [7, 14, 21]) for (const bTh of [20, 25, 30]) {
    for (const tp of [2, 3, 5, 8]) for (const sl of [null, 5, 10]) {
      out.push({ name: `RSI(${p})<${bTh} TP${tp}/SL${sl ?? "-"}`, tree: leaf(symbol, [rsi(p, "buy", "lt", bTh)]), risk: { takeProfitPercent: tp, stopLossPercent: sl } });
    }
    for (const sTh of [65, 70, 75]) out.push({ name: `RSI(${p})<${bTh}/>${sTh}`, tree: leaf(symbol, [rsi(p, "buy", "lt", bTh), rsi(p, "sell", "gt", sTh)]), risk: {} });
  }
  // 딥 + TP라더(사용자 전략 계열)
  for (const drop of [-3, -5, -7]) out.push({ name: `dipROC(3)<=${drop} TP라더5/10`, tree: leaf(symbol, [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "roc", params: { period: 3 }, operator: "lt", value: drop }], quantityPercent: 100 }]), risk: { tpLadder: [{ pct: 5, sellPct: 50 }, { pct: 10, sellPct: 100 }] } });
  return out;
}
const mkCfg = (d: Bar[], symbol: string, tf: string) => ({ strategyId: "sweep", symbol, startDate: d[0].date, endDate: d[d.length - 1].date, initialCapital: 1_000_000, commission: 0.1, timeframe: tf, slippage: 0.05, gapHandling: "worst" as const });

interface Row { id: string; winRate: number; trades: number; ret: number; mdd: number; oosRobust: boolean; testPsr: number; oosRet: number; oosTrades: number }
const rows: Row[] = [];
let total = 0;

for (const symbol of SYMBOLS) for (const tf of TFS) {
  let data: Bar[];
  try { data = await fetchKlines(symbol, tf, 3000); } catch { continue; }
  if (data.length < 80) continue;
  const split = Math.floor(data.length * 0.7);
  for (const c of buildConfigs(symbol)) {
    total++;
    try {
      const full = runCompositeBacktest(c.tree as never, data, mkCfg(data, symbol, tf) as never, c.risk as never);
      if (full.totalTrades < 1) continue;
      const tr = runCompositeBacktest(c.tree as never, data.slice(0, split), mkCfg(data.slice(0, split), symbol, tf) as never, c.risk as never);
      const te = runCompositeBacktest(c.tree as never, data.slice(split), mkCfg(data.slice(split), symbol, tf) as never, c.risk as never);
      const m = calcReturnMoments(te.equityCurve);
      const psr = probabilisticSharpe(m.perBarSharpe, m.n, m.skewness, m.kurtosis, 0);
      rows.push({
        id: `${symbol} ${tf} ${c.name}`, winRate: full.winRate ?? 0, trades: full.totalTrades, ret: full.totalReturnPercent,
        mdd: full.maxDrawdownPercent ?? 0, oosRet: te.totalReturnPercent, oosTrades: te.totalTrades,
        oosRobust: tr.totalReturnPercent > 0 && te.totalReturnPercent > 0 && te.totalTrades >= 1, testPsr: +psr.toFixed(3),
      });
    } catch { /* skip bad config */ }
  }
}

// winRate는 0~100(퍼센트) 스케일. 90% = >=90.
const hiWin = rows.filter((r) => r.winRate >= 90);
const hiWinSamples = hiWin.filter((r) => r.trades >= 10);
const survivors = hiWinSamples.filter((r) => r.oosRobust && r.testPsr >= 0.9);
console.log(`\n══ 전략 스윕 결과 (총 ${total} 구성, 거래발생 ${rows.length}) ══`);
console.log(`승률 ≥90%:                 ${hiWin.length}`);
console.log(` + 거래수 ≥10(표본충분):    ${hiWinSamples.length}`);
console.log(` + OOS강건 & DSR(PSR≥0.9):  ${survivors.length}  ← 진짜 후보(다중검정 전)`);
console.log(`\n— 승률 ≥90% 상위 12(승률만 보면 함정인지 OOS/MDD/거래수로 확인) —`);
for (const r of hiWin.sort((a, b) => (b.winRate - a.winRate) || (b.trades - a.trades)).slice(0, 12)) {
  console.log(`  승률 ${r.winRate.toFixed(0)}% · ${r.trades}회 · 전체 ${r.ret.toFixed(1)}% · MDD ${r.mdd.toFixed(0)}% · OOS ${r.oosRet.toFixed(1)}%(${r.oosTrades}회) ${r.oosRobust ? "🟢robust" : "🔴"} PSR ${r.testPsr} · ${r.id}`);
}
if (survivors.length) {
  console.log(`\n— 게이트 전부 통과(승률90+거래10+OOS강건+PSR0.9) —`);
  for (const r of survivors.sort((a, b) => b.testPsr - a.testPsr)) console.log(`  ✅ ${r.id} · 승률 ${(r.winRate * 100).toFixed(0)}% ${r.trades}회 · OOS ${r.oosRet.toFixed(1)}% PSR ${r.testPsr}`);
  console.log(`\n⚠️ 다중검정: ${total}개 시도 중 ${survivors.length}개 생존. 우연 기대치(5% 유의수준)≈${(total * 0.05).toFixed(0)}개 → 생존수가 그보다 적거나 비슷하면 '진짜'가 아닐 수 있음(2차 적대검증 필요).`);
} else {
  console.log(`\n🟡 모든 게이트 통과 = 0개. 정직한 결과: 승률만 높은 건 OOS/DSR에서 전부 탈락(과적합·꼬리위험). 프로젝트 기존 결론(OOS-robust 알파≈0)과 일치.`);
}
