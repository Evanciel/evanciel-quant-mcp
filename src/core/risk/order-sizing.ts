/**
 * core/risk/order-sizing.ts — 봇 주문 목표수량 단일 산출(순수). Design §3.
 *
 * 핵심: 백테엔진(진입)과 러너(주문)가 **이 함수 하나만** 호출 → backtest≡live 구조 보장.
 * legacy(quantityPercent / floor(capital/price))와 vol_target(변동성 타게팅)을 내부 분기로 모두 처리.
 * legacy 경로는 기존 공식을 그대로 재현 → riskSizing 미설정 봇은 **바이트 동일**(회귀 0).
 *
 * 정직: vol_target = 변동성 반비례 사이징 = **리스크 통제**(고변동 작게/저변동 크게, 무레버리지). 알파 아님.
 */
import { floorQty } from "../position/qty.js";
import { computePositionSize, computeEwmaVol, annualizeVol, toLogReturns } from "./sizing.js";

export interface RiskSizingConfig {
  method: "vol_target"; // 이번엔 vol_target만(enum 확장 여지)
  targetVolAnnual: number; // 예: 0.2 (연 20%)
  leverageCap?: number; // 기본 1.0(현물 무레버리지)
  lookback?: number; // realizedVol 계산 봉수(기본=가용분)
}

export interface OrderQtyInput {
  equity: number; // 백테=러닝 balance, 라이브=bot.capital(또는 실잔고)
  price: number; // 진입 체결 추정가
  commissionPct: number; // 기존 사이징과 동일 수수료 반영(예: 0.1)
  closes: number[]; // realizedVol용 최근 종가(오름차순, 현재 봉 포함 가능)
  timeframe: string; // 연환산용(크립토 √365 계열)
  legacyQuantityPercent: number; // riskSizing 없을 때 기존 공식 재현(러너는 100=floor(capital/price) 동치)
  riskSizing?: RiskSizingConfig | null;
}

export interface OrderQtyResult {
  qty: number; // 정규화/캡 전 목표수량(floorQty 적용)
  notional: number;
  detail: Record<string, unknown>;
}

/**
 * 단일 진입 목표수량. 부수효과 0 → 엔진·러너 공용.
 * 안전: equity/price≤0 → 0, realizedVol≤0/표본<2 → vol_target 레버리지 0(무한레버리지 가드) → qty 0(무거래, 예외 없음).
 */
export function computeOrderQty(i: OrderQtyInput): OrderQtyResult {
  const px = i.price * (1 + i.commissionPct / 100);
  if (!(i.equity > 0) || !(px > 0)) return { qty: 0, notional: 0, detail: { error: "equity/price<=0" } };

  // ── legacy: 기존 공식 그대로(바이트 동일) ──
  if (!i.riskSizing) {
    const invest = i.equity * (i.legacyQuantityPercent / 100);
    return { qty: floorQty(invest / px), notional: invest, detail: { mode: "legacy", legacyQuantityPercent: i.legacyQuantityPercent } };
  }

  // ── vol_target ──
  const lookback = i.riskSizing.lookback && i.riskSizing.lookback > 0 ? i.riskSizing.lookback : i.closes.length;
  const slice = i.closes.slice(-Math.max(2, lookback));
  const realizedVolAnnual = annualizeVol(computeEwmaVol(toLogReturns(slice)), i.timeframe);
  const sized = computePositionSize({
    method: "vol_target",
    equity: i.equity,
    price: i.price,
    targetVolAnnual: i.riskSizing.targetVolAnnual,
    realizedVolAnnual, // 0이면 computeVolTargetLeverage가 0 반환(무한레버리지 가드)
    leverageCap: i.riskSizing.leverageCap ?? 1.0,
  });
  return {
    qty: floorQty(sized.notional / px),
    notional: sized.notional,
    detail: { mode: "vol_target", realizedVolAnnual, ...sized.detail },
  };
}
