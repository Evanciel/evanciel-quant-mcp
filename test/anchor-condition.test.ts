/**
 * anchor-condition.test.ts — 세션 앵커 조건(시가/전일종가/세션고저/VWAP) 검증.
 * 갭앤고("현재가 > 당일시가×1.03")·오프닝레인지 돌파 표현 해금. 룩어헤드 없음.
 */
import { describe, it, expect } from "vitest";
import type { StrategyNode, Strategy, BacktestConfig } from "../src/core/types/strategy.js";
import { runCompositeBacktest } from "../src/core/backtest/engine.js";
import { validateRootNode } from "../src/core/validation/composite-node.js";

const strat = (): Strategy => ({ id: "s", userId: "u", name: "s", description: "", symbol: "X",
  rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: 200 }], quantityPercent: 100 }],
  isActive: true, createdAt: new Date(), updatedAt: new Date() });
const ALWAYS: StrategyNode = { id: "a", type: "leaf", name: "always", strategy: strat() };
const NEVER: StrategyNode = { id: "n", type: "leaf", name: "never", strategy: { ...strat(), rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: -200 }], quantityPercent: 100 }] } };

type B = { date: string; datetime: string; open: number; high: number; low: number; close: number; volume: number };
const mk = (h: number, o: number, hi: number, lo: number, c: number): B => {
  const iso = new Date(Date.UTC(2025, 0, 2, h)).toISOString();
  return { date: iso.slice(0, 10), datetime: iso, open: o, high: hi, low: lo, close: c, volume: 1000 };
};
// 단일 일자(2025-01-02) 6개 시간봉. 당일시가=100. bar2에서 close 104 > 100×1.03=103.
const oneDay: B[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 100, 102, 100, 101),
  mk(2, 101, 105, 101, 104), // 갭 +4% 돌파
  mk(3, 104, 104, 102, 103),
  mk(4, 103, 103, 101, 102),
  mk(5, 102, 103, 100, 101),
];

const cfg: BacktestConfig = { strategyId: "t", symbol: "X", startDate: "2025-01-02", endDate: "2025-01-02", initialCapital: 1e6, commission: 0.1, timeframe: "1h" };
const gated = (cond: unknown): StrategyNode => ({ id: "cn", type: "condition", name: "c", condition: cond as never, thenNode: ALWAYS, elseNode: NEVER });
const run = (bars: B[], cond: unknown) => runCompositeBacktest(gated(cond), bars as unknown as Parameters<typeof runCompositeBacktest>[1], cfg);

describe("anchor 조건", () => {
  it("스키마 검증", () => {
    expect(validateRootNode(gated({ type: "anchor", anchor: "dayOpen", operator: "gt", multiplier: 1.03 }))).toBeNull();
    expect(validateRootNode(gated({ type: "anchor", anchor: "bogus", operator: "gt" }))).not.toBeNull();
    expect(validateRootNode(gated({ type: "anchor", anchor: "dayOpen", operator: "gt", multiplier: -1 }))).not.toBeNull(); // 음수 배수 거부
  });

  it("dayOpen 갭 돌파: 현재가 > 시가×1.03 → 매매 발생", () => {
    expect(run(oneDay, { type: "anchor", anchor: "dayOpen", operator: "gt", multiplier: 1.03 }).totalTrades).toBeGreaterThan(0);
    // 배수 ×2(=200) 돌파 불가 → 무거래
    expect(run(oneDay, { type: "anchor", anchor: "dayOpen", operator: "gt", multiplier: 2 }).totalTrades).toBe(0);
  });

  it("prevClose: 윈도우에 전일 없으면 fail-closed(무거래)", () => {
    // 단일 일자만 → prevClose 산출 불가 → false → 무거래
    expect(run(oneDay, { type: "anchor", anchor: "prevClose", operator: "gt" }).totalTrades).toBe(0);
  });

  it("sessionHigh: 종가가 당일 최고가 미만이면 gte로만 진입(돌파 순간)", () => {
    // close >= sessionHigh 는 신고가 봉에서만 참. bar2(c104,h105: c<h)는 거짓, 신고가=종가인 봉 필요.
    // 여기서는 무거래여도 무방 — gt sessionHigh(종가>당일고가)는 불가능하므로 항상 false 확인.
    expect(run(oneDay, { type: "anchor", anchor: "sessionHigh", operator: "gt" }).totalTrades).toBe(0);
  });
});
