import type {
  Strategy,
  BacktestConfig,
  BacktestResult,
  BacktestTrade,
  Condition,
  IndicatorType,
  StrategyNode,
  NodeCondition,
} from "../types/strategy";
import { computeIndicator } from "./indicators";
import { calcMaxDrawdown, calcSharpeRatio, calcTradeStats } from "./metrics";
// 다단계 부분익절 라더 — 라이브(bot-runner)와 "동일 호출"로 backtest≡live (Design Ref: tp-ladder §2 Option C).
import { evaluateLadderTick, openPosition, type PositionState, type LadderLevel, type ScaleInConfig, type PyramidConfig } from "../position/ladder";

interface OHLCV {
  date: string;
  datetime?: string; // 전체 ISO(시각 포함). 시간대(hour/minute/session) 조건 평가용. 없으면 date 자정.
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function evaluateCondition(
  indicatorValues: number[],
  condition: Condition,
  prices: number[],
  volumes: number[],
  index: number,
  indicatorCache?: Map<string, number[]>
): boolean {
  const value = indicatorValues[index];
  if (isNaN(value)) return false;

  // 비교 대상 지표 값 조회 (캐시 우선 사용)
  let targetValues: number[] | null = null;
  let target: number;
  if (typeof condition.value === "number") {
    target = condition.value;
  } else {
    const targetKey = `${condition.value as IndicatorType}-${JSON.stringify(condition.valueParams || {})}`;
    if (indicatorCache && indicatorCache.has(targetKey)) {
      targetValues = indicatorCache.get(targetKey)!;
    } else {
      targetValues = computeIndicator(
        prices,
        volumes,
        condition.value as IndicatorType,
        condition.valueParams || {}
      );
      if (indicatorCache) {
        indicatorCache.set(targetKey, targetValues);
      }
    }
    target = targetValues[index];
    if (isNaN(target)) return false;
  }

  switch (condition.operator) {
    case "gt": return value > target;
    case "lt": return value < target;
    case "gte": return value >= target;
    case "lte": return value <= target;
    case "cross_above": {
      if (index === 0) return false;
      const prevValue = indicatorValues[index - 1];
      let prevTarget: number;
      if (typeof condition.value === "number") {
        prevTarget = condition.value;
      } else {
        prevTarget = targetValues![index - 1];
      }
      return prevValue <= prevTarget && value > target;
    }
    case "cross_below": {
      if (index === 0) return false;
      const prevValue = indicatorValues[index - 1];
      let prevTarget: number;
      if (typeof condition.value === "number") {
        prevTarget = condition.value;
      } else {
        prevTarget = targetValues![index - 1];
      }
      return prevValue >= prevTarget && value < target;
    }
    default: return false;
  }
}

/**
 * performance 조건 메트릭 계산(공용) — window = 최근 lookbackDays+1 종가 슬라이스.
 * backtest(engine)와 live(bot-runner)가 이 함수를 공유해 동일 윈도우·동일 산식 보장(backtest==live).
 * 과거: 라이브가 getCloses(N)=N+5/N+10봉 전체를 써서 윈도우 길이가 달라 라우팅 발산.
 */
export function computePerfMetric(window: number[], metric: "returnPercent" | "drawdown" | "winRate"): number {
  if (window.length < 2) return 0;
  switch (metric) {
    case "drawdown": {
      let peak = window[0], maxDd = 0;
      for (const p of window) { if (p > peak) peak = p; const dd = peak > 0 ? ((peak - p) / peak) * 100 : 0; if (dd > maxDd) maxDd = dd; }
      return -maxDd; // 음수=손실
    }
    case "winRate": {
      let wins = 0;
      for (let k = 1; k < window.length; k++) if (window[k] > window[k - 1]) wins++;
      return (wins / (window.length - 1)) * 100;
    }
    case "returnPercent":
    default: {
      const start = window[0];
      return start > 0 ? ((window[window.length - 1] - start) / start) * 100 : 0;
    }
  }
}

export function runBacktest(
  strategy: Strategy,
  data: OHLCV[],
  config: BacktestConfig
): BacktestResult {
  let balance = config.initialCapital;
  let position = 0;
  let avgEntryPrice = 0;
  const trades: BacktestTrade[] = [];
  const equityCurve: { date: string; value: number }[] = [];

  const prices = data.map((d) => d.close);
  const volumes = data.map((d) => d.volume);
  const highs = data.map((d) => d.high);
  const lows = data.map((d) => d.low);

  // 지표 미리 계산
  const indicatorCache = new Map<string, number[]>();
  for (const rule of strategy.rules) {
    for (const cond of rule.conditions) {
      const key = `${cond.indicator}-${JSON.stringify(cond.params)}`;
      if (!indicatorCache.has(key)) {
        indicatorCache.set(
          key,
          computeIndicator(prices, volumes, cond.indicator, cond.params, highs, lows)
        );
      }
      // 비교 대상이 지표인 경우도 미리 캐싱
      if (typeof cond.value !== "number" && cond.value) {
        const valueKey = `${cond.value as IndicatorType}-${JSON.stringify(cond.valueParams || {})}`;
        if (!indicatorCache.has(valueKey)) {
          indicatorCache.set(
            valueKey,
            computeIndicator(prices, volumes, cond.value as IndicatorType, cond.valueParams || {}, highs, lows)
          );
        }
      }
    }
  }

  for (let i = 0; i < data.length; i++) {
    const price = data[i].close;

    // 손절/익절 체크
    if (position > 0) {
      const pnlPercent = ((price - avgEntryPrice) / avgEntryPrice) * 100;
      if (strategy.stopLossPercent && pnlPercent <= -strategy.stopLossPercent) {
        const pnl = (price - avgEntryPrice) * position;
        balance += position * price * (1 - config.commission / 100);
        trades.push({
          date: data[i].date,
          action: "sell",
          price,
          quantity: position,
          pnl,
          balance,
        });
        position = 0;
        avgEntryPrice = 0;
      } else if (strategy.takeProfitPercent && pnlPercent >= strategy.takeProfitPercent) {
        const pnl = (price - avgEntryPrice) * position;
        balance += position * price * (1 - config.commission / 100);
        trades.push({
          date: data[i].date,
          action: "sell",
          price,
          quantity: position,
          pnl,
          balance,
        });
        position = 0;
        avgEntryPrice = 0;
      }
    }

    // 전략 규칙 평가
    for (const rule of strategy.rules) {
      const allMet = rule.conditions.every((cond) => {
        const key = `${cond.indicator}-${JSON.stringify(cond.params)}`;
        const values = indicatorCache.get(key) || [];
        return evaluateCondition(values, cond, prices, volumes, i, indicatorCache);
      });

      if (!allMet) continue;

      // 체결 가격 결정: 시장가=종가+슬리피지, 지정가=오프셋 적용 후 high/low 범위 확인
      const isLimit = rule.orderType === "limit" && rule.limitPriceOffset !== undefined;
      const slip = (config.slippage ?? 0.05) / 100; // 기본 0.05%
      let fillPrice = isLimit ? price : (rule.action === "buy" ? price * (1 + slip) : price * (1 - slip));

      if (isLimit) {
        const targetPrice = price * (1 + (rule.limitPriceOffset || 0) / 100);
        const low = data[i].low;
        const high = data[i].high;

        if (rule.action === "buy") {
          // 매수 지정가: 목표가 이하로 내려왔는지 (low <= targetPrice)
          if (low <= targetPrice) {
            fillPrice = Math.min(targetPrice, high); // 체결가 = min(지정가, 고가)
          } else {
            continue; // 지정가에 도달 안 함 → 체결 안 됨
          }
        } else {
          // 매도 지정가: 목표가 이상으로 올라왔는지 (high >= targetPrice)
          if (high >= targetPrice) {
            fillPrice = Math.max(targetPrice, low); // 체결가 = max(지정가, 저가)
          } else {
            continue; // 지정가에 도달 안 함
          }
        }
      }

      if (rule.action === "buy" && position === 0) {
        const investAmount = balance * (rule.quantityPercent / 100);
        // 수수료 예약 후 수량 산정(과거: floor(invest/price) 직후 cost에 수수료 가산 → cost>invest → 잔고 음수/과레버리지)
        const qty = Math.floor(investAmount / (fillPrice * (1 + config.commission / 100)));
        if (qty > 0) {
          const cost = qty * fillPrice * (1 + config.commission / 100);
          balance -= cost;
          position = qty;
          avgEntryPrice = fillPrice;
          trades.push({
            date: data[i].date,
            action: "buy",
            price: fillPrice,
            quantity: qty,
            pnl: 0,
            balance,
          });
        }
      } else if (rule.action === "sell" && position > 0) {
        const pnl = (fillPrice - avgEntryPrice) * position;
        balance += position * fillPrice * (1 - config.commission / 100);
        trades.push({
          date: data[i].date,
          action: "sell",
          price: fillPrice,
          quantity: position,
          pnl,
          balance,
        });
        position = 0;
        avgEntryPrice = 0;
      }
    }

    const equity = balance + position * price;
    equityCurve.push({ date: data[i].date, value: equity });
  }

  // 결과 계산
  const finalEquity = equityCurve[equityCurve.length - 1]?.value || config.initialCapital;
  const totalReturn = finalEquity - config.initialCapital;
  const totalReturnPercent = (totalReturn / config.initialCapital) * 100;

  const { winRate, profitFactor } = calcTradeStats(trades);
  const maxDrawdown = calcMaxDrawdown(equityCurve, config.initialCapital);
  const sharpeRatio = calcSharpeRatio(equityCurve, config.timeframe);

  return {
    totalReturn,
    totalReturnPercent,
    maxDrawdown,
    winRate,
    totalTrades: trades.length,
    profitFactor,
    sharpeRatio,
    trades,
    equityCurve,
  };
}

// ── 복합 전략 백테스트 ──

/**
 * 노드 트리를 평가하여 현재 시점에 어떤 전략을 사용할지 결정
 */
const MAX_RECURSION_DEPTH = 10;

export function resolveActiveStrategy(
  node: StrategyNode,
  data: OHLCV[],
  index: number,
  prices: number[],
  volumes: number[],
  depth: number = 0
): Strategy | null {
  if (depth > MAX_RECURSION_DEPTH) {
    console.error(`[backtest] Max recursion depth (${MAX_RECURSION_DEPTH}) exceeded`);
    return null;
  }

  switch (node.type) {
    case "leaf":
      return node.strategy;

    case "condition": {
      const met = evaluateNodeCondition(node.condition, data, index, prices, volumes);
      if (met) return resolveActiveStrategy(node.thenNode, data, index, prices, volumes, depth + 1);
      if (node.elseNode) return resolveActiveStrategy(node.elseNode, data, index, prices, volumes, depth + 1);
      return null;
    }

    case "composite": {
      if (node.mode === "priority") {
        for (const child of node.children) {
          const s = resolveActiveStrategy(child, data, index, prices, volumes, depth + 1);
          if (s) return s;
        }
        return null;
      }
      if (node.children.length === 0) return null;
      // weighted 중첩 노드: 가장 높은 가중치의 자식 선택 (결정론적).
      // weights 길이가 children과 달라도 안전하도록 children 길이로 순회 + 누락 가중치는 0 취급
      // (이전: weights.length로 순회 → weights가 더 길면 children[maxIdx] undefined 크래시).
      const weights = node.weights || node.children.map(() => 1);
      let maxIdx = 0;
      for (let i = 1; i < node.children.length; i++) {
        if ((weights[i] ?? 0) > (weights[maxIdx] ?? 0)) maxIdx = i;
      }
      return resolveActiveStrategy(node.children[maxIdx], data, index, prices, volumes, depth + 1);
    }

    default:
      return null;
  }
}

function evaluateNodeCondition(
  condition: NodeCondition,
  data: OHLCV[],
  index: number,
  prices: number[],
  volumes: number[]
): boolean {
  const highs = data.map((d) => d.high);
  const lows = data.map((d) => d.low);
  switch (condition.type) {
    case "indicator": {
      const values = computeIndicator(prices, volumes, condition.indicator, condition.params, highs, lows);
      const val = values[index];
      if (isNaN(val)) return false;
      switch (condition.operator) {
        case "gt": return val > condition.value;
        case "lt": return val < condition.value;
        case "gte": return val >= condition.value;
        case "lte": return val <= condition.value;
        case "cross_above":
          return index > 0 && values[index - 1] <= condition.value && val > condition.value;
        case "cross_below":
          return index > 0 && values[index - 1] >= condition.value && val < condition.value;
        default: return false;
      }
    }

    case "time": {
      // datetime(시각 포함) 있으면 사용, 없으면 date(자정). hour/minute는 datetime 필수.
      const iso = data[index].datetime ?? data[index].date;
      const date = new Date(iso);
      const tz = (condition as { tz?: string }).tz;
      // tz-aware 시/분 추출(예: "Asia/Seoul" → KST 9시). en-GB hour12:false = 00~23.
      const local = tz
        ? (() => { const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
                   return { h: Number(p.find((x) => x.type === "hour")?.value ?? "0") % 24, m: Number(p.find((x) => x.type === "minute")?.value ?? "0") }; })()
        : { h: date.getUTCHours(), m: date.getUTCMinutes() };
      let fieldVal: number;
      switch (condition.field) {
        // UTC 기준(date-only 문자열은 UTC 자정 파싱) → 서버 TZ 무관 재현성 + 라이브와 일치
        case "month": fieldVal = date.getUTCMonth() + 1; break;
        case "quarter": fieldVal = Math.ceil((date.getUTCMonth() + 1) / 3); break;
        case "dayOfWeek": fieldVal = date.getUTCDay(); break;
        case "hour": fieldVal = local.h; break;       // 시간대 조건(0~23). tz로 시장 현지시각.
        case "minute": fieldVal = local.m; break;     // 분(0~59).
        default: return false;
      }
      switch (condition.operator) {
        case "eq": return condition.values.includes(fieldVal);
        case "in": return condition.values.includes(fieldVal);
        case "between": return fieldVal >= condition.values[0] && fieldVal <= condition.values[1];
        default: return false;
      }
    }

    case "performance": {
      if (index < condition.lookbackDays) return false;
      // 공용 computePerfMetric 사용(live와 동일 윈도우 N+1·동일 산식 → backtest==live)
      const window = prices.slice(index - condition.lookbackDays, index + 1);
      const metricValue = computePerfMetric(window, condition.metric);
      switch (condition.operator) {
        case "gt": return metricValue > condition.value;
        case "lt": return metricValue < condition.value;
        case "gte": return metricValue >= condition.value;
        case "lte": return metricValue <= condition.value;
        default: return false;
      }
    }

    default:
      return false;
  }
}

/**
 * weighted 모드 병렬 백테스트
 * 자본을 weight 비율대로 분할하여 각 자식 전략을 독립 실행한 뒤 결과를 합산합니다.
 */
// 깊이 초과/자본0 시 반환할 영(zero) 결과.
function zeroResult(data: OHLCV[]): BacktestResult {
  return {
    totalReturn: 0, totalReturnPercent: 0, maxDrawdown: 0,
    winRate: 0, totalTrades: 0, profitFactor: 0, sharpeRatio: 0,
    trades: [], equityCurve: data.map((d) => ({ date: d.date, value: 0 })),
  };
}

/**
 * weighted 복합 노드의 자식별 자본 배분 비율(합=1)을 계산하는 공용 함수.
 * weights를 children 길이에 정렬(초과 무시), 비유한/0/음수는 0으로 처리, 전부 무효면 동등분할.
 *
 * 과거 버그: totalWeight가 weights 배열 "전체"를 합산했음 → weights.length가 children과 다르면
 * 배분 비율의 합이 1이 아니게 되어(예: 자식2 + weights[1,2,3,4,5] → 20%만 배분) 합산 equity가
 * initialCapital과 어긋나 calcMaxDrawdown이 유령 낙폭(MDD 80~100%)을 산출하고 자본이 미/과배분됨.
 * backtest(여기)와 live(bot-runner)가 이 함수를 공유해 항상 비율 합=1을 보장한다.
 */
export function weightedChildRatios(childCount: number, weights?: number[]): number[] {
  if (childCount <= 0) return [];
  const raw = Array.from({ length: childCount }, (_, i) => {
    const w = weights?.[i];
    return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : 0;
  });
  const total = raw.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total) || total <= 0) return Array.from({ length: childCount }, () => 1 / childCount);
  return raw.map((w) => w / total);
}

