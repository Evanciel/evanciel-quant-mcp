/**
 * qty.ts — 주문 수량 정밀도(순수). 크립토는 분수 거래(0.0001 BTC)라 정수 floor 금지.
 *
 * 과거 버그: 엔진이 Math.floor(투자금/가격)으로 정수 절사 → BTC(가격 6만)를 소액 자본으로 사면 floor(0.0158)=0
 * → 매수 자체가 안 일어남(신호 소실). 고가 코인 실거래 불가. 8자리(거래소 최대 정밀도)로 내림하면 분수 허용 +
 * 부동소수 잡음 제거. 라이브 체결은 어댑터 normalizeQuantity가 심볼별 stepSize로 추가 정렬.
 */
export const floorQty = (q: number): number => (Number.isFinite(q) && q > 0 ? Math.floor(q * 1e8) / 1e8 : 0);
