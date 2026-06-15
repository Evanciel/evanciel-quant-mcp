/**
 * market-hours.test.ts — isMarketOpen/sessionKey 경계 검증(네트워크 0).
 * KR 평일 09:00~15:18 KST 연속매매만 open, 동시호가/주말/장외 closed. Binance 24/7.
 */
import { describe, it, expect } from "vitest";
import { isMarketOpen, sessionKey } from "../src/util/market-hours.js";

// KST 시각 t를 UTC Date로(함수가 +9h 시프트하므로 UTC=KST-9h). 2026-06-15=월, 06-13=토, 06-14=일.
const kst = (iso: string) => new Date(new Date(iso + "Z").getTime() - 9 * 3600 * 1000);

describe("isMarketOpen", () => {
  it("Binance는 항상 open(주말·야간 무관)", () => {
    expect(isMarketOpen("binance", kst("2026-06-13T03:00:00"))).toBe(true); // 토 새벽
    expect(isMarketOpen("binance", kst("2026-06-15T23:00:00"))).toBe(true); // 월 야간
  });
  it("키움 평일 연속매매 09:00~15:18 = open", () => {
    expect(isMarketOpen("kiwoom", kst("2026-06-15T09:00:00"))).toBe(true);  // 개장
    expect(isMarketOpen("kiwoom", kst("2026-06-15T12:00:00"))).toBe(true);  // 장중
    expect(isMarketOpen("kiwoom", kst("2026-06-15T15:18:00"))).toBe(true);  // 연속매매 끝
  });
  it("키움 장외·동시호가·주말 = closed", () => {
    expect(isMarketOpen("kiwoom", kst("2026-06-15T08:59:00"))).toBe(false); // 장전
    expect(isMarketOpen("kiwoom", kst("2026-06-15T15:19:00"))).toBe(false); // 동시호가 진입
    expect(isMarketOpen("kiwoom", kst("2026-06-15T15:30:00"))).toBe(false); // 마감
    expect(isMarketOpen("kiwoom", kst("2026-06-15T18:00:00"))).toBe(false); // 야간
    expect(isMarketOpen("kiwoom", kst("2026-06-13T12:00:00"))).toBe(false); // 토
    expect(isMarketOpen("kiwoom", kst("2026-06-14T12:00:00"))).toBe(false); // 일
  });
  it("KIS도 키움과 동일 KRX 규칙", () => {
    expect(isMarketOpen("kis", kst("2026-06-15T12:00:00"))).toBe(true);
    expect(isMarketOpen("kis", kst("2026-06-15T16:00:00"))).toBe(false);
  });
});

describe("sessionKey", () => {
  it("KR은 KST 날짜 경계 — 같은 세션 내 다른 시각은 동일 키(세션당 1회 재주문 보장)", () => {
    const a = sessionKey("kiwoom", kst("2026-06-15T09:00:00"));
    const b = sessionKey("kiwoom", kst("2026-06-15T15:18:00"));
    expect(a).toBe(b);
    expect(a).toBe("2026-06-15");
  });
  it("KR 날짜가 바뀌면 세션 키도 바뀜(day-order 만료 경계)", () => {
    expect(sessionKey("kiwoom", kst("2026-06-15T10:00:00"))).not.toBe(sessionKey("kiwoom", kst("2026-06-16T10:00:00")));
  });
  it("KST 자정 직후/직전이 다른 날(UTC 자정 아님)", () => {
    expect(sessionKey("kiwoom", kst("2026-06-15T00:30:00"))).toBe("2026-06-15"); // KST 00:30
    expect(sessionKey("kiwoom", kst("2026-06-15T23:30:00"))).toBe("2026-06-15"); // KST 23:30 같은 날
  });
});