function runWeightedParallelBacktest(
  node: import("../types/strategy").CompositeNode,
  data: OHLCV[],
  config: BacktestConfig,
  depth: number = 0
): BacktestResult {
  if (depth > MAX_RECURSION_DEPTH) {
    console.error(`[backtest] weighted parallel max recursion depth (${MAX_RECURSION_DEPTH}) exceeded`);
    return zeroResult(data);
  }
  // 배분 비율 합=1 보장(아래 헬퍼). length 불일치/비유한 weights에도 유령 낙폭 없음.
  const ratios = weightedChildRatios(node.children.length, node.weights);

  // 각 자식에 자본 배분 후 독립 백테스트
  const childResults: BacktestResult[] = node.children.map((child, i) => {
    const childCapital = Math.floor(config.initialCapital * ratios[i]);
    if (childCapital <= 0) {
      return {
        totalReturn: 0, totalReturnPercent: 0, maxDrawdown: 0,
        winRate: 0, totalTrades: 0, profitFactor: 0, sharpeRatio: 0,
        trades: [], equityCurve: data.map((d) => ({ date: d.date, value: 0 })),
      };
    }
    return runCompositeBacktest(child, data, { ...config, initialCapital: childCapital }, depth + 1);
  });

  // 결과 합산
  const allTrades = childResults.flatMap((r) => r.trades).sort((a, b) => a.date.localeCompare(b.date));
  const totalReturn = childResults.reduce((sum, r) => sum + r.totalReturn, 0);
  const totalReturnPercent = (totalReturn / config.initialCapital) * 100;
  const totalTrades = childResults.reduce((sum, r) => sum + r.totalTrades, 0);

  // 합산 equity curve: 날짜별로 각 자식의 equity를 더함
  const equityCurve = data.map((d, i) => ({
    date: d.date,
    value: childResults.reduce((sum, r) => sum + (r.equityCurve[i]?.value || 0), 0),
  }));

  const { winRate, profitFactor } = calcTradeStats(allTrades);
  const maxDrawdown = calcMaxDrawdown(equityCurve, config.initialCapital);
  const sharpeRatio = calcSharpeRatio(equityCurve, config.timeframe);

  return { totalReturn, totalReturnPercent, maxDrawdown, winRate, totalTrades, profitFactor, sharpeRatio, trades: allTrades, equityCurve };
}

