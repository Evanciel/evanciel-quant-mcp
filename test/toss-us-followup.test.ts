/**
 * toss-us-followup.test.ts — US 세션 게이팅(FR-B) 검증.
 * isMarketOpen/sessionKey가 토스 US 심볼에 US RTH(09:30~16:00 ET, DST 반영)를 적용하고,
 * KR(kis/키움/토스 KR)·binance 기존 동작은 보존하는지.
 * 앵커 날짜(2026): 7/6=월(EDT), 1/5=월(EST), 7/4=토.
 */
import { describe, it, expect } from "vitest";
import { isMarketOpen, sessionKey, isUsEasternDst } from "../src/util/market-hours.js";

describe("isUsEasternDst — 서머타임 판정", () => {
  it("7월=EDT(true), 1월=EST(false)", () => {
    expect(isUsEasternDst(new Date("2026-07-06T14:00:00Z"))).toBe(true);
    expect(isUsEasternDst(new Date("2026-01-05T15:00:00Z"))).toBe(false);
  });
});

describe("isMarketOpen — 토스 US 심볼 (RTH 09:30~16:00 ET)", () => {
  it("EDT 평일 장중(10:00 ET) 개장", () => {
    expect(isMarketOpen("toss", new Date("2026-07-06T14:00:00Z"), "AAPL")).toBe(true); // 14:00Z = 10:00 EDT 월
  });
  it("EDT 개장 경계: 09:30 열림 / 09:29 닫힘 / 16:00 닫힘", () => {
    expect(isMarketOpen("toss", new Date("2026-07-06T13:30:00Z"), "AAPL")).toBe(true);  // 09:30 EDT
    expect(isMarketOpen("toss", new Date("2026-07-06T13:29:00Z"), "AAPL")).toBe(false); // 09:29
    expect(isMarketOpen("toss", new Date("2026-07-06T20:00:00Z"), "AAPL")).toBe(false); // 16:00 (장마감)
    expect(isMarketOpen("toss", new Date("2026-07-06T19:59:00Z"), "AAPL")).toBe(true);  // 15:59
  });
  it("EST(겨울) 장중: 15:00Z=10:00 EST 개장 / 14:00Z=09:00 EST 닫힘", () => {
    expect(isMarketOpen("toss", new Date("2026-01-05T15:00:00Z"), "AAPL")).toBe(true);
    expect(isMarketOpen("toss", new Date("2026-01-05T14:00:00Z"), "AAPL")).toBe(false);
  });
  it("주말은 닫힘", () => {
    expect(isMarketOpen("toss", new Date("2026-07-04T14:00:00Z"), "AAPL")).toBe(false); // 토요일
  });
  it("같은 시각이라도 토스 KR 심볼은 KR 시간 적용(US와 분리)", () => {
    // 14:00Z = 23:00 KST(월) → KR 폐장. 같은 시각 AAPL은 EDT 10:00 개장.
    expect(isMarketOpen("toss", new Date("2026-07-06T14:00:00Z"), "005930")).toBe(false);
    expect(isMarketOpen("toss", new Date("2026-07-06T14:00:00Z"), "AAPL")).toBe(true);
  });
});

describe("isMarketOpen — 기존 브로커 보존(회귀가드)", () => {
  it("binance는 항상 개장", () => {
    expect(isMarketOpen("binance", new Date("2026-07-04T03:00:00Z"))).toBe(true); // 주말도 24/7
  });
  it("KR(키움): 01:00Z=10:00 KST 개장 / 14:00Z=23:00 KST 닫힘", () => {
    expect(isMarketOpen("kiwoom", new Date("2026-07-06T01:00:00Z"))).toBe(true);
    expect(isMarketOpen("kiwoom", new Date("2026-07-06T14:00:00Z"))).toBe(false);
  });
  it("토스 심볼 미전달 시 KR 시간(기존 비-binance 동작)", () => {
    expect(isMarketOpen("toss", new Date("2026-07-06T01:00:00Z"))).toBe(true);  // KST 10:00
    expect(isMarketOpen("toss", new Date("2026-07-06T14:00:00Z"))).toBe(false); // KST 23:00
  });
});

describe("sessionKey — 통화권별 날짜 경계", () => {
  const t = new Date("2026-07-06T02:00:00Z"); // EDT 7/5 22:00, KST 7/6 11:00, UTC 7/6
  it("토스 US=ET 날짜, 토스 KR=KST 날짜, binance=UTC 날짜", () => {
    expect(sessionKey("toss", t, "AAPL")).toBe("2026-07-05"); // ET(-4): 7/5 22:00
    expect(sessionKey("toss", t, "005930")).toBe("2026-07-06"); // KST(+9): 7/6 11:00
    expect(sessionKey("binance", t)).toBe("2026-07-06"); // UTC
    expect(sessionKey("kiwoom", t)).toBe("2026-07-06"); // KST
  });
});
