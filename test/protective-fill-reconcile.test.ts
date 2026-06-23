/**
 * protective-fill-reconcile.test.ts — #6 거래소 상주 SL/TP 체결 reconcile 통합검증(mock 어댑터, 키 불필요).
 *
 * 검증: 라이브 바이낸스 봇이 진입 후 거래소 상주 STOP/TP가 거래소에서 체결되면(getOpenOrders에서 사라짐),
 *   다음 틱에 reconcileProtectiveFills가 getOrderByClientId로 체결을 잡아 SELL을 멱등 기록 + 잔여 leg 취소 +
 *   포지션 정리한다. 실거래소 계약은 scripts가 testnet 실검증.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-protfill-${process.pid}`);
process.env.BINANCE_ENV = "testnet";
process.env.BINANCE_API_KEY = "x".repeat(64);
process.env.BINANCE_API_SECRET = "y".repeat(64);

const calls = vi.hoisted(() => ({
  placed: [] as any[], cancelled: [] as string[], cashBalance: 100000,
  protFilled: false, protFillPrice: 85, slExec: 1e9, tpExec: 0, // slExec/tpExec>0 = 그 leg가 그 수량만큼 체결됨
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
        // leg별 체결 제어: slExec(pS)/tpExec(pT)>0면 그 수량만큼 filled. 기본 spot=SL만 전량, TP 미체결.
        if (!calls.protFilled) return null;
        if (/^pS/.test(cid) && calls.slExec > 0) return { orderId: "fS-" + cid, symbol: "BTCUSDT", side: "sell", quantity: calls.slExec, executedQty: calls.slExec, price: calls.protFillPrice, status: "filled" as const, timestamp: new Date() };
        if (/^pT/.test(cid) && calls.tpExec > 0) return { orderId: "fT-" + cid, symbol: "BTCUSDT", side: "sell", quantity: calls.tpExec, executedQty: calls.tpExec, price: calls.protFillPrice + 20, status: "filled" as const, timestamp: new Date() };
        return null; // 미체결
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

// 항상매수(rsi<200) — F4 같은-봉 재진입 억제 검증용(보호 체결 후 즉시 재매수 시도하는 신호).
const alwaysBuy: StrategyNode = { id: "l", type: "leaf", name: "ab", strategy: { id: "s2", userId: "u", name: "ab", description: "", symbol: "BTCUSDT",
  rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: 200 }], quantityPercent: 100 }], isActive: true, createdAt: new Date(), updatedAt: new Date() } };

function mkBot(root: StrategyNode) {
  const comp = store.insertComposite({ name: "protfill", root_node: root, symbol: "BTCUSDT", market: "spot", leverage: 1, stop_loss_percent: 5, take_profit_percent: 10, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
  return store.insertBot({ name: "protfill-bot", symbol: "BTCUSDT", composite_strategy_id: comp.id, mode: "live", capital: 1000, broker: "binance", interval_seconds: 3600 }).id;
}

let botId: string;
beforeAll(() => { botId = mkBot(strat); });
beforeEach(() => { calls.protFilled = false; calls.slExec = 1e9; calls.tpExec = 0; calls.cancelled.length = 0; calls.placed.length = 0; });

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

  it("F3: 같은 틱 다중 leg 체결 → 합산 기록(체결분 유실 없음, 오버셀 방지)", async () => {
    const id = mkBot(strat);
    klinesMock.mockResolvedValue(flat(60, 90));
    await tickBot(id); // 진입
    const q = (store.getBot(id)?.position_state as any).qty as number;
    // SL·TP 둘 다 부분 체결(합>포지션) → totalFilled는 포지션 전량으로 캡, 단일 SELL 합산 기록.
    calls.protFilled = true; calls.slExec = q * 0.6; calls.tpExec = q * 0.7;
    klinesMock.mockResolvedValue(flat(60, 100));
    await tickBot(id);
    const recSells = store.recentTrades(id, 20).filter((t) => t.reason?.includes("상주 SL/TP 거래소 체결"));
    expect(recSells.length).toBe(1);              // 합산 단일 기록(leg별 중복 아님)
    expect(recSells[0].qty).toBeCloseTo(q, 6);    // 포지션 전량으로 캡(1.3q 아님)
    expect(store.getBot(id)?.position_state).toBeNull(); // 전량 청산
  });

  it("F4: 보호 체결 봉에는 같은 봉 재진입 금지(always-buy 신호여도)", async () => {
    const id = mkBot(alwaysBuy);
    klinesMock.mockResolvedValue(flat(60, 90));
    await tickBot(id); // 진입(보유)
    const before = store.recentTrades(id, 50).filter((t) => t.side === "buy").length;
    // SL 체결 + always-buy 신호 동시 → reconcile이 청산하면 같은 틱엔 재매수 금지(백테 sltpExited 미러).
    calls.protFilled = true; calls.slExec = 1e9;
    klinesMock.mockResolvedValue(flat(60, 90)); // 가격 90 = always-buy 신호 유지
    const r = await tickBot(id);
    expect(r.action).toBe("sell");                // 보호 청산 액션
    const afterBuys = store.recentTrades(id, 50).filter((t) => t.side === "buy").length;
    expect(afterBuys).toBe(before);               // 새 매수 0(같은 봉 재진입 억제)
    expect(store.getBot(id)?.position_state).toBeNull();
  });
});
