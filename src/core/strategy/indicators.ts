export function sma(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
      continue;
    }
    const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    result.push(sum / period);
  }
  return result;
}

export function ema(data: number[], period: number): number[] {
  const result: number[] = [];
  const multiplier = 2 / (period + 1);

  for (let i = 0; i < data.length; i++) {
    if (i === 0) {
      result.push(data[0]);
    } else {
      result.push(data[i] * multiplier + result[i - 1] * (1 - multiplier));
    }
  }
  return result;
}

export function rsi(data: number[], period: number = 14): number[] {
  const result: number[] = [];
  if (data.length <= period) return data.map(() => NaN);

  // Wilder Smoothed RSI (업계 표준 — TradingView, MetaTrader 동일)
  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < data.length; i++) {
    const change = data[i] - data[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }

  // 첫 period 구간은 NaN
  result.push(NaN); // index 0
  for (let i = 0; i < period - 1; i++) {
    result.push(NaN);
  }

  // 첫 번째 평균 (SMA seed)
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const rs0 = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs0));

  // Wilder exponential smoothing
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    if (avgLoss === 0) {
      result.push(100);
    } else {
      const rs = avgGain / avgLoss;
      result.push(100 - 100 / (1 + rs));
    }
  }

  return result;
}

export function macd(
  data: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): { macd: number[]; signal: number[]; histogram: number[] } {
  const fastEma = ema(data, fastPeriod);
  const slowEma = ema(data, slowPeriod);

  const macdLine = fastEma.map((f, i) => f - slowEma[i]);
  const signalLine = ema(macdLine, signalPeriod);
  const histogram = macdLine.map((m, i) => m - signalLine[i]);

  return { macd: macdLine, signal: signalLine, histogram };
}

export function bollingerBands(
  data: number[],
  period: number = 20,
  stdDev: number = 2
): { upper: number[]; middle: number[]; lower: number[] } {
  const middle = sma(data, period);
  const upper: number[] = [];
  const lower: number[] = [];

  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      upper.push(NaN);
      lower.push(NaN);
      continue;
    }

    const slice = data.slice(i - period + 1, i + 1);
    const mean = middle[i];
    const variance =
      slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
    const sd = Math.sqrt(variance);

    upper.push(mean + stdDev * sd);
    lower.push(mean - stdDev * sd);
  }

  return { upper, middle, lower };
}

/** Stochastic Oscillator %K */
export function stochastic(closes: number[], highs: number[], lows: number[], kPeriod = 14, dPeriod = 3): { k: number[]; d: number[] } {
  const k: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < kPeriod - 1) { k.push(NaN); continue; }
    const highSlice = highs.slice(i - kPeriod + 1, i + 1);
    const lowSlice = lows.slice(i - kPeriod + 1, i + 1);
    const hh = Math.max(...highSlice);
    const ll = Math.min(...lowSlice);
    k.push(hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100);
  }
  const d = sma(k.map((v) => (isNaN(v) ? 0 : v)), dPeriod);
  return { k, d };
}

/** Average True Range */
export function atr(closes: number[], highs: number[], lows: number[], period = 14): number[] {
  const tr: number[] = [highs[0] - lows[0]];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  return sma(tr, period);
}

/**
 * On-Balance Volume — 롤링 윈도우(최근 period봉 부호거래량 합).
 * 과거: index 0부터 누적 → 최신값이 입력길이에 종속 → 라이브(warmup ~250봉)와 백테스트(가변 days)에서
 * 절대값 발산(backtest≠live, 상수 비교 시 신호반전). 롤링으로 윈도우 독립 → backtest==live.
 */
export function obv(closes: number[], volumes: number[], period = 20): number[] {
  const signed: number[] = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) signed.push(volumes[i]);
    else if (closes[i] < closes[i - 1]) signed.push(-volumes[i]);
    else signed.push(0);
  }
  const result: number[] = [];
  let sum = 0;
  for (let i = 0; i < signed.length; i++) {
    sum += signed[i];
    if (i >= period) sum -= signed[i - period];
    // 워밍업: 부분윈도우(signed[0]=0 강제항 포함)는 NaN 처리 → sma/bollinger와 동일 규약.
    // 입력길이==period 경계에서 마지막값이 길이 의존하던 잠복 비일관 제거(완전 길이 독립).
    result.push(i < period ? NaN : sum);
  }
  return result;
}

/** Williams %R */
export function williamsR(closes: number[], highs: number[], lows: number[], period = 14): number[] {
  const result: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { result.push(NaN); continue; }
    const hh = Math.max(...highs.slice(i - period + 1, i + 1));
    const ll = Math.min(...lows.slice(i - period + 1, i + 1));
    result.push(hh === ll ? -50 : ((hh - closes[i]) / (hh - ll)) * -100);
  }
  return result;
}