/**
 * 복합 전략 백테스트
 * 매 캔들마다 노드 트리를 평가하여 활성 전략을 결정하고 실행합니다.
 */
/**
 * 라더 모드 시그널 평가 — 활성 전략의 buy/sell 발화(live bot-runner evaluateStrategy와 동일 의미).
 * 캐시 공유. 첫 발화 buy 규칙 + sell 발화 여부 반환.
 */
export function evalLadderSignals(
  activeStrategy: Strategy,
  i: number,
  prices: number[],
  volumes: number[],
  highs: number[],
  lows: number[],
  cache: Map<string, number[]>
): { buyRule: Strategy["rules"][number] | null; sell: boolean } {
  const ruleFires = (rule: Strategy["rules"][number]) => {
    for (const cond of rule.conditions) {
      const key = `${cond.indicator}-${JSON.stringify(cond.params)}`;
      if (!cache.has(key)) cache.set(key, computeIndicator(prices, volumes, cond.indicator, cond.params, highs, lows));
    }
    return rule.conditions.every((cond) => {
      const key = `${cond.indicator}-${JSON.stringify(cond.params)}`;
      return evaluateCondition(cache.get(key) || [], cond, prices, volumes, i, cache);
    });
  };
  let buyRule: Strategy["rules"][number] | null = null;
  let sell = false;
  for (const rule of activeStrategy.rules) {
    if (!ruleFires(rule)) continue;
    if (rule.action === "buy" && !buyRule) buyRule = rule;
    else if (rule.action === "sell") sell = true;
  }
  return { buyRule, sell };
}

