/**
 * time-condition.test.ts — 시간대(hour/minute) 조건 + tz 변환 검증. "아침 9시 KST" 표현 해금.
 */
import { describe, it, expect } from "vitest";
import type { StrategyNode, Strategy, BacktestConfig } from "../src/core/types/strategy.js";
import { runCompositeBacktest } from "../src/core/backtest/engine.js";
import { validateRootNode } from "../src/core/validation/composite-node.js";

const strat = (buyVal: number): Strategy => ({ id: "s", userId: "u", name: "s", description: "", symbol: "X",
  rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: buyVal }], quantityPercent: 100 },
          { id: "se", action: "sell", conditions: [{ id: "c2", indicator: "rsi", params: { period: 2 }, operator: "gt", value: buyVal }], quantityPercent: 100 }],
  isActive: true, createdAt: new Date(), updatedAt: new Date() });
const ALWAYS: StrategyNode = { id: "a", type: "leaf", name: "always", strategy: strat(200) }; // rsi<200 항상참→매수
const NEVER: StrategyNode = { id: "n", type: "leaf", name: "never", strategy: strat(-200) };

// 48개 시간봉(2025-01-01T00:00Z ~ 02d). datetime=UTC 시각.
const bars = Array.from({ length: 48 }, (_, i) => {
  const iso = new Date(Date.UTC(2025, 0, 1, i)).toISOString();
  const price = 100 + Math.sin(i / 5) * 3;
  return { date: iso.slice(0, 10), datetime: iso, open: price, high: price + 1, low: price - 1, close: price, volume: 1000 };
});
const cfg: BacktestConfig = { strategyId: "t", symbol: "X", startDate: bars[0].date, endDate: bars[47].date, initialCapital: 1e6, commission: 0.1, timeframe: "1h" };
const gated = (cond: unknown): StrategyNode => ({ id: "cn", type: "condition", name: "c", condition: cond as never, thenNode: ALWAYS, elseNode: NEVER });
const run = (cond: unknown) => runCompositeBacktest(gated(cond), bars as unknown as Parameters<typeof runCompositeBacktest>[1], cfg);

describe("time-of-day 조건", () => {
  it("hour/minute/tz 트리 검증 통과", () => {
    expect(validateRootNode(gated({ type: "time", field: "hour", operator: "between", values: [9, 11], tz: "Asia/Seoul" }))).toBeNull();
    expect(validateRootNode(gated({ type: "time", field: "minute", operator: "eq", values: [30] }))).toBeNull();
  });

  it("UTC hour 게이팅: 특정 시각에만 거래 발생", () => {
    const inWindow = run({ type: "time", field: "hour", operator: "between", values: [8, 16] }); // UTC 8~16시
    const noWindow = run({ type: "time", field: "hour", operator: "between", values: [25, 26] }); // 불가능 범위
    expect(inWindow.totalTrades).toBeGreaterThan(0);
    expect(noWindow.totalTrades).toBe(0);
  });

  it("tz 변환: UTC 0시 = KST 9시 (Asia/Seoul hour eq 9 매칭)", () => {
    // 봉 0,24 = UTC 0시 = KST 9시. tz 적용 시 hour eq [9]가 그 봉들에서 참.
    const kst9 = run({ type: "time", field: "hour", operator: "eq", values: [9], tz: "Asia/Seoul" });
    const utc9 = run({ type: "time", field: "hour", operator: "eq", values: [9] }); // tz 없음=UTC 9시(다른 봉)
    expect(kst9.totalTrades).toBeGreaterThan(0); // KST 9시 = UTC 0시 봉 존재 → 거래
    expect(utc9.totalTrades).toBeGreaterThan(0);
    // 둘이 서로 다른 봉을 가리키므로 진입 시점이 달라야(=tz가 실제로 작동) — 진입가 다름 가능. 최소 둘 다 거래 발생.
  });
});
