/**
 * qty-fractional.test.ts — 크립토 분수 수량(정수 floor 버그 수정) 회귀 잠금.
 * 과거: 엔진이 Math.floor(자본/가격) → BTC(6만) 소액자본=floor(0.0158)=0 → 무거래(신호 소실).
 * 이제 floorQty(8자리)로 분수 허용.
 */
import { describe, it, expect } from "vitest";
import { floorQty } from "../src/core/position/qty.js";
import { runCompositeBacktest } from "../src/core/backtest/engine.js";
import type { StrategyNode, Strategy, BacktestConfig } from "../src/core/types/strategy.js";

describe("floorQty", () => {
  it("8자리 내림 + 분수 허용", () => {
    expect(floorQty(0.015873256)).toBeCloseTo(0.01587325, 8);
    expect(floorQty(15.5)).toBe(15.5);
    expect(floorQty(100)).toBe(100);
  });
  it("0/음수/비유한 → 0", () => {
    expect(floorQty(0)).toBe(0);
    expect(floorQty(-1)).toBe(0);
    expect(floorQty(NaN)).toBe(0);
    expect(floorQty(Infinity)).toBe(0);
  });
});

describe("고가 코인 소액 자본 사이징(분수)", () => {
  const strat: Strategy = { id: "s", userId: "u", name: "s", description: "", symbol: "BTCUSDT",
    rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: 200 }], quantityPercent: 100 }],
    isActive: true, createdAt: new Date(), updatedAt: new Date() };
  const node: StrategyNode = { id: "l", type: "leaf", name: "buy", strategy: strat };
  // 가격 60000, 자본 1000 → 정수 floor면 0(무거래), 분수면 ~0.0166
  const bars = Array.from({ length: 40 }, (_, i) => ({ date: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10), open: 60000, high: 60100, low: 59900, close: 60000, volume: 1000 }));
  const cfg: BacktestConfig = { strategyId: "t", symbol: "BTCUSDT", startDate: bars[0].date, endDate: bars[39].date, initialCapital: 1000, commission: 0.1, timeframe: "1d" };

  it("자본 1000으로 BTC(6만) 매수: 분수 수량으로 체결(이전엔 floor→0 무거래)", () => {
    const res = runCompositeBacktest(node, bars as unknown as Parameters<typeof runCompositeBacktest>[1], cfg);
    expect(res.totalTrades).toBeGreaterThan(0); // 거래 발생(이전엔 0)
    const buy = res.trades.find((t) => t.action === "buy")!;
    expect(buy.quantity).toBeGreaterThan(0);
    expect(buy.quantity).toBeLessThan(1); // 분수(< 1 BTC)
    expect(buy.quantity).toBeCloseTo(1000 / 60000, 2); // ≈0.0166 (자본/가격, 슬리피지·수수료 소액 무시)
  });
});
