/**
 * protective-fill-reconcile.test.ts — #6 거래소 상주 SL/TP 체결 reconcile 통합검증(mock 어댑터, 키 불필요).
 *
 * 검증: 라이브 바이낸스 봇이 진입 후 거래소 상주 STOP/TP가 거래소에서 체결되면(getOpenOrders에서 사라짐),
 *   다음 틱에 reconcileProtectiveFills가 getOrderByClientId로 체결을 잡아 SELL을 멱등 기록 + 잔여 leg 취소 +
 *   포지션 정리한다. 실거래소 계약은 scripts가 testnet 실검증.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-protfill-${process.pid}`);
process.env.BINANCE_ENV = "testnet";
process.env.BINANCE_API_KEY = "x".repeat(64);
process.env.BINANCE_API_SECRET = "y".repeat(64);

const calls = vi.hoisted(() => ({
  placed: [] as any[], cancelled: [] as string[], cashBalance: 100000,
  protFilled: false, protFillPrice: 85,
}));
const klinesMock = vi.hoisted(() => vi.fn());

vi.mock("../src/data/binance-public.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, fetchKlines: klinesMock };
});
vi.mock("../src/brokers/index.js", () => ({
  getAdapter: () => ({
    adapter: {
      async placeOrder(o: any) {
        calls.placed.push(o);
        return { orderId: "oid-" + calls.placed.length, symbol: o.symbol, side: o.side, quantity: o.quantity, price: o.price ?? 90, status: "filled", timestamp: new Date() };
      },
      // 보호주문 cid(pS.../pT...) 는 protFilled 시 filled 반환, 그 외(진입 cid 등)는 null.
      async getOrderByClientId(_s: string, cid: string) {
        if (calls.protFilled && /^p[ST]/.test(cid)) {
          // filled stop = 전량 체결(reduceOnly 풀수량). 큰 executedQty → reconcile가 min()으로 포지션 전량 캡.
          return { orderId: "fill-" + cid, symbol: "BTCUSDT", side: "sell", quantity: 1e9, executedQty: 1e9, price: calls.protFillPrice, status: "filled" as const, timestamp: new Date() };
        }
        return null;
      },
      async cancelOrderByClientId(_s: string, cid: string) { calls.cancelled.push(cid); return true; },
      async cancelOrder() { return true; },
      async normalizeQuantity(_s: string, q: number) { return q; },
      async getBalance() { return { totalAsset: calls.cashBalance, cashBalance: calls.cashBalance, currency: "USDT" }; },
      async getPositions() { return []; },
    },
  }),
}));

import * as store from "../src/store/db.js";
import { tickBot } from "../src/runner/runner.js";
import type { StrategyNode } from "../src/core/types/strategy.js";

const bar = (i: number, c: number) => { const iso = new Date(Date.UTC(2025, 0, 1) + i * 3600000).toISOString(); return { date: iso.slice(0, 10), datetime: iso, open: c, high: c + 0.2, low: c - 0.2, close: c, volume: 1000 }; };
const flat = (n: number, c: number) => Array.from({ length: n }, (_, i) => bar(i, c));

// buy: sma(1)<95 / sell: sma(1)>105. 가격 90=항상매수·SL미발동, 가격 100=관망(재매수 안 함).
const strat: StrategyNode = { id: "l", type: "leaf", name: "bls", strategy: { id: "s", userId: "u", name: "s", description: "", symbol: "BTCUSDT",
  rules: [
    { id: "b", action: "buy", conditions: [{ id: "c", indicator: "sma", params: { period: 1 }, operator: "lt", value: 95 }], quantityPercent: 100 },
    { id: "se", action: "sell", conditions: [{ id: "c2", indicator: "sma", params: { period: 1 }, operator: "gt", value: 105 }], quantityPercent: 100 },
  ], isActive: true, createdAt: new Date(), updatedAt: new Date() } };

let botId: string;

beforeAll(() => {
  const comp = store.insertComposite({ name: "protfill", root_node: strat, symbol: "BTCUSDT", market: "spot", leverage: 1, stop_loss_percent: 5, take_profit_percent: 10, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
  const bot = store.insertBot({ name: "protfill-bot", symbol: "BTCUSDT", composite_strategy_id: comp.id, mode: "live", capital: 1000, broker: "binance", interval_seconds: 3600 });
  botId = bot.id;
});

describe("#6 상주 SL/TP 거래소 체결 reconcile", () => {
  it("진입(SL+TP 배치) → 거래소 SL 체결 → 다음 틱에 SELL 멱등 기록 + TP 취소 + 청산", async () => {
    // ── 틱1: 가격 90 → 매수 + 상주 SL/TP 배치
    klinesMock.mockResolvedValue(flat(60, 90));
    const r1 = await tickBot(botId);
    expect(r1.action).toBe("buy");
    const p1 = store.getBot(botId)?.position_state as { qty: number; protectiveIds?: string[]; live?: boolean } | null;
    expect(p1?.qty).toBeGreaterThan(0);
    expect(p1?.live).toBe(true);
    expect((p1?.protectiveIds ?? []).length).toBe(2); // SL + TP 두 다리
    const protBefore = [...(p1?.protectiveIds ?? [])];

    // ── 틱2: 가격 100(관망) + 거래소 SL 체결 시뮬
    calls.protFilled = true;
    klinesMock.mockResolvedValue(flat(60, 100));
    await tickBot(botId);

    const after = store.getBot(botId)?.position_state;
    expect(after).toBeNull(); // 청산 완료

    const trades = store.recentTrades(botId, 20);
    const recSells = trades.filter((t) => t.reason?.includes("상주 SL/TP 거래소 체결"));
    expect(recSells.length).toBe(1);
    expect(recSells[0].side).toBe("sell");
    expect(recSells[0].price).toBeCloseTo(85);
    expect(recSells[0].is_paper).toBe(0); // 실거래 체결

    // 잔여 leg(체결 안 된 다리) 취소됨
    expect(calls.cancelled.some((c) => protBefore.includes(c))).toBe(true);

    // ── 틱3: 멱등 — 포지션 없음 + 재기록 0(같은 cid)
    klinesMock.mockResolvedValue(flat(60, 100));
    await tickBot(botId);
    const recSells2 = store.recentTrades(botId, 20).filter((t) => t.reason?.includes("상주 SL/TP 거래소 체결"));
    expect(recSells2.length).toBe(1); // 여전히 1건(이중기록 없음)
  });
});
