/**
 * execution/reconcile.ts — 실잔고/실포지션 동기화 + 체결 확인의 순수 결정 로직.
 *
 * 왜 중요한가(P0): 현재 봇은 거래소 실잔고/실포지션을 한 번도 안 본다. capital은 가상값이고, 라이브 주문이
 * 부분체결/거부되면 로컬 장부와 거래소 진실이 소리없이 발산한다. 이 모듈은 "거래소 진실 vs 로컬"을 비교해
 * 드리프트를 정량화(computePositionDrift)하고, 실잔고 기반 사이징(sizeFromBalance), 모호한 주문의 체결여부
 * 판정(classifyFillStatus)을 순수하게 계산한다. 어댑터 호출(getBalance/getPositions/getOrderByClientId)은 러너가.
 */

export interface DriftResult {
  inSync: boolean;
  localQty: number;
  exchangeQty: number;
  driftQty: number;          // exchange - local (양수=거래소가 더 많이 보유)
  severity: "ok" | "minor" | "major";
  recommended: "none" | "adopt_exchange"; // 정정 권고: 거래소 진실 채택
}

/**
 * 로컬 장부 수량 vs 거래소 실제 수량 비교(순수). 절대/상대 허용오차 내면 동기화로 간주.
 * 발산 시 '거래소 진실 채택' 권고(거래소가 사실). major=상대 5% 초과 또는 부호 불일치.
 */
export function computePositionDrift(localQty: number, exchangeQty: number, absTol = 1e-8, relTol = 0.01): DriftResult {
  const lq = Number.isFinite(localQty) ? localQty : 0;
  const eq = Number.isFinite(exchangeQty) ? exchangeQty : 0;
  const drift = eq - lq;
  const scale = Math.max(Math.abs(lq), Math.abs(eq), 1e-12);
  const rel = Math.abs(drift) / scale;
  const inSync = Math.abs(drift) <= absTol || rel <= relTol;
  let severity: DriftResult["severity"] = "ok";
  if (!inSync) severity = rel > 0.05 || Math.sign(lq) !== Math.sign(eq) ? "major" : "minor";
  return { inSync, localQty: lq, exchangeQty: eq, driftQty: +drift.toFixed(10), severity, recommended: inSync ? "none" : "adopt_exchange" };
}

/**
 * 실잔고 기반 주문 수량 산정(순수). 가용현금×비율/가격 → lot 절사. 현금 부족/비정상 입력이면 0.
 * 라이브에서 정적 capital이 아니라 실제 cashBalance로 사이징 → 잔고초과 주문(거래소 거부) 방지.
 */
export function sizeFromBalance(cashBalance: number, price: number, fractionPercent: number, lotStep = 0): number {
  if (!(cashBalance > 0) || !(price > 0) || !(fractionPercent > 0)) return 0;
  const budget = cashBalance * (Math.min(100, fractionPercent) / 100);
  let qty = budget / price;
  // lotStep 지정 시 그 격자로, 아니면 8자리(크립토 분수 — 정수 floor 금지: BTC 소액=0 방지).
  qty = lotStep > 0 ? Math.floor(qty / lotStep) * lotStep : Math.floor(qty * 1e8) / 1e8;
  return qty > 0 ? qty : 0;
}

export type FillVerdict = "filled" | "open" | "not_placed" | "rejected" | "unknown";

/**
 * 모호한 placeOrder(타임아웃/네트워크 실패) 후 getOrderByClientId 결과로 체결여부 판정(순수).
 * filled→확정 / pending(지정가 미체결)→open / null(주문없음)→재시도 안전 / rejected→실패 / 조회불가(undefined)→unknown(보수적).
 */
export function classifyFillStatus(order: { status: "filled" | "pending" | "rejected" } | null | undefined): FillVerdict {
  if (order === undefined) return "unknown";   // 어댑터가 조회 미지원 → 보수적
  if (order === null) return "not_placed";      // 거래소에 없음 → 주문 안 나감(재시도 안전)
  switch (order.status) {
    case "filled": return "filled";
    case "pending": return "open";
    case "rejected": return "rejected";
    default: return "unknown";
  }
}
