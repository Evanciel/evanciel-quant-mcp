/**
 * regime-sweep.ts — 레짐 분기 전략 검증. 추세 상승확실=롱, 하락확실=숏, 애매=관망(노출 스위칭).
 *   롱봇: condition(regime∈[trend_up]) → 매수(RSI 눌림)/청산, else 청산. runCompositeBacktest.
 *   숏봇: condition(regime∈[trend_down]) → 숏(RSI 랠리)/커버, else 커버. runShortBacktest.
 *   레짐 게이트 유무 비교(게이트가 하락장 롱손실·반등 숏손실을 막는지). 승률+OOS+DSR+거래수.
 * 실행: npx tsx scripts/regime-sweep.ts
 */
import { fetchKlines, type Bar } from "../src/data/binance-public.js";
import { runCompositeBacktest } from "../src/core/backtest/engine.js";
import { runShortBacktest } from "../src/core/backtest/short-engine.js";
import { calcReturnMoments } from "../src/core/backtest/metrics.js";
import { probabilisticSharpe } from "../src/core/backtest/deflated-sharpe.js";

const SYMBOLS = (process.env.SWEEP_SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT").split(",");
const TFS = (process.env.SWEEP_TFS || "4h,1d").split(",");
const now = new Date().toISOString();
const rsi = (p: number, op: string, v: number) => ({ id: `c${op}${v}`, indicator: "rsi", params: { period: p }, operator: op, value: v });
const rule = (action: string, conds: ReturnType<typeof rsi>[]) => ({ id: action, action, conditions: conds, quantityPercent: 100 });
const leaf = (rules: unknown[]) => ({ id: "l", type: "leaf", name: "x", strategy: { id: "s", userId: "u", name: "x", description: "", symbol: "X", rules, isActive: true, createdAt: now, updatedAt: now } });
const ALWAYS = (action: string) => rule(action, [rsi(14, "lt", 101)]); // RSI<101 = 항상참(레짐 벗어나면 무조건 청산/커버)
const gate = (inL: string[], thenL: unknown, elseL: unknown) => ({ id: "r", type: "condition", name: "regime", condition: { type: "regime", in: inL }, thenNode: thenL, elseNode: elseL });
const mkCfg = (d: Bar[], symbol: string, tf: string) => ({ strategyId: "rg", symbol, startDate: d[0].date, endDate: d[d.length - 1].date, initialCapital: 1_000_000, commission: 0.1, timeframe: tf, slippage: 0.05, gapHandling: "worst" as const });

interface Row { id: string; side: string; gated: boolean; winRate: number; trades: number; ret: number; oosRet: number; oosTrades: number; oosRobust: boolean; testPsr: number }
const rows: Row[] = [];
const moments = (eq: { date: string; value: number }[]) => { const m = calcReturnMoments(eq); return +probabilisticSharpe(m.perBarSharpe, m.n, m.skewness, m.kurtosis, 0).toFixed(3); };

for (const symbol of SYMBOLS) for (const tf of TFS) {
  let data: Bar[]; try { data = await fetchKlines(symbol, tf, 3000); } catch { continue; }
  if (data.length < 120) continue;
  const split = Math.floor(data.length * 0.7);
  const run = (side: "long" | "short", gated: boolean, name: string, tree: unknown, risk: Record<string, unknown>) => {
    try {
      const eng = side === "long" ? runCompositeBacktest : runShortBacktest;
      const full = eng(tree as never, data, mkCfg(data, symbol, tf) as never, risk as never);
      if (full.totalTrades < 1) return;
      const tr = eng(tree as never, data.slice(0, split), mkCfg(data.slice(0, split), symbol, tf) as never, risk as never);
      const te = eng(tree as never, data.slice(split), mkCfg(data.slice(split), symbol, tf) as never, risk as never);
      rows.push({ id: `${symbol} ${tf} ${name}`, side, gated, winRate: full.winRate ?? 0, trades: full.totalTrades, ret: full.totalReturnPercent, oosRet: te.totalReturnPercent, oosTrades: te.totalTrades, oosRobust: tr.totalReturnPercent > 0 && te.totalReturnPercent > 0 && te.totalTrades >= 1, testPsr: moments(te.equityCurve) });
    } catch (e) { if (process.env.DBG) console.error(name, e instanceof Error ? e.message : e); }
  };
  for (const p of [14]) for (const bTh of [40, 45]) for (const sTh of [65, 70]) {
    // 롱: 게이트(상승레짐만) vs 무게이트
    const longThen = leaf([rule("buy", [rsi(p, "lt", bTh)]), rule("sell", [rsi(p, "gt", sTh)])]);
    run("long", true, `LONG↑gate RSI<${bTh}/>${sTh}`, gate(["trend_up"], longThen, leaf([ALWAYS("sell")])), { stopLossPercent: 8 });
    run("long", false, `LONG nogate RSI<${bTh}/>${sTh}`, longThen, { stopLossPercent: 8 });
  }
  for (const p of [14]) for (const sTh of [65, 70]) for (const bTh of [30, 40]) {
    // 숏: 게이트(하락레짐만) vs 무게이트. sell=숏진입, buy=커버.
    const shortThen = leaf([rule("sell", [rsi(p, "gt", sTh)]), rule("buy", [rsi(p, "lt", bTh)])]);
    run("short", true, `SHORT↓gate RSI>${sTh}/<${bTh}`, gate(["trend_down", "high_vol"], shortThen, leaf([ALWAYS("buy")])), { stopLossPercent: 10 });
    run("short", false, `SHORT nogate RSI>${sTh}/<${bTh}`, shortThen, { stopLossPercent: 10 });
  }
}

const robust = (r: Row) => r.oosRobust && r.testPsr >= 0.9 && r.trades >= 10;
const summ = (side: string, gated: boolean) => { const s = rows.filter((r) => r.side === side && r.gated === gated); return `${s.filter(robust).length}/${s.length} robust`; };
console.log(`\n══ 레짐 분기 전략 (총 ${rows.length} 백테스트) ══`);
console.log(`롱 게이트(상승만):  ${summ("long", true)}   vs  롱 무게이트: ${summ("long", false)}`);
console.log(`숏 게이트(하락만):  ${summ("short", true)}   vs  숏 무게이트: ${summ("short", false)}`);
console.log(`\n— 레짐게이트 robust 상위 12 —`);
for (const r of rows.filter((r) => r.gated && robust(r)).sort((a, b) => b.testPsr - a.testPsr).slice(0, 12)) console.log(`  [${r.side}] 승률 ${r.winRate.toFixed(0)}% · ${r.trades}회 · 전체 ${r.ret.toFixed(1)}% · OOS ${r.oosRet.toFixed(1)}%(${r.oosTrades}) PSR ${r.testPsr} · ${r.id}`);
console.log(`\n⚠️ 정직: 게이트가 robust 비율을 높이면 '레짐 분기'가 유효하다는 신호. 단 여전히 과거 데이터(현 하락장 비중↑) 기반 — 다중검정·향후 레짐 전환 위험 상존. 적대검증 필요.`);
