/**
 * allocation.test.ts — 포트폴리오 배분(equal/inverse_vol/vol_target) 순수 검증.
 */
import { describe, it, expect } from "vitest";
import { allocatePortfolio, type AssetReturns } from "../src/core/risk/allocation.js";

// 저변동 자산 A(작은 수익률 진동) vs 고변동 자산 B(큰 진동)
const lowVol: number[] = Array.from({ length: 100 }, (_, i) => (i % 2 ? 0.001 : -0.001));
const highVol: number[] = Array.from({ length: 100 }, (_, i) => (i % 2 ? 0.03 : -0.03));
const assets: AssetReturns[] = [{ symbol: "LOW", returns: lowVol }, { symbol: "HIGH", returns: highVol }];

describe("allocatePortfolio", () => {
  it("equal: 1/N 동등 배분", () => {
    const r = allocatePortfolio(assets, "equal", { timeframe: "1d" });
    expect(r.weights.LOW).toBeCloseTo(0.5, 6);
    expect(r.weights.HIGH).toBeCloseTo(0.5, 6);
  });

  it("inverse_vol: 저변동 자산에 더 큰 비중", () => {
    const r = allocatePortfolio(assets, "inverse_vol", { timeframe: "1d" });
    expect(r.weights.LOW).toBeGreaterThan(r.weights.HIGH);
    expect(r.weights.LOW + r.weights.HIGH).toBeCloseTo(1, 5);
    expect(r.volsAnnual.HIGH).toBeGreaterThan(r.volsAnnual.LOW); // 변동성 추정 정상
  });

  it("vol_target: grossLeverage 산출(목표/추정변동성)", () => {
    const r = allocatePortfolio(assets, "vol_target", { timeframe: "1d", targetVolAnnual: 0.2 });
    expect(r.grossLeverage).toBeGreaterThan(0);
    expect(r.weights.LOW + r.weights.HIGH).toBeCloseTo(1, 5);
  });

  it("데이터 부족 자산 제외(skipped)", () => {
    const r = allocatePortfolio([{ symbol: "OK", returns: lowVol }, { symbol: "BAD", returns: [0.01] }], "inverse_vol", {});
    expect(r.skipped).toEqual(["BAD"]);
    expect(r.weights.OK).toBeCloseTo(1, 5); // 유효 1개 → 전량
    expect(r.weights.BAD).toBeUndefined();
  });

  it("유효 자산 0개 → 빈 weights", () => {
    const r = allocatePortfolio([{ symbol: "X", returns: [] }], "equal", {});
    expect(r.weights).toEqual({});
  });

  it("전부 변동성 0 → equal 폴백(0분모 방지)", () => {
    const flat = Array.from({ length: 50 }, () => 0);
    const r = allocatePortfolio([{ symbol: "A", returns: flat }, { symbol: "B", returns: flat }], "inverse_vol", {});
    expect(r.weights.A).toBeCloseTo(0.5, 5);
    expect(r.weights.B).toBeCloseTo(0.5, 5);
  });
});
