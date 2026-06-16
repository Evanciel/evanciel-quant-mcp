/**
 * regime-halt-demo.ts — 레짐 정지(리스크 통제) 가치 증명. 추세 자동판단 → 상승레짐만 보유, 아니면 관망(정지).
 *   비교: ①레짐정지 롱(trend_up일 때만 보유) vs ②그냥 보유(buy&hold). 수익률 + 최대낙폭(MDD).
 *   정직: 레짐정지는 "더 버는" 게 아니라 "하락장 낙폭을 줄이는" 리스크 통제. computeRegime 룩어헤드 없음.
 * 실행: npx tsx scripts/regime-halt-demo.ts
 */
import { fetchKlines, type Bar } from "../src/data/binance-public.js";
import { computeRegime } from "../src/core/backtest/regime.js";

const SYMBOLS = (process.env.SWEEP_SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT").split(",");
const TF = process.env.SWEEP_TF || "1d";
const BARS = Number(process.env.SWEEP_BARS || 1500);
const COMM = 0.001, SLIP = 0.0005;

function maxDD(eq: number[]): number { let peak = eq[0], mdd = 0; for (const v of eq) { if (v > peak) peak = v; const dd = (peak - v) / peak; if (dd > mdd) mdd = dd; } return mdd * 100; }

function regimeHaltLong(data: Bar[]): { ret: number; mdd: number; daysIn: number; winRate: number; trades: number } {
  const prices = data.map((b) => b.close), highs = data.map((b) => b.high), lows = data.map((b) => b.low);
  let equity = 1, side: "flat" | "long" = "flat", entry = 0, inBars = 0, trades = 0, wins = 0;
  const eq: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const px = prices[i];
    if (i < 50) { eq.push(equity); continue; }
    const up = computeRegime(prices.slice(0, i + 1), highs.slice(0, i + 1), lows.slice(0, i + 1)).label === "trend_up";
    if (side === "long" && !up) { const net = ((px * (1 - SLIP) - entry) / entry) - COMM; equity *= 1 + net; side = "flat"; trades++; if (net > 0) wins++; }
    else if (side === "flat" && up) { side = "long"; entry = px * (1 + SLIP); equity *= 1 - COMM; }
    if (side === "long") inBars++;
    eq.push(side === "long" ? equity * (1 + (px - entry) / entry) : equity);
  }
  if (side === "long") { const net = (prices[prices.length - 1] - entry) / entry; equity *= 1 + net; trades++; if (net > 0) wins++; } // 마지막 미청산도 1거래로
  return { ret: (equity - 1) * 100, mdd: maxDD(eq), daysIn: Math.round((inBars / (data.length - 50)) * 100), winRate: trades ? (wins / trades) * 100 : 0, trades };
}
function buyHold(data: Bar[]): { ret: number; mdd: number } {
  const p = data.map((b) => b.close); const eq = p.map((x) => x / p[0]);
  return { ret: (p[p.length - 1] / p[0] - 1) * 100, mdd: maxDD(eq) };
}

console.log(`══ 레짐 정지(리스크 통제) vs 그냥 보유 — ${TF}, ${BARS}봉 ══`);
console.log(`종목      | 레짐정지 수익 / MDD / 보유비율 | 그냥보유 수익 / MDD`);
for (const s of SYMBOLS) {
  let data: Bar[]; try { data = await fetchKlines(s, TF, BARS); } catch { continue; }
  if (data.length < 200) continue;
  const h = regimeHaltLong(data), b = buyHold(data);
  const ddCut = b.mdd > 0 ? Math.round((1 - h.mdd / b.mdd) * 100) : 0;
  console.log(`${s.padEnd(9)} | 승률 ${h.winRate.toFixed(0)}%(${h.trades}회) · ${h.ret.toFixed(0).padStart(5)}% / MDD ${h.mdd.toFixed(0)}% / 노출 ${h.daysIn}% | 보유 ${b.ret.toFixed(0).padStart(5)}% / MDD ${b.mdd.toFixed(0)}% → 낙폭 ${ddCut > 0 ? ddCut + "%↓" : "감소못함"}`);
}
console.log(`\n정직: 레짐정지는 보통 "수익은 보유와 비슷하거나 덜, 대신 MDD(낙폭)가 크게 작다"가 핵심 — 하락장에 빠져나와 손실을 던다(리스크 통제). 알파(초과수익)는 기대 안 함. 과거≠미래.`);
