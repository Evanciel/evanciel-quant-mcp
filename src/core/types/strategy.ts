export type IndicatorType = "sma" | "ema" | "rsi" | "macd" | "bollinger" | "volume" | "stochastic" | "atr" | "obv" | "williams_r" | "stochastic_rsi" | "cci" | "adx" | "supertrend" | "vwap" | "mfi" | "parabolic_sar" | "ichimoku" | "roc" | "donchian" | "aroon";
export type ConditionOperator = "gt" | "lt" | "gte" | "lte" | "cross_above" | "cross_below";
export type ActionType = "buy" | "sell";

export interface Indicator {
  type: IndicatorType;
  params: Record<string, number>;
}

export interface Condition {
  id: string;
  indicator: IndicatorType;
  params: Record<string, number>;
  operator: ConditionOperator;
  value: number | IndicatorType;
  valueParams?: Record<string, number>;
}

export type OrderType = "market" | "limit";

export interface StrategyRule {
  id: string;
  action: ActionType;
  conditions: Condition[];
  quantityPercent: number; // 잔고 대비 %
  orderType?: OrderType;         // 기본 market
  limitPriceOffset?: number;     // 지정가: 현재가 대비 % (음수=아래, 양수=위)
}

export interface Strategy {
  id: string;
  userId: string;
  name: string;
  description: string;
  symbol: string;
  rules: StrategyRule[];
  stopLossPercent?: number;
  takeProfitPercent?: number;
  maxPositionSize?: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface BacktestConfig {
  strategyId: string;
  symbol: string;
  startDate: string;
  endDate: string;
  initialCapital: number;
  commission: number; // %
  slippage?: number; // % (기본 0.05 — 시장가 체결 시 가격 변동)
  timeframe?: string; // 봉 주기(1m~1d). Sharpe 연환산에 사용. 미지정 시 일봉(크립토 365). (mig017 연계)
}

export interface BacktestTrade {
  date: string;
  action: ActionType;
  price: number;
  quantity: number;
  pnl: number;
  balance: number;
}

export interface BacktestResult {
  totalReturn: number;
  totalReturnPercent: number;
  maxDrawdown: number;
  winRate: number;
  totalTrades: number;
  profitFactor: number;
  sharpeRatio: number;
  trades: BacktestTrade[];
  equityCurve: { date: string; value: number }[];
}

export const INDICATOR_LABELS: Record<IndicatorType, string> = {
  sma: "단순이동평균 (SMA)",
  ema: "지수이동평균 (EMA)",
  rsi: "RSI",
  macd: "MACD",
  bollinger: "볼린저 밴드",
  volume: "거래량",
  stochastic: "스토캐스틱 (%K)",
  atr: "ATR (변동성)",
  obv: "OBV (거래량 흐름)",
  williams_r: "Williams %R",
  stochastic_rsi: "스토캐스틱 RSI",
  cci: "CCI (상품채널지수)",
  adx: "ADX (추세 강도)",
  supertrend: "슈퍼트렌드",
  vwap: "VWAP (거래량가중평균)",
  mfi: "MFI (자금흐름지수)",
  parabolic_sar: "파라볼릭 SAR",
  ichimoku: "일목균형표 (전환선)",
  roc: "ROC (변화율)",
  donchian: "돈치안 채널",
  aroon: "아룬 (추세 전환)",
};

export const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  gt: "보다 크다 (>)",
  lt: "보다 작다 (<)",
  gte: "이상 (>=)",
  lte: "이하 (<=)",
  cross_above: "상향돌파",
  cross_below: "하향돌파",
};

// ── 복합 전략 (Strategy Lab) ──

export type StrategyNode = LeafNode | ConditionNode | CompositeNode;

export interface LeafNode {
  id: string;
  type: "leaf";
  name: string;
  strategy: Strategy;
}

export interface ConditionNode {
  id: string;
  type: "condition";
  name: string;
  condition: NodeCondition;
  thenNode: StrategyNode;
  elseNode?: StrategyNode;
}

