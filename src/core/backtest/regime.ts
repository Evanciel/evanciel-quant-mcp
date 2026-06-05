/**
 * 시장 레짐 감지 (추세/횡보/고변동성) — 순수함수(backtest≡live). 신규 지표는 Kaufman ER 1개뿐(나머지 재사용).
 *
 * 정직한 포지셔닝(리서치): 레짐의 검증된 효용은 '진입 알파'가 아니라 '노출/사이징·전략군 게이팅과 하락장 회피'다
 * (Grayscale 50일MA Sharpe 1.9 vs 1.3, 주효과는 MDD 축소). ADX/ER 라벨 스위칭 단독 진입 알파는 WEAK →
 * '마스터 게이트/사이즈 배수'로만 사용. 휘프소 방어 위해 지속성 확인(persistence) 헬퍼 동봉.
 * 주의: ADX는 indicators.ts에서 Wilder RMA 아닌 EMA 평활 → 절대임계(25/40)는 상대지표로만, TradingView와 불일치.
 */
import { sma, atr, adx } from "../strategy/indicators";

export type RegimeLabel = "trend_up" | "trend_down" | "range" | "high_vol";

export interface RegimeResult {
  label: RegimeLabel;
  confidence: number; // 0~1 (= 최고점수/총점)
  adx: number;
  efficiencyRatio: number;
  atrPct: number;       // ATR/close (현재)
  atrPctile: number;    // ATR% 롤링 퍼센타일 (0~1)
  maSlope: number;      // SMA20 10봉 변화율
  direction: "up" | "down" | "flat";
  scores: Record<RegimeLabel, number>;
}

/**
 * Kaufman 효율성비율(ER) = |close[t]−close[t−n]| / Σ|close diff|. 1=효율적 추세, 0=노이즈/횡보.
 * 휘프소 필터 가성비 최고(리서치). 신규 지표 1개.
 */
export function kaufmanEfficiencyRatio(closes: number[], period = 14): number {
  const n = closes.length;
  if (n < period + 1) return 0;
  const change = Math.abs(closes[n - 1] - closes[n - 1 - period]);
  let volatility = 0;
  for (let i = n - period; i < n; i++) volatility += Math.abs(closes[i] - closes[i - 1]);
  return volatility > 0 ? change / volatility : 0;
}

/** 값이 시계열에서 차지하는 퍼센타일 순위(0~1). value 이하 비율. */
function percentileRank(series: number[], value: number): number {
  const clean = series.filter((x) => Number.isFinite(x));
  if (clean.length === 0) return 0;
  const below = clean.filter((x) => x <= value).length;
  return below / clean.length;
}

export interface RegimeParams {
  adxPeriod?: number; erPeriod?: number; atrPeriod?: number; maPeriod?: number; slopeLookback?: number;
  adxTrend?: number; adxRange?: number; erTrend?: number; erRange?: number;
  volHighPctile?: number; slopeUp?: number; slopeDown?: number;
}

/**
 * 레짐 계산. closes/highs/lows 동일 길이 OHLC. 가중 점수제로 4레짐 중 argmax 채택.
 * 추세강도=ADX·ER, 방향=MA기울기, 변동성=ATR% 퍼센타일. 모든 지표는 backtest/indicators와 동일 함수.
 */