export function runCompositeBacktest(
  rootNode: StrategyNode,
  data: OHLCV[],
  config: BacktestConfig,
  depth: number = 0,
  // composite(워크플로우) 레벨 SL/TP. live bot-runner의 composite.stop_loss_percent / take_profit_percent에 해당.
  // 활성 leaf가 자체 SL/TP를 갖지 않거나(=Case 2) 활성 leaf 자체가 없을 때(=Case 3)의 폴백 손절/익절선.
  // 미전달(undefined) 시 기존 동작과 100% 동일(폴백 없음) → 기존 호출부·테스트·퍼저 회귀 없음.
  compositeRisk?: { stopLossPercent?: number | null; takeProfitPercent?: number | null; tpLadder?: LadderLevel[] | null; scaleIn?: ScaleInConfig | null; pyramid?: PyramidConfig | null; trailingStopPercent?: number | null }
): BacktestResult {
  if (depth > MAX_RECURSION_DEPTH) {
    console.error(`[backtest] composite max recursion depth (${MAX_RECURSION_DEPTH}) exceeded`);
    return zeroResult(data);
  }
  // weighted 모드: 자본을 비율대로 분할하여 각 자식을 독립 백테스트.
  // compositeRisk를 자식에 전달하지 않음 → top-level weighted는 composite SL/TP 미적용
  // (live bot-runner의 weighted 자식 경로도 checkStopLossTakeProfit를 호출하지 않음 → backtest==live).
  if (rootNode.type === "composite" && rootNode.mode === "weighted" && rootNode.children.length > 0) {
    return runWeightedParallelBacktest(rootNode, data, config, depth);
  }

  const prices = data.map((d) => d.close);
  const volumes = data.map((d) => d.volume);
  const highs = data.map((d) => d.high);
  const lows = data.map((d) => d.low);

  let balance = config.initialCapital;
  let position = 0;
  let avgEntryPrice = 0;
  let positionState: PositionState | null = null; // 라더 모드 포지션 라이프사이클
  const trades: BacktestTrade[] = [];
  const equityCurve: { date: string; value: number }[] = [];

  const compositeIndicatorCache = new Map<string, number[]>();
  // tp_ladder 있으면 라더 라이프사이클 모드, 없으면 기존 단일 SL/TP 경로(하위호환).
  const ladder = compositeRisk?.tpLadder && compositeRisk.tpLadder.length > 0 ? compositeRisk.tpLadder : null;
  const scaleIn = compositeRisk?.scaleIn && compositeRisk.scaleIn.ladder.length > 0 ? compositeRisk.scaleIn : null;
  const pyramid = compositeRisk?.pyramid && compositeRisk.pyramid.ladder.length > 0 ? compositeRisk.pyramid : null;

  for (let i = 0; i < data.length; i++) {
    const price = data[i].close;
    const activeStrategy = resolveActiveStrategy(rootNode, data, i, prices, volumes);

    // 손절/익절 체크: 포지션 보유 중이면 활성 leaf 존재 여부와 무관하게 평가한다.
    // 우선순위 = 활성 leaf SL/TP ?? composite 레벨 SL/TP
    //   (live bot-runner의 `resolvedStrategy?.stopLossPercent ?? composite.stop_loss_percent`와 동일).
    // 과거 버그(backtest≠live): 이 블록이 `if (activeStrategy)` 안에 있어 leaf가 null로 해소되면
    //   composite SL/TP를 무시하고 보유했으나, live는 같은 상황에서 composite SL/TP로 청산했다.
    //   게이트 밖으로 올려 양쪽이 일치(Case 2: leaf 활성·leaf SL 없음 / Case 3: leaf 미활성, 둘 다 청산).
    if (!ladder && !scaleIn && !pyramid) {
    // ── 기존 단일 SL/TP 경로(하위호환, tp_ladder·scale_in 모두 NULL) ──
    let sltpExited = false;
    if (position > 0) {
      const pnlPercent = ((price - avgEntryPrice) / avgEntryPrice) * 100;
      const sl = activeStrategy?.stopLossPercent ?? compositeRisk?.stopLossPercent;
      const tp = activeStrategy?.takeProfitPercent ?? compositeRisk?.takeProfitPercent;
      if ((sl && pnlPercent <= -sl) || (tp && pnlPercent >= tp)) {
        const pnl = (price - avgEntryPrice) * position;
        balance += position * price * (1 - (config.commission ?? 0.1) / 100);
        trades.push({ date: data[i].date, action: "sell", price, quantity: position, pnl, balance });
        position = 0;
        avgEntryPrice = 0;
        sltpExited = true;
      }
    }

    // SL/TP가 발동한 캔들에서는 전략 시그널을 평가하지 않는다(같은 봉 stop→재매수 방지).
    // live bot-runner는 SL/TP 청산 후 `continue`로 해당 틱의 시그널 평가를 건너뛴다 → 동일 의미.
    if (activeStrategy && !sltpExited) {
      // 전략 규칙 평가 (캐시는 전체 루프에서 공유)
      const indicatorCache = compositeIndicatorCache;
      for (const rule of activeStrategy.rules) {
        for (const cond of rule.conditions) {
          const key = `${cond.indicator}-${JSON.stringify(cond.params)}`;
          if (!indicatorCache.has(key)) {
            indicatorCache.set(key, computeIndicator(prices, volumes, cond.indicator, cond.params, highs, lows));
          }
        }
      }

      for (const rule of activeStrategy.rules) {
        const allMet = rule.conditions.every((cond) => {
          const key = `${cond.indicator}-${JSON.stringify(cond.params)}`;
          const values = indicatorCache.get(key) || [];
          return evaluateCondition(values, cond, prices, volumes, i, indicatorCache);
        });
        if (!allMet) continue;

        if (rule.action === "buy" && position === 0) {
          const slip = (config.slippage ?? 0.05) / 100;
          const buyPrice = price * (1 + slip);
          const investAmount = balance * (rule.quantityPercent / 100);
          // 수수료 예약 후 수량 산정(잔고 음수/과레버리지 방지)
          const qty = Math.floor(investAmount / (buyPrice * (1 + (config.commission ?? 0.1) / 100)));
          if (qty > 0) {
            balance -= qty * buyPrice * (1 + (config.commission ?? 0.1) / 100);
            position = qty;
            avgEntryPrice = buyPrice;
            trades.push({ date: data[i].date, action: "buy", price: buyPrice, quantity: qty, pnl: 0, balance });
          }
        } else if (rule.action === "sell" && position > 0) {
          const slip = (config.slippage ?? 0.05) / 100;
          const sellPrice = price * (1 - slip);
          const pnl = (sellPrice - avgEntryPrice) * position;
          balance += position * sellPrice * (1 - (config.commission ?? 0.1) / 100);
          trades.push({ date: data[i].date, action: "sell", price: sellPrice, quantity: position, pnl, balance });
          position = 0;
          avgEntryPrice = 0;
        }
      }
    }
    } else {
      // ── 라더 모드: 포지션 라이프사이클 (live bot-runner와 "동일" evaluateLadderTick 호출 → backtest≡live) ──
      const sigSL = activeStrategy?.stopLossPercent ?? compositeRisk?.stopLossPercent ?? null;
      let exitedThisBar = false;
      if (position > 0 && positionState) {
        const sell = activeStrategy
          ? evalLadderSignals(activeStrategy, i, prices, volumes, highs, lows, compositeIndicatorCache).sell
          : false;
        const { exits, adds, next } = evaluateLadderTick(positionState, price, ladder ?? [], { strategySell: sell, scaleIn, pyramid });
        const slip = (config.slippage ?? 0.05) / 100;
        for (const ex of exits) {
          const sellPrice = price * (1 - slip);
          const pnl = (sellPrice - avgEntryPrice) * ex.qty;
          balance += ex.qty * sellPrice * (1 - (config.commission ?? 0.1) / 100);
          trades.push({ date: data[i].date, action: "sell", price: sellPrice, quantity: ex.qty, pnl, balance });
        }
        // 스케일인(물타기) 추가매수 — 한 틱에 청산과 동시 발생 안 함(가격 구간 배타적).
        for (const ad of adds) {
          const buyPrice = price * (1 + slip);
          balance -= ad.qty * buyPrice * (1 + (config.commission ?? 0.1) / 100);
          trades.push({ date: data[i].date, action: "buy", price: buyPrice, quantity: ad.qty, pnl: 0, balance });
        }
        position = next.remainingQty;
        if (next.status === "closed") {
          positionState = null;
          position = 0;
          avgEntryPrice = 0;
          exitedThisBar = true; // 같은 봉 재매수 방지(비라더 sltpExited와 동일 의미)
        } else {
          positionState = next;
          avgEntryPrice = next.entryAvg; // 스케일인 평단 갱신 반영
        }
      }
      // 진입(오픈): 무포지션 + 같은 봉 청산 아님 → 활성 전략 buy 발화 시
      if (position === 0 && activeStrategy && !exitedThisBar) {
        const { buyRule } = evalLadderSignals(activeStrategy, i, prices, volumes, highs, lows, compositeIndicatorCache);
        if (buyRule) {
          const slip = (config.slippage ?? 0.05) / 100;
          const buyPrice = price * (1 + slip);
          const investAmount = balance * (buyRule.quantityPercent / 100);
          const qty = Math.floor(investAmount / (buyPrice * (1 + (config.commission ?? 0.1) / 100)));
          if (qty > 0) {
            balance -= qty * buyPrice * (1 + (config.commission ?? 0.1) / 100);
            position = qty;
            avgEntryPrice = buyPrice;
            positionState = openPosition({ entryPrice: buyPrice, qty, stopLossPercent: sigSL, trailingStopPercent: compositeRisk?.trailingStopPercent, openedAt: data[i].date });
            trades.push({ date: data[i].date, action: "buy", price: buyPrice, quantity: qty, pnl: 0, balance });
          }
        }
      }
    }

    equityCurve.push({ date: data[i].date, value: balance + position * price });
  }

  // 결과 계산
  const finalEquity = equityCurve[equityCurve.length - 1]?.value || config.initialCapital;
  const totalReturn = finalEquity - config.initialCapital;
  const totalReturnPercent = (totalReturn / config.initialCapital) * 100;

  const { winRate, profitFactor } = calcTradeStats(trades);
  const maxDrawdown = calcMaxDrawdown(equityCurve, config.initialCapital);
  const sharpeRatio = calcSharpeRatio(equityCurve, config.timeframe);

  return { totalReturn, totalReturnPercent, maxDrawdown, winRate, totalTrades: trades.length, profitFactor, sharpeRatio, trades, equityCurve };
}
