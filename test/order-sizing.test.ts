/**
 * order-sizing.test.ts — computeOrderQty 순수 검증(L1). Design §7.
 */
import { describe, it, expect } from "vitest";
import { computeOrderQty, type OrderQtyInput } from "../src/core/risk/order-sizing.js";
import { floorQty } from "../src/core/position/qty.js";
import { computePositionSize } from "../src/core/risk/sizing.js";

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

// ── ATR 모드 ──
// 상수 레인지 봉: close=100, high=101, low=99 → 모든 TR=2 → ATR(period)=2(정확).
const flatCloses = Array.from({ length: 60 }, () => 100);
const flatHighs = flatCloses.map((c) => c + 1);
const flatLows = flatCloses.map((c) => c - 1);

describe("computeOrderQty — atr", () => {
  const atrCfg = { method: "atr" as const, riskPct: 0.01, atrMult: 2, atrPeriod: 14 };

  it("computeAtrSize 공식 동치: units=(equity×riskPct)/(ATR×atrMult), notional 캡, floorQty(notional/px)", () => {
    const r = computeOrderQty(base({ equity: 10000, price: 100, closes: flatCloses, highs: flatHighs, lows: flatLows, riskSizing: atrCfg }));
    // 동일 입력으로 computePositionSize 직접 호출(ATR=2 알려짐) → notional/qty 동치 증명.
    const direct = computePositionSize({ method: "atr", equity: 10000, price: 100, riskPct: 0.01, atr: 2, atrMult: 2 });
    const px = 100 * 1.001;
    expect(r.detail.mode).toBe("atr");
    expect(r.detail.atr).toBe(2);
    expect(r.notional).toBe(direct.notional);
    expect(r.qty).toBe(floorQty(direct.notional / px));
    expect(r.qty).toBeGreaterThan(0);
  });

  it("notional은 equity를 넘지 않음(현물 무레버리지 캡)", () => {
    // riskPct 큼 + ATR 작음 → 원래 notional이 equity 초과하려 함 → 캡 발동.
    const big = computeOrderQty(base({ equity: 10000, price: 100, closes: flatCloses, highs: flatHighs, lows: flatLows, riskSizing: { method: "atr", riskPct: 0.5, atrMult: 1 } }));
    expect(big.notional).toBeLessThanOrEqual(10000 + 1e-6);
  });

  it("riskPct 증가 → 수량 증가(단조), 단 캡 이내", () => {
    const small = computeOrderQty(base({ equity: 10000, price: 100, closes: flatCloses, highs: flatHighs, lows: flatLows, riskSizing: { method: "atr", riskPct: 0.005, atrMult: 2 } }));
    const large = computeOrderQty(base({ equity: 10000, price: 100, closes: flatCloses, highs: flatHighs, lows: flatLows, riskSizing: { method: "atr", riskPct: 0.02, atrMult: 2 } }));
    expect(large.qty).toBeGreaterThan(small.qty);
  });

  it("highs/lows 미제공 → ATR 산출 불가 → fixed(riskPct) 안전 폴백(노출 0 아님)", () => {
    const r = computeOrderQty(base({ equity: 10000, price: 100, closes: flatCloses, riskSizing: atrCfg }));
    // computePositionSize atr 분기: price>0이지만 atr=0 → fixed(riskPct). notional=equity×riskPct.
    const px = 100 * 1.001;
    expect(r.detail.mode).toBe("atr");
    expect(r.detail.atr).toBe(0);
    expect(r.qty).toBe(floorQty((10000 * 0.01) / px));
    expect(r.qty).toBeGreaterThan(0);
  });

  it("equity/price≤0 → qty 0 (예외 없음)", () => {
    expect(computeOrderQty(base({ equity: 0, closes: flatCloses, highs: flatHighs, lows: flatLows, riskSizing: atrCfg })).qty).toBe(0);
    expect(computeOrderQty(base({ price: 0, closes: flatCloses, highs: flatHighs, lows: flatLows, riskSizing: atrCfg })).qty).toBe(0);
  });
});

