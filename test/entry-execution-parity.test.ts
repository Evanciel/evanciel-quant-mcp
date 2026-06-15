/**
 * entry-execution-parity.test.ts — audit P1-5 crown-jewel: resolveEntryFill 순수함수 패리티/불변.
 *   ① market/미설정 = 레거시 바이트 동일(close*(1+slip), entryBarIndex=신호봉)
 *   ② TOUCH = limit 정확 체결 + entryBarIndex 재배치  ③ TIMEOUT = close_t*(1+cap) 폴백
 *   ④ 퍼즈 500: backtestEntryPrice ≥ limitPrice = liveFloor (never-more-optimistic, 모든 입력)
 *   ⑤ 클램프(timeoutBars/maxSlippagePct/limitOffsetPct)
 */
import { describe, it, expect } from "vitest";
import {
  resolveEntryFill, computeLimitPrice, checkSlippageCap, elapsedClosedBars,
  clampTimeoutBars, clampMaxSlippagePct, clampLimitOffsetPct,
} from "../src/core/execution/entry.js";

const d = (rows: [number, number][]) => rows.map(([low, close]) => ({ low, close }));

describe("resolveEntryFill — 시장가/미설정(레거시 바이트 동일)", () => {
  it("미설정 → close*(1+slip), entryBarIndex=신호봉", () => {
    const r = resolveEntryFill(d([[100, 100]]), 0, undefined, 0.05);
    expect(r.fillPrice).toBeCloseTo(100 * 1.0005, 8);
    expect(r.entryBarIndex).toBe(0);
  });
  it("type:market → 동일", () => {
    const r = resolveEntryFill(d([[100, 100]]), 0, { type: "market" }, 0.05);
    expect(r.fillPrice).toBeCloseTo(100 * 1.0005, 8);
    expect(r.entryBarIndex).toBe(0);
  });
});

describe("resolveEntryFill — 지정가 TOUCH / TIMEOUT", () => {
  it("TOUCH: 윈도우 내 low<limit → limit 정확 체결(maker, 슬리피지 0) + entryBarIndex 재배치", () => {
    // 신호봉0 close100, offset-2 → limit98. 봉1 low97<98 → 터치(j=1).
    const r = resolveEntryFill(d([[100, 100], [97, 99], [99, 100]]), 0, { type: "limit", limitOffsetPct: -2, timeoutBars: 3, maxSlippagePct: 0.5 }, 0.05);
    expect(r.fillPrice).toBeCloseTo(98, 6);
    expect(r.entryBarIndex).toBe(1);
  });
  it("TIMEOUT: 미교차 → close_t*(1+cap) 폴백, entryBarIndex=min(s+timeoutBars,last)", () => {
    // limit98 미교차(low들 ≥99). timeoutBars2 → 윈도우[0,1] 미터치 → t=2, fill=close2*1.005.
    const r = resolveEntryFill(d([[100, 100], [99, 100], [99.5, 101], [100, 102]]), 0, { type: "limit", limitOffsetPct: -2, timeoutBars: 2, maxSlippagePct: 0.5 }, 0.05);
    expect(r.entryBarIndex).toBe(2);
    expect(r.fillPrice).toBeCloseTo(101 * 1.005, 6);
  });
  it("같은 봉 터치(low<limit at s) → entryBarIndex=s(즉시)", () => {
    const r = resolveEntryFill(d([[97, 100], [100, 101]]), 0, { type: "limit", limitOffsetPct: -2, timeoutBars: 3, maxSlippagePct: 0.5 }, 0.05);
    expect(r.entryBarIndex).toBe(0);
    expect(r.fillPrice).toBeCloseTo(98, 6);
  });
});

describe("resolveEntryFill — 퍼즈 500: backtestEntryPrice ≥ limitPrice(never-more-optimistic)", () => {
  it("모든 입력서 fillPrice ≥ limit, s ≤ entryBarIndex ≤ last", () => {
    for (let n = 0; n < 500; n++) {
      const len = 5 + (n % 20);
      const data = Array.from({ length: len }, (_, k) => {
        const close = 50 + ((n * 7 + k * 13) % 100);
        const low = close * (0.9 + ((n + k) % 11) / 100); // 0.90..1.00 × close
        return { low, close };
      });
      const s = n % Math.max(1, len - 1);
      const offset = -(n % 6); // 0..-5
      const tb = 1 + (n % 50);
      const cap = (n % 5) / 2; // 0..2
      const limitPrice = computeLimitPrice(data[s].close, offset);
      const r = resolveEntryFill(data, s, { type: "limit", limitOffsetPct: offset, timeoutBars: tb, maxSlippagePct: cap }, 0.05);
      expect(r.fillPrice).toBeGreaterThanOrEqual(limitPrice - 1e-9);
      expect(r.entryBarIndex).toBeGreaterThanOrEqual(s);
      expect(r.entryBarIndex).toBeLessThanOrEqual(len - 1);
    }
  });
});

describe("clamp / helpers", () => {
  it("clampTimeoutBars 1..50, 기본 3", () => {
    expect(clampTimeoutBars(0)).toBe(1);
    expect(clampTimeoutBars(100)).toBe(50);
    expect(clampTimeoutBars(undefined)).toBe(3);
    expect(clampTimeoutBars(7)).toBe(7);
  });
  it("clampMaxSlippagePct 0..5, 기본 0.5", () => {
    expect(clampMaxSlippagePct(-1)).toBe(0);
    expect(clampMaxSlippagePct(10)).toBe(5);
    expect(clampMaxSlippagePct(undefined)).toBe(0.5);
  });
  it("clampLimitOffsetPct -5..0(양수=현재가위 매수 금지→0), 기본 0", () => {
    expect(clampLimitOffsetPct(5)).toBe(0);
    expect(clampLimitOffsetPct(-10)).toBe(-5);
    expect(clampLimitOffsetPct(undefined)).toBe(0);
    expect(clampLimitOffsetPct(-2)).toBe(-2);
  });
  it("checkSlippageCap: deviation ≤ cap 통과 / 초과 차단", () => {
    expect(checkSlippageCap(100, 100.4, 0.5).ok).toBe(true);
    expect(checkSlippageCap(100, 100.6, 0.5).ok).toBe(false);
    expect(checkSlippageCap(0, 100, 0.5).ok).toBe(false); // 비정상 limit → fail-closed
  });
  it("elapsedClosedBars: 격자 경과 봉수", () => {
    const iso = (h: number) => new Date(Date.UTC(2025, 0, 1, h)).toISOString();
    expect(elapsedClosedBars(iso(0), iso(3), 3600_000)).toBe(3);
    expect(elapsedClosedBars(iso(0), iso(0), 3600_000)).toBe(0);
  });
});
