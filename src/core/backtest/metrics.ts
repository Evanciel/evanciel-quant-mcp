/**
 * 백테스트 성과 지표 계산 모듈
 * Sharpe Ratio, MDD(최대낙폭), 승률, 수익 팩터 등 공통 계산 함수를 제공합니다.
 */
import type { BacktestTrade } from "../types/strategy";

interface EquityPoint {
  date: string;
  value: number;
}

/** 최대 낙폭(MDD)을 계산합니다. 백분율(%) 단위로 반환합니다. */
export function calcMaxDrawdown(equityCurve: EquityPoint[], initialCapital: number): number {
  let maxDrawdown = 0;
  let peak = initialCapital;
  for (const point of equityCurve) {
    if (point.value > peak) peak = point.value;
    const drawdown = peak > 0 ? ((peak - point.value) / peak) * 100 : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  return maxDrawdown;
}

/**
 * 봉(타임프레임)당 연간 봉 개수. 크립토는 24/7이므로 365일 기준.
 * 주의: 과거에는 주식 거래일(×√252)을 하드코딩했으나, 이 프로젝트는 크립토 우선 + 인트라데이 봉이라
 * 봉주기별 정확한 연환산이 필수다(1h를 √252로 연환산하면 SR이 ~6배 과소). DSR/사이징/게이트 입력 전제.
 */
export const BARS_PER_YEAR: Record<string, number> = {
  "1m": 525600, "3m": 175200, "5m": 105120, "15m": 35040, "30m": 17520,
  "1h": 8760, "2h": 4380, "4h": 2190, "6h": 1460, "8h": 1095, "12h": 730,
  "1d": 365, "3d": 121.667, "1w": 52.143,
};

/** 타임프레임 → 연간 봉 개수(크립토 24/7, 365d). 미지정/미지원은 일봉(365)으로 폴백. */
export function periodsPerYear(timeframe = "1d"): number {
  return BARS_PER_YEAR[timeframe] ?? 365;
}

/**
 * 샤프 비율(Sharpe Ratio)을 계산합니다.
 * 무위험 수익률 연 3% 기준, 표본 표준편차 사용, 봉주기별 연환산(×√(연간봉수)) 적용.
 * timeframe 미지정 시 일봉(크립토 365) 가정. 데이터 부족/변동성 0이면 0.
 */
export function calcSharpeRatio(equityCurve: EquityPoint[], timeframe = "1d"): number {
  const ppy = periodsPerYear(timeframe);
  const RISK_FREE_ANNUAL = 0.03;
  const rfPerBar = RISK_FREE_ANNUAL / ppy;

  const returns = equityCurve
    .slice(1)
    .map((p, i) => {
      const prev = equityCurve[i].value;
      return prev > 0 ? (p.value - prev) / prev : 0;
    });

  if (returns.length === 0) return 0;

  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const stdReturn = Math.sqrt(
    returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) /
      Math.max(returns.length - 1, 1)
  );

  return stdReturn > 0 ? ((avgReturn - rfPerBar) / stdReturn) * Math.sqrt(ppy) : 0;
}

/**
 * Deflated Sharpe Ratio 입력용 수익률 모멘트. 비연환산 per-bar Sharpe(rf=0) + 왜도/첨도 + 표본수(T).
 * López de Prado DSR 공식은 비연환산 per-bar SR과 고차모멘트를 요구한다.
 * 반환: { n(=T, 수익 관측치수), perBarSharpe, skewness, kurtosis(정규=3) }.
 */
export function calcReturnMoments(equityCurve: EquityPoint[]): {
  n: number;
  perBarSharpe: number;
  skewness: number;
  kurtosis: number;
} {
  const returns = equityCurve.slice(1).map((p, i) => {
    const prev = equityCurve[i].value;
    return prev > 0 ? (p.value - prev) / prev : 0;
  });
  const n = returns.length;
  if (n < 2) return { n, perBarSharpe: 0, skewness: 0, kurtosis: 3 };

  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / n; // 모분산(왜도/첨도 정의와 일관)
  const sd = Math.sqrt(variance);
  if (sd === 0) return { n, perBarSharpe: 0, skewness: 0, kurtosis: 3 };

  const m3 = returns.reduce((s, r) => s + (r - mean) ** 3, 0) / n;
  const m4 = returns.reduce((s, r) => s + (r - mean) ** 4, 0) / n;
  return {
    n,
    perBarSharpe: mean / sd, // 비연환산, rf=0 (DSR 표준)
    skewness: m3 / sd ** 3,
    kurtosis: m4 / sd ** 4, // 정규분포=3
  };
}

/** 매도 거래 목록에서 승률(%)과 수익 팩터를 계산합니다. */
export function calcTradeStats(trades: BacktestTrade[]): {
  winRate: number;
  profitFactor: number;
} {
  const sellTrades = trades.filter((t) => t.action === "sell");
  const winTrades = sellTrades.filter((t) => t.pnl > 0);
  const winRate = sellTrades.length > 0 ? (winTrades.length / sellTrades.length) * 100 : 0;

  const grossProfit = winTrades.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(
    sellTrades.filter((t) => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0)
  );
  const profitFactor =
    grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 9999 : 0;

  return { winRate, profitFactor };
}
