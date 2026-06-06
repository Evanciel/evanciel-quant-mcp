/**
 * event-condition.test.ts — 이벤트(캘린더) 조건. "FOMC 2시간 전 청산"·"실적 직후 변동성 매매".
 * 인라인 times(자기완결) + 명명 캘린더(FOMC 주입) + 회피(elseNode) + 검증.
 */
import { describe, it, expect } from "vitest";
import type { StrategyNode, Strategy, BacktestConfig } from "../src/core/types/strategy.js";
import { runCompositeBacktest } from "../src/core/backtest/engine.js";
import { validateRootNode } from "../src/core/validation/composite-node.js";
import { collectEventCalendars, buildEventCalendars, FOMC } from "../src/core/calendar/calendars.js";

const strat = (on: boolean): Strategy => ({ id: "s", userId: "u", name: "s", description: "", symbol: "X",
  rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: on ? 200 : -200 }], quantityPercent: 100 },
          { id: "se", action: "sell", conditions: [{ id: "c2", indicator: "rsi", params: { period: 2 }, operator: "gt", value: on ? 200 : -200 }], quantityPercent: 100 }],
  isActive: true, createdAt: new Date(), updatedAt: new Date() });
const ALWAYS: StrategyNode = { id: "a", type: "leaf", name: "always", strategy: strat(true) };
const NEVER: StrategyNode = { id: "n", type: "leaf", name: "never", strategy: strat(false) };

// 시간봉 N개(주어진 시작 epoch부터 1h 간격)
const barsFrom = (startMs: number, n: number) => Array.from({ length: n }, (_, i) => {
  const iso = new Date(startMs + i * 3600000).toISOString();
  const price = 100 + Math.sin(i / 4) * 2;
  return { date: iso.slice(0, 10), datetime: iso, open: price, high: price + 1, low: price - 1, close: price, volume: 1000 };
});

const gated = (cond: unknown, thenN: StrategyNode = ALWAYS, elseN: StrategyNode = NEVER): StrategyNode =>
  ({ id: "cn", type: "condition", name: "ev", condition: cond as never, thenNode: thenN, elseNode: elseN });

describe("event 조건", () => {
  it("스키마: calendar 또는 times 필수, ISO/시간 검증", () => {
    expect(validateRootNode(gated({ type: "event", times: ["2025-01-01T12:00:00Z"], hoursBefore: 2, hoursAfter: 1 }))).toBeNull();
    expect(validateRootNode(gated({ type: "event", calendar: "FOMC", hoursBefore: 24 }))).toBeNull();
    expect(validateRootNode(gated({ type: "event" }))).not.toBeNull(); // 둘 다 없음
    expect(validateRootNode(gated({ type: "event", times: ["not-a-date"] }))).not.toBeNull(); // 잘못된 ISO
    expect(validateRootNode(gated({ type: "event", times: ["2025-01-01T00:00:00Z"], hoursBefore: -1 }))).not.toBeNull(); // 음수 시간
  });

  it("인라인 times: 이벤트 [전2h, 후2h] 윈도우에서만 매매", () => {
    // 이벤트 = 시작+12h. 봉 24개(시작~+23h). 윈도우 = [10h, 14h].
    const start = Date.UTC(2025, 0, 1, 0);
    const eventIso = new Date(start + 12 * 3600000).toISOString();
    const bars = barsFrom(start, 24);
    const cfg: BacktestConfig = { strategyId: "t", symbol: "X", startDate: bars[0].date, endDate: bars[23].date, initialCapital: 1e6, commission: 0.1, timeframe: "1h" };
    const inWindow = runCompositeBacktest(gated({ type: "event", times: [eventIso], hoursBefore: 2, hoursAfter: 2 }), bars as unknown as Parameters<typeof runCompositeBacktest>[1], cfg);
    expect(inWindow.totalTrades).toBeGreaterThan(0); // 10~14h 봉에서 거래
    // 윈도우가 데이터 밖(다음날) → 무거래
    const outside = runCompositeBacktest(gated({ type: "event", times: ["2030-01-01T00:00:00Z"], hoursBefore: 1, hoursAfter: 1 }), bars as unknown as Parameters<typeof runCompositeBacktest>[1], cfg);
    expect(outside.totalTrades).toBe(0);
  });

  it("이벤트 회피(elseNode): 윈도우 밖에서만 매매", () => {
    const start = Date.UTC(2025, 0, 1, 0);
    const eventIso = new Date(start + 12 * 3600000).toISOString();
    const bars = barsFrom(start, 24);
    const cfg: BacktestConfig = { strategyId: "t", symbol: "X", startDate: bars[0].date, endDate: bars[23].date, initialCapital: 1e6, commission: 0.1, timeframe: "1h" };
    // then=NEVER(이벤트 중 거래 안 함), else=ALWAYS(평시 거래) → "FOMC 회피"
    const avoid = runCompositeBacktest(gated({ type: "event", times: [eventIso], hoursBefore: 3, hoursAfter: 3 }, NEVER, ALWAYS), bars as unknown as Parameters<typeof runCompositeBacktest>[1], cfg);
    expect(avoid.totalTrades).toBeGreaterThan(0); // 윈도우 밖 봉에서 거래
  });

  it("명명 캘린더 FOMC: collectEventCalendars + buildEventCalendars 주입 → 윈도우 매매", () => {
    const tree = gated({ type: "event", calendar: "FOMC", hoursBefore: 3, hoursAfter: 3 });
    expect(collectEventCalendars(tree)).toEqual(["FOMC"]);
    const eventCalendars = buildEventCalendars(["FOMC"]);
    expect(eventCalendars.FOMC.length).toBe(FOMC.length);
    // FOMC "2025-01-29T19:00:00Z" 주변 봉
    const start = Date.UTC(2025, 0, 29, 14); // 14:00Z ~
    const bars = barsFrom(start, 12); // ~01:00 다음날까지(19:00Z 포함)
    const cfg: BacktestConfig = { strategyId: "t", symbol: "X", startDate: bars[0].date, endDate: bars[bars.length - 1].date, initialCapital: 1e6, commission: 0.1, timeframe: "1h", eventCalendars };
    const r = runCompositeBacktest(tree, bars as unknown as Parameters<typeof runCompositeBacktest>[1], cfg);
    expect(r.totalTrades).toBeGreaterThan(0); // 19:00Z FOMC ±3h 윈도우 봉에서 거래
  });

  it("명명 캘린더 미주입 → fail-closed(무거래)", () => {
    const start = Date.UTC(2025, 0, 29, 14);
    const bars = barsFrom(start, 12);
    const cfg: BacktestConfig = { strategyId: "t", symbol: "X", startDate: bars[0].date, endDate: bars[bars.length - 1].date, initialCapital: 1e6, commission: 0.1, timeframe: "1h" }; // eventCalendars 없음
    const r = runCompositeBacktest(gated({ type: "event", calendar: "FOMC", hoursBefore: 3, hoursAfter: 3 }), bars as unknown as Parameters<typeof runCompositeBacktest>[1], cfg);
    expect(r.totalTrades).toBe(0);
  });
});
