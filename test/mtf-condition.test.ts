/**
 * mtf-condition.test.ts — 멀티타임프레임(상위TF 확인) 조건. "1h 추세 + 5m 진입".
 * HTF→LTF 정렬 룩어헤드 없음 + 트리 수집 + 엔진 통합 + 미주입 fail-closed.
 */
import { describe, it, expect } from "vitest";
import type { StrategyNode, Strategy, BacktestConfig } from "../src/core/types/strategy.js";
import { runCompositeBacktest, mtfKey } from "../src/core/backtest/engine.js";
import { collectMtfConditions, alignMtfSeries, buildMtfSeries, type MtfBar } from "../src/core/strategy/mtf.js";
import { validateRootNode } from "../src/core/validation/composite-node.js";

const iso = (ms: number) => new Date(ms).toISOString();
const H = (openMs: number, c: number): MtfBar => ({ datetime: iso(openMs), open: c, high: c + 1, low: c - 1, close: c, volume: 1000 });
const HOUR = 3600000, MIN5 = 300000;
const base = Date.UTC(2025, 0, 1, 0); // 00:00

describe("alignMtfSeries (HTF→LTF, 룩어헤드 없음)", () => {
  // HTF 1h: 00:00=10, 01:00=20, 02:00=30. sma period1 → 값=종가.
  const htf = [H(base, 10), H(base + HOUR, 20), H(base + 2 * HOUR, 30)];
  // LTF 5m: 00:00 ~ 02:55 (36봉)
  const ltf = Array.from({ length: 36 }, (_, k) => H(base + k * MIN5, 100));
  const aligned = alignMtfSeries(ltf, htf, "sma", { period: 1 });

  it("HTF 봉이 닫히기 전엔 NaN(룩어헤드 차단)", () => {
    expect(Number.isNaN(aligned[0])).toBe(true);   // 00:00 — 아무 HTF도 안 닫힘
    expect(Number.isNaN(aligned[11])).toBe(true);  // 00:55
  });
  it("HTF 봉이 닫힌 직후부터 그 값 전방채움", () => {
    expect(aligned[12]).toBeCloseTo(10, 6); // 01:00 — HTF[00:00] 닫힘 → 10
    expect(aligned[23]).toBeCloseTo(10, 6); // 01:55 — 여전히 10
    expect(aligned[24]).toBeCloseTo(20, 6); // 02:00 — HTF[01:00] 닫힘 → 20
    expect(aligned[35]).toBeCloseTo(20, 6); // 02:55 — 여전히 20 (HTF[02:00]은 03:00에 닫힘=미사용)
  });
  it("HTF 빈 배열 → 전부 NaN", () => {
    expect(alignMtfSeries(ltf, [], "sma", { period: 1 }).every((x) => Number.isNaN(x))).toBe(true);
  });
});

describe("collectMtfConditions + mtfKey", () => {
  const strat: Strategy = { id: "s", userId: "u", name: "s", description: "", symbol: "X", rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: 200 }], quantityPercent: 100 }], isActive: true, createdAt: new Date(), updatedAt: new Date() };
  const leaf: StrategyNode = { id: "l", type: "leaf", name: "x", strategy: strat };
  const tree: StrategyNode = {
    id: "cn", type: "condition", name: "1h 추세",
    condition: { type: "indicator", indicator: "sma", params: { period: 50 }, operator: "gt", value: 0, timeframe: "1h" },
    thenNode: leaf,
  };
  it("timeframe 지정 지표조건 수집", () => {
    const needs = collectMtfConditions(tree);
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ timeframe: "1h", indicator: "sma" });
  });
  it("timeframe 없는 조건은 무시", () => {
    const noTf: StrategyNode = { id: "cn", type: "condition", name: "x", condition: { type: "indicator", indicator: "rsi", params: { period: 14 }, operator: "lt", value: 30 }, thenNode: leaf };
    expect(collectMtfConditions(noTf)).toHaveLength(0);
  });
  it("mtfKey 결정론적(params 순서 무관)", () => {
    expect(mtfKey("1h", "macd", { fast: 12, slow: 26 })).toBe(mtfKey("1h", "macd", { slow: 26, fast: 12 }));
  });
});

describe("엔진 통합: MTF 게이팅 + 미주입 fail-closed", () => {
  const strat = (on: boolean): Strategy => ({ id: "s", userId: "u", name: "s", description: "", symbol: "X", rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: on ? 200 : -200 }], quantityPercent: 100 }, { id: "se", action: "sell", conditions: [{ id: "c2", indicator: "rsi", params: { period: 2 }, operator: "gt", value: on ? 200 : -200 }], quantityPercent: 100 }], isActive: true, createdAt: new Date(), updatedAt: new Date() });
  const ALWAYS: StrategyNode = { id: "a", type: "leaf", name: "always", strategy: strat(true) };
  const NEVER: StrategyNode = { id: "n", type: "leaf", name: "never", strategy: strat(false) };
  // LTF 5m 48봉. HTF 1h: 앞쪽 종가 10(추세 약), 뒤쪽 30(추세 강).
  const ltf = Array.from({ length: 48 }, (_, k) => H(base + k * MIN5, 100 + Math.sin(k / 4)));
  const htf = Array.from({ length: 5 }, (_, k) => H(base + k * HOUR, k < 2 ? 10 : 30)); // 02:00부터 30
  const cond = { type: "indicator" as const, indicator: "sma" as const, params: { period: 1 }, operator: "gt" as const, value: 15, timeframe: "1h" };
  const gated: StrategyNode = { id: "cn", type: "condition", name: "1h sma>15", condition: cond as never, thenNode: ALWAYS, elseNode: NEVER };
  const cfg = (mtf?: Record<string, number[]>): BacktestConfig => ({ strategyId: "t", symbol: "X", startDate: ltf[0].datetime.slice(0, 10), endDate: ltf[47].datetime.slice(0, 10), initialCapital: 1e6, commission: 0.1, timeframe: "5m", mtfSeries: mtf });

  it("스키마: timeframe 지정 조건 검증 통과", () => {
    expect(validateRootNode(gated)).toBeNull();
  });
  it("MTF 주입 시: 상위TF sma>15(=30) 구간에서만 매매", async () => {
    const needs = collectMtfConditions(gated);
    const mtf = await buildMtfSeries(ltf, needs, async (tf) => (tf === "1h" ? htf : []));
    const withMtf = runCompositeBacktest(gated, ltf as unknown as Parameters<typeof runCompositeBacktest>[1], cfg(mtf));
    expect(withMtf.totalTrades).toBeGreaterThan(0); // 03:00+ 구간(HTF=30>15)에서 거래
  });
  it("MTF 미주입 시: fail-closed(무거래)", () => {
    const noMtf = runCompositeBacktest(gated, ltf as unknown as Parameters<typeof runCompositeBacktest>[1], cfg(undefined));
    expect(noMtf.totalTrades).toBe(0);
  });
});
