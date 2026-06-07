/**
 * live-protective.test.ts — 라이브 봇 상주 보호주문 배선 통합검증(mock 어댑터, 키 불필요).
 * 검증: ① 라이브 진입 → 거래소 보호주문(SL) 배치 + protectiveIds 저장 ② 청산 → 보호주문 취소.
 * 실거래소 주문/스톱 계약은 scripts/verify-testnet-order-e2e.ts가 testnet 실검증.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-live-${process.pid}`);
// 라이브 게이트 통과용(testnet 가짜 키 — 실거래소 호출 안 함, 어댑터는 모킹).
process.env.BINANCE_ENV = "testnet";
process.env.BINANCE_API_KEY = "x".repeat(64);
process.env.BINANCE_API_SECRET = "y".repeat(64);

// 주문/취소 기록용(hoisted).
const calls = vi.hoisted(() => ({ placed: [] as any[], cancelled: [] as string[] }));
const klinesMock = vi.hoisted(() => vi.fn());

vi.mock("../src/data/binance-public.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, fetchKlines: klinesMock };
});
vi.mock("../src/brokers/index.js", () => ({
  getAdapter: () => ({
    adapter: {
      async placeOrder(o: any) { calls.placed.push(o); return { orderId: "oid-" + calls.placed.length, symbol: o.symbol, side: o.side, quantity: o.quantity, price: o.price ?? 100, status: "filled", timestamp: new Date() }; },
      async cancelOrderByClientId(_s: string, cid: string) { calls.cancelled.push(cid); return true; },
      async cancelOrder() { return true; },
      async getBalance() { return { totalAsset: 100000, cashBalance: 100000, currency: "USDT" }; },
      async getPositions() { return []; },
    },
  }),
}));

import * as store from "../src/store/db.js";
import { tickBot } from "../src/runner/runner.js";
import type { StrategyNode } from "../src/core/types/strategy.js";

const bar = (i: number, c: number) => { const iso = new Date(Date.UTC(2025, 0, 1) + i * 3600000).toISOString(); return { date: iso.slice(0, 10), datetime: iso, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000 }; };
const barsAt = (n: number, prices: (i: number) => number) => Array.from({ length: n }, (_, i) => bar(i, prices(i)));

// buy: sma(1)<95(=가격<95) / sell: sma(1)>105. 깔끔한 진입/청산(재진입 없음).
const buyLowSellHigh: StrategyNode = { id: "l", type: "leaf", name: "bls", strategy: { id: "s", userId: "u", name: "s", description: "", symbol: "BTCUSDT",
  rules: [
    { id: "b", action: "buy", conditions: [{ id: "c", indicator: "sma", params: { period: 1 }, operator: "lt", value: 95 }], quantityPercent: 100 },
    { id: "se", action: "sell", conditions: [{ id: "c2", indicator: "sma", params: { period: 1 }, operator: "gt", value: 105 }], quantityPercent: 100 },
  ], isActive: true, createdAt: new Date(), updatedAt: new Date() } };

let liveBotId: string;
beforeAll(() => {
  const comp = store.insertComposite({ name: "live", root_node: buyLowSellHigh, symbol: "BTCUSDT", market: "spot", leverage: 1, stop_loss_percent: 5, take_profit_percent: 10, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
  // capital 1000 + price 90 → qty 11(정수). mode=live → 게이트 통과(testnet 키) → 실주문경로(mock)
  const bot = store.insertBot({ name: "live-bot", symbol: "BTCUSDT", composite_strategy_id: comp.id, mode: "live", capital: 1000, broker: "binance", interval_seconds: 3600 });
  liveBotId = bot.id;
});

describe("라이브 봇 상주 보호주문 배선", () => {
  it("① 라이브 진입 시 거래소 보호주문(SL/TP) 배치 + protectiveIds 저장", async () => {
    klinesMock.mockResolvedValue(barsAt(50, () => 90)); // 가격 90<95 → 매수, 청산 없음 → 보유
    const r = await tickBot(liveBotId);
    expect(r.action).toBe("buy");
    // 매수 1건 + 보호주문(SL/TP) 배치됨
    const protOrders = calls.placed.filter((o) => o.type === "stop_market" || o.type === "take_profit_market");
    expect(protOrders.length).toBeGreaterThanOrEqual(1);
    const sl = protOrders.find((o) => o.type === "stop_market");
    expect(sl).toBeTruthy();
    expect(sl.side).toBe("sell");
    expect(sl.reduceOnly).toBe(true);
    expect(sl.stopPrice).toBeCloseTo(85.5, 1); // 평단 90 × (1-5%)
    const st = store.getBot(liveBotId)?.position_state as { protectiveIds?: string[] } | null;
    expect((st?.protectiveIds ?? []).length).toBeGreaterThanOrEqual(1); // 상주주문 추적
  });

  it("② 청산 시 보호주문 취소(고아주문 0)", async () => {
    calls.cancelled.length = 0;
    // 가격 90(매수)→110(sma>105 매도) → 엔진 진입+청산(재진입 없음) → 봇 청산 → 보호주문 전부 취소.
    klinesMock.mockResolvedValue(barsAt(50, (i) => (i < 30 ? 90 : 110)));
    const r = await tickBot(liveBotId);
    expect(r.action).toBe("sell");
    expect(calls.cancelled.length).toBeGreaterThanOrEqual(1); // 보호주문 취소됨(고아주문 0)
    const st = store.getBot(liveBotId)?.position_state;
    expect(st).toBeNull(); // 청산 → flat
  });
});