export interface CompositeNode {
  id: string;
  type: "composite";
  name: string;
  mode: "priority" | "weighted";
  children: StrategyNode[];
  weights?: number[];
}

export type NodeCondition = IndicatorCondition | TimeCondition | PerformanceCondition;

export interface IndicatorCondition {
  type: "indicator";
  indicator: IndicatorType;
  params: Record<string, number>;
  operator: ConditionOperator;
  value: number;
}

export interface TimeCondition {
  type: "time";
  field: "month" | "quarter" | "dayOfWeek";
  operator: "eq" | "in" | "between";
  values: number[];
}

export interface PerformanceCondition {
  type: "performance";
  metric: "returnPercent" | "drawdown" | "winRate";
  lookbackDays: number;
  operator: ConditionOperator;
  value: number;
}

export interface MultiBacktestResult {
  results: {
    name: string;
    result: BacktestResult;
    benchmarkReturn: number;
  }[];
  bestStrategy: string;
  period: { start: string; end: string };
}

export interface OptimizeConfig {
  strategy: Strategy;
  parameterRanges: {
    ruleIndex: number;
    conditionIndex: number;
    field: "period" | "value";
    min: number;
    max: number;
    step: number;
  }[];
  symbol: string;
  days: number;
  initialCapital: number;
  metric: "totalReturnPercent" | "sharpeRatio" | "profitFactor" | "maxDrawdown";
}

export interface OptimizeResult {
  bestParams: Record<string, number>;
  bestMetric: number;
  allResults: {
    params: Record<string, number>;
    result: BacktestResult;
  }[];
  warnings: string[];
}

export type PeriodUnit = "candle" | "day" | "hour" | "minute";

export interface IndicatorMeta {
  label: string;
  periodLabel: string;
  periodUnit: PeriodUnit;
  periodHint: string;
  periodDefault: number;
  valueLabel: string;
  valueUnit: string;
  valueHint: string;
  valueDefault: number;
  description: string;
}

