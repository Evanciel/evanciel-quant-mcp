/**
 * regime-directional.ts — 통합 추세추종(레짐 방향전환). 한 전략이 매 봉 레짐 판정 → 상승=롱, 하락=숏, 애매=관망.
 *   레짐 전환 시 기존 포지션 청산 + 반대/관망 전환(한 자본곡선). computeRegime(룩어헤드 없음, 현재봉까지 슬라이스).
 *   선택 손절. 종목 전반 + OOS(70/30) + PSR. 정직: 추세추종은 추세장에 강하고 횡보장에 휩쏘 — 그래서 range/high_vol=관망.
 * 실행: npx tsx scripts/regime-directional.ts   (SWEEP_SYMBOLS/SWEEP_TFS env)
 */
import { fetchKlines, type Bar } from "../src/data/binance-public.js";
import { computeRegime } from "../src/core/backtest/regime.js";
import { calcReturnMoments } from "../src/core/backtest/metrics.js";
import { probabilisticSharpe } from "../src/core/backtest/deflated-sharpe.js";

const SYMBOLS = (process.env.SWEEP_SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT").split(",");
const TFS = (process.env.SWEEP_TFS || "4h,1d").split(",");
const BARS = Number(process.env.SWEEP_BARS || 1500);
const COMM = 0.001, SLIP = 0.0005; // 0.1% 수수료, 0.05% 슬리피지(편도)

interface Res { ret: number; trades: number; winRate: number; eq: { date: string; value: number }[] }
function runDirectional(data: Bar[], slPct: number | null): Res {
  const prices = data.map((b) => b.close), highs = data.map((b) => b.high), lows = data.map((b) => b.low);
  let side: "flat" | "long" | "short" = "flat", entry = 0, equity = 1, trades = 0, wins = 0;
  const eq: { date: string; value: number }[] = [];
  const warmup = 50;
  const close = (px: number) => {
    if (side === "flat") return;
    const gross = side === "long" ? (px - entry) / entry : (entry - px) / entry;
    const net = gross - 2 * COMM; equity *= 1 + net; trades++; if (net > 0) wins++; side = "flat";
  };
  for (let i = 0; i < data.length; i++) {
    const px = prices[i];
    if (i < warmup) { eq.push({ date: data[i].date, value: equity }); continue; }
    // 손절: 레짐 전환 전이라도 불리 이동 시 청산
    if (side !== "flat" && slPct) {
      const adverse = side === "long" ? (px - entry) / entry : (entry - px) / entry;
      if (adverse <= -slPct / 100) close(px * (side === "long" ? 1 - SLIP : 1 + SLIP));
    }
    const label = computeRegime(prices.slice(0, i + 1), highs.slice(0, i + 1), lows.slice(0, i + 1)).label;
    const desired = label === "trend_up" ? "long" : label === "trend_down" ? "short" : "flat";
    if (side !== desired) {
      close(px * (side === "long" ? 1 - SLIP : side === "short" ? 1 + SLIP : 1));
      if (desired !== "flat") { side = desired; entry = px * (desired === "long" ? 1 + SLIP : 1 - SLIP); }
    }
    const unreal = side === "flat" ? 0 : side === "long" ? (px - entry) / entry : (entry - px) / entry;
    eq.push({ date: data[i].date, value: equity * (1 + unreal) });
  }
  return { ret: (equity - 1) * 100, trades, winRate: trades ? (wins / trades) * 100 : 0, eq };
}
const psrOf = (eq: { date: string; value: number }[]) => { const m = calcReturnMoments(eq); return +probabilisticSharpe(m.perBarSharpe, m.n, m.skewness, m.kurtosis, 0).toFixed(3); };

console.log(`══ 통합 추세추종(레짐 롱/숏 전환) — ${BARS}봉, 수수료 ${COMM * 100}%/편도 ──`);
for (const sl of [null, 10]) {
  console.log(`\n── 손절 ${sl ? sl + "%" : "없음(레짐전환만)"} ──`);
  for (const tf of TFS) for (const symbol of SYMBOLS) {
    let data: Bar[]; try { data = await fetchKlines(symbol, tf, BARS); } catch { continue; }
    if (data.length < 200) continue;
    const split = Math.floor(data.length * 0.7);
    const full = runDirectional(data, sl);
    const te = runDirectional(data.slice(split), sl);
    const robust = te.ret > 0 && te.trades >= 5;
    console.log(`  ${symbol} ${tf}: 전체 ${full.ret.toFixed(1)}% (${full.trades}회, 승률${full.winRate.toFixed(0)}%) · OOS ${te.ret.toFixed(1)}%(${te.trades}회) PSR ${psrOf(te.eq)} ${robust ? "🟢" : "🔴"}`);
  }
}
console.log(`\n⚠️ 정직: 추세추종은 큰 추세 몇 번에 수익 집중(양의 왜도)·승률 낮음 정상. 횡보장 휩쏘가 적. 과거≠미래.`);
