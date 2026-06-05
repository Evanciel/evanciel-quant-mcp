/**
 * 백테스트 공유 지표 계산 모듈
 * engine.ts와 sandbox/auto-trader.ts가 공통으로 사용합니다.
 */
import type { IndicatorType } from "../types/strategy";
import { sma, ema, rsi, macd, bollingerBands, stochastic, atr, obv, williamsR, stochasticRsi, cci, adx, supertrend, vwap, mfi, parabolicSar, ichimoku, roc, donchian, aroon } from "../strategy/indicators";

/**
 * 종가/거래량/고가/저가 배열에서 지표값 배열을 계산합니다.
 */
export function computeIndicator(
  prices: number[],
  volumes: number[],
  type: IndicatorType,
  params: Record<string, number>,
  highs?: number[],
  lows?: number[]
): number[] {
  const h = highs || prices;
  const l = lows || prices;

  switch (type) {
    case "sma":
      return sma(prices, params.period || 20);
    case "ema":
      return ema(prices, params.period || 20);
    case "rsi":
      return rsi(prices, params.period || 14);
    case "macd":
      return macd(prices, params.fast || 12, params.slow || 26, params.signal || 9).macd;
    case "bollinger":
      return bollingerBands(prices, params.period || 20, params.stdDev || 2).middle;
    case "volume":
      return volumes;
    case "stochastic":
      return stochastic(prices, h, l, params.period || 14, params.dPeriod || 3).k;
    case "atr":
      return atr(prices, h, l, params.period || 14);
    case "obv":
      return obv(prices, volumes, params.period || 20);
    case "williams_r":
      return williamsR(prices, h, l, params.period || 14);
    case "stochastic_rsi":
      return stochasticRsi(prices, params.period || 14, params.stochPeriod || 14, params.kPeriod || 3, params.dPeriod || 3).k;
    case "cci":
      return cci(prices, h, l, params.period || 20);
    case "adx":
      return adx(prices, h, l, params.period || 14);
    case "supertrend":
      return supertrend(prices, h, l, params.period || 10, params.multiplier || 3);
    case "vwap":
      return vwap(prices, h, l, volumes, params.period || 20);
    case "mfi":
      return mfi(prices, h, l, volumes, params.period || 14);
    case "parabolic_sar":
      return parabolicSar(h, l, (params.period || 2) / 100, 0.2);
    case "ichimoku":
      return ichimoku(h, l, params.period || 9, 26).tenkan;
    case "roc":
      return roc(prices, params.period || 12);
    case "donchian":
      return donchian(h, l, params.period || 20).upper;
    case "aroon":
      return aroon(h, l, params.period || 25).up;
    default:
      return prices;
  }
}
