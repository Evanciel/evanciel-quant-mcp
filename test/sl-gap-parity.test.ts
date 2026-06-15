/**
 * sl-gap-parity.test.ts — audit P1-12 후속: SL 갭 체결 모델 backtest≡live 패리티.
 *   [버그] 라이브 러너 cfg가 gapHandling 미설정(엔진 기본 'close'=낙관) + OOS/DSR 게이트도 'close' 기본 →
 *     러너 내부 시뮬이 라이브 상주스톱 현실(갭 저가 발동·시가 체결)보다 낙관적. 'worst'로 검증한 전략을 라이브가 더 후하게 운용.
 *   [수정] 러너 cfg(단일/스캐너) + 게이트(handlers backtest/optimize) 모두 gapHandling 기본 'worst'.
 *     never-more-optimistic: 게이트 기본 == 러너 == 라이브 현실. 'close'는 명시 opt-out으로만(엔진 기본은 하위호환 'close' 유지).
 */
import { describe, it, expect, vi } from "vitest";

const klinesMock = vi.hoisted(() => vi.fn());
vi.mock("../src/data/binance-public.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, fetchKlines: klinesMock };
});

import { backtest } from "../src/mcp-server/handlers.js";
import { runCompositeBacktest } from "../src/core/backtest/engine.js";
import { derivePosition } from "../src/runner/runner.js";
import type { StrategyNode, BacktestConfig } from "../src/core/types/strategy.js";

const bar = (i: number, o: number, h: number, l: number, c: number) => {
  const iso = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString();
  return { date: iso.slice(0, 10), datetime: iso, open: o, high: h, low: l, close: c, volume: 1000 };
};
// 진입 90(sma<95) → 봉30 플래시크래시(low 70 < SL 85.5, close 95 회복) → 이후 100(재진입 없게 >95)
const flashCrash = () => [
  ...Array.from({ length: 30 }, (_, i) => bar(i, 90, 90.5, 89.5, 90)),
  bar(30, 88, 96, 70, 95),
  ...Array.from({ length: 8 }, (_, i) => bar(31 + i, 100, 100.5, 99.5, 100)),
];
// 리프 전략에 stopLossPercent=5 (handlers.backtest는 5th arg risk 미전달 → 리프 SL 경로 사용)
const tree: StrategyNode = { id: "l", type: "leaf", name: "bl", strategy: { id: "s", userId: "u", name: "s", description: "", symbol: "BTCUSDT",
  stopLossPercent: 5,
  rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "sma", params: { period: 1 }, operator: "lt", value: 95 }], quantityPercent: 100 }],
  isActive: true, createdAt: new Date(), updatedAt: new Date() } };

const sellCount = (r: { trades: { action: string }[] }) => r.trades.filter((t) => t.action === "sell").length;

describe("audit P1-12 후속: SL 갭 모델 게이트≡러너 패리티(never-more-optimistic)", () => {
  it("OOS 게이트 기본 = 'worst'(== 명시 worst, ≠ close opt-out)", async () => {
    klinesMock.mockResolvedValue(flashCrash());
    const def = await backtest({ tree, symbol: "BTCUSDT", interval: "1d", days: 40 }) as { ok: boolean; stats: { totalTrades: number } };
    const worst = await backtest({ tree, symbol: "BTCUSDT", interval: "1d", days: 40, gapHandling: "worst" }) as { stats: { totalTrades: number } };
    const close = await backtest({ tree, symbol: "BTCUSDT", interval: "1d", days: 40, gapHandling: "close" }) as { stats: { totalTrades: number } };
    expect(def.ok).toBe(true);
    expect(def.stats.totalTrades).toBe(worst.stats.totalTrades); // 기본 == worst(SL 발동·청산 포함)
    expect(worst.stats.totalTrades).toBeGreaterThan(close.stats.totalTrades); // worst 청산 > close 보유(낙관)
  });

  it("엔진 모델 차이 고정: close=미발동 / worst=발동(갭 저가 터치)", () => {
    const data = flashCrash();
    const cfgBase = { strategyId: "t", symbol: "BTCUSDT", startDate: data[0].date, endDate: data[data.length - 1].date, initialCapital: 10000, commission: 0.1, timeframe: "1d" } as BacktestConfig;
    expect(sellCount(runCompositeBacktest(tree, data as never, { ...cfgBase, gapHandling: "close" } as never))).toBe(0);
    expect(sellCount(runCompositeBacktest(tree, data as never, { ...cfgBase, gapHandling: "worst" } as never))).toBe(1);
  });

  it("러너 cfg(gapHandling 'worst' + slippage 0.05) → SL 청산 후 want=flat(라이브가 손실 포지션 보유 안 함)", () => {
    const data = flashCrash();
    // tickBot이 만드는 cfg와 동일 형태(worst + 명시 slippage). 러너는 res.trades → derivePosition → want.
    const runnerCfg = { strategyId: "runner", symbol: "BTCUSDT", startDate: data[0].date, endDate: data[data.length - 1].date, initialCapital: 10000, commission: 0.1, timeframe: "1d", gapHandling: "worst", slippage: 0.05 } as BacktestConfig;
    const res = runCompositeBacktest(tree, data as never, runnerCfg as never);
    expect(sellCount(res)).toBe(1); // 러너 시뮬도 갭에서 SL 발동
    expect(derivePosition(res.trades).holding).toBe(false); // 청산 후 flat → 라이브가 들고 있지 않음(never-more-optimistic)
  });
});
