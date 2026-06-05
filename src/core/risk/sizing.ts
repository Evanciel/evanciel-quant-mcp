/**
 * 포지션 사이징 — 변동성 타게팅 / ATR / fractional Kelly. 순수함수(I/O 0) → 라이브·백테 공용(backtest≡live).
 *
 * 정직한 포지셔닝(리서치 결론): 사이징의 검증된 가치는 "수익 알파"가 아니라 "낙폭·파산위험 통제"다.
 * 변동성 타게팅만 STRONG 등급(MDD 대폭 축소, Moreira-Muir 2017). 비용 차감 시 '수익' 효과는 대부분 증발.
 * 크립토 연환산은 ×√365(24/7)로 통일 — metrics.periodsPerYear와 동일 기준.
 */
import { periodsPerYear } from "../backtest/metrics";

/**
 * EWMA(RiskMetrics) 변동성: per-bar 표준편차. σ²_t = λ·σ²_{t-1} + (1-λ)·r²_{t-1}.
 * returns = 로그수익률 배열. seed = 앞 min(30,n)개 단순분산. λ=0.94(일봉 표준).
 */
export function computeEwmaVol(returns: number[], lambda = 0.94): number {
  const r = returns.filter((x) => Number.isFinite(x));
  if (r.length < 2) return 0;
  const seedN = Math.min(30, r.length);
  const seed = r.slice(0, seedN);
  const seedMean = seed.reduce((a, b) => a + b, 0) / seedN;
  let variance = seed.reduce((s, x) => s + (x - seedMean) ** 2, 0) / seedN;
  for (let i = seedN; i < r.length; i++) {
    variance = lambda * variance + (1 - lambda) * r[i - 1] ** 2;
  }
  return Math.sqrt(Math.max(variance, 0));
}

/** per-bar 변동성 → 연환산(크립토 ×√365 계열). */
export function annualizeVol(perBarVol: number, timeframe = "1d"): number {
  return perBarVol * Math.sqrt(periodsPerYear(timeframe));
}

/** 가격 배열 → 로그수익률. */
export function toLogReturns(prices: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0 && prices[i] > 0) out.push(Math.log(prices[i] / prices[i - 1]));
  }
  return out;
}

/**
 * 변동성 타게팅 레버리지 = targetVol / realizedVol, [0, cap] 클램프.
 * realizedVol→0 무한레버리지 버그 방지(클램프 필수). 페이퍼-first 현물은 cap=1.0.
 */
export function computeVolTargetLeverage(opts: {
  targetVolAnnual: number; realizedVolAnnual: number; leverageCap?: number;
}): number {
  const { targetVolAnnual, realizedVolAnnual, leverageCap = 1.0 } = opts;
  if (!(realizedVolAnnual > 0) || !(targetVolAnnual > 0)) return 0;
  const lev = targetVolAnnual / realizedVolAnnual;
  return Math.max(0, Math.min(lev, leverageCap));
}

/**
 * ATR 기반 사이징: 트레이드당 리스크를 equity의 riskPct로 고정. units=(equity×riskPct)/(ATR×atrMult).
 * 스톱가격 = entry − ATR×atrMult(롱). 자산/변동성 무관하게 트레이드당 손실 일정 → 다심볼 혼합에 적합.
 */
export function computeAtrSize(opts: {
  equity: number; riskPct: number; price: number; atr: number; atrMult?: number;
}): { units: number; notional: number; stopPrice: number; riskAmount: number; stopDistance: number } {
  const { equity, riskPct, price, atr, atrMult = 2.0 } = opts;
  const stopDistance = atr * atrMult;
  if (!(equity > 0) || !(riskPct > 0) || !(stopDistance > 0) || !(price > 0)) {
    return { units: 0, notional: 0, stopPrice: 0, riskAmount: 0, stopDistance };
  }
  const riskAmount = equity * riskPct;
  let units = riskAmount / stopDistance;
  let notional = units * price;
  // 노출 상한: notional은 equity를 넘지 않게(현물 무레버리지). 넘으면 equity 한도로 축소.
  if (notional > equity) { notional = equity; units = notional / price; }
  return { units, notional, stopPrice: price - stopDistance, riskAmount, stopDistance };
}

