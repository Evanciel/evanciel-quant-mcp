/**
 * backtest-dip-strategy.ts — 사용자 딥매수 전략 백테스트(정직 검증).
 *   진입: ROC(3) ≤ -7%(분봉 3봉간 7%↓ = "단기 급락+연속하락" 근사) → 매수
 *   사이징: 자본 10%/진입 + scale-in 물타기(-5%/-10% 평단하락 시 base만큼 추가, 최대 3배)
 *   익절: TP 라더 +5% 절반 / +10% 전부
 * 실행: npx tsx scripts/backtest-dip-strategy.ts [SYMBOL] [INTERVAL]  (기본 SOLUSDT 5m)
 *   ※ 분봉=크립토만(엔진상 KR은 일봉). 결과는 OOS(70/30)로 과적합 함께 표기. 정직: risk filter, not alpha.
 */
import { fetchKlines } from "../src/data/binance-public.js";
import { runCompositeBacktest } from "../src/core/backtest/engine.js";

const SYMBOL = process.argv[2] || "SOLUSDT";
const INTERVAL = process.argv[3] || "5m";
const DROP = Number(process.argv[4] || -7); // ROC(3) 임계
const now = new Date().toISOString();

const tree = {
  id: "r", type: "leaf", name: "dip",
  strategy: {
    id: "s", userId: "u", name: "dip", description: "", symbol: SYMBOL,
    rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "roc", params: { period: 3 }, operator: "lt", value: DROP }], quantityPercent: 10 }],
    isActive: true, createdAt: now, updatedAt: now,
  },
};
const risk = {
  tpLadder: [{ pct: 5, sellPct: 50 }, { pct: 10, sellPct: 100 }],
  scaleIn: { ladder: [{ dropPct: 5, addPct: 100 }, { dropPct: 10, addPct: 100 }], maxMultiple: 3 },
};
const mkCfg = (d: { date: string }[]) => ({ strategyId: "dip", symbol: SYMBOL, startDate: d[0].date, endDate: d[d.length - 1].date, initialCapital: 1_000_000, commission: 0.1, timeframe: INTERVAL, slippage: 0.05, gapHandling: "worst" as const });
const stat = (r: { totalReturnPercent: number; totalTrades: number; winRate?: number; maxDrawdownPercent?: number }) => `수익률 ${r.totalReturnPercent.toFixed(2)}% · 거래 ${r.totalTrades}회 · 승률 ${((r.winRate ?? 0) * 100).toFixed(0)}% · MDD ${(r.maxDrawdownPercent ?? 0).toFixed(1)}%`;

const data = await fetchKlines(SYMBOL, INTERVAL, 3000);
console.log(`── 딥매수 전략 백테스트: ${SYMBOL} ${INTERVAL}, ${data.length}봉 (${data[0].date}~${data[data.length - 1].date}) · ROC(3)≤${DROP}% ──`);
const full = runCompositeBacktest(tree as never, data, mkCfg(data) as never, risk as never);
console.log(`전체:   ${stat(full)}`);

// OOS 70/30(과적합 정직 표기)
const split = Math.floor(data.length * 0.7);
if (split >= 30 && data.length - split >= 20) {
  const tr = runCompositeBacktest(tree as never, data.slice(0, split), mkCfg(data.slice(0, split)) as never, risk as never);
  const te = runCompositeBacktest(tree as never, data.slice(split), mkCfg(data.slice(split)) as never, risk as never);
  console.log(`In-Sample(70%):  ${stat(tr)}`);
  console.log(`Out-Sample(30%): ${stat(te)}`);
  const robust = tr.totalReturnPercent > 0 && te.totalReturnPercent > 0 && te.totalTrades >= 1;
  console.log(`\n${robust ? "🟢" : "🟡"} OOS robust: ${robust}  (둘 다 +수익 & OOS 거래≥1이어야 robust. 아니면 과적합/표본부족)`);
}
console.log(`\n※ 정직: 과거 백테스트는 미래 보장 아님. 이 시스템 정체성=리스크 통제·거짓발견 필터(알파 보장 아님). 거래 0이면 임계가 이 종목/기간엔 너무 빡셈 → 종목/INTERVAL/임계 조정.`);
