/**
 * krx-tick.ts — KRX 호가단위(2023 개편) 공용 모듈. (audit P0-4)
 * 키움 모의 E2E(2026-06)에서 실증: 지정가가 틱에 안 맞으면 return_code=20(RC4003 호가단위 오류)로
 * 거부됨. KIS도 동일 KRX 규칙 → 키움/KIS 양쪽 placeOrder가 지정가를 이 틱으로 정렬해야 한다.
 * 원본: kiwoom.ts 로컬 함수에서 추출(동작 바이트 동일 — 회귀 0).
 */

/** 가격대별 KRX 호가단위(원). */
export function krxTick(price: number): number {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

/** 지정가를 가장 가까운 KRX 틱으로 정렬(반올림). 비양수는 그대로 반환(상위 검증에 위임). */
export function roundToKrxTick(price: number): number {
  if (!(price > 0)) return price;
  const t = krxTick(price);
  return Math.round(price / t) * t;
}

/**
 * KR 종목 코드(6자리 숫자) 여부 — KRW/USD 통화 판정 + KR 정수주 판정의 **단일 진실원**.
 * 토스는 KR(005930)·US(AAPL)를 단일 API로 섞어 다루므로 통화/수량 분기가 이 한 곳에서만 정의돼야 한다
 * (safety.quoteCurrencyFor / toss 어댑터 / 대시보드가 전부 이 함수를 재사용 → 정의 불일치로 인한 서킷 오버킷·오통화 방지).
 */
export function isKrSymbol(symbol: string): boolean {
  return /^\d{6}$/.test((symbol ?? "").trim());
}