export function computeRegime(
  closes: number[], highs: number[], lows: number[], params: RegimeParams = {}
): RegimeResult {
  const {
    adxPeriod = 14, erPeriod = 14, atrPeriod = 14, maPeriod = 20, slopeLookback = 10,
    adxTrend = 25, adxRange = 20, erTrend = 0.35, erRange = 0.2,
    volHighPctile = 0.8, slopeUp = 0.02, slopeDown = -0.02,
  } = params;

  const adxArr = adx(closes, highs, lows, adxPeriod);
  const adxNow = lastFinite(adxArr);
  const er = kaufmanEfficiencyRatio(closes, erPeriod);
  const atrArr = atr(closes, highs, lows, atrPeriod);
  const atrNow = lastFinite(atrArr);
  const closeNow = closes[closes.length - 1] || 0;
  const atrPct = closeNow > 0 ? atrNow / closeNow : 0;
  // ATR% 롤링 퍼센타일
  const atrPctSeries: number[] = [];
  for (let i = 0; i < atrArr.length; i++) {
    if (Number.isFinite(atrArr[i]) && closes[i] > 0) atrPctSeries.push(atrArr[i] / closes[i]);
  }
  const atrPctile = percentileRank(atrPctSeries, atrPct);
  // MA 기울기
  const ma = sma(closes, maPeriod);
  const maNow = lastFinite(ma);
  const maPast = ma.length > slopeLookback ? ma[ma.length - 1 - slopeLookback] : maNow;
  const maSlope = Number.isFinite(maPast) && maPast !== 0 ? (maNow - maPast) / maPast : 0;
  const direction: "up" | "down" | "flat" = maSlope > slopeUp ? "up" : maSlope < slopeDown ? "down" : "flat";

  // 레짐별 가중 점수
  const trendStrength = (adxNow > adxTrend ? 2 : adxNow > adxRange ? 1 : 0) + (er > erTrend ? 2 : er > erRange ? 1 : 0); // 0~4
  const volScore = atrPctile > volHighPctile ? 2 : atrPctile > 0.6 ? 1 : 0;
  const scores: Record<RegimeLabel, number> = {
    trend_up: trendStrength + (direction === "up" ? 2 : 0),
    trend_down: trendStrength + (direction === "down" ? 2 : 0),
    range: (adxNow < adxRange ? 2 : 0) + (er < erRange ? 2 : 0) + (direction === "flat" ? 1 : 0),
    high_vol: volScore,
  };
  // 고변동 오버라이드는 '추세가 약할 때(choppy)'만 — ATR%는 하락추세에서 가격↓로 자연 상승하므로,
  //   강추세를 고변동으로 오인하지 않게 trendStrength<2일 때만 변동성 퍼센타일로 high_vol 강제(리스크 보수).
  const choppy = trendStrength < 2;
  let label: RegimeLabel;
  let best: number;
  if (atrPctile > volHighPctile && choppy) {
    label = "high_vol"; best = scores.high_vol || 2;
  } else {
    label = "range"; best = scores.range;
    for (const k of ["trend_up", "trend_down", "high_vol", "range"] as RegimeLabel[]) {
      if (scores[k] > best) { best = scores[k]; label = k; }
    }
  }
  const total = scores.trend_up + scores.trend_down + scores.range + scores.high_vol;
  const confidence = label === "high_vol" && atrPctile > volHighPctile ? +atrPctile.toFixed(3)
    : total > 0 ? +(best / total).toFixed(3) : 0;

  return {
    label, confidence, adx: +adxNow.toFixed(2), efficiencyRatio: +er.toFixed(3),
    atrPct: +atrPct.toFixed(4), atrPctile: +atrPctile.toFixed(3), maSlope: +maSlope.toFixed(4),
    direction, scores,
  };
}

function lastFinite(arr: number[]): number {
  for (let i = arr.length - 1; i >= 0; i--) if (Number.isFinite(arr[i])) return arr[i];
  return 0;
}

export interface RegimeFilter {
  minAdx?: number; minEfficiencyRatio?: number; maxVolPctile?: number;
  direction?: "up" | "down" | "any"; allow?: RegimeLabel[];
}

/**
 * 레짐 게이트 통과 여부 — deploy({regimeFilter}) 저장 후 라이브 진입 시 평가용(마스터 게이트).
 * 추세 요구·고변동 차단·방향 일치·허용 레짐 화이트리스트. 진입 알파 아니라 '노출 게이팅'.
 */
export function regimeGatePasses(regime: RegimeResult, filter: RegimeFilter = {}): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (typeof filter.minAdx === "number" && regime.adx < filter.minAdx) reasons.push(`ADX ${regime.adx} < ${filter.minAdx}(추세 약함)`);
  if (typeof filter.minEfficiencyRatio === "number" && regime.efficiencyRatio < filter.minEfficiencyRatio) reasons.push(`ER ${regime.efficiencyRatio} < ${filter.minEfficiencyRatio}(노이즈/횡보)`);
  if (typeof filter.maxVolPctile === "number" && regime.atrPctile > filter.maxVolPctile) reasons.push(`변동성 퍼센타일 ${regime.atrPctile} > ${filter.maxVolPctile}(고변동 회피)`);
  if (filter.direction && filter.direction !== "any" && regime.direction !== filter.direction) reasons.push(`방향 ${regime.direction} ≠ 요구 ${filter.direction}`);
  if (Array.isArray(filter.allow) && filter.allow.length && !filter.allow.includes(regime.label)) reasons.push(`레짐 ${regime.label} 미허용(허용: ${filter.allow.join("/")})`);
  return { pass: reasons.length === 0, reasons };
}

/**
 * 휘프소 방어: 최근 N봉의 레짐 라벨이 모두 동일할 때만 '확정'(persistence 확인). 아니면 직전 확정 유지(default=지속).
 * regimes = 최신순 또는 시간순 라벨 배열. 기본 3봉 연속.
 */
export function confirmRegimePersistence(labels: RegimeLabel[], persistence = 3, prevConfirmed: RegimeLabel | null = null): RegimeLabel | null {
  if (labels.length < persistence) return prevConfirmed;
  const recent = labels.slice(-persistence);
  return recent.every((l) => l === recent[0]) ? recent[0] : prevConfirmed;
}
