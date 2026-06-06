/**
 * spread-condition.test.ts — 스프레드(페어/스탯아브) 조건 검증. A=봇심볼, B=auxSeries 주입.
 * ratio/diffPct/zscore. B 부재 시 fail-closed(무거래). backtest≡live(러너가 동일 auxSeries 주입).
 */
import { describe, it, expect } from "vitest";
import type { StrategyNode, Strategy, BacktestConfig } from "../src/core/types/strategy.js";
import { runCompositeBacktest } from "../src/core/backtest/engine.js";
import { validateRootNode } from "../src/core/validation/composite-node.js";

const strat = (on: boolean): Strategy => ({ id: "s", userId: "u", name: "s", description: "", symbol: "A",
  rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: on ? 200 : -200 }], quantityPercent: 100 }],
  isActive: true, createdAt: new Date(), updatedAt: new Date() });
const ALWAYS: StrategyNode = { id: "a", type: "leaf", name: "always", strategy: strat(true) };
const NEVER: StrategyNode = { id: "n", type: "leaf", name: "never", strategy: strat(false) };

const N = 60;
// A 종가: 100→160 상승. B 종가: 200 고정. ratio = A/B = 0.5→0.8.
const aClose = Array.from({ length: N }, (_, i) => 100 + i);
const bClose = Array.from({ length: N }, () => 200);
const bars = aClose.map((c, i) => ({ date: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10), open: c, high: c + 1, low: c - 1, close: c, volume: 1000 }));

const cfg = (aux?: Record<string, number[]>): BacktestConfig => ({ strategyId: "t", symbol: "A", startDate: bars[0].date, endDate: bars[N - 1].date, initialCapital: 1e6, commission: 0.1, timeframe: "1d", auxSeries: aux });
const gated = (cond: unknown): StrategyNode => ({ id: "cn", type: "condition", name: "c", condition: cond as never, thenNode: ALWAYS, elseNode: NEVER });
const run = (cond: unknown, aux?: Record<string, number[]>) => runCompositeBacktest(gated(cond), bars as unknown as Parameters<typeof runCompositeBacktest>[1], cfg(aux), 0);

describe("spread 조건", () => {
  it("스키마 검증", () => {
    expect(validateRootNode(gated({ type: "spread", symbolB: "B", expr: "ratio", operator: "gt", value: 0.7 }))).toBeNull();
    expect(validateRootNode(gated({ type: "spread", symbolB: "", expr: "ratio", operator: "gt", value: 1 }))).not.toBeNull(); // symbolB 필수
    expect(validateRootNode(gated({ type: "spread", symbolB: "B", expr: "zscore", lookback: 1, operator: "gt", value: 1 }))).not.toBeNull(); // lookback≥2
  });

  it("ratio: A/B > 0.7 일 때만 매매 (A=140부터)", () => {
    // ratio 0.7 = A 140. A는 100..159 → 140 이상 구간에서 진입.
    expect(run({ type: "spread", symbolB: "B", expr: "ratio", operator: "gt", value: 0.7 }, { B: bClose }).totalTrades).toBeGreaterThan(0);
    // 불가능한 임계(ratio>5) → 무거래
    expect(run({ type: "spread", symbolB: "B", expr: "ratio", operator: "gt", value: 5 }, { B: bClose }).totalTrades).toBe(0);
  });

  it("diffPct: (A/B−1)×100", () => {
    // A/B at end = 159/200 = 0.795 → diffPct = -20.5%. > -30 참(후반). > 50 거짓.
    expect(run({ type: "spread", symbolB: "B", expr: "diffPct", operator: "gt", value: -30 }, { B: bClose }).totalTrades).toBeGreaterThan(0);
    expect(run({ type: "spread", symbolB: "B", expr: "diffPct", operator: "gt", value: 50 }, { B: bClose }).totalTrades).toBe(0);
  });

  it("B 부재/미정렬 시 fail-closed(무거래)", () => {
    expect(run({ type: "spread", symbolB: "B", expr: "ratio", operator: "gt", value: 0.1 }).totalTrades).toBe(0); // aux 없음
    expect(run({ type: "spread", symbolB: "B", expr: "ratio", operator: "gt", value: 0.1 }, { B: [1, 2, 3] }).totalTrades).toBe(0); // 길이 불일치
  });

  it("zscore: 추세 스프레드는 후반에 양의 z (lookback 윈도우)", () => {
    // ratio 단조증가 → 현재가 윈도우 평균보다 위 → zscore>0. > 0.5 후반 참, > 100 거짓.
    expect(run({ type: "spread", symbolB: "B", expr: "zscore", lookback: 10, operator: "gt", value: 0.5 }, { B: bClose }).totalTrades).toBeGreaterThan(0);
    expect(run({ type: "spread", symbolB: "B", expr: "zscore", lookback: 10, operator: "gt", value: 100 }, { B: bClose }).totalTrades).toBe(0);
  });
});
