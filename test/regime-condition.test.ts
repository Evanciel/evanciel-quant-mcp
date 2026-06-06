/**
 * regime-condition.test.ts — 레짐 조건(trend/range/high_vol) 트리 게이팅 검증.
 * computeRegime 재사용(순수함수 → backtest≡live). "추세장에서만 매매" 표현 해금.
 */
import { describe, it, expect } from "vitest";
import type { StrategyNode, Strategy, BacktestConfig } from "../src/core/types/strategy.js";
import { runCompositeBacktest } from "../src/core/backtest/engine.js";
import { validateRootNode } from "../src/core/validation/composite-node.js";
import { computeRegime } from "../src/core/backtest/regime.js";

const strat = (buyVal: number): Strategy => ({ id: "s", userId: "u", name: "s", description: "", symbol: "X",
  rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: buyVal }], quantityPercent: 100 }],
  isActive: true, createdAt: new Date(), updatedAt: new Date() });
const ALWAYS: StrategyNode = { id: "a", type: "leaf", name: "always", strategy: strat(200) }; // rsi<200 항상참→매수
const NEVER: StrategyNode = { id: "n", type: "leaf", name: "never", strategy: strat(-200) };

// 강한 상승추세 120봉 (ER≈1, ADX↑, slope up → trend_up)
const bar = (i: number, c: number) => ({ date: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10), open: c, high: c + 1, low: c - 1, close: c, volume: 1000 });
const trendBars = Array.from({ length: 120 }, (_, i) => bar(i, 100 + i * 2));
// 횡보(choppy): 매 봉 등락 반복(지그재그) → 순변화≈0, |변화|합 큼 → ER≈0, ADX↓ → range
const rangeBars = Array.from({ length: 120 }, (_, i) => bar(i, 100 + (i % 2) * 2));

const cfg = (bars: ReturnType<typeof bar>[]): BacktestConfig => ({ strategyId: "t", symbol: "X", startDate: bars[0].date, endDate: bars[bars.length - 1].date, initialCapital: 1e6, commission: 0.1, timeframe: "1d" });
const gated = (cond: unknown): StrategyNode => ({ id: "cn", type: "condition", name: "c", condition: cond as never, thenNode: ALWAYS, elseNode: NEVER });
const run = (bars: ReturnType<typeof bar>[], cond: unknown) => runCompositeBacktest(gated(cond), bars as unknown as Parameters<typeof runCompositeBacktest>[1], cfg(bars));

describe("regime 조건", () => {
  it("스키마 검증: in 화이트리스트", () => {
    expect(validateRootNode(gated({ type: "regime", in: ["trend_up", "high_vol"] }))).toBeNull();
    expect(validateRootNode(gated({ type: "regime", in: [] }))).not.toBeNull(); // 최소 1개
    expect(validateRootNode(gated({ type: "regime", in: ["bogus"] }))).not.toBeNull();
  });

  it("computeRegime: 강추세=trend_up, 횡보=range", () => {
    const c = trendBars.map((b) => b.close), h = trendBars.map((b) => b.high), l = trendBars.map((b) => b.low);
    expect(computeRegime(c, h, l).label).toBe("trend_up");
    const rc = rangeBars.map((b) => b.close), rh = rangeBars.map((b) => b.high), rl = rangeBars.map((b) => b.low);
    expect(computeRegime(rc, rh, rl).label).toBe("range");
  });

  it("게이팅: trend_up 요구 시 추세장에서만 매매", () => {
    expect(run(trendBars, { type: "regime", in: ["trend_up"] }).totalTrades).toBeGreaterThan(0);
    expect(run(rangeBars, { type: "regime", in: ["trend_up"] }).totalTrades).toBe(0);
  });
});