/** Stochastic RSI — RSI에 Stochastic을 적용 */
export function stochasticRsi(closes: number[], rsiPeriod = 14, stochPeriod = 14, kPeriod = 3, dPeriod = 3): { k: number[]; d: number[] } {
  const rsiValues = rsi(closes, rsiPeriod);
  const k: number[] = [];
  for (let i = 0; i < rsiValues.length; i++) {
    if (i < rsiPeriod + stochPeriod - 2 || isNaN(rsiValues[i])) { k.push(NaN); continue; }
    const slice = rsiValues.slice(i - stochPeriod + 1, i + 1).filter((v) => !isNaN(v));
    if (slice.length < stochPeriod) { k.push(NaN); continue; }
    const hh = Math.max(...slice);
    const ll = Math.min(...slice);
    k.push(hh === ll ? 50 : ((rsiValues[i] - ll) / (hh - ll)) * 100);
  }
  const cleanK = k.map((v) => (isNaN(v) ? 0 : v));
  const d = sma(cleanK, dPeriod);
  return { k, d };
}

/** CCI — Commodity Channel Index */
export function cci(closes: number[], highs: number[], lows: number[], period = 20): number[] {
  const result: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { result.push(NaN); continue; }
    const typicalPrices: number[] = [];
    for (let j = i - period + 1; j <= i; j++) {
      typicalPrices.push((highs[j] + lows[j] + closes[j]) / 3);
    }
    const tp = typicalPrices[typicalPrices.length - 1];
    const mean = typicalPrices.reduce((a, b) => a + b, 0) / period;
    const meanDev = typicalPrices.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
    result.push(meanDev === 0 ? 0 : (tp - mean) / (0.015 * meanDev));
  }
  return result;
}

/** ADX — Average Directional Index */
export function adx(closes: number[], highs: number[], lows: number[], period = 14): number[] {
  if (closes.length < 2) return closes.map(() => NaN);
  // +DM, -DM, TR 계산
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  const tr: number[] = [highs[0] - lows[0]];
  for (let i = 1; i < closes.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  // Smoothed 평균
  const smoothTR = ema(tr, period);
  const smoothPlusDM = ema(plusDM, period);
  const smoothMinusDM = ema(minusDM, period);
  // +DI, -DI
  const dx: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const pdi = smoothTR[i] === 0 ? 0 : (smoothPlusDM[i] / smoothTR[i]) * 100;
    const mdi = smoothTR[i] === 0 ? 0 : (smoothMinusDM[i] / smoothTR[i]) * 100;
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100);
  }
  return ema(dx, period);
}

/** Supertrend — ATR 기반 추세 지표 */
export function supertrend(closes: number[], highs: number[], lows: number[], period = 10, multiplier = 3): number[] {
  const atrValues = sma(
    highs.map((h, i) => {
      if (i === 0) return h - lows[i];
      return Math.max(h - lows[i], Math.abs(h - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    }),
    period
  );
  const result: number[] = [];
  let trend = 1; // 1=상승, -1=하락
  let upperBand = 0;
  let lowerBand = 0;
  for (let i = 0; i < closes.length; i++) {
    if (isNaN(atrValues[i])) { result.push(NaN); continue; }
    const mid = (highs[i] + lows[i]) / 2;
    const newUpper = mid + multiplier * atrValues[i];
    const newLower = mid - multiplier * atrValues[i];
    upperBand = i > 0 && newUpper < upperBand && closes[i - 1] > upperBand ? upperBand : newUpper;
    lowerBand = i > 0 && newLower > lowerBand && closes[i - 1] < lowerBand ? lowerBand : newLower;
    if (closes[i] > upperBand) trend = 1;
    else if (closes[i] < lowerBand) trend = -1;
    result.push(trend === 1 ? lowerBand : upperBand);
  }
  return result;
}

/**
 * VWAP — 롤링 윈도우(최근 period봉 거래량가중평균, intraday VWAP 근사).
 * 과거: window-origin부터 누적 → 최신값이 입력길이에 종속(backtest≠live). 롤링으로 윈도우 독립.
 */
export function vwap(closes: number[], highs: number[], lows: number[], volumes: number[], period = 20): number[] {
  const result: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const start = Math.max(0, i - period + 1);
    let tpv = 0, vol = 0;
    for (let j = start; j <= i; j++) {
      const tp = (highs[j] + lows[j] + closes[j]) / 3;
      tpv += tp * volumes[j];
      vol += volumes[j];
    }
    const tpCur = (highs[i] + lows[i] + closes[i]) / 3;
    result.push(vol === 0 ? tpCur : tpv / vol);
  }
  return result;
}

/** MFI — Money Flow Index */
export function mfi(closes: number[], highs: number[], lows: number[], volumes: number[], period = 14): number[] {
  const result: number[] = [];
  const tp: number[] = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  for (let i = 0; i < closes.length; i++) {
    if (i < period) { result.push(NaN); continue; }
    let posFlow = 0, negFlow = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const rawMF = tp[j] * volumes[j];
      if (tp[j] > tp[j - 1]) posFlow += rawMF;
      else if (tp[j] < tp[j - 1]) negFlow += rawMF;
    }
    result.push(100 - 100 / (1 + (negFlow === 0 ? 100 : posFlow / negFlow)));
  }
  return result;
}

