/**
 * entry-execution-engine.test.ts — audit P1-5: runCompositeBacktest 엔진 통합.
 *   ① 미설정 vs type:market → trades·equityCurve 바이트 동일(회귀 0 — 시장가 경로 불변)
 *   ② 지정가 TOUCH → limit 체결(슬리피지 0, 시장가보다 유리한 진입가)
 *   ③ 지정가 미체결 N봉 → entryBarIndex 재배치 + 대기 중 flat(에쿼티=초기자본)
 */
import { describe, it, expect } from "vitest";
import { runCompositeBacktest } from "../src/core/backtest/engine.js";
import type { StrategyNode, BacktestConfig } from "../src/core/types/strategy.js";

const bar = (i: number, o: number, h: number, l: number, c: number) => {
  const iso = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString();
  return { date: iso.slice(0, 10), datetime: iso, open: o, high: h, low: l, close: c, volume: 1000 };
};
// buy-always(sma1<99999) + sell(sma1>110) → 매수/매도 라운드트립으로 trades 풍부하게.
const tree: StrategyNode = { id: "l", type: "leaf", name: "x", strategy: { id: "s", userId: "u", name: "s", description: "", symbol: "TESTUSDT",
  rules: [
    { id: "b", action: "buy", conditions: [{ id: "c", indicator: "sma", params: { period: 1 }, operator: "lt", value: 99999 }], quantityPercent: 100 },
    { id: "se", action: "sell", conditions: [{ id: "c2", indicator: "sma", params: { period: 1 }, operator: "gt", value: 110 }], quantityPercent: 100 },
  ], isActive: true, createdAt: new Date(), updatedAt: new Date() } };
const cfg = (data: ReturnType<typeof bar>[]): BacktestConfig => ({ strategyId: "t", symbol: "TESTUSDT", startDate: data[0].date, endDate: data[data.length - 1].date, initialCapital: 10000, commission: 0.1, timeframe: "1d" });

describe("P1-5 엔진: 시장가 경로 바이트 동일(회귀 0)", () => {
  it("entryExecution 미설정 == {type:'market'} (trades·equityCurve 일치)", () => {
    const data = Array.from({ length: 20 }, (_, i) => { const c = 100 + i; return bar(i, c, c + 0.5, c - 0.5, c); });
    const baseline = runCompositeBacktest(tree, data as never, cfg(data));
    const market = runCompositeBacktest(tree, data as never, { ...cfg(data), entryExecution: { type: "market" } });
    expect(market.trades).toEqual(baseline.trades);
    expect(market.equityCurve).toEqual(baseline.equityCurve);
  });
});

describe("P1-5 엔진: 지정가 진입", () => {
  it("TOUCH(같은 봉 low<limit) → limit 체결가(시장가보다 낮은 진입가, 슬리피지 0)", () => {
    // bar0 close100 low99. 시장가=100*(1.0005)=100.05. 지정가 offset0 → limit100, low99<100 → 터치 j=0 → 체결 100.
    const data = [bar(0, 100, 100, 99, 100), ...Array.from({ length: 5 }, (_, i) => bar(1 + i, 100, 100.5, 99.5, 100))];
    const mkt = runCompositeBacktest(tree, data as never, cfg(data));
    const lim = runCompositeBacktest(tree, data as never, { ...cfg(data), entryExecution: { type: "limit", limitOffsetPct: 0, timeoutBars: 3, maxSlippagePct: 0.5 } });
    const mktBuy = mkt.trades.find((t) => t.action === "buy")!;
    const limBuy = lim.trades.find((t) => t.action === "buy")!;
    expect(limBuy.price).toBeCloseTo(100, 6);       // limit(maker)
    expect(mktBuy.price).toBeCloseTo(100 * 1.0005, 6); // 시장가+슬립
    expect(limBuy.price).toBeLessThan(mktBuy.price);   // 지정가가 더 유리
  });

  it("미체결 N봉 → entryBarIndex 재배치 + 대기 중 flat(에쿼티=초기자본)", () => {
    // offset-1 → limit99. 봉0,1 low100(미터치), 봉2 low98<99 → 터치 j=2. timeoutBars5.
    const data = [
      bar(0, 100, 100.5, 100, 100),
      bar(1, 100, 100.5, 100, 100),
      bar(2, 100, 100.5, 98, 100),
      ...Array.from({ length: 4 }, (_, i) => bar(3 + i, 100, 100.5, 99.5, 100)),
    ];
    const r = runCompositeBacktest(tree, data as never, { ...cfg(data), entryExecution: { type: "limit", limitOffsetPct: -1, timeoutBars: 5, maxSlippagePct: 0.5 } });
    const firstBuy = r.trades.find((t) => t.action === "buy")!;
    expect(firstBuy.date).toBe(data[2].date);          // 진입 봉 재배치(신호봉0이 아닌 체결봉2)
    expect(firstBuy.price).toBeCloseTo(99, 6);          // limit 체결
    expect(r.equityCurve[0].value).toBeCloseTo(10000, 6); // 대기 봉0 flat(미체결 지정가 무노출)
    expect(r.equityCurve[1].value).toBeCloseTo(10000, 6); // 대기 봉1 flat
    expect(r.equityCurve[2].value).not.toBeCloseTo(10000, 6); // 체결 봉2: 보유 시작 → 에쿼티 flat 이탈(limit99<종가100 → 평가이익)
    expect(r.equityCurve[2].value).toBeGreaterThan(10000);    // limit 체결가(99) < 종가(100) → 즉시 평가이익
  });
});
