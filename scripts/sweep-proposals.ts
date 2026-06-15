/**
 * sweep-proposals.ts — ultracode 가설(전략족 제안)을 전수 백테스트. 승률+OOS+DSR+거래수 동일 게이트.
 *   입력: JSON 파일(proposals 배열 [{family, configs:[{name, buy:[{indicator,period,operator,value}], sell?, takeProfitPercent?, stopLossPercent?, symbols, tfs}]}]).
 * 실행: npx tsx scripts/sweep-proposals.ts <proposals.json>
 */
import { readFileSync } from "node:fs";
import { fetchKlines, type Bar } from "../src/data/binance-public.js";
import { runCompositeBacktest } from "../src/core/backtest/engine.js";
import { calcReturnMoments } from "../src/core/backtest/metrics.js";
import { probabilisticSharpe } from "../src/core/backtest/deflated-sharpe.js";

const file = process.argv[2];
if (!file) { console.error("사용법: npx tsx scripts/sweep-proposals.ts <proposals.json>"); process.exit(1); }
const proposals = JSON.parse(readFileSync(file, "utf8")) as { family?: string; configs?: Cfg[] }[];
interface Cond { indicator: string; period: number; operator: string; value: number }
interface Cfg { name: string; buy: Cond[]; sell?: Cond[]; takeProfitPercent?: number; stopLossPercent?: number; symbols?: string[]; tfs?: string[] }

const now = new Date().toISOString();
const toRule = (action: string, conds: Cond[]) => ({ id: action, action, conditions: conds.map((c, i) => ({ id: `c${i}`, indicator: c.indicator, params: { period: c.period || 14 }, operator: c.operator, value: c.value })), quantityPercent: 100 });
const toTree = (symbol: string, c: Cfg) => ({ id: "r", type: "leaf", name: c.name, strategy: { id: "s", userId: "u", name: c.name, description: "", symbol, rules: [toRule("buy", c.buy), ...(c.sell && c.sell.length ? [toRule("sell", c.sell)] : [])], isActive: true, createdAt: now, updatedAt: now } });
const mkCfg = (d: Bar[], symbol: string, tf: string) => ({ strategyId: "prop", symbol, startDate: d[0].date, endDate: d[d.length - 1].date, initialCapital: 1_000_000, commission: 0.1, timeframe: tf, slippage: 0.05, gapHandling: "worst" as const });

// 데이터 캐시(심볼×tf 1회 페치)
const cache = new Map<string, Bar[]>();
async function getData(symbol: string, tf: string): Promise<Bar[]> {
  const k = `${symbol}:${tf}`; if (cache.has(k)) return cache.get(k)!;
  let d: Bar[] = []; try { d = await fetchKlines(symbol, tf, 3000); } catch { /* skip */ }
  cache.set(k, d); return d;
}

interface Row { id: string; family: string; winRate: number; trades: number; ret: number; oosRet: number; oosTrades: number; oosRobust: boolean; testPsr: number }
const rows: Row[] = [];
let total = 0;
const VALID_IND = new Set(["rsi", "stochastic", "cci", "mfi", "williams_r", "roc", "adx", "sma", "ema", "macd", "supertrend", "bollinger"]);

for (const p of proposals) {
  for (const c of p.configs ?? []) {
    if (!c.buy?.length || c.buy.some((b) => !VALID_IND.has(b.indicator))) continue; // 무효 지표 스킵
    const symbols = (c.symbols ?? ["BTCUSDT"]).filter((s) => /USDT$/.test(s));
    const tfs = (c.tfs ?? ["1d"]).filter((t) => ["1h", "4h", "1d"].includes(t));
    for (const symbol of symbols) for (const tf of tfs) {
      total++;
      const data = await getData(symbol, tf);
      if (data.length < 80) continue;
      const split = Math.floor(data.length * 0.7);
      try {
        const risk = { takeProfitPercent: c.takeProfitPercent ?? null, stopLossPercent: c.stopLossPercent ?? null };
        const full = runCompositeBacktest(toTree(symbol, c) as never, data, mkCfg(data, symbol, tf) as never, risk as never);
        if (full.totalTrades < 1) continue;
        const tr = runCompositeBacktest(toTree(symbol, c) as never, data.slice(0, split), mkCfg(data.slice(0, split), symbol, tf) as never, risk as never);
        const te = runCompositeBacktest(toTree(symbol, c) as never, data.slice(split), mkCfg(data.slice(split), symbol, tf) as never, risk as never);
        const m = calcReturnMoments(te.equityCurve);
        rows.push({
          id: `${symbol} ${tf} ${c.name}`, family: p.family ?? "?", winRate: full.winRate ?? 0, trades: full.totalTrades, ret: full.totalReturnPercent,
          oosRet: te.totalReturnPercent, oosTrades: te.totalTrades, oosRobust: tr.totalReturnPercent > 0 && te.totalReturnPercent > 0 && te.totalTrades >= 1, testPsr: +probabilisticSharpe(m.perBarSharpe, m.n, m.skewness, m.kurtosis, 0).toFixed(3),
        });
      } catch { /* skip */ }
    }
  }
}

const hiWin = rows.filter((r) => r.winRate >= 90 && r.trades >= 10);
const survivors = rows.filter((r) => r.winRate >= 90 && r.trades >= 10 && r.oosRobust && r.testPsr >= 0.9);
const robustAny = rows.filter((r) => r.trades >= 10 && r.oosRobust && r.testPsr >= 0.9); // 승률 무관 OOS강건(보너스)
console.log(`\n══ 가설 스윕 (총 ${total} 백테스트, 거래발생 ${rows.length}) ══`);
console.log(`승률≥90% & 거래≥10:        ${hiWin.length}`);
console.log(` + OOS강건 & PSR≥0.9:       ${survivors.length}  ← 요청한 "진짜 90%+ 전략"`);
console.log(`(참고) 승률무관 OOS강건+PSR≥0.9: ${robustAny.length}`);
if (survivors.length) { console.log(`\n— 90%+ 생존자 —`); for (const r of survivors.sort((a, b) => b.testPsr - a.testPsr)) console.log(`  ✅ ${r.id} [${r.family}] 승률${r.winRate.toFixed(0)}% ${r.trades}회 전체${r.ret.toFixed(1)}% OOS${r.oosRet.toFixed(1)}%(${r.oosTrades}) PSR${r.testPsr}`); }
else console.log(`\n🟡 90%+ 생존자 0개.`);
if (robustAny.length) { console.log(`\n— (보너스) OOS강건 상위(승률 무관) —`); for (const r of robustAny.sort((a, b) => b.testPsr - a.testPsr).slice(0, 10)) console.log(`  · ${r.id} [${r.family}] 승률${r.winRate.toFixed(0)}% ${r.trades}회 OOS${r.oosRet.toFixed(1)}%(${r.oosTrades}) PSR${r.testPsr}`); }
console.log(`\n⚠️ 다중검정: ${total} 백테스트 중 생존 ${survivors.length}. 우연 기대치(5%)≈${(total * 0.05).toFixed(0)} → 생존이 그보다 적으면 진짜 아닐 수 있음(2차 적대검증 필요).`);
