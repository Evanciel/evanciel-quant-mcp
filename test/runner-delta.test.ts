/**
 * runner-delta.test.ts — planPositionDelta 수량 델타 정합 검증.
 * 엔진 넷 포지션을 라이브 보유에 봉마다 추종 → 라더(부분익절)·스케일인·피라미딩이 라이브에 반영(backtest≡live).
 */
import { describe, it, expect } from "vitest";
import { planPositionDelta } from "../src/runner/runner.js";
import { runCompositeBacktest } from "../src/core/backtest/engine.js";
import type { StrategyNode, Strategy, BacktestConfig } from "../src/core/types/strategy.js";

const want = (holding: boolean, qty: number, entryAvg = 100) => ({ holding, qty, entryAvg });

/** 트레이드열 → 넷 보유(러너 derivePosition과 동일 산식). 테스트용. */
function deriveNet(trades: { action: string; price: number; quantity: number }[]) {
  let qty = 0, cost = 0;
  for (const t of trades) {
    if (t.action === "buy") { cost += t.price * t.quantity; qty += t.quantity; }
    else { const s = Math.min(t.quantity, qty); if (qty > 0) cost -= (cost / qty) * s; qty -= s; if (qty <= 1e-9) { qty = 0; cost = 0; } }
  }
  return { holding: qty > 1e-9, qty, entryAvg: qty > 0 ? cost / qty : 0 };
}

describe("planPositionDelta", () => {
  it("flat → 진입(전량 매수)", () => {
    const p = planPositionDelta(0, want(true, 10), 100, 1e6);
    expect(p).toMatchObject({ side: "buy", qty: 10, partial: false, wantQty: 10 });
  });
  it("보유 → 부분 익절(델타 매도, partial)", () => {
    const p = planPositionDelta(10, want(true, 5), 100, 1e6);
    expect(p).toMatchObject({ side: "sell", qty: 5, partial: true, wantQty: 5 });
  });
  it("보유 → 추가매수(스케일인/피라미딩, 델타 매수, partial)", () => {
    const p = planPositionDelta(5, want(true, 15), 100, 1e6);
    expect(p).toMatchObject({ side: "buy", qty: 10, partial: true, wantQty: 15 });
  });
  it("보유 → 전량 청산(partial=false)", () => {
    const p = planPositionDelta(10, want(false, 0), 100, 1e6);
    expect(p).toMatchObject({ side: "sell", qty: 10, partial: false, wantQty: 0 });
  });
  it("수량 동일 → hold", () => {
    expect(planPositionDelta(10, want(true, 10), 100, 1e6).side).toBe("hold");
    expect(planPositionDelta(0, want(false, 0), 100, 1e6).side).toBe("hold");
  });
  it("want.qty 0인데 holding=true → 자본 기반 수량 산정", () => {
    const p = planPositionDelta(0, want(true, 0), 100, 1000);
    expect(p.side).toBe("buy");
    expect(p.wantQty).toBe(10); // floor(1000/100)
  });
  it("라더 시퀀스 10→5→2→0: 각 단계가 델타 체결로 반영", () => {
    // 엔진 넷 포지션이 단계적으로 줄 때, 라이브가 봉마다 부분매도로 추종
    let curQty = 0;
    const steps = [10, 5, 2, 0];
    const plans = steps.map((netQty, i) => {
      const prev = i === 0 ? 0 : steps[i - 1];
      const holding = netQty > 0;
      const p = planPositionDelta(curQty, want(holding, netQty), 100, 1e6);
      curQty = p.wantQty;
      return { from: prev, to: netQty, ...p };
    });
    expect(plans.map((p) => p.side)).toEqual(["buy", "sell", "sell", "sell"]);
    expect(plans.map((p) => p.qty)).toEqual([10, 5, 3, 2]); // 진입10, -5, -3, -2
    expect(plans[1].partial && plans[2].partial).toBe(true); // 중간은 부분익절
    expect(plans[3].partial).toBe(false); // 마지막은 전량 청산
    expect(curQty).toBe(0);
  });
});

describe("backtest≡live 패리티: 라더 봇을 봉마다 러너 시뮬레이션", () => {
  // 상승 봉(100→+20%): tpLadder가 +5/+10/+15%에서 부분익절. 러너가 봉마다 델타로 추종.
  const bars = Array.from({ length: 50 }, (_, i) => {
    const c = 100 * (1 + i * 0.005); // i=10:+5%, 20:+10%, 30:+15%
    return { date: new Date(Date.UTC(2025, 0, 1) + i * 3600000).toISOString().slice(0, 10), datetime: new Date(Date.UTC(2025, 0, 1) + i * 3600000).toISOString(), open: c, high: c * 1.001, low: c * 0.999, close: c, volume: 1000 };
  });
  const strat: Strategy = { id: "s", userId: "u", name: "s", description: "", symbol: "X",
    rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: 200 }], quantityPercent: 100 }],
    isActive: true, createdAt: new Date(), updatedAt: new Date() };
  const node: StrategyNode = { id: "l", type: "leaf", name: "ladder", strategy: strat };
  const tpLadder = [{ pct: 5, sellPct: 50 }, { pct: 10, sellPct: 50 }, { pct: 15, sellPct: 100 }];
  const cfg = (d: typeof bars): BacktestConfig => ({ strategyId: "t", symbol: "X", startDate: d[0].date, endDate: d[d.length - 1].date, initialCapital: 1e6, commission: 0.1, timeframe: "1h" });

  it("러너 델타 누적 = 엔진 넷 포지션 곡선(부분익절 ≥2회, 단일 덤핑 아님)", () => {
    let curQty = 0;
    let buys = 0, sells = 0, partialSells = 0, totalBought = 0, totalSold = 0;
    const netCurve: number[] = [];
    for (let i = 5; i < bars.length; i++) {
      const slice = bars.slice(0, i + 1);
      const res = runCompositeBacktest(node, slice as unknown as Parameters<typeof runCompositeBacktest>[1], cfg(slice), 0, { tpLadder });
      const net = deriveNet(res.trades);
      netCurve.push(+net.qty.toFixed(6));
      const plan = planPositionDelta(curQty, net, slice[slice.length - 1].close, 1e6);
      if (plan.side === "buy") { buys++; totalBought += plan.qty; }
      else if (plan.side === "sell") { sells++; totalSold += plan.qty; if (plan.partial) partialSells++; }
      curQty = plan.wantQty; // 봇 보유 갱신(러너가 persist하는 값)
    }
    const engineFinalNet = netCurve[netCurve.length - 1];
    // 1) 러너가 추종한 최종 보유수량 == 엔진 넷 포지션
    expect(curQty).toBeCloseTo(engineFinalNet, 6);
    // 2) 부분 익절이 ≥2회 발생(라더가 단계적으로 빠짐 — 단일 덤핑 아님)
    expect(partialSells).toBeGreaterThanOrEqual(2);
    // 3) 수량 보존: 총매수 == 총매도 + 최종보유
    expect(totalBought).toBeCloseTo(totalSold + curQty, 6);
    // 4) 진입 발생(전량청산 후 always-buy 재진입도 정상 추종 → buys≥1)
    expect(buys).toBeGreaterThanOrEqual(1);
  });
});
