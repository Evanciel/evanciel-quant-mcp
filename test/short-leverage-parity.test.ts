/**
 * short-leverage-parity.test.ts — 선물 숏 백테스트의 레버리지 사이징 패리티 + 노레버 회귀.
 *
 * 불변식:
 *  ① 노레버(leverage 미지정/≤1): 진입 qty가 기존 공식 floorQty(capital/entryPrice) **바이트 동일**(회귀 0).
 *  ② backtest≡live: leverage>1 진입 qty == computeOrderQty(선물 경로, 동일 입력) → 단일 사이징 소스.
 *  ③ 레버리지 효과: 명목 qty가 ~leverage배(노출 확대). 청산가는 short.ts(shortLiquidationPrice)가 강제.
 */
import { describe, it, expect } from "vitest";
import type { StrategyNode, Strategy, BacktestConfig } from "../src/core/types/strategy.js";
import { runShortBacktest } from "../src/core/backtest/short-engine.js";
import { computeOrderQty } from "../src/core/risk/order-sizing.js";
import { floorQty } from "../src/core/position/qty.js";

// "항상 약세" 단일 leaf: sell 룰(숏 진입)만, buy 룰 없음 → 첫 가능 봉에서 숏 진입(커버 없음).
const strat = (): Strategy => ({
  id: "s", userId: "u", name: "s", description: "", symbol: "X",
  rules: [{ id: "sell", action: "sell", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: 200 }], quantityPercent: 100 }],
  isActive: true, createdAt: new Date(), updatedAt: new Date(),
});
const leaf: StrategyNode = { id: "a", type: "leaf", name: "always-short", strategy: strat() };

type B = { date: string; datetime: string; open: number; high: number; low: number; close: number; volume: number };
// 30봉 ±2% 진동(고유 date). 숏 진입은 슬리피지 불리가(entryPrice=price×(1−slip)).
const bars: B[] = Array.from({ length: 30 }, (_, i) => {
  const iso = new Date(Date.UTC(2025, 0, 1 + i)).toISOString();
  const c = 100 * (1 + (i % 2 ? 0.02 : -0.02));
  return { date: iso.slice(0, 10), datetime: iso, open: c, high: c * 1.005, low: c * 0.995, close: c, volume: 1000 };
});

const cfg = (): BacktestConfig => ({
  strategyId: "t", symbol: "X", startDate: bars[0].date, endDate: bars[bars.length - 1].date,
  initialCapital: 100_000, commission: 0.1, slippage: 0.05, timeframe: "1h",
});
type ShortRisk = Parameters<typeof runShortBacktest>[3];
const run = (risk?: ShortRisk) => runShortBacktest(leaf, bars as unknown as Parameters<typeof runShortBacktest>[1], cfg(), risk);

describe("숏 레버리지 — 노레버 회귀(바이트 동일)", () => {
  it("leverage 미지정 → 진입 qty == floorQty(capital/entryPrice) (기존 공식)", () => {
    const entry = run({}).trades.find((t) => t.action === "sell")!;
    expect(entry).toBeTruthy();
    // 숏 엔진은 노레버 진입 시 수수료 미반영 floorQty(capital/entryPrice) 사용(기존 동작).
    const expected = floorQty(100_000 / entry.price);
    expect(entry.quantity).toBe(expected);
  });

  it("leverage=1 == 노레버 (명시 1배는 무레버리지와 동일)", () => {
    const a = run({}).trades.find((t) => t.action === "sell")!;
    const b = run({ leverage: 1 }).trades.find((t) => t.action === "sell")!;
    expect(b.quantity).toBe(a.quantity);
  });
});

describe("숏 레버리지 — backtest≡live(computeOrderQty 동치) + 노출 확대", () => {
  it("leverage=5 진입 qty == computeOrderQty(선물 경로, 동일 입력)", () => {
    const entry = run({ leverage: 5 }).trades.find((t) => t.action === "sell")!;
    expect(entry).toBeTruthy();
    // 엔진은 진입 봉의 entryPrice로 computeOrderQty(market=futures, leverage=5) 호출. 동일 입력 재현 → 동일 qty.
    const idx = bars.findIndex((b) => b.date === entry.date);
    expect(idx).toBeGreaterThanOrEqual(0);
    const direct = computeOrderQty({
      equity: 100_000, price: entry.price, commissionPct: 0.1,
      closes: bars.map((b) => b.close).slice(0, idx + 1), timeframe: "1h",
      legacyQuantityPercent: 100, riskSizing: null, market: "futures", leverage: 5,
    }).qty;
    expect(direct).toBeGreaterThan(0);
    expect(entry.quantity).toBe(direct);
  });

  it("레버리지 진입 명목 > 노레버 명목 (노출 확대, ~leverage배)", () => {
    const noLev = run({}).trades.find((t) => t.action === "sell")!;
    const lev3 = run({ leverage: 3 }).trades.find((t) => t.action === "sell")!;
    // 명목 = qty × entryPrice. 레버리지 명목이 노레버의 ~3배(floor 단위 오차 허용).
    const noLevNotional = noLev.quantity * noLev.price;
    const lev3Notional = lev3.quantity * lev3.price;
    expect(lev3Notional).toBeGreaterThan(noLevNotional * 2.5);
    expect(lev3Notional).toBeLessThanOrEqual(noLevNotional * 3 + lev3.price); // 캡 + floor 오차
  });

  it("과도 레버리지(maxLeverage 클램프) — DoS/파산 방지", () => {
    const r = run({ leverage: 1000, maxLeverage: 10 });
    const entry = r.trades.find((t) => t.action === "sell")!;
    // clamp 10배: 명목 ≈ capital×10 (floor 전 정확히는 computeOrderQty가 캡).
    const direct = computeOrderQty({
      equity: 100_000, price: entry.price, commissionPct: 0.1,
      closes: [entry.price], timeframe: "1h", legacyQuantityPercent: 100, riskSizing: null,
      market: "futures", leverage: 1000, maxLeverage: 10,
    });
    expect(direct.detail.futuresLeverage).toBe(10);
    expect(entry.quantity).toBe(direct.qty);
  });
});
