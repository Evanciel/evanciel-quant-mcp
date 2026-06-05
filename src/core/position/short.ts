/**
 * 숏 포지션 라이프사이클 — 순수함수(I/O 0). 롱(ladder.ts)의 부호반전 미러.
 * Phase A(백테 숏코어, 머니패스 0)의 핵심. 향후 Phase B 라이브 선물 어댑터가 "동일 호출" → backtest≡live
 * (이 코드베이스 21버그 근본원인=라이브≠백테 발산 재발 방지). 백테엔진 숏경로가 이 함수만 사용.
 *
 * 정직한 포지셔닝(리서치 도메인2): 방향성 숏 단독 alpha=weak/none, 비대칭 위험(손실 무제한·청산가 상방)만 추가.
 * 유일 구조적 엣지=펀딩 캐리(델타뉴트럴). 숏은 '레짐 헤지·양방향·캐리 실험' 표현력으로만 노출. 알파 광고 금지.
 *
 * 숏 의미(롱 반전): 진입=고가에 차입매도 → 가격 하락 시 이익. PnL=(진입가−청산가)×수량.
 *   손절=가격 '상승'(진입 위 slPrice), 익절=가격 '하락'(진입 아래 tpPrice). 트레일링=저점(trough) 추종.
 *   펀딩: 강세편향(rate>0)이면 숏이 펀딩 '수취'(롱이 숏에게 지불).
 */

export interface ShortPosition {
  status: "open" | "closed";
  entryAvg: number;
  qty: number;
  slPct: number | null;
  tpPct: number | null;
  trailPct: number | null;
  troughPrice: number; // 최저가(트레일링 기준)
  slPrice: number;     // 현재 유효 손절가(진입 위)
  leverage: number;
  fundingPnl: number;  // 누적 펀딩 손익(숏 수취=+)
  openedAt: string;
}

/** 숏 고정 손절가 = 진입 × (1 + slPct/100). 진입 '위'(상승 시 손실). */
export function shortStopPrice(entry: number, slPct: number): number {
  return entry * (1 + slPct / 100);
}

/** 숏 익절가 = 진입 × (1 − tpPct/100). 진입 '아래'(하락 시 이익). */
export function shortTakeProfitPrice(entry: number, tpPct: number): number {
  return entry * (1 - tpPct / 100);
}

/** 숏 트레일링 손절 = 저점 × (1 + trailPct/100). 저점이 내려갈수록 손절가도 내려가 이익 보호. */
export function shortTrailStop(troughPrice: number, trailPct: number): number {
  return troughPrice * (1 + trailPct / 100);
}

/**
 * 숏 유효 손절가 = min(고정, 트레일링). 숏은 손절이 진입 위에 있고, '더 낮은' 손절가가 더 타이트(이익 보호).
 * 롱 effectiveStopLoss의 max ↔ 숏은 min (부호 반전).
 */
export function effectiveShortStop(state: ShortPosition, troughPrice: number): number {
  const fixed = state.slPct != null ? shortStopPrice(state.entryAvg, state.slPct) : Infinity;
  const trail = state.trailPct != null ? shortTrailStop(troughPrice, state.trailPct) : Infinity;
  const eff = Math.min(fixed, trail);
  return Number.isFinite(eff) ? eff : 0; // 둘 다 없으면 0(손절 없음)
}

/** 숏 PnL = (진입가 − 청산가) × 수량. 가격 하락 시 양수. */
export function computeShortPnl(entry: number, exit: number, qty: number): number {
  return (entry - exit) * qty;
}

/**
 * 숏 펀딩 손익 = notional × ratePerInterval × intervals. rate>0(강세편향)이면 숏 '수취'(+).
 * notional은 청산 시점이 아닌 명목(진입가×수량) 근사. 백테/라이브 동일.
 */
export function shortFundingPnl(notional: number, ratePerInterval: number, intervals: number): number {
  if (!(notional > 0) || !Number.isFinite(ratePerInterval) || !(intervals > 0)) return 0;
  return notional * ratePerInterval * intervals;
}

/**
 * 숏 청산가(레버리지) ≈ 진입 × (1 + 1/leverage − mmr). 진입 '위'(상승 시 강제청산). leverage=1이면 ~2배.
 * ⚠️ 근사치 — Phase B 라이브는 /fapi/v2/positionRisk의 liquidationPrice를 신뢰원으로 사용(브래킷 자체계산 금지).
 */
