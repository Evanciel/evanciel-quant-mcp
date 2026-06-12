/**
 * krx-tick.test.ts — KRX 호가단위 공용 모듈(audit P0-4) 경계가격 표 기반 검증.
 * 키움 로컬 함수에서 추출된 모듈이 원 동작과 바이트 동일함을 보장(회귀 0).
 */
import { describe, expect, it } from "vitest";
import { krxTick, roundToKrxTick } from "../src/brokers/krx-tick.js";

describe("krxTick — 가격대별 호가단위(2023 개편)", () => {
  // [가격, 기대 틱] — 각 구간의 하한/상한-경계 양쪽을 표로 고정.
  const table: [number, number][] = [
    [1, 1], [1999, 1],          // < 2,000 → 1원
    [2000, 5], [4999, 5],       // < 5,000 → 5원
    [5000, 10], [19999, 10],    // < 20,000 → 10원
    [20000, 50], [49999, 50],   // < 50,000 → 50원
    [50000, 100], [199999, 100],// < 200,000 → 100원
    [200000, 500], [499999, 500],// < 500,000 → 500원
    [500000, 1000], [1000000, 1000], // ≥ 500,000 → 1,000원
  ];
  it.each(table)("가격 %d → 틱 %d원", (price, tick) => {
    expect(krxTick(price)).toBe(tick);
  });
});

describe("roundToKrxTick — 가장 가까운 틱으로 반올림", () => {
  const table: [number, number][] = [
    [1234, 1234],       // 1원 틱 — 그대로
    [2003, 2005],       // 5원 틱 반올림 (2003→2005)
    [2002, 2000],       // 5원 틱 내림 (2002→2000)
    [5004, 5000],       // 10원 틱
    [5005, 5010],       // 10원 틱 (round half up)
    [20025, 20050],     // 50원 틱
    [20024, 20000],
    [71550, 71600],     // 100원 틱 (삼성전자급 가격대)
    [71549, 71500],
    [250250, 250500],   // 500원 틱
    [250249, 250000],
    [512345, 512000],   // 1,000원 틱
    [512500, 513000],
  ];
  it.each(table)("입력 %d → 정렬 %d", (input, expected) => {
    expect(roundToKrxTick(input)).toBe(expected);
  });

  it("정렬된 가격은 항상 틱의 정수배", () => {
    for (const p of [1500, 3333, 12345, 34567, 123456, 345678, 765432]) {
      const r = roundToKrxTick(p);
      expect(r % krxTick(r)).toBe(0);
    }
  });

  it("비양수는 그대로 반환(상위 검증에 위임 — silent 보정 금지)", () => {
    expect(roundToKrxTick(0)).toBe(0);
    expect(roundToKrxTick(-100)).toBe(-100);
    expect(Number.isNaN(roundToKrxTick(NaN))).toBe(true);
  });
});
