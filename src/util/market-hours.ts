/**
 * market-hours.ts — 거래소 개장(연속매매) 여부 순수함수. limit_bracket 봇의 재주문 게이트.
 *   키움/KIS(KRX): 평일 09:00~15:18 KST(연속매매). 15:20~15:30 장마감 동시호가(단일가 경매)는 제외 → 모니터만
 *     (적대검증 kr#4: 동시호가는 연속매매와 체결 메커니즘이 달라 의도와 다른 체결 위험). 공휴일 캘린더 미반영 →
 *     공휴일엔 placeOrder가 거부(fail-safe). UTC epoch → KST 벽시계 시프트는 dayBoundaryIso(safety.ts) 기법 재사용.
 *   Binance(크립토): 24/7 항상 개장.
 */
import type { Broker } from "../brokers/safety.js";

const KR_OPEN_MIN = 9 * 60;                  // 09:00
const KR_CONTINUOUS_END_MIN = 15 * 60 + 18;  // 15:18 (15:20 장마감 동시호가 직전 버퍼)

/** 현재 신규/재주문이 가능한 연속매매 세션인가. KR=평일 09:00~15:18, Binance=항상. */
export function isMarketOpen(broker: Broker, now: Date = new Date()): boolean {
  if (broker === "binance") return true; // 크립토 24/7
  const kst = new Date(now.getTime() + 9 * 3600 * 1000); // UTC epoch+9h → getUTC*로 읽으면 KST 벽시계(머신 TZ 무관)
  const dow = kst.getUTCDay(); // 0=일 6=토
  if (dow === 0 || dow === 6) return false; // 주말
  const hm = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return hm >= KR_OPEN_MIN && hm <= KR_CONTINUOUS_END_MIN;
}

/**
 * 세션 키(거래 세션 식별자). day-order 만료 경계 = 세션 전환. 멱등키·세션당 재주문 캡 기준.
 *   벽시계(Date.now()) 대신 이 키를 써야 폴링(15초)이 봉보다 잦아도 "세션당 1회 재주문"이 보장됨(적대검증 safety#5).
 *   KR=KST 날짜(YYYY-MM-DD), Binance=UTC 날짜(GTC라 사실상 미사용, 캡 카운터 일관성용).
 */
export function sessionKey(broker: Broker, now: Date = new Date()): string {
  const shift = broker === "binance" ? 0 : 9 * 3600 * 1000; // KR=KST 날짜 경계
  return new Date(now.getTime() + shift).toISOString().slice(0, 10);
}
