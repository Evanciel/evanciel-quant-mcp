/**
 * candle-integrity.test.ts — 캔들 무결성 검증(audit P1-22) 회귀.
 * interval 불일치(요청≠응답 주기) + 봉 누락 감지, KR 주말 갭 오탐 방지.
 */
import { describe, it, expect } from "vitest";
import { intervalToMs, validateCandleContiguity } from "../src/util/candle.js";

const at = (ms: number) => ({ datetime: new Date(ms).toISOString() });
const series = (startMs: number, stepMs: number, n: number) => Array.from({ length: n }, (_, i) => at(startMs + i * stepMs));

const HOUR = 3_600_000, DAY = 86_400_000, MIN = 60_000;

describe("intervalToMs", () => {
  it("형식 파싱", () => {
    expect(intervalToMs("1m")).toBe(MIN);
    expect(intervalToMs("5m")).toBe(5 * MIN);
    expect(intervalToMs("1h")).toBe(HOUR);
    expect(intervalToMs("4h")).toBe(4 * HOUR);
    expect(intervalToMs("1d")).toBe(DAY);
    expect(intervalToMs("bogus")).toBe(0); // 미지 → 0(검증 스킵)
  });
});

describe("validateCandleContiguity — crypto(엄격)", () => {
  it("연속 1h 봉 → valid", () => {
    expect(validateCandleContiguity(series(0, HOUR, 50), "1h", "crypto").valid).toBe(true);
  });
  it("interval 불일치(5m 요청, 1h 응답) → invalid", () => {
    const r = validateCandleContiguity(series(0, HOUR, 50), "5m", "crypto");
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("interval 불일치");
  });
  it("봉 누락(중간 큰 간격) → invalid", () => {
    const bars = [...series(0, HOUR, 20), at(20 * HOUR + 5 * HOUR), at(20 * HOUR + 6 * HOUR), at(20 * HOUR + 7 * HOUR)]; // 5h 점프
    const r = validateCandleContiguity(bars, "1h", "crypto");
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("봉 누락");
  });
  it("비단조(중복/역순) → invalid", () => {
    const bars = [at(0), at(HOUR), at(HOUR), at(2 * HOUR)]; // 중복
    expect(validateCandleContiguity(bars, "1h", "crypto").valid).toBe(false);
  });
  it("표본 3개 미만 → valid(검증 불가, 상위 가드가 처리)", () => {
    expect(validateCandleContiguity([at(0), at(HOUR)], "1h", "crypto").valid).toBe(true);
  });
});

describe("validateCandleContiguity — kr(중앙값, 주말 갭 허용)", () => {
  it("일봉 + 주말 갭(금→월 3일) → valid(오탐 없음)", () => {
    // 월~금 1일 간격, 금→월 3일 간격이 반복되는 현실적 KR 일봉
    const bars: { datetime: string }[] = [];
    let t = Date.UTC(2025, 0, 6); // 월요일
    for (let w = 0; w < 8; w++) {
      for (let d = 0; d < 5; d++) { bars.push(at(t)); t += DAY; } // 월~금
      t += 2 * DAY; // 주말 스킵
    }
    expect(validateCandleContiguity(bars, "1d", "kr").valid).toBe(true);
  });
  it("KR에 5m 요청했는데 일봉 반환 → invalid(interval 중앙값 불일치)", () => {
    const bars: { datetime: string }[] = [];
    let t = Date.UTC(2025, 0, 6);
    for (let i = 0; i < 40; i++) { bars.push(at(t)); t += (i % 5 === 4 ? 3 : 1) * DAY; }
    const r = validateCandleContiguity(bars, "5m", "kr");
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("interval 불일치");
  });
  it("장중 5m + 야간 갭(하루 1회 큰 간격) → valid(중앙값=5m)", () => {
    const bars: { datetime: string }[] = [];
    let t = Date.UTC(2025, 0, 6, 0, 0);
    for (let day = 0; day < 5; day++) {
      for (let i = 0; i < 60; i++) { bars.push(at(t)); t += 5 * MIN; } // 5시간치 5m봉
      t += 19 * HOUR; // 야간 갭
    }
    expect(validateCandleContiguity(bars, "5m", "kr").valid).toBe(true);
  });
});
