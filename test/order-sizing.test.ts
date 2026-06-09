/**
 * order-sizing.test.ts — computeOrderQty 순수 검증(L1). Design §7.
 */
import { describe, it, expect } from "vitest";
import { computeOrderQty, type OrderQtyInput } from "../src/core/risk/order-sizing.js";
import { floorQty } from "../src/core/position/qty.js";

const base = (over: Partial<OrderQtyInput> = {}): OrderQtyInput => ({
  equity: 10000, price: 100, commissionPct: 0.1, closes: [], timeframe: "1d",
  legacyQuantityPercent: 100, riskSizing: null, ...over,
});

// 변동성 시계열: 저변동(±0.5%) vs 고변동(±5%)
const lowVol = Array.from({ length: 120 }, (_, i) => 100 * (1 + (i % 2 ? 0.005 : -0.005)));
const highVol = Array.from({ length: 120 }, (_, i) => 100 * (1 + (i % 2 ? 0.05 : -0.05)));

describe("computeOrderQty — legacy(바이트 동일)", () => {
  it("legacyQuantityPercent=100 → floor(capital/price) 동치 (러너 공식 재현)", () => {
    const r = computeOrderQty(base({ equity: 10000, price: 100, legacyQuantityPercent: 100 }));
    const expected = floorQty((10000 * 1) / (100 * 1.001));
    expect(r.qty).toBe(expected);
    expect(r.detail.mode).toBe("legacy");
  });

  it("legacyQuantityPercent=50 → balance*qp/100 재현 (엔진 공식)", () => {
    const r = computeOrderQty(base({ equity: 10000, price: 100, legacyQuantityPercent: 50 }));
    expect(r.qty).toBe(floorQty((10000 * 0.5) / (100 * 1.001)));
  });

  it("equity<=0 / price<=0 → qty 0", () => {
    expect(computeOrderQty(base({ equity: 0 })).qty).toBe(0);
    expect(computeOrderQty(base({ price: 0 })).qty).toBe(0);
  });
});

describe("computeOrderQty — vol_target", () => {
  const vt = { method: "vol_target" as const, targetVolAnnual: 0.2, leverageCap: 1.0 };

  it("고변동 < 저변동 수량 (변동성 반비례)", () => {
    const low = computeOrderQty(base({ closes: lowVol, riskSizing: vt }));
    const high = computeOrderQty(base({ closes: highVol, riskSizing: vt }));
    expect(high.qty).toBeLessThan(low.qty);
    expect(low.detail.mode).toBe("vol_target");
  });

  it("leverageCap≤1 클램프 (저변동이어도 notional ≤ equity)", () => {
    const r = computeOrderQty(base({ equity: 10000, price: 100, closes: lowVol, riskSizing: vt }));
    expect(r.notional).toBeLessThanOrEqual(10000 + 1e-6);
  });

  it("realizedVol 0 (가격 무변동) → qty 0 (무한레버리지 가드)", () => {
    const flat = Array.from({ length: 60 }, () => 100);
    const r = computeOrderQty(base({ closes: flat, riskSizing: vt }));
    expect(r.qty).toBe(0);
  });

  it("표본 부족(<2) → qty 0 (예외 없음)", () => {
    const r = computeOrderQty(base({ closes: [100], riskSizing: vt }));
    expect(r.qty).toBe(0);
  });

  it("NaN/비정상 종가 섞여도 크래시 없이 유한 결과", () => {
    const dirty = [...lowVol.slice(0, 50), NaN, 0, -5, ...lowVol.slice(50)];
    const r = computeOrderQty(base({ closes: dirty, riskSizing: vt }));
    expect(Number.isFinite(r.qty)).toBe(true);
    expect(r.qty).toBeGreaterThanOrEqual(0);
  });

  it("lookback 지정 시 해당 봉만 사용(긴 시계열에서 최근만)", () => {
    const r = computeOrderQty(base({ closes: highVol, riskSizing: { ...vt, lookback: 20 } }));
    expect(Number.isFinite(r.qty)).toBe(true);
    expect(r.detail.mode).toBe("vol_target");
  });
});