/**
 * Fractional Kelly: f_full = winRate − (1−winRate)/(avgWin/avgLoss); f_used = f_full × fraction.
 * 가드: 표본<minSample → 고정 fallbackRiskPct 폴백(추정오차 폭발 방지), 음수 → 0, 상한 capFraction.
 * 실무 표준 = Half-Kelly(0.5). avgWin/avgLoss는 양수 크기.
 */
export function computeFractionalKelly(opts: {
  winRate: number; avgWin: number; avgLoss: number;
  fraction?: number; sampleSize?: number; minSample?: number;
  fallbackRiskPct?: number; capFraction?: number;
}): { fraction: number; usedFallback: boolean } {
  const {
    winRate, avgWin, avgLoss, fraction = 0.5, sampleSize = 0,
    minSample = 100, fallbackRiskPct = 0.01, capFraction = 0.25,
  } = opts;
  if (sampleSize < minSample) return { fraction: fallbackRiskPct, usedFallback: true };
  if (!(avgLoss > 0) || !(avgWin > 0)) return { fraction: fallbackRiskPct, usedFallback: true };
  const b = avgWin / avgLoss;
  const fFull = winRate - (1 - winRate) / b;
  const fUsed = Math.max(0, Math.min(fFull * fraction, capFraction));
  return { fraction: fUsed, usedFallback: false };
}

export type SizingMethod = "fixed" | "vol_target" | "atr" | "kelly";

/**
 * 통합 사이징 디스패처 → equity 대비 투입 notional(+세부). 페이퍼-first 현물: notional ≤ equity 보장.
 * method별 필요 입력이 없으면 fixed로 안전 폴백.
 */
export function computePositionSize(opts: {
  method: SizingMethod; equity: number; price?: number;
  // fixed
  riskPct?: number;
  // vol_target
  targetVolAnnual?: number; realizedVolAnnual?: number; leverageCap?: number;
  // atr
  atr?: number; atrMult?: number;
  // kelly
  winRate?: number; avgWin?: number; avgLoss?: number; kellyFraction?: number; sampleSize?: number;
}): { method: SizingMethod; notional: number; fractionOfEquity: number; detail: Record<string, unknown> } {
  const { method, equity } = opts;
  if (!(equity > 0)) return { method, notional: 0, fractionOfEquity: 0, detail: { error: "equity<=0" } };

  const clampNotional = (n: number) => Math.max(0, Math.min(n, equity));
  const wrap = (notional: number, detail: Record<string, unknown>) => {
    const n = clampNotional(notional);
    return { method, notional: n, fractionOfEquity: n / equity, detail };
  };

  switch (method) {
    case "vol_target": {
      const lev = computeVolTargetLeverage({
        targetVolAnnual: opts.targetVolAnnual ?? 0.2,
        realizedVolAnnual: opts.realizedVolAnnual ?? 0,
        leverageCap: opts.leverageCap ?? 1.0,
      });
      return wrap(equity * lev, { leverage: lev, targetVolAnnual: opts.targetVolAnnual ?? 0.2, realizedVolAnnual: opts.realizedVolAnnual });
    }
    case "atr": {
      if (!(opts.price! > 0) || !(opts.atr! > 0)) return wrap(equity * (opts.riskPct ?? 0.01), { fallback: "fixed(no atr/price)" });
      const a = computeAtrSize({ equity, riskPct: opts.riskPct ?? 0.01, price: opts.price!, atr: opts.atr!, atrMult: opts.atrMult ?? 2.0 });
      return wrap(a.notional, { units: a.units, stopPrice: a.stopPrice, riskAmount: a.riskAmount, stopDistance: a.stopDistance });
    }
    case "kelly": {
      const k = computeFractionalKelly({
        winRate: opts.winRate ?? 0, avgWin: opts.avgWin ?? 0, avgLoss: opts.avgLoss ?? 0,
        fraction: opts.kellyFraction ?? 0.5, sampleSize: opts.sampleSize ?? 0,
      });
      return wrap(equity * k.fraction, { kellyFraction: k.fraction, usedFallback: k.usedFallback });
    }
    case "fixed":
    default:
      return wrap(equity * (opts.riskPct ?? 0.01), { riskPct: opts.riskPct ?? 0.01 });
  }
}
