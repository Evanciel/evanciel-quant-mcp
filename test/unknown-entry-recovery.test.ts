/**
 * unknown-entry-recovery.test.ts — #5 신규 진입 결과불명(unknown) 회수 통합검증(mock 어댑터, 키 불필요).
 *
 * 검증: 바이낸스 라이브 신규 진입 placeOrder가 unknown(타임아웃)으로 끝나면 → 재진입 억제 마커 영속(이중매수 차단).
 *   다음 틱 resolveUnknownEntry가 거래소 실보유를 **의도수량 한도**로 입양(주문이 실린 경우) 또는 N틱 연속 부재 시
 *   마커 해제(안 실린 경우). 실거래소 getPositions 계약은 testnet/mock 스크립트가 검증.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-unkentry-${process.pid}`);
process.env.BINANCE_ENV = "testnet";
process.env.BINANCE_API_KEY = "x".repeat(64);
process.env.BINANCE_API_SECRET = "y".repeat(64);

const calls = vi.hoisted(() => ({ throwEntry: false, ghostQty: 0, ghostAvg: 90, placed: [] as any[], cancelled: [] as string[] }));
const klinesMock = vi.hoisted(() => vi.fn());

vi.mock("../src/data/binance-public.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, fetchKlines: klinesMock };
});
vi.mock("../src/brokers/index.js", () => ({
  getAdapter: () => ({
    adapter: {
      async placeOrder(o: any) {
        // 신규 진입 시장가 매수만 throw(throwEntry) → fillOrder가 unknown 처리. 보호주문/그 외는 정상.
        if (calls.throwEntry && o.type === "market" && o.side === "buy") throw new Error("network timeout(mock entry)");
        calls.placed.push(o);
        return { orderId: "oid-" + calls.placed.length, symbol: o.symbol, side: o.side, quantity: o.quantity, executedQty: o.quantity, price: o.price ?? 90, status: "filled", timestamp: new Date() };
      },
      // throwEntry 동안엔 조회도 throw → verdict=unknown(실림 불명). 그 외엔 null(보호주문 미체결).
      async getOrderByClientId() { if (calls.throwEntry) throw new Error("query timeout(mock)"); return null; },
      async cancelOrderByClientId(_s: string, cid: string) { calls.cancelled.push(cid); return true; },
      async cancelOrder() { return true; },
      async normalizeQuantity(_s: string, q: number) { return q; },
      async getBalance() { return { totalAsset: 100000, cashBalance: 100000, currency: "USDT" }; },
      async getPositions() { return calls.ghostQty > 0 ? [{ symbol: "BTC", name: "BTC", quantity: calls.ghostQty, free: calls.ghostQty, avgPrice: calls.ghostAvg, currentPrice: calls.ghostAvg, pnl: 0, pnlPercent: 0 }] : []; },
    },
  }),
}));

import * as store from "../src/store/db.js";
import { tickBot } from "../src/runner/runner.js";
import type { StrategyNode } from "../src/core/types/strategy.js";

const bar = (i: number, c: number) => { const iso = new Date(Date.UTC(2025, 0, 1) + i * 3600000).toISOString(); return { date: iso.slice(0, 10), datetime: iso, open: c, high: c + 0.2, low: c - 0.2, close: c, volume: 1000 }; };
const flat = (n: number, c: number) => Array.from({ length: n }, (_, i) => bar(i, c));

// 항상매수(rsi<200) — 신규 진입 신호.
const strat: StrategyNode = { id: "l", type: "leaf", name: "buy", strategy: { id: "s", userId: "u", name: "s", description: "", symbol: "BTCUSDT",
  rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: 200 }], quantityPercent: 100 }], isActive: true, createdAt: new Date(), updatedAt: new Date() } };

function newBot() {
  const comp = store.insertComposite({ name: "unk", root_node: strat, symbol: "BTCUSDT", market: "spot", leverage: 1, stop_loss_percent: 5, take_profit_percent: 10, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
  return store.insertBot({ name: "unk-bot", symbol: "BTCUSDT", composite_strategy_id: comp.id, mode: "live", capital: 1000, broker: "binance", interval_seconds: 3600 });
}

beforeEach(() => { calls.throwEntry = false; calls.ghostQty = 0; calls.placed.length = 0; calls.cancelled.length = 0; klinesMock.mockResolvedValue(flat(60, 90)); });

describe("#5 신규 진입 결과불명 회수", () => {
  it("진입 unknown → 재진입 억제 마커 영속(매수 기록 0)", async () => {
    const bot = newBot();
    calls.throwEntry = true;
    const r = await tickBot(bot.id);
    expect(r.action).toBe("hold");
    const p = store.getBot(bot.id)?.position_state as any;
    expect(p?.pendingUnknownEntry).toBeTruthy();
    expect(p?.pendingUnknownEntry.intendedQty).toBeGreaterThan(0);
    expect(p?.qty).toBe(0);
    expect(store.recentTrades(bot.id, 10).length).toBe(0); // 유령 매수 기록 없음
  });

  it("마커 + 거래소 실보유 → 의도수량 이하 전량 입양 + 마커 제거", async () => {
    const bot = newBot();
    calls.throwEntry = true;
    await tickBot(bot.id); // 틱1: 마커
    const intended = (store.getBot(bot.id)?.position_state as any).pendingUnknownEntry.intendedQty as number;

    // 틱2: 주문이 실제로 실렸음(거래소 보유 = 의도보다 작게) → 전량 입양
    calls.throwEntry = false;
    calls.ghostQty = Math.max(1, Math.floor(intended * 0.7));
    await tickBot(bot.id);
    const adoptTrade = store.recentTrades(bot.id, 20).find((t) => t.reason?.includes("reconcile 입양"));
    expect(adoptTrade).toBeTruthy();
    expect(adoptTrade!.side).toBe("buy");
    expect(adoptTrade!.qty).toBeCloseTo(calls.ghostQty, 6);
    expect(adoptTrade!.is_paper).toBe(0);
    const p2 = store.getBot(bot.id)?.position_state as any;
    expect(p2?.pendingUnknownEntry).toBeUndefined(); // 마커 해소
    expect(p2?.qty).toBeGreaterThan(0);
  });

  it("거래소 보유가 의도수량 초과(수동보유 섞임) → 의도수량 한도로만 입양(오입양 방지)", async () => {
    const bot = newBot();
    calls.throwEntry = true;
    await tickBot(bot.id);
    const intended = (store.getBot(bot.id)?.position_state as any).pendingUnknownEntry.intendedQty as number;

    calls.throwEntry = false;
    calls.ghostQty = intended * 100; // 거래소엔 훨씬 많은 보유(수동분 섞임)
    await tickBot(bot.id);
    const adoptTrade = store.recentTrades(bot.id, 20).find((t) => t.reason?.includes("reconcile 입양"));
    expect(adoptTrade).toBeTruthy();
    expect(adoptTrade!.qty).toBeCloseTo(intended, 6); // 의도수량 한도로 캡(거래소 전량 아님)
  });

  it("거래소 부재 RECON_CLEAR_MISSES(3틱) 연속 → 마커 해제(재진입 허용)", async () => {
    const bot = newBot();
    calls.throwEntry = true;
    await tickBot(bot.id); // 마커
    calls.throwEntry = false;
    calls.ghostQty = 0; // 주문 안 실림(거래소 부재)
    await tickBot(bot.id); // miss 1
    expect((store.getBot(bot.id)?.position_state as any)?.pendingUnknownEntry?.misses).toBe(1);
    await tickBot(bot.id); // miss 2
    expect((store.getBot(bot.id)?.position_state as any)?.pendingUnknownEntry?.misses).toBe(2);
    await tickBot(bot.id); // miss 3 → clear
    const p = store.getBot(bot.id)?.position_state as any;
    expect(p?.pendingUnknownEntry).toBeFalsy(); // 마커 해제(null 또는 무마커)
  });
});
