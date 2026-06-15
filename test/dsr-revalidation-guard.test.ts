/**
 * dsr-revalidation-guard.test.ts — audit P1-5 PR-4: backtest() OOS/DSR 게이트가 entryExecution을 반영하는지 고정.
 *   지정가 진입 모델이 full + train/test(OOS) 동일 경로로 흘러 결과를 바꾼다 → 라이브 limit 봇은 이 모델로 재검증해야 함을 보장.
 *   (DSR 델타가 실재·표면화됨을 문서화하는 가드. 시장가 기본은 불변.)
 */
import { describe, it, expect, vi } from "vitest";

const klinesMock = vi.hoisted(() => vi.fn());
vi.mock("../src/data/binance-public.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, fetchKlines: klinesMock };
});

import { backtest } from "../src/mcp-server/handlers.js";
import type { StrategyNode } from "../src/core/types/strategy.js";

const tree: StrategyNode = { id: "l", type: "leaf", name: "x", strategy: { id: "s", userId: "u", name: "s", description: "", symbol: "BTCUSDT",
  rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "sma", params: { period: 1 }, operator: "lt", value: 99999 }], quantityPercent: 100 }],
  isActive: true, createdAt: new Date(), updatedAt: new Date() } };

// 70봉 상승(100→), bar0 저가 98(지정가 -1%=99 터치 → 진입가 99 < 시장가 100.05). buy-always 보유.
const rising = () => Array.from({ length: 70 }, (_, i) => {
  const c = 100 + i * 0.3; const iso = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString();
  return { date: iso.slice(0, 10), datetime: iso, open: c, high: c + 0.5, low: i === 0 ? 98 : c - 0.5, close: c, volume: 1000 };
});

describe("audit P1-5 PR-4: backtest() OOS 게이트 entryExecution 반영(DSR 재검증 표면)", () => {
  it("지정가 모델이 full 백테 결과를 바꾸고(더 나은 진입가), OOS도 동일 경로 통과", async () => {
    klinesMock.mockResolvedValue(rising());
    const market = await backtest({ tree, symbol: "BTCUSDT", interval: "1d", days: 70 }) as { ok: boolean; stats: { totalReturnPercent: number }; oos: unknown };
    const limit = await backtest({ tree, symbol: "BTCUSDT", interval: "1d", days: 70, entryExecution: { type: "limit", limitOffsetPct: -1, timeoutBars: 3, maxSlippagePct: 0.5 } }) as { ok: boolean; stats: { totalReturnPercent: number }; oos: unknown };
    expect(market.ok).toBe(true); expect(limit.ok).toBe(true);
    expect(limit.stats.totalReturnPercent).not.toBeCloseTo(market.stats.totalReturnPercent, 3); // entryExecution이 full 백테에 반영
    expect(limit.stats.totalReturnPercent).toBeGreaterThan(market.stats.totalReturnPercent);    // 지정가 99 < 시장가 100.05 → 더 나은 진입
    expect(market.oos).not.toBeNull(); expect(limit.oos).not.toBeNull();                        // train/test(OOS)도 entryExecution 경로 통과(에러 없이)
  });

  it("entryExecution 미설정 = 시장가(기본) — 회귀 없음", async () => {
    klinesMock.mockResolvedValue(rising());
    const a = await backtest({ tree, symbol: "BTCUSDT", interval: "1d", days: 70 }) as { stats: { totalReturnPercent: number } };
    const b = await backtest({ tree, symbol: "BTCUSDT", interval: "1d", days: 70, entryExecution: { type: "market" } }) as { stats: { totalReturnPercent: number } };
    expect(b.stats.totalReturnPercent).toBeCloseTo(a.stats.totalReturnPercent, 6); // market == 미설정(바이트 동일)
  });
});