export function shortLiquidationPrice(entry: number, leverage: number, mmr = 0.005): number {
  if (!(leverage > 0)) return Infinity;
  return entry * (1 + 1 / leverage - mmr);
}

export function openShort(opts: {
  entryPrice: number; qty: number;
  stopLossPercent?: number | null; takeProfitPercent?: number | null;
  trailingStopPercent?: number | null; leverage?: number; openedAt: string;
}): ShortPosition {
  const { entryPrice, qty, stopLossPercent, takeProfitPercent, trailingStopPercent, leverage = 1, openedAt } = opts;
  const slPct = typeof stopLossPercent === "number" && stopLossPercent > 0 ? stopLossPercent : null;
  const tpPct = typeof takeProfitPercent === "number" && takeProfitPercent > 0 ? takeProfitPercent : null;
  const trailPct = typeof trailingStopPercent === "number" && trailingStopPercent > 0 ? trailingStopPercent : null;
  const state: ShortPosition = {
    status: "open", entryAvg: entryPrice, qty, slPct, tpPct, trailPct,
    troughPrice: entryPrice, slPrice: 0, leverage: leverage > 0 ? leverage : 1, fundingPnl: 0, openedAt,
  };
  state.slPrice = effectiveShortStop(state, entryPrice);
  return state;
}

export interface ShortTickResult {
  exit: { qty: number; price: number; reason: string; pnl: number } | null;
  next: ShortPosition;
}

/**
 * 숏 1틱 평가. 우선순위(롱과 동일 보수): ①손절(가격≥slPrice) ②커버신호(전략 청산) ③익절(가격≤tpPrice).
 * 트레일링은 이번 틱 저점 반영. 펀딩은 opts로 누적(선택). 청산가 도달도 손절로 처리.
 */
export function evaluateShortTick(
  state: ShortPosition, price: number,
  opts: { coverSignal?: boolean; fundingRatePerInterval?: number; intervalsElapsed?: number } = {}
): ShortTickResult {
  if (state.status !== "open" || !(state.qty > 0)) return { exit: null, next: state };

  const troughPrice = Math.min(state.troughPrice, price);
  // 펀딩 누적(숏 수취=+)
  let fundingPnl = state.fundingPnl;
  if (opts.fundingRatePerInterval != null && (opts.intervalsElapsed ?? 0) > 0) {
    fundingPnl += shortFundingPnl(state.entryAvg * state.qty, opts.fundingRatePerInterval, opts.intervalsElapsed!);
  }

  const slNow = effectiveShortStop({ ...state, troughPrice }, troughPrice);
  const liqPrice = shortLiquidationPrice(state.entryAvg, state.leverage);
  const tpPrice = state.tpPct != null ? shortTakeProfitPrice(state.entryAvg, state.tpPct) : null;

  const nextOpen: ShortPosition = { ...state, troughPrice, slPrice: slNow, fundingPnl };
  const closeWith = (reason: string): ShortTickResult => ({
    exit: { qty: state.qty, price, reason, pnl: computeShortPnl(state.entryAvg, price, state.qty) + fundingPnl },
    next: { ...nextOpen, status: "closed", qty: 0 },
  });

  // ① 손절/청산 (가격 상승 = 숏 손실). 청산가 우선(더 위험).
  if (state.leverage > 1 && price >= liqPrice) return closeWith(`liquidation @${liqPrice.toFixed(2)}`);
  if (slNow > 0 && price >= slNow) {
    const isTrail = state.trailPct != null && shortTrailStop(troughPrice, state.trailPct) <= slNow + 1e-9 && shortTrailStop(troughPrice, state.trailPct) < (state.slPct != null ? shortStopPrice(state.entryAvg, state.slPct) : Infinity);
    return closeWith(`${isTrail ? "trailing-stop" : "stop-loss"} @${slNow.toFixed(2)}`);
  }
  // ② 커버 신호(전략 청산)
  if (opts.coverSignal) return closeWith("cover-signal");
  // ③ 익절 (가격 하락 = 숏 이익)
  if (tpPrice != null && price <= tpPrice + 1e-9) return closeWith(`take-profit @${tpPrice.toFixed(2)}`);

  return { exit: null, next: nextOpen };
}