/** Parabolic SAR */
export function parabolicSar(highs: number[], lows: number[], afStart = 0.02, afMax = 0.2): number[] {
  if (highs.length === 0) return [];
  const result: number[] = [];
  let trend = 1, sar = lows[0], ep = highs[0], af = afStart;
  for (let i = 0; i < highs.length; i++) {
    if (i === 0) { result.push(sar); continue; }
    let newSar = sar + af * (ep - sar);
    if (trend === 1) {
      newSar = Math.min(newSar, lows[i - 1], i >= 2 ? lows[i - 2] : lows[i - 1]);
      if (lows[i] < newSar) { trend = -1; newSar = ep; ep = lows[i]; af = afStart; }
      else if (highs[i] > ep) { ep = highs[i]; af = Math.min(af + afStart, afMax); }
    } else {
      newSar = Math.max(newSar, highs[i - 1], i >= 2 ? highs[i - 2] : highs[i - 1]);
      if (highs[i] > newSar) { trend = 1; newSar = ep; ep = highs[i]; af = afStart; }
      else if (lows[i] < ep) { ep = lows[i]; af = Math.min(af + afStart, afMax); }
    }
    sar = newSar;
    result.push(sar);
  }
  return result;
}

/** Ichimoku Cloud — 전환선 반환 */
export function ichimoku(highs: number[], lows: number[], tenkanPeriod = 9, kijunPeriod = 26): {
  tenkan: number[]; kijun: number[]; senkouA: number[]; senkouB: number[];
} {
  function midline(h: number[], l: number[], period: number): number[] {
    return h.map((_, i) => {
      if (i < period - 1) return NaN;
      const hh = Math.max(...h.slice(i - period + 1, i + 1));
      const ll = Math.min(...l.slice(i - period + 1, i + 1));
      return (hh + ll) / 2;
    });
  }
  const tenkan = midline(highs, lows, tenkanPeriod);
  const kijun = midline(highs, lows, kijunPeriod);
  const senkouA = tenkan.map((t, i) => (isNaN(t) || isNaN(kijun[i]) ? NaN : (t + kijun[i]) / 2));
  const senkouB = midline(highs, lows, 52);
  return { tenkan, kijun, senkouA, senkouB };
}

/** ROC — Rate of Change */
export function roc(closes: number[], period = 12): number[] {
  return closes.map((c, i) => i < period ? NaN : ((c - closes[i - period]) / closes[i - period]) * 100);
}

/** Donchian Channels — 상한선 반환 */
export function donchian(highs: number[], lows: number[], period = 20): { upper: number[]; lower: number[]; middle: number[] } {
  const upper: number[] = [], lower: number[] = [], middle: number[] = [];
  for (let i = 0; i < highs.length; i++) {
    if (i < period - 1) { upper.push(NaN); lower.push(NaN); middle.push(NaN); continue; }
    const hh = Math.max(...highs.slice(i - period + 1, i + 1));
    const ll = Math.min(...lows.slice(i - period + 1, i + 1));
    upper.push(hh); lower.push(ll); middle.push((hh + ll) / 2);
  }
  return { upper, lower, middle };
}

/** Aroon — Aroon Up 반환 */
export function aroon(highs: number[], lows: number[], period = 25): { up: number[]; down: number[] } {
  const up: number[] = [], down: number[] = [];
  for (let i = 0; i < highs.length; i++) {
    if (i < period) { up.push(NaN); down.push(NaN); continue; }
    const slice_h = highs.slice(i - period, i + 1);
    const slice_l = lows.slice(i - period, i + 1);
    const highIdx = slice_h.indexOf(Math.max(...slice_h));
    const lowIdx = slice_l.indexOf(Math.min(...slice_l));
    up.push((highIdx / period) * 100);
    down.push((lowIdx / period) * 100);
  }
  return { up, down };
}
