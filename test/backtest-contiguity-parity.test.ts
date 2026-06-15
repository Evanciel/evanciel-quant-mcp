/**
 * backtest-contiguity-parity.test.ts — audit P1-22-02: 백테스트도 캔들 무결성 게이트(backtest≡live).
 *   라이브 러너(tickBot)는 간극/형식깨짐 데이터에 hold하는데, 백테스트 핸들러는 무검증으로 통과하던 패리티 위반 회귀.
 *   fetchKlines를 mock해 간극 시계열을 주입 → backtest()가 거부(throw)하는지, 연속 시계열은 정상인지 고정.
 */
import { describe, it, expect, vi } from "vitest";

const klinesMock = vi.hoisted(() => vi.fn());
vi.mock("../src/data/binance-public.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, fetchKlines: klinesMock };
});

import { backtest } from "../src/mcp-server/handlers.js";
import type { StrategyNode } from "../src/core/types/strategy.js";

const tree: StrategyNode = { id: "l", type: "leaf", name: "s", strategy: { id: "s", userId: "u", name: "s", description: "", symbol: "BTCUSDT",
  rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 14 }, operator: "lt", value: 30 }], quantityPercent: 100 }],
  isActive: true, createdAt: new Date(), updatedAt: new Date() } };

const contiguous = (n: number) => Array.from({ length: n }, (_, i) => {
  const iso = new Date(Date.UTC(2025, 0, 1) + i * 3600000).toISOString();
  return { date: iso.slice(0, 10), datetime: iso, open: 100, high: 101, low: 99, close: 100 + Math.sin(i / 3) * 5, volume: 1 };
});
// 25번째 봉부터 +10h 시프트 → bar24~bar25 사이 11h 간극(1h interval의 1.5배 초과 = 봉 누락).
const gapped = () => contiguous(50).map((x, i) => i < 25 ? x : { ...x, datetime: new Date(Date.parse(x.datetime) + 10 * 3600000).toISOString() });

describe("audit P1-22-02 백테스트 캔들 무결성(backtest≡live)", () => {
  it("간극 있는 crypto 시계열 → 백테스트 거부(throw)", async () => {
    klinesMock.mockResolvedValue(gapped());
    await expect(backtest({ tree, symbol: "BTCUSDT", interval: "1h", days: 50 })).rejects.toThrow(/무결성|간극|누락/);
  });

  it("연속 시계열 → 정상 백테스트(거부 안 함)", async () => {
    klinesMock.mockResolvedValue(contiguous(50));
    const r = await backtest({ tree, symbol: "BTCUSDT", interval: "1h", days: 50 });
    expect((r as { ok: boolean }).ok).toBe(true);
  });
});
