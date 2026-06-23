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
import { computeRegime, type RegimeParams, type RegimeLabel } from "./regime";
// 다단계 부분익절 라더 — 라이브(bot-runner)와 "동일 호출"로 backtest≡live (Design Ref: tp-ladder §2 Option C).
import { evaluateLadderTick, openPosition, type PositionState, type LadderLevel, type ScaleInConfig, type PyramidConfig } from "../position/ladder";
import { floorQty, quantizeQty } from "../position/qty";
import { computeOrderQty } from "../risk/order-sizing"; // 변동성 타게팅 사이징(엔진·러너 공용 → backtest≡live)
import { resolveEntryFill } from "../execution/entry"; // 봇 지정가 진입 체결 모델(엔진·러너 공용 → backtest≡live, audit P1-5)

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

    // 손절/익절 체크. gapHandling='worst'(P1-12)면 SL은 봉 저가 터치로 판정, 체결가=min(시가, 손절선)(갭 보수 모델).
    if (position > 0) {
      const pnlPercent = ((price - avgEntryPrice) / avgEntryPrice) * 100;
      const worst = config.gapHandling === "worst";
      const stopLevel = strategy.stopLossPercent ? avgEntryPrice * (1 - strategy.stopLossPercent / 100) : 0;
      const slHit = !!strategy.stopLossPercent && (worst ? (data[i].low ?? price) <= stopLevel + 1e-12 : pnlPercent <= -strategy.stopLossPercent);
      if (slHit) {
        const exitPrice = worst ? Math.min(data[i].open ?? price, stopLevel) : price;
        const pnl = (exitPrice - avgEntryPrice) * position;
        balance += position * exitPrice * (1 - config.commission / 100);
        trades.push({
          date: data[i].date,
          action: "sell",
          price: exitPrice,
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
        // 사이징: riskSizing 있으면 변동성 타게팅/ATR/Kelly, 없으면 legacy(balance*qp/100) 바이트 동일. 엔진·러너 공용함수 → backtest≡live.
        // highs/lows는 ATR 모드만 사용(legacy/vol_target/kelly은 무시) → 추가 전달이 기존 모드 결과를 바꾸지 않음(회귀 0).
        const qty = computeOrderQty({
          equity: balance, price: fillPrice, commissionPct: config.commission,
          closes: prices.slice(0, i + 1), highs: highs.slice(0, i + 1), lows: lows.slice(0, i + 1),
          timeframe: config.timeframe ?? "1d",
          legacyQuantityPercent: rule.quantityPercent, riskSizing: config.riskSizing ?? null,
          symbol: config.symbol, // KR(6자리 숫자)이면 정수주 양자화 → 라이브와 일관(크립토는 분수 유지)
        }).qty;
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

/**
 * 평가 컨텍스트 — 메인 data 외 추가 시리즈 주입(전부 메인 data와 동일 길이·정렬).
 * aux: 스프레드용 symbolB 종가. mtf: 멀티타임프레임용 (key=mtfKey) 상위TF 지표값(LTF로 전방채움, 룩어헤드 없음).
 */
export interface EvalContext {
  aux?: Record<string, number[]>;
  mtf?: Record<string, number[]>;
  // regime MTF: regimeMtfKey → 상위TF 레짐 라벨(LTF 전방채움·룩어헤드0, 닫힌 HTF 없으면 null). mtf(지표값 number[]맵)와 형태가 달라 분리.
  mtfRegime?: Record<string, (RegimeLabel | null)[]>;
  events?: Record<string, number[]>; // 명명 캘린더 → 이벤트 epoch(ms) 배열
}

/** 멀티타임프레임 지표 조건의 안정 키(엔진·주입기 공유). timeframe|indicator|정렬된 params. */
export function mtfKey(timeframe: string, indicator: string, params: Record<string, number>): string {
  const p = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join(",");
  return `${timeframe}|${indicator}|${p}`;
}

/**
 * 멀티타임프레임 regime 조건의 안정 키(엔진·주입기 공유). regime|timeframe|정렬된 params.
 * mtfKey와 별도: regime은 indicator축이 없고 OHLC 3배열을 슬라이스해 내부에서 다중지표를 산출하므로 키 형태도 분리.
 */
export function regimeMtfKey(timeframe: string, params?: RegimeParams): string {
  const p = params ? Object.keys(params).sort().map((k) => `${k}=${(params as Record<string, number | undefined>)[k]}`).join(",") : "";
  return `regime|${timeframe}|${p}`;
}

export function resolveActiveStrategy(
  node: StrategyNode,
  data: OHLCV[],
  index: number,
  prices: number[],
  volumes: number[],
  depth: number = 0,
  ctx?: EvalContext   // 멀티심볼(spread aux) + 멀티타임프레임(mtf) 주입 컨텍스트. 재귀 전파.
): Strategy | null {
  if (depth > MAX_RECURSION_DEPTH) {
    console.error(`[backtest] Max recursion depth (${MAX_RECURSION_DEPTH}) exceeded`);
    return null;
  }

  switch (node.type) {
    case "leaf":
      return node.strategy;

    case "condition": {
      const met = evaluateNodeCondition(node.condition, data, index, prices, volumes, ctx);
      if (met) return resolveActiveStrategy(node.thenNode, data, index, prices, volumes, depth + 1, ctx);
      if (node.elseNode) return resolveActiveStrategy(node.elseNode, data, index, prices, volumes, depth + 1, ctx);
      return null;
    }

    case "composite": {
      if (node.mode === "priority") {
        for (const child of node.children) {
          const s = resolveActiveStrategy(child, data, index, prices, volumes, depth + 1, ctx);
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
      return resolveActiveStrategy(node.children[maxIdx], data, index, prices, volumes, depth + 1, ctx);
    }

    default:
      return null;
  }
}

// ── 세션 앵커 헬퍼 (순수함수) ──

/** ISO 타임스탬프의 '세션 일자' 키(YYYY-MM-DD). tz 지정 시 시장 현지일자, 없으면 UTC 일자. */
function localDayKey(iso: string, tz?: string): string {
  const d = new Date(iso);
  if (!tz) return d.toISOString().slice(0, 10);
  // en-CA = YYYY-MM-DD 포맷
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/**
 * 세션 기준값 산출(룩어헤드 없음: idx까지의 당일 봉만 사용). 산출 불가(전일종가 없음/거래량0 VWAP)면 null.
 * dayOpen=당일 첫봉 시가, prevClose=전일 마지막봉 종가, sessionHigh/Low=당일 고저, vwapFromOpen=당일 시가기준 VWAP(전형가격).
 */
function anchorValue(data: OHLCV[], idx: number, ref: string, tz?: string): number | null {
  const keyAt = (j: number) => localDayKey(data[j].datetime ?? data[j].date, tz);
  const today = keyAt(idx);
  let start = idx;
  while (start > 0 && keyAt(start - 1) === today) start--; // 당일 첫봉 인덱스
  switch (ref) {
    case "dayOpen":
      return data[start].open;
    case "prevClose":
      return start === 0 ? null : data[start - 1].close; // 윈도우에 전일 없음 → null(fail-closed)
    case "sessionHigh": {
      let h = -Infinity;
      for (let j = start; j <= idx; j++) h = Math.max(h, data[j].high);
      return Number.isFinite(h) ? h : null;
    }
    case "sessionLow": {
      let l = Infinity;
      for (let j = start; j <= idx; j++) l = Math.min(l, data[j].low);
      return Number.isFinite(l) ? l : null;
    }
    case "vwapFromOpen": {
      let pv = 0, v = 0;
      for (let j = start; j <= idx; j++) { const tp = (data[j].high + data[j].low + data[j].close) / 3; pv += tp * data[j].volume; v += data[j].volume; }
      return v > 0 ? pv / v : null;
    }
    default:
      return null;
  }
}

/** 스프레드(페어) 값: a=A종가, b=B종가. ratio=A/B, diffPct=(A/B−1)×100, zscore=lookback 윈도우 표준화. 산출 불가면 null. */
function spreadValue(a: number[], b: number[], idx: number, expr: string, lookback: number): number | null {
  const av = a[idx], bv = b[idx];
  if (!Number.isFinite(av) || !Number.isFinite(bv) || bv === 0) return null;
  const ratio = av / bv;
  if (expr === "ratio") return ratio;
  if (expr === "diffPct") return (ratio - 1) * 100;
  // zscore: 최근 lookback개 비율의 평균/표준편차로 현재 비율 표준화
  if (idx < lookback - 1) return null;
  const win: number[] = [];
  for (let j = idx - lookback + 1; j <= idx; j++) {
    if (!Number.isFinite(a[j]) || !Number.isFinite(b[j]) || b[j] === 0) return null;
    win.push(a[j] / b[j]);
  }
  const mean = win.reduce((x, y) => x + y, 0) / win.length;
  const variance = win.reduce((x, y) => x + (y - mean) * (y - mean), 0) / win.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return null;
  return (ratio - mean) / sd;
}

function evaluateNodeCondition(
  condition: NodeCondition,
  data: OHLCV[],
  index: number,
  prices: number[],
  volumes: number[],
  ctx?: EvalContext
): boolean {
  const highs = data.map((d) => d.high);
  const lows = data.map((d) => d.low);
  switch (condition.type) {
    case "indicator": {
      // 멀티타임프레임: timeframe 지정 시 상위TF 지표값(LTF로 전방채움된 mtf 시리즈) 사용. 미주입 시 fail-closed.
      let values: number[];
      if (condition.timeframe) {
        const series = ctx?.mtf?.[mtfKey(condition.timeframe, condition.indicator, condition.params)];
        if (!series || series.length !== prices.length) return false; // HTF 미주입/미정렬 → 무거래
        values = series;
      } else {
        values = computeIndicator(prices, volumes, condition.indicator, condition.params, highs, lows);
      }
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

    case "regime": {
      // 멀티타임프레임: timeframe 지정 시 상위TF 레짐 라벨(LTF로 전방채움된 mtfRegime 시리즈)을 사용. 미주입 시 fail-closed.
      //   라벨은 alignMtfRegimeLabels가 'HTF 봉별 진짜 HTF 시계열'로 미리 계산(전방채움 raw OHLC 재계산 시 반복값으로 ER/기울기가
      //   붕괴하는 문제 회피). 룩어헤드0=닫힌 HTF만 노출. 단일TF 엔진 경로와 동일 의미(현재봉까지 윈도우).
      if (condition.timeframe) {
        const labels = ctx?.mtfRegime?.[regimeMtfKey(condition.timeframe, condition.params)];
        if (!labels || labels.length !== prices.length) return false; // HTF 미주입/미정렬 → 무거래(indicator MTF의 가드와 동일)
        const lab = labels[index];
        return lab !== null && condition.in.includes(lab);
      }
      // 단일TF: 현재 봉(index)까지의 데이터로 레짐 판정 — 룩어헤드 없음(computeRegime은 배열 마지막 원소 기준).
      const upTo = index + 1;
      const r = computeRegime(prices.slice(0, upTo), highs.slice(0, upTo), lows.slice(0, upTo), condition.params);
      return condition.in.includes(r.label);
    }

    case "anchor": {
      const m = condition.multiplier ?? 1;
      const ref = anchorValue(data, index, condition.anchor, condition.tz);
      if (ref === null || !Number.isFinite(ref)) return false; // 기준값 산출 불가 → false(fail-closed)
      const target = ref * m;
      const cur = prices[index];
      switch (condition.operator) {
        case "gt": return cur > target;
        case "lt": return cur < target;
        case "gte": return cur >= target;
        case "lte": return cur <= target;
        case "cross_above": {
          if (index === 0) return false;
          const refPrev = anchorValue(data, index - 1, condition.anchor, condition.tz);
          if (refPrev === null || !Number.isFinite(refPrev)) return false;
          return prices[index - 1] <= refPrev * m && cur > target;
        }
        case "cross_below": {
          if (index === 0) return false;
          const refPrev = anchorValue(data, index - 1, condition.anchor, condition.tz);
          if (refPrev === null || !Number.isFinite(refPrev)) return false;
          return prices[index - 1] >= refPrev * m && cur < target;
        }
        default: return false;
      }
    }

    case "event": {
      // 현재 봉이 어떤 이벤트의 [event-before, event+after] 윈도우에 들면 참. 인라인 times + 명명 캘린더(주입) 병합.
      const t = Date.parse(data[index].datetime ?? data[index].date);
      if (!Number.isFinite(t)) return false;
      const before = (condition.hoursBefore ?? 0) * 3600000;
      const after = (condition.hoursAfter ?? 0) * 3600000;
      const hit = (e: number) => Number.isFinite(e) && t >= e - before && t <= e + after;
      if (Array.isArray(condition.times)) {
        for (const iso of condition.times) { if (hit(Date.parse(iso))) return true; }
      }
      if (condition.calendar) {
        const cal = ctx?.events?.[condition.calendar];
        if (cal) for (const e of cal) { if (hit(e)) return true; }
      }
      return false; // 윈도우 밖 또는 캘린더 미주입 → false(fail-closed). "이벤트 회피"는 elseNode로.
    }

    case "spread": {
      const b = ctx?.aux?.[condition.symbolB];
      if (!b || b.length !== prices.length) return false; // B 데이터 부재/미정렬 → false(fail-closed, 무거래)
      const lb = condition.lookback ?? 20;
      const sv = spreadValue(prices, b, index, condition.expr, lb);
      if (sv === null) return false;
      switch (condition.operator) {
        case "gt": return sv > condition.value;
        case "lt": return sv < condition.value;
        case "gte": return sv >= condition.value;
        case "lte": return sv <= condition.value;
        case "cross_above": {
          if (index === 0) return false;
          const prev = spreadValue(prices, b, index - 1, condition.expr, lb);
          if (prev === null) return false;
          return prev <= condition.value && sv > condition.value;
        }
        case "cross_below": {
          if (index === 0) return false;
          const prev = spreadValue(prices, b, index - 1, condition.expr, lb);
          if (prev === null) return false;
          return prev >= condition.value && sv < condition.value;
        }
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
  compositeRisk?: { stopLossPercent?: number | null; takeProfitPercent?: number | null; tpLadder?: LadderLevel[] | null; scaleIn?: ScaleInConfig | null; pyramid?: PyramidConfig | null; trailingStopPercent?: number | null },
  // P0-5 포지션 시드(라이브 러너 전용): 진입봉이 윈도우 밖으로 스크롤아웃된 장기보유를 엔진이 '이미 보유 중'으로 보게 한다.
  //   단순 SL/TP 경로에서만 적용(라더/스케일인/피라미딩은 미지원 → 무시). 보유 중엔 재매수 차단(position!==0)·청산만 평가하므로
  //   풀히스토리 백테가 그 시점에 보유 중이던 상태와 동일 → derivePosition(seed 동반)으로 want 동일(backtest≡live).
  //   ⚠️ 의사결정(trades) 추출 전용 — balance/equity는 시드 매입비용 미반영이라 성능지표 산출엔 쓰지 말 것.
  seed?: { position: number; avgEntryPrice: number }
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
  // 지정가 진입 대기(audit P1-5). 신호 봉에서 지정가가 같은 봉에 안 채워지면 여기 보관 → entryBarIndex 봉에서 개시.
  //   미설정(시장가)은 resolveEntryFill이 entryBarIndex=신호봉을 반환 → pendingFill 미사용(레거시 바이트 동일).
  let pendingFill: { entryBarIndex: number; fillPrice: number; qty: number; isLadder: boolean; sigSL: number | null } | null = null;
  const trades: BacktestTrade[] = [];
  const equityCurve: { date: string; value: number }[] = [];

  const compositeIndicatorCache = new Map<string, number[]>();
  // tp_ladder 있으면 라더 라이프사이클 모드, 없으면 기존 단일 SL/TP 경로(하위호환).
  const ladder = compositeRisk?.tpLadder && compositeRisk.tpLadder.length > 0 ? compositeRisk.tpLadder : null;
  const scaleIn = compositeRisk?.scaleIn && compositeRisk.scaleIn.ladder.length > 0 ? compositeRisk.scaleIn : null;
  const pyramid = compositeRisk?.pyramid && compositeRisk.pyramid.ladder.length > 0 ? compositeRisk.pyramid : null;
  // P0-5 시드 주입: 단순 SL/TP 경로에서만(라더/스케일인/피라미딩은 포지션 라이프사이클이 달라 미지원). 보유 중 시작 → 재매수 차단.
  if (seed && seed.position > 1e-9 && !ladder && !scaleIn && !pyramid) { position = seed.position; avgEntryPrice = seed.avgEntryPrice; }

  for (let i = 0; i < data.length; i++) {
    const price = data[i].close;
    // 지정가 진입 대기 해소(audit P1-5): 미체결 동안 무포지션(flat) → SL/시그널 평가 안 함. entryBarIndex 봉에서 개시.
    //   (시장가 경로는 entryBarIndex=신호봉이라 pendingFill이 설정되지 않음 → 이 블록 미진입 = 레거시 바이트 동일.)
    if (pendingFill) {
      if (i < pendingFill.entryBarIndex) {
        equityCurve.push({ date: data[i].date, value: balance }); // position=0 → flat cash(미체결 지정가 무노출)
        continue;
      }
      const pf = pendingFill; // i === entryBarIndex: 지정가(maker) 또는 캡 폴백 체결 → 포지션 개시
      balance -= pf.qty * pf.fillPrice * (1 + (config.commission ?? 0.1) / 100);
      position = pf.qty;
      avgEntryPrice = pf.fillPrice;
      if (pf.isLadder) positionState = openPosition({ entryPrice: pf.fillPrice, qty: pf.qty, stopLossPercent: pf.sigSL, trailingStopPercent: compositeRisk?.trailingStopPercent, openedAt: data[i].date });
      trades.push({ date: data[i].date, action: "buy", price: pf.fillPrice, quantity: pf.qty, pnl: 0, balance });
      pendingFill = null;
      equityCurve.push({ date: data[i].date, value: balance + position * price }); // 개시 봉: 보유 반영. 같은 봉 청산 안 함(같은봉 진입-청산 금지).
      continue;
    }
    const activeStrategy = resolveActiveStrategy(rootNode, data, i, prices, volumes, 0, { aux: config.auxSeries, mtf: config.mtfSeries, mtfRegime: config.mtfRegimeSeries, events: config.eventCalendars });

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
      // gapHandling='worst'(P1-12): SL은 봉 저가 터치 판정 + 체결가=min(시가, 손절선). TP는 종가 유지(보수).
      const worst = config.gapHandling === "worst";
      const stopLevel = sl ? avgEntryPrice * (1 - sl / 100) : 0;
      const slHit = !!sl && (worst ? (data[i].low ?? price) <= stopLevel + 1e-12 : pnlPercent <= -sl);
      const tpHit = !!tp && pnlPercent >= (tp as number);
      if (slHit || tpHit) {
        const exitPrice = slHit && worst ? Math.min(data[i].open ?? price, stopLevel) : price;
        const pnl = (exitPrice - avgEntryPrice) * position;
        balance += position * exitPrice * (1 - (config.commission ?? 0.1) / 100);
        trades.push({ date: data[i].date, action: "sell", price: exitPrice, quantity: position, pnl, balance });
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
          // 진입 체결 해소(audit P1-5): 시장가=신호봉 즉시 체결(레거시 바이트 동일), 지정가=윈도우 내 maker 또는 타임아웃 폴백.
          const { fillPrice, entryBarIndex } = resolveEntryFill(data, i, config.entryExecution, config.slippage ?? 0.05);
          // 사이징: riskSizing 있으면 변동성 타게팅/ATR/Kelly, 없으면 legacy 바이트 동일. 러너는 want.qty로 이 결과를 그대로 라이브 반영.
          // highs/lows는 ATR 모드만 사용(legacy/vol_target/kelly은 무시) → 기존 모드 결과 불변(회귀 0).
          const qty = computeOrderQty({
            equity: balance, price: fillPrice, commissionPct: config.commission ?? 0.1,
            closes: prices.slice(0, i + 1), highs: highs.slice(0, i + 1), lows: lows.slice(0, i + 1),
            timeframe: config.timeframe ?? "1d",
            legacyQuantityPercent: rule.quantityPercent, riskSizing: config.riskSizing ?? null,
            symbol: config.symbol, // KR(6자리 숫자)이면 정수주 양자화 → 라이브와 일관(크립토는 분수 유지)
          }).qty;
          if (qty > 0) {
            if (entryBarIndex === i) { // 같은 봉 체결(시장가 또는 같은봉 지정가 터치) → 즉시 개시
              balance -= qty * fillPrice * (1 + (config.commission ?? 0.1) / 100);
              position = qty;
              avgEntryPrice = fillPrice;
              trades.push({ date: data[i].date, action: "buy", price: fillPrice, quantity: qty, pnl: 0, balance });
            } else { // 지정가 미체결 → entryBarIndex 봉에서 개시(이 봉은 flat). 추가 rule 평가 중단.
              pendingFill = { entryBarIndex, fillPrice, qty, isLadder: false, sigSL: null };
              break;
            }
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
        const { exits, adds, next } = evaluateLadderTick(positionState, price, ladder ?? [], { strategySell: sell, scaleIn, pyramid, symbol: config.symbol, buySlipPct: config.slippage ?? 0.05 }); // 평단=체결가 기준(P1-11)
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
          // 진입 체결 해소(audit P1-5): 시장가=즉시 개시(레거시 바이트 동일), 지정가=윈도우 maker 또는 타임아웃 폴백.
          const { fillPrice, entryBarIndex } = resolveEntryFill(data, i, config.entryExecution, config.slippage ?? 0.05);
          const investAmount = balance * (buyRule.quantityPercent / 100);
          // KR(6자리 숫자)이면 정수주 양자화(라이브와 일관), 크립토는 floorQty(8자리 분수)와 바이트 동일.
          const qty = quantizeQty(investAmount / (fillPrice * (1 + (config.commission ?? 0.1) / 100)), config.symbol);
          if (qty > 0) {
            if (entryBarIndex === i) { // 즉시 개시(시장가 또는 같은봉 지정가 터치)
              balance -= qty * fillPrice * (1 + (config.commission ?? 0.1) / 100);
              position = qty;
              avgEntryPrice = fillPrice;
              positionState = openPosition({ entryPrice: fillPrice, qty, stopLossPercent: sigSL, trailingStopPercent: compositeRisk?.trailingStopPercent, openedAt: data[i].date });
              trades.push({ date: data[i].date, action: "buy", price: fillPrice, quantity: qty, pnl: 0, balance });
            } else { // 지정가 미체결 → entryBarIndex 봉에서 openPosition으로 개시(이 봉은 flat).
              pendingFill = { entryBarIndex, fillPrice, qty, isLadder: true, sigSL: sigSL ?? null };
            }
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
