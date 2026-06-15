/**
 * sweep-short.ts — 숏 전략 그리드 백테스트(하락장 방향). runShortBacktest(sell=숏진입, buy=커버).
 *   랠리매도(RSI 과매수→숏) + 추세하락(데드크로스→숏) + TP/SL. 승률+OOS+DSR+거래수 동일 게이트.
 * 실행: npx tsx scripts/sweep-short.ts   (SWEEP_SYMBOLS/SWEEP_TFS env 가능)
 */
import { fetchKlines, type Bar } from "../src/data/binance-public.js";
import { runShortBacktest } from "../src/core/backtest/short-engine.js";
import { calcReturnMoments } from "../src/core/backtest/metrics.js";
import { probabilisticSharpe } from "../src/core/backtest/deflated-sharpe.js";

const SYMBOLS = (process.env.SWEEP_SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT").split(",");
const TFS = (process.env.SWEEP_TFS || "4h,1d").split(",");
const now = new Date().toISOString();
const leaf = (symbol: string, rules: unknown[]) => ({ id: "r", type: "leaf", name: "s", strategy: { id: "s", userId: "u", name: "s", description: "", symbol, rules, isActive: true, createdAt: now, updatedAt: now } });
const cond = (indicator: string, p: number, op: string, v: number) => ({ indicator, params: { period: p }, operator: op, value: v });
const rule = (action: string, c: ReturnType<typeof cond>[]) => ({ id: action, action, conditions: c.map((x, i) => ({ id: `c${i}`, ...x })), quantityPercent: 100 });

interface Cand { name: string; tree: unknown; risk: Record<string, unknown> }
function buildShort(symbol: string): Cand[] {
  const out: Cand[] = [];
  for (const p of [7, 14, 21]) for (const sTh of [65, 70, 75]) {
    // 과매수 숏(sell=진입) + TP/SL 커버
    for (const tp of [3, 5, 8]) for (const sl of [null, 10]) out.push({ name: `S RSI(${p})>${sTh} TP${tp}/SL${sl ?? "-"}`, tree: leaf(symbol, [rule("sell", [cond("rsi", p, "gt", sTh)])]), risk: { takeProfitPercent: tp, stopLossPercent: sl } });
    // 과매수 숏 + RSI 과매도 커버(buy=커버)
    for (const bTh of [30, 40]) out.push({ name: `S RSI(${p})>${sTh}/<${bTh}`, tree: leaf(symbol, [rule("sell", [cond("rsi", p, "gt", sTh)]), rule("buy", [cond("rsi", p, "lt", bTh)])]), risk: {} });
  }
  // 추세하락 추종: 데드크로스(sell=숏진입) / 골든크로스(buy=커버)
  for (const ma of [20, 50]) out.push({ name: `S deathcross SMA(${ma})`, tree: leaf(symbol, [rule("sell", [cond("sma", ma, "cross_below", 0)]), rule("buy", [cond("sma", ma, "cross_above", 0)])]), risk: { stopLossPercent: 10 } });
  // 추세하락 + ADX 게이트(추세강할 때만 숏)
  for (const ma of [20, 50]) out.push({ name: `S deathcross SMA(${ma})+ADX>20`, tree: leaf(symbol, [rule("sell", [cond("sma", ma, "cross_below", 0), cond("adx", 14, "gt", 20)]), rule("buy", [cond("sma", ma, "cross_above", 0)])]), risk: { stopLossPercent: 10 } });
  return out;
}
const mkCfg = (d: Bar[], symbol: string, tf: string) => ({ strategyId: "short", symbol, startDate: d[0].date, endDate: d[d.length - 1].date, initialCapital: 1_000_000, commission: 0.1, timeframe: tf, slippage: 0.05 });

interface Row { id: string; winRate: number; trades: number; ret: number; oosRet: number; oosTrades: number; oosRobust: boolean; testPsr: number }
const rows: Row[] = [];
let total = 0;
for (const symbol of SYMBOLS) for (const tf of TFS) {
  let data: Bar[]; try { data = await fetchKlines(symbol, tf, 3000); } catch { continue; }
  if (data.length < 80) continue;
  const split = Math.floor(data.length * 0.7);
  for (const c of buildShort(symbol)) {
    total++;
    try {
      const full = runShortBacktest(c.tree as never, data, mkCfg(data, symbol, tf) as never, c.risk as never);
      if (full.totalTrades < 1) continue;
      const tr = runShortBacktest(c.tree as never, data.slice(0, split), mkCfg(data.slice(0, split), symbol, tf) as never, c.risk as never);
      const te = runShortBacktest(c.tree as never, data.slice(split), mkCfg(data.slice(split), symbol, tf) as never, c.risk as never);
      const m = calcReturnMoments(te.equityCurve);
      rows.push({ id: `${symbol} ${tf} ${c.name}`, winRate: full.winRate ?? 0, trades: full.totalTrades, ret: full.totalReturnPercent, oosRet: te.totalReturnPercent, oosTrades: te.totalTrades, oosRobust: tr.totalReturnPercent > 0 && te.totalReturnPercent > 0 && te.totalTrades >= 1, testPsr: +probabilisticSharpe(m.perBarSharpe, m.n, m.skewness, m.kurtosis, 0).toFixed(3) });
    } catch { /* skip */ }
  }
}
const hiWin = rows.filter((r) => r.winRate >= 90 && r.trades >= 10);
const survivors = rows.filter((r) => r.winRate >= 90 && r.trades >= 10 && r.oosRobust && r.testPsr >= 0.9);
const robustAny = rows.filter((r) => r.trades >= 10 && r.oosRobust && r.testPsr >= 0.9);
console.log(`\n══ 숏 전략 스윕 (총 ${total}, 거래발생 ${rows.length}) ══`);
console.log(`승률≥90% & 거래≥10:        ${hiWin.length}`);
console.log(` + OOS강건 & PSR≥0.9:       ${survivors.length}  ← 진짜 90%+ 숏`);
console.log(`(참고) 승률무관 OOS강건+PSR: ${robustAny.length}`);
console.log(`\n— OOS강건(robust) 숏 상위 12(승률·OOS·거래수) —`);
for (const r of rows.filter((r) => r.oosRobust && r.trades >= 5).sort((a, b) => b.testPsr - a.testPsr).slice(0, 12)) console.log(`  승률 ${r.winRate.toFixed(0)}% · ${r.trades}회 · 전체 ${r.ret.toFixed(1)}% · OOS ${r.oosRet.toFixed(1)}%(${r.oosTrades}) PSR ${r.testPsr} · ${r.id}`);
if (!survivors.length) console.log(`\n🟡 90%+ & OOS+DSR 숏 생존자 0개${robustAny.length ? ` (단 OOS강건 ${robustAny.length}개는 있음 — 승률은 낮아도 하락장 방향이 맞음)` : ""}.`);
console.log(`\n⚠️ 숏도 다중검정(${total}) 보정 필요. 과거 하락장 백테 ≠ 미래(추세 전환 시 숏이 가장 위험).`);
