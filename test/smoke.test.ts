/**
 * smoke.test.ts — 추출된 코어가 stock-autotrade 없이 독립으로 "실제로 도는지" 검증.
 * 타입 통과(tsc)뿐 아니라 엔진/검증/리스크/파생/DSR 함수가 합성 데이터로 동작함을 확인.
 * 네트워크 0 (Binance fetch 미호출). backtest≡live 의 공용 순수함수만 사용.
 */
import { describe, it, expect } from "vitest";
import type { StrategyNode, BacktestConfig, Strategy } from "../src/core/types/strategy";
import { runCompositeBacktest } from "../src/core/backtest/engine";
import { runShortBacktest } from "../src/core/backtest/short-engine";
import { validateRootNode } from "../src/core/validation/composite-node";
import { probabilisticSharpe, deflatedSharpe } from "../src/core/backtest/deflated-sharpe";
import { computeRegime } from "../src/core/backtest/regime";
import { computePositionSize } from "../src/core/risk/sizing";
import { evaluatePortfolioRisk } from "../src/core/risk/portfolio";
import { summarizeDerivatives } from "../src/core/signals/derivatives";

// ── 합성 OHLCV (진동 + 상승) ──
function genData(n: number, start = 100) {
  const data = [];
  for (let i = 0; i < n; i++) {
    const price = start + Math.sin(i / 10) * 5 + i * 0.1;
    data.push({
      date: new Date(2025, 0, i + 1).toISOString().slice(0, 10),
      open: price - 1, high: price + 2, low: price - 2, close: price, volume: 1000 + (i % 7) * 50,
    });
  }
  return data;
}

const rsiStrategy: Strategy = {
  id: "s", userId: "u", name: "RSI", description: "", symbol: "BTCUSDT",
  rules: [
    { id: "buy", action: "buy", conditions: [{ id: "c1", indicator: "rsi", params: { period: 14 }, operator: "lt", value: 40 }], quantityPercent: 80 },
    { id: "sell", action: "sell", conditions: [{ id: "c2", indicator: "rsi", params: { period: 14 }, operator: "gt", value: 60 }], quantityPercent: 100 },
  ],
  stopLossPercent: 10, takeProfitPercent: 20, isActive: true, createdAt: new Date("2025-01-01"), updatedAt: new Date("2025-01-01"),
};

const leafNode: StrategyNode = { id: "leaf", type: "leaf", name: "Simple", strategy: rsiStrategy };
const config: BacktestConfig = { strategyId: "t", symbol: "BTCUSDT", startDate: "2025-01-01", endDate: "2025-07-01", initialCapital: 1_000_000, commission: 0.1, timeframe: "1d" };

describe("quant-mcp core — standalone execution", () => {
  it("validateRootNode accepts a well-formed tree", () => {
    expect(validateRootNode(leafNode)).toBeNull();
  });

  it("validateRootNode rejects a malformed tree (loud reject)", () => {
    const broken = { id: "x", type: "leaf", name: "bad" }; // strategy 누락
    expect(validateRootNode(broken)).not.toBeNull();
  });

  it("runCompositeBacktest produces a full equity curve + finite stats", () => {
    const data = genData(120);
    const r = runCompositeBacktest(leafNode, data, config);
    expect(r.equityCurve).toHaveLength(120);
    expect(Number.isFinite(r.totalReturnPercent)).toBe(true);
    expect(Number.isFinite(r.sharpeRatio)).toBe(true);
    expect(Number.isFinite(r.maxDrawdown)).toBe(true);
  });

  it("runShortBacktest runs (sell=open short, buy=cover)", () => {
    const data = genData(120);
    const r = runShortBacktest(leafNode, data, config, { stopLossPercent: 5, trailingStopPercent: 3 });
    expect(r.equityCurve.length).toBeGreaterThan(0);
    expect(Number.isFinite(r.totalReturnPercent)).toBe(true);
  });

  it("DSR/PSR math is finite and in [0,1]", () => {
    const psr = probabilisticSharpe(1.2, 252, 0, 3, 0);
    expect(psr).toBeGreaterThanOrEqual(0);
    expect(psr).toBeLessThanOrEqual(1);
    const { dsr, sr0, psr: dsrPsr } = deflatedSharpe({ srHat: 1.2, n: 252, varSR: 0.5, nTrials: 50 });
    expect(Number.isFinite(dsr)).toBe(true);
    expect(Number.isFinite(sr0)).toBe(true);
    expect(dsr).toBeGreaterThanOrEqual(0);
    expect(dsr).toBeLessThanOrEqual(dsrPsr + 1e-9); // DSR ≤ PSR (다중검정 보정은 항상 더 보수적)
  });

  it("computeRegime classifies into a known label", () => {
    const data = genData(80);
    const reg = computeRegime(data.map((d) => d.close), data.map((d) => d.high), data.map((d) => d.low));
    expect(["trend_up", "trend_down", "range", "high_vol"]).toContain(reg.label);
  });

  it("computePositionSize (ATR) yields a non-negative notional", () => {
    const s = computePositionSize({ method: "atr", equity: 100_000, price: 64_000, atr: 1_200, atrMult: 2, riskPct: 1 });
    expect(s.notional).toBeGreaterThanOrEqual(0);
    expect(s.method).toBe("atr");
  });

  it("evaluatePortfolioRisk computes heat + circuit state", () => {
    const pr = evaluatePortfolioRisk({
      positions: [{ symbol: "BTCUSDT", riskFraction: 0.05 }, { symbol: "ETHUSDT", riskFraction: 0.04 }],
      equity: 95_000, peakEquity: 100_000,
    });
    expect(Number.isFinite(pr.heat)).toBe(true);
    expect(typeof pr.allowNewEntry).toBe("boolean");
  });

  it("summarizeDerivatives tolerates partial input (degrade, not throw)", () => {
    const d = summarizeDerivatives({ symbol: "BTCUSDT", intervalHours: 8, fundingRate: 0.0001, oiNow: 1e9, oiThen: 9e8, priceNow: 64000, priceThen: 63000 });
    expect(d.symbol).toBe("BTCUSDT");
    expect(Array.isArray(d.warnings)).toBe(true);
  });
});
