/**
 * qty.ts — 주문 수량 정밀도(순수). 크립토는 분수 거래(0.0001 BTC)라 정수 floor 금지.
 *
 * 과거 버그: 엔진이 Math.floor(투자금/가격)으로 정수 절사 → BTC(가격 6만)를 소액 자본으로 사면 floor(0.0158)=0
 * → 매수 자체가 안 일어남(신호 소실). 고가 코인 실거래 불가. 8자리(거래소 최대 정밀도)로 내림하면 분수 허용 +
 * 부동소수 잡음 제거. 라이브 체결은 어댑터 normalizeQuantity가 심볼별 stepSize로 추가 정렬.
 */
export const floorQty = (q: number): number => (Number.isFinite(q) && q > 0 ? Math.floor(q * 1e8) / 1e8 : 0);

/**
 * KR 주식 종목코드 판정(순수). 한국 거래소(KRX) 종목은 6자리 숫자코드(예 "005930" 삼성전자).
 *   접두 'A'(예 "A005930") / 접미 거래소·시장 코드(예 "005930.KS", "005930_AL")를 흡수 — 키움 normalizeSymbol과 동일 규약.
 *   크립토(BTCUSDT 등 영문) / 미국주식(AAPL 등)은 false → 분수 수량 경로 유지(회귀 0).
 * 이 판정으로 엔진(백테)·러너(라이브)가 동일하게 KR을 정수 수량으로 처리 → store(장부)==거래소 실계좌(발산 방지).
 */
export function isKrStockSymbol(symbol: string | undefined | null): boolean {
  if (!symbol) return false;
  const s = String(symbol).trim().toUpperCase();
  // 'A005930' 접두 제거 → 6자리 숫자만 남으면 KR. 접미(.KS/_AL 등)는 6자리 숫자 뒤 경계로 흡수.
  const noPrefix = /^[A-Z]\d{6}$/.test(s) ? s.slice(1) : s;
  return /^\d{6}(\b|[._]|$)/.test(noPrefix);
}

/**
 * 인스트루먼트 인지 수량 양자화(순수). KR 주식(정수주만 거래) → 정수 내림, 그 외(크립토/미국주식) → floorQty(8자리 분수).
 *   엔진 사이징·라더 진입·러너 주문이 이 단일 함수로 분기 → KR이면 backtest도 정수=라이브와 일관(발산 차단).
 *   심볼 미지정/비KR이면 floorQty와 **바이트 동일**(크립토 회귀 0). 라이브 체결은 어댑터 normalizeQuantity가 한 번 더 정렬(이중 안전).
 */
export function quantizeQty(q: number, symbol?: string | null): number {
  if (!(Number.isFinite(q) && q > 0)) return 0;
  if (isKrStockSymbol(symbol)) return Math.floor(q); // KR 정수주(소수주 미지원)
  return floorQty(q); // 크립토/기타: 8자리 분수 허용
}