// ── Kelly 모드 ──
describe("computeOrderQty — kelly", () => {
  it("fractional Kelly 공식 동치: f=winRate−(1−winRate)/b, ×fraction, cap → notional=equity×f", () => {
    // winRate=0.6, b=avgWin/avgLoss=2 → fFull=0.6−0.4/2=0.4 → Half-Kelly 0.2 (≤cap 0.25).
    const cfg = { method: "kelly" as const, winRate: 0.6, avgWin: 2, avgLoss: 1, fraction: 0.5, sampleSize: 200 };
    const r = computeOrderQty(base({ equity: 10000, price: 100, riskSizing: cfg }));
    const direct = computePositionSize({ method: "kelly", equity: 10000, price: 100, winRate: 0.6, avgWin: 2, avgLoss: 1, kellyFraction: 0.5, sampleSize: 200 });
    const px = 100 * 1.001;
    expect(r.detail.mode).toBe("kelly");
    expect(r.detail.kellyFraction).toBeCloseTo(0.2, 9);
    expect(r.notional).toBe(direct.notional);
    expect(r.qty).toBe(floorQty(direct.notional / px));
  });

  it("표본 부족(sampleSize<minSample 100) → fallbackRiskPct(0.01) 폴백", () => {
    const cfg = { method: "kelly" as const, winRate: 0.9, avgWin: 5, avgLoss: 1, fraction: 0.5, sampleSize: 10 };
    const r = computeOrderQty(base({ equity: 10000, price: 100, riskSizing: cfg }));
    const px = 100 * 1.001;
    expect(r.detail.usedFallback).toBe(true);
    expect(r.qty).toBe(floorQty((10000 * 0.01) / px)); // fallback 1%
  });

  it("capFraction(25%) 내부 상한 — 고엣지에서도 notional≤equity×0.25", () => {
    // winRate=0.9, b=10 → fFull=0.9−0.1/10=0.89; full Kelly(fraction=1) → cap 0.25.
    const cfg = { method: "kelly" as const, winRate: 0.9, avgWin: 10, avgLoss: 1, fraction: 1, sampleSize: 500 };
    const r = computeOrderQty(base({ equity: 10000, price: 100, riskSizing: cfg }));
    expect(r.detail.kellyFraction).toBeCloseTo(0.25, 9);
    expect(r.notional).toBeLessThanOrEqual(10000 * 0.25 + 1e-6);
  });

  it("음의 엣지(winRate 낮음) → fraction 0 → qty 0(베팅 안 함)", () => {
    // winRate=0.3, b=1 → fFull=0.3−0.7/1=−0.4 → max(0,...)=0.
    const cfg = { method: "kelly" as const, winRate: 0.3, avgWin: 1, avgLoss: 1, fraction: 0.5, sampleSize: 300 };
    const r = computeOrderQty(base({ equity: 10000, price: 100, riskSizing: cfg }));
    expect(r.qty).toBe(0);
  });
});

// ── 회귀 가드: highs/lows + 유니언 확장 후에도 legacy/vol_target 결과 불변(바이트 동일) ──
describe("computeOrderQty — 회귀(legacy/vol_target 불변)", () => {
  it("legacy: highs/lows 동반 제공해도 결과 동일(ATR 외 모드는 무시)", () => {
    const without = computeOrderQty(base({ equity: 10000, price: 100, legacyQuantityPercent: 70 }));
    const withHL = computeOrderQty(base({ equity: 10000, price: 100, legacyQuantityPercent: 70, highs: flatHighs, lows: flatLows }));
    expect(withHL.qty).toBe(without.qty);
    expect(withHL.notional).toBe(without.notional);
    expect(withHL.detail.mode).toBe("legacy");
  });

  it("vol_target: highs/lows 동반 제공해도 결과 동일(ATR 외 모드는 무시)", () => {
    const vt = { method: "vol_target" as const, targetVolAnnual: 0.2, leverageCap: 1.0 };
    const without = computeOrderQty(base({ closes: highVol, riskSizing: vt }));
    const withHL = computeOrderQty(base({ closes: highVol, riskSizing: vt, highs: highVol.map((c) => c * 1.01), lows: highVol.map((c) => c * 0.99) }));
    expect(withHL.qty).toBe(without.qty);
    expect(withHL.notional).toBe(without.notional);
  });
});
