/**
 * market-hours.ts — 거래소 개장(연속매매) 여부 순수함수. limit_bracket 봇의 재주문 게이트.
 *   키움/KIS(KRX) + 토스 KR: 평일 09:00~15:18 KST(연속매매). 15:20~15:30 장마감 동시호가는 제외(모니터만, 적대검증 kr#4).
 *   토스 US(영문 티커): 평일 09:30~16:00 ET(정규장 RTH) — EDT(UTC-4)/EST(UTC-5) DST 반영(아래 isUsEasternDst).
 *   Binance(크립토): 24/7 항상 개장. 공휴일 캘린더 미반영 → 공휴일엔 거래소가 placeOrder 거부(fail-safe).
 *   UTC epoch → 현지 벽시계 시프트는 dayBoundaryIso(safety.ts) 기법 재사용. 토스 US 심볼 판정은 isKrSymbol(단일 진실원).
 */
import type { Broker } from "../brokers/safety.js";
import { isKrSymbol } from "../brokers/krx-tick.js";

const KR_OPEN_MIN = 9 * 60;                  // 09:00
const KR_CONTINUOUS_END_MIN = 15 * 60 + 18;  // 15:18 (15:20 장마감 동시호가 직전 버퍼)
const US_OPEN_MIN = 9 * 60 + 30;             // 09:30 ET (정규장 시작)
const US_CLOSE_MIN = 16 * 60;                // 16:00 ET (정규장 종료)

/** 토스 US 심볼(영문 티커=비KR)인가. 토스만 KR/US 혼재라 심볼로 분기. */
function isUsToss(broker: Broker, symbol?: string): boolean {
  return broker === "toss" && !!symbol && !isKrSymbol(symbol);
}

/**
 * 주어진 시각이 US 동부 서머타임(EDT)인가. 규칙: 3월 2번째 일요일 02:00 ~ 11월 1번째 일요일 02:00(현지).
 * 전환 시각(02:00 ET)은 RTH(09:30~16:00) 밖이라 경계 ±1h 근사가 장중 판정에 영향 없음(전환일에도 RTH는 정확).
 */
export function isUsEasternDst(now: Date): boolean {
  const y = now.getUTCFullYear();
  const march1Dow = new Date(Date.UTC(y, 2, 1)).getUTCDay();
  const secondSunMarch = 1 + ((7 - march1Dow) % 7) + 7;        // 3월 2번째 일요일(일자)
  const dstStart = Date.UTC(y, 2, secondSunMarch, 7);          // 02:00 EST = 07:00 UTC
  const nov1Dow = new Date(Date.UTC(y, 10, 1)).getUTCDay();
  const firstSunNov = 1 + ((7 - nov1Dow) % 7);                 // 11월 1번째 일요일(일자)
  const dstEnd = Date.UTC(y, 10, firstSunNov, 6);             // 02:00 EDT = 06:00 UTC
  const t = now.getTime();
  return t >= dstStart && t < dstEnd;
}

/** 현재 신규/재주문이 가능한 연속매매 세션인가. KR=평일 09:00~15:18 KST, US(토스)=평일 09:30~16:00 ET, Binance=항상. */
export function isMarketOpen(broker: Broker, now: Date = new Date(), symbol?: string): boolean {
  if (broker === "binance") return true; // 크립토 24/7
  if (isUsToss(broker, symbol)) {
    const offsetH = isUsEasternDst(now) ? 4 : 5;                // ET = UTC - (EDT 4 / EST 5)
    const et = new Date(now.getTime() - offsetH * 3600 * 1000); // UTC epoch-offset → ET 벽시계(getUTC*로 읽음)
    const dow = et.getUTCDay();
    if (dow === 0 || dow === 6) return false;                   // 주말
    const hm = et.getUTCHours() * 60 + et.getUTCMinutes();
    return hm >= US_OPEN_MIN && hm < US_CLOSE_MIN;
  }
  // KR(kis/키움 + 토스 KR 심볼)
  const kst = new Date(now.getTime() + 9 * 3600 * 1000); // UTC epoch+9h → getUTC*로 읽으면 KST 벽시계(머신 TZ 무관)
  const dow = kst.getUTCDay();
  if (dow === 0 || dow === 6) return false; // 주말
  const hm = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return hm >= KR_OPEN_MIN && hm <= KR_CONTINUOUS_END_MIN;
}

/**
 * 세션 키(거래 세션 식별자). day-order 만료 경계 = 세션 전환. 멱등키·세션당 재주문 캡 기준.
 *   벽시계 대신 이 키를 써야 폴링(15초)이 봉보다 잦아도 "세션당 1회 재주문"이 보장됨(적대검증 safety#5).
 *   KR=KST 날짜, US(토스)=ET 날짜, Binance=UTC 날짜(GTC라 사실상 미사용, 캡 카운터 일관성용).
 */
export function sessionKey(broker: Broker, now: Date = new Date(), symbol?: string): string {
  if (broker === "binance") return now.toISOString().slice(0, 10); // UTC 날짜
  if (isUsToss(broker, symbol)) {
    const offsetH = isUsEasternDst(now) ? 4 : 5;
    return new Date(now.getTime() - offsetH * 3600 * 1000).toISOString().slice(0, 10); // ET 날짜
  }
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST 날짜
}
