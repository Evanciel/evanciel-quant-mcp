/**
 * seed-parity.test.ts — P0-5 엔진 포지션 시드의 backtest≡live 패리티 게이트.
 *
 * 증명: 진입봉이 윈도우 밖으로 스크롤아웃돼도, 라이브 포지션으로 **시드 재실행**한 윈도우 백테가
 *   풀히스토리 백테와 **동일한 want(보유/청산)** 를 낸다 → 라이브가 시드 결과를 써도 진실과 일치.
 * 지표는 period-1(=현재가, 룩백 절단 없음)로 시딩 정확성만 격리(지표 윈도우 절단은 별개·기존 사안).
 * 청산→재진입까지 비교(시드 시 balance에서 매입원가 차감 → 재진입 사이징도 풀히스토리와 정합).
 */
import { describe, it, expect } from "vitest";
import { runCompositeBacktest } from "../src/core/backtest/engine.js";
import { derivePosition } from "../src/runner/runner.js";
import type { StrategyNode, BacktestConfig } from "../src/core/types/strategy.js";
type OHLCV = Parameters<typeof runCompositeBacktest>[1][number];

const bar = (i: number, close: number, low?: number, high?: number): OHLCV => {
  const iso = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString();
  return { date: iso.slice(0, 10), datetime: iso, open: close, high: high ?? close + 1, low: low ?? close - 1, close, volume: 1000 } as OHLCV;
};

// buy: sma(1) < 95 / sell: sma(1) > 110 (period-1 = 현재가)
const strat: StrategyNode = { id: "l", type: "leaf", name: "s", strategy: { id: "s", userId: "u", name: "s", description: "", symbol: "BTCUSDT",
  rules: [
    { id: "b", action: "buy", conditions: [{ id: "c1", indicator: "sma", params: { period: 1 }, operator: "lt", value: 95 }], quantityPercent: 100 },
    { id: "s", action: "sell", conditions: [{ id: "c2", indicator: "sma", params: { period: 1 }, operator: "gt", value: 110 }], quantityPercent: 100 },
  ], isActive: true, createdAt: new Date(), updatedAt: new Date() } };

const cfg: BacktestConfig = { strategyId: "t", symbol: "BTCUSDT", startDate: "2025-01-01", endDate: "2025-02-01", initialCapital: 10000, commission: 0.1, timeframe: "1d", gapHandling: "worst", slippage: 0.05 };

const wantFull = (data: OHLCV[], risk?: Parameters<typeof runCompositeBacktest>[4]) => derivePosition(runCompositeBacktest(strat, data, cfg, 0, risk).trades);

function wantSeeded(data: OHLCV[], K: number, risk?: Parameters<typeof runCompositeBacktest>[4]) {
  // 시드 = 풀히스토리 [0..K) 처리 후 보유 상태(=바 K 진입 시점 포지션). 엔진이 산출 → 수량/평단 자동 일치.
  const seed = derivePosition(runCompositeBacktest(strat, data.slice(0, K), cfg, 0, risk).trades);
  const win = data.slice(K);
  const wtrades = runCompositeBacktest(strat, win, cfg, 0, risk, { position: seed.qty, avgEntryPrice: seed.entryAvg }).trades;
  return derivePosition(wtrades, { qty: seed.qty, entryAvg: seed.entryAvg });
}
const wantWindowNoSeed = (data: OHLCV[], K: number, risk?: Parameters<typeof runCompositeBacktest>[4]) =>
  derivePosition(runCompositeBacktest(strat, data.slice(K), cfg, 0, risk).trades);

const K = 5; // 진입(바0)이 윈도우 [5..] 밖 = 스크롤아웃
const eq = (a: ReturnType<typeof derivePosition>, b: ReturnType<typeof derivePosition>) => {
  expect(a.holding).toBe(b.holding);
  expect(a.qty).toBeCloseTo(b.qty, 6);
  if (a.holding) expect(a.entryAvg).toBeCloseTo(b.entryAvg, 6);
};

describe("P0-5 시드 패리티 (backtest≡live)", () => {
  it("보유 지속(청산 없음) → 시드 윈도우 = 풀히스토리(둘 다 보유)", () => {
    const data = [bar(0, 90), ...Array.from({ length: 9 }, (_, i) => bar(i + 1, 100))]; // 바0 진입, 이후 100 보유
    const full = wantFull(data);
    expect(full.holding).toBe(true);
    eq(wantSeeded(data, K), full);
    // 시드 없으면 윈도우는 진입을 못 봐 flat(=오청산) → 시딩이 고치는 바로 그 버그
    expect(wantWindowNoSeed(data, K).holding).toBe(false);
  });

  it("전략 청산 신호(윈도우 내) → 시드 윈도우 = 풀히스토리(둘 다 청산)", () => {
    const data = [bar(0, 90), ...Array.from({ length: 8 }, (_, i) => bar(i + 1, 100)), bar(9, 120)]; // 바9 sell(>110)
    const full = wantFull(data);
    expect(full.holding).toBe(false);
    eq(wantSeeded(data, K), full);
  });

  it("손절(SL 10%, worst) 윈도우 내 → 시드 윈도우 = 풀히스토리(둘 다 청산)", () => {
    const risk = { stopLossPercent: 10 };
    const data = [bar(0, 90), ...Array.from({ length: 8 }, (_, i) => bar(i + 1, 100)), bar(9, 85, 80)]; // 바9 저가80 ≤ 81(=90*0.9)
    const full = wantFull(data, risk);
    expect(full.holding).toBe(false);
    eq(wantSeeded(data, K, risk), full);
  });

  it("익절(TP 15%) 윈도우 내 → 시드 윈도우 = 풀히스토리(둘 다 청산)", () => {
    const risk = { takeProfitPercent: 15 };
    const data = [bar(0, 90), ...Array.from({ length: 8 }, (_, i) => bar(i + 1, 100)), bar(9, 104)]; // +15.5% ≥ 103.5
    const full = wantFull(data, risk);
    expect(full.holding).toBe(false);
    eq(wantSeeded(data, K, risk), full);
  });

  it("청산→재진입(윈도우 내) → 시드 윈도우 = 풀히스토리(재진입 수량까지 일치)", () => {
    // 바0 진입@90 → 바9 청산@120(sell>110) → 바10 재진입@90(buy<95) → 바11 보유.
    // 시드 시 balance 미차감이면 청산대금이 미차감 원금 위에 더해져 재진입 want.qty가 과대(라이브 과매수) → 이 케이스가 게이트.
    const data = [bar(0, 90), ...Array.from({ length: 8 }, (_, i) => bar(i + 1, 100)), bar(9, 120), bar(10, 90), bar(11, 100)];
    const full = wantFull(data);
    expect(full.holding).toBe(true); // 재진입 후 보유
    eq(wantSeeded(data, K), full);   // 재진입 수량(qty)·평단까지 풀히스토리와 일치
  });
});
