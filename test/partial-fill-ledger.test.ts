/**
 * partial-fill-ledger.test.ts — 부분체결 시 장부가 '의도 수량'이 아닌 '실제 체결 수량'으로 기록되는지(audit P1-1).
 * 종전: fillOrder가 filledQty를 반환해도 호출부가 의도수량(plan.qty/actualWantQty)으로 trade·position을 기록 →
 *   거래소(부분만 체결)와 장부(전량 기록)가 발산. 이제 trade.qty와 position.qty 모두 체결분이어야 한다.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-partial-${process.pid}`);
process.env.BINANCE_ENV = "testnet";
process.env.BINANCE_API_KEY = "x".repeat(64);
process.env.BINANCE_API_SECRET = "y".repeat(64);

const calls = vi.hoisted(() => ({ fillRatio: 1.0, placed: [] as { type: string; quantity: number }[] }));
const klinesMock = vi.hoisted(() => vi.fn());

vi.mock("../src/data/binance-public.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, fetchKlines: klinesMock };
});
vi.mock("../src/brokers/index.js", () => ({
  getAdapter: () => ({
    adapter: {
      async placeOrder(o: { type: string; symbol: string; side: string; quantity: number; price?: number }) {
        calls.placed.push({ type: o.type, quantity: o.quantity });
        const exec = o.type === "market" ? o.quantity * calls.fillRatio : o.quantity;
        // 부분체결 시 Binance 실동작 모사: executedQty<origQty, filled(체결분>0 종료 상태)
        return { orderId: "oid", symbol: o.symbol, side: o.side, quantity: exec, executedQty: exec, origQty: o.quantity, price: 100, status: "filled", timestamp: new Date() };
      },
      async getOrderByClientId() { return null; },
      async cancelOrderByClientId() { return true; },
      async cancelOrder() { return true; },
      async getBalance() { return { totalAsset: 100000, cashBalance: 100000, currency: "USDT" }; },
      async getPositions() { return []; },
    },
  }),
  configuredBrokers: () => [],
}));

import * as store from "../src/store/db.js";
import { tickBot } from "../src/runner/runner.js";
import type { StrategyNode } from "../src/core/types/strategy.js";

const bar = (i: number, c: number) => { const iso = new Date(Date.UTC(2025, 0, 1) + i * 3600000).toISOString(); return { date: iso.slice(0, 10), datetime: iso, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000 }; };
const barsAt = (n: number, prices: (i: number) => number) => Array.from({ length: n }, (_, i) => bar(i, prices(i)));

const buyLow: StrategyNode = { id: "l", type: "leaf", name: "bl", strategy: { id: "s", userId: "u", name: "s", description: "", symbol: "BTCUSDT",
  rules: [
    { id: "b", action: "buy", conditions: [{ id: "c", indicator: "sma", params: { period: 1 }, operator: "lt", value: 95 }], quantityPercent: 100 },
    { id: "se", action: "sell", conditions: [{ id: "c2", indicator: "sma", params: { period: 1 }, operator: "gt", value: 105 }], quantityPercent: 100 },
  ], isActive: true, createdAt: new Date(), updatedAt: new Date() } };

let botId: string;
beforeAll(() => {
  const comp = store.insertComposite({ name: "pf", root_node: buyLow, symbol: "BTCUSDT", market: "spot", leverage: 1, stop_loss_percent: null, take_profit_percent: null, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
  const bot = store.insertBot({ name: "pf-bot", symbol: "BTCUSDT", composite_strategy_id: comp.id, mode: "live", capital: 1000, broker: "binance", interval_seconds: 3600 });
  botId = bot.id;
});

describe("부분체결 장부 정합(P1-1)", () => {
  it("매수 의도 수량의 절반만 체결 → trade.qty·position.qty 모두 체결분", async () => {
    calls.fillRatio = 0.5;
    klinesMock.mockResolvedValue(barsAt(50, () => 90)); // <95 → 매수
    const r = await tickBot(botId);
    expect(r.action).toBe("buy");
    const buy = store.recentTrades(botId, 10).find((t) => t.side === "buy");
    const intended = calls.placed.find((p) => p.type === "market")!.quantity;
    expect(buy!.qty).toBeCloseTo(intended * 0.5); // 의도수량이 아닌 체결분
    const ps = store.getBot(botId)?.position_state as { qty: number };
    expect(ps.qty).toBeCloseTo(intended * 0.5);
  });

  it("매도 부분체결 → 체결분만 차감, 잔여는 보유 유지(전량 청산 둔갑 금지)", async () => {
    calls.fillRatio = 0.5;
    calls.placed = [];
    const before = (store.getBot(botId)?.position_state as { qty: number }).qty;
    // 엔진 윈도우 안에 매수(90)→매도(110) 시그널이 모두 보이게(무체결 윈도우 가드 회피) + 새 봉(멱등키 변경).
    klinesMock.mockResolvedValue(barsAt(52, (i) => (i < 40 ? 90 : 110)));
    const r = await tickBot(botId);
    expect(r.action).toBe("sell");
    const sells = store.recentTrades(botId, 10).filter((t) => t.side === "sell");
    const intendedSell = calls.placed.find((p) => p.type === "market")!.quantity;
    expect(sells[0].qty).toBeCloseTo(intendedSell * 0.5);
    const ps = store.getBot(botId)?.position_state as { qty: number } | null;
    expect(ps).not.toBeNull(); // 부분만 팔렸으니 잔여 보유
    expect(ps!.qty).toBeCloseTo(before - intendedSell * 0.5);
  });
});