export const INDICATOR_META: Record<IndicatorType, IndicatorMeta> = {
  sma: {
    label: "단순이동평균 (SMA)",
    periodLabel: "이동평균 기간",
    periodUnit: "candle",
    periodHint: "캔들 수 (일봉=일, 시간봉=시간)",
    periodDefault: 20,
    valueLabel: "비교 이동평균 기간",
    valueUnit: "캔들",
    valueHint: "크로스: 비교할 다른 SMA 기간 / 비교: 이탈 %",
    valueDefault: 60,
    description: "N개 캔들의 종가 평균. 추세 방향 판단에 사용",
  },
  ema: {
    label: "지수이동평균 (EMA)",
    periodLabel: "EMA 기간",
    periodUnit: "candle",
    periodHint: "캔들 수. 최근 데이터에 더 높은 가중치",
    periodDefault: 12,
    valueLabel: "비교 EMA 기간",
    valueUnit: "캔들",
    valueHint: "크로스: 비교할 다른 EMA 기간",
    valueDefault: 26,
    description: "최근 가격에 가중치를 둔 이동평균. SMA보다 빠른 반응",
  },
  rsi: {
    label: "RSI (상대강도지수)",
    periodLabel: "RSI 기간",
    periodUnit: "candle",
    periodHint: "일반적으로 14 사용",
    periodDefault: 14,
    valueLabel: "RSI 기준값",
    valueUnit: "0~100",
    valueHint: "30 이하=과매도, 70 이상=과매수",
    valueDefault: 30,
    description: "0~100 범위. 30 이하면 과매도(매수 기회), 70 이상이면 과매수(매도 기회)",
  },
  macd: {
    label: "MACD",
    periodLabel: "빠른 EMA 기간",
    periodUnit: "candle",
    periodHint: "기본 12. 느린 EMA는 자동 26",
    periodDefault: 12,
    valueLabel: "시그널 기준",
    valueUnit: "값",
    valueHint: "0 = 시그널 라인 기준 크로스",
    valueDefault: 0,
    description: "빠른 EMA와 느린 EMA의 차이. 시그널 라인 돌파로 매매 시점 판단",
  },
  bollinger: {
    label: "볼린저 밴드",
    periodLabel: "이동평균 기간",
    periodUnit: "candle",
    periodHint: "기본 20. 밴드 폭 계산 기준",
    periodDefault: 20,
    valueLabel: "표준편차 배수",
    valueUnit: "배 (±σ)",
    valueHint: "-2=하단밴드, +2=상단밴드",
    valueDefault: 2,
    description: "이동평균 ± 표준편차. 밴드 이탈 시 반등 또는 돌파 신호",
  },
  volume: {
    label: "거래량",
    periodLabel: "평균 거래량 기간",
    periodUnit: "candle",
    periodHint: "N개 캔들의 평균 거래량과 비교",
    periodDefault: 20,
    valueLabel: "평균 대비 비율",
    valueUnit: "%",
    valueHint: "200 = 평균의 2배 이상",
    valueDefault: 200,
    description: "거래량 급증은 강한 매수/매도세 신호. 평균 대비 비율로 판단",
  },
  stochastic: {
    label: "스토캐스틱 (%K)",
    periodLabel: "K 기간",
    periodUnit: "candle" as PeriodUnit,
    periodHint: "기본 14. 고가/저가 범위 기준",
    periodDefault: 14,
    valueLabel: "기준값",
    valueUnit: "%",
    valueHint: "20=과매도, 80=과매수",
    valueDefault: 20,
    description: "현재 가격이 최근 고저 범위에서 어디에 있는지 (0~100)",
  },
  atr: {
    label: "ATR (변동성)",
    periodLabel: "ATR 기간",
    periodUnit: "candle" as PeriodUnit,
    periodHint: "기본 14",
    periodDefault: 14,
    valueLabel: "기준값",
    valueUnit: "가격",
    valueHint: "ATR 절대값. 높을수록 변동성 큼",
    valueDefault: 100,
    description: "True Range의 이동평균. 변동성 측정 + 손절폭 결정에 사용",
  },
  obv: {
    label: "OBV (거래량 흐름)",
    periodLabel: "기간",
    periodUnit: "candle" as PeriodUnit,
    periodHint: "OBV는 기간 불필요",
    periodDefault: 1,
    valueLabel: "기준값",
    valueUnit: "누적량",
    valueHint: "OBV 절대값",
    valueDefault: 0,
    description: "가격 상승 시 거래량 합산, 하락 시 차감. 거래량 선행 신호",
  },
  williams_r: {
    label: "Williams %R",
    periodLabel: "기간",
    periodUnit: "candle" as PeriodUnit,
    periodHint: "기본 14",
    periodDefault: 14,
    valueLabel: "기준값",
    valueUnit: "%",
    valueHint: "-80=과매도, -20=과매수",
    valueDefault: -80,
    description: "0~-100 범위. Stochastic 반전 (음수)",
  },
  stochastic_rsi: {
    label: "스토캐스틱 RSI",
    periodLabel: "RSI 기간",
    periodUnit: "candle" as PeriodUnit,
    periodHint: "기본 14",
    periodDefault: 14,
    valueLabel: "기준값",
    valueUnit: "%",
    valueHint: "20=과매도, 80=과매수. RSI보다 민감",
    valueDefault: 20,
    description: "RSI에 Stochastic을 적용. 크립토에서 특히 인기. 더 빠른 신호",
  },
  cci: {
    label: "CCI (상품채널지수)",
    periodLabel: "기간",
    periodUnit: "candle" as PeriodUnit,
    periodHint: "기본 20",
    periodDefault: 20,
    valueLabel: "기준값",
    valueUnit: "",
    valueHint: "-100=과매도, +100=과매수",
    valueDefault: -100,
    description: "전형적 가격의 평균 편차. -100 이하 과매도, +100 이상 과매수",
  },
  adx: {
    label: "ADX (추세 강도)",
    periodLabel: "기간",
    periodUnit: "candle" as PeriodUnit,
    periodHint: "기본 14",
    periodDefault: 14,
    valueLabel: "기준값",
    valueUnit: "",
    valueHint: "25 이상이면 강한 추세. 20 이하 횡보",
    valueDefault: 25,
    description: "추세의 강도만 측정 (방향 무관). 횡보장 필터링에 유용",
  },
  supertrend: {
    label: "슈퍼트렌드",
    periodLabel: "ATR 기간",
    periodUnit: "candle" as PeriodUnit,
    periodHint: "기본 10",
    periodDefault: 10,
    valueLabel: "배수",
    valueUnit: "x",
    valueHint: "ATR 배수. 기본 3. 높을수록 둔감",
    valueDefault: 3,
    description: "ATR 기반 추세 추적. 가격이 밴드 위면 상승, 아래면 하락 추세",
  },
  vwap: {
    label: "VWAP",
    periodLabel: "기간",
    periodUnit: "candle" as PeriodUnit,
    periodHint: "누적 계산 (기간 불필요)",
    periodDefault: 1,
    valueLabel: "비교값",
    valueUnit: "가격",
    valueHint: "VWAP 가격과 비교",
    valueDefault: 0,
    description: "거래량 가중 평균 가격. 데이트레이더 필수. 기관 기준선",
  },
  mfi: {
    label: "MFI (자금흐름지수)",
    periodLabel: "기간",
    periodUnit: "candle" as PeriodUnit,
    periodHint: "기본 14",
    periodDefault: 14,
    valueLabel: "기준값",
    valueUnit: "%",
    valueHint: "20=과매도, 80=과매수. RSI+거래량",
    valueDefault: 20,
    description: "거래량 가중 RSI. 실제 자금 흐름으로 과매수/과매도 판단",
  },
  parabolic_sar: {
    label: "파라볼릭 SAR",
    periodLabel: "AF 시작값 (×100)",
    periodUnit: "candle" as PeriodUnit,
    periodHint: "기본 2 (=0.02). 가속 인자",
    periodDefault: 2,
    valueLabel: "비교값",
    valueUnit: "가격",
    valueHint: "SAR 가격과 현재가 비교",
    valueDefault: 0,
    description: "추세 추적 + 손절선. 점이 가격 위면 하락, 아래면 상승 추세",
  },
  ichimoku: {
    label: "일목균형표 (전환선)",
    periodLabel: "전환선 기간",
    periodUnit: "candle" as PeriodUnit,
    periodHint: "기본 9 (한국 기본값)",
    periodDefault: 9,
    valueLabel: "비교값",
    valueUnit: "가격",
    valueHint: "전환선 가격과 비교",
    valueDefault: 0,
    description: "일본 발명, 한국 인기. 전환선(9)+기준선(26)+선행스팬+후행스팬",
  },
  roc: {
    label: "ROC (변화율)",
    periodLabel: "기간",
    periodUnit: "candle" as PeriodUnit,
    periodHint: "기본 12. N봉 전 대비 변화율",
    periodDefault: 12,
    valueLabel: "기준값",
    valueUnit: "%",
    valueHint: "양수=상승, 음수=하락",
    valueDefault: 0,
    description: "N봉 전 대비 가격 변화율(%). 다이버전스 감지에 유용",
  },
  donchian: {
    label: "돈치안 채널",
    periodLabel: "기간",
    periodUnit: "candle" as PeriodUnit,
    periodHint: "기본 20. 터틀 트레이딩 원조",
    periodDefault: 20,
    valueLabel: "비교값",
    valueUnit: "가격",
    valueHint: "채널 상한선과 비교",
    valueDefault: 0,
    description: "N봉 최고가/최저가 채널. 돌파 전략의 원조 (터틀 트레이딩)",
  },
  aroon: {
    label: "아룬 (추세 전환)",
    periodLabel: "기간",
    periodUnit: "candle" as PeriodUnit,
    periodHint: "기본 25",
    periodDefault: 25,
    valueLabel: "기준값",
    valueUnit: "%",
    valueHint: "70 이상=강한 추세, 30 이하=약한 추세",
    valueDefault: 70,
    description: "최고/최저가 발생 위치로 추세 강도 측정. 100=방금 고점, 0=오래 전",
  },
};
