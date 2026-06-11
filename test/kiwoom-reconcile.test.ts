/**
 * kiwoom-reconcile.test.ts — 체결 reconcile 러너 통합(거래소 실보유를 장부 진실로 동기화).
 *
 * 실측 배경(키움 모의서버): 키움 시장가는 지연체결 → 주문 시점 pending(price0), 잠시 후 실제 체결.
 *  Bug#2 fail-closed로 봇은 동결(장부 보유 0)하지만 거래소엔 체결 → 역방향 발산(거래소 보유 ↔ 장부 0).
 *  reconcileLivePosition이 tickBot 시작 시 거래소 실보유(getPositions)를 조회해 장부를 거래소 진실로 동기화한다.
 *
 * 검증: ① adopt(거래소 보유 → 장부 채택, 지연체결 반영) ② no_exchange_pos clear는 연속 N틱 후에만(지연체결 오삭제 방지)
 *  ③ 크립토(Binance, getOrderByClientId 지원)는 reconcile 미진입(getPositions 미호출) ④ 조회 실패 시 장부 불변.
 * 실 키움 호출 0(getAdapter 모킹, getPositions를 state로 제어).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-kiwoom-recon-${process.pid}`);
process.env.BINANCE_ENV = "testnet";
process.env.BINANCE_API_KEY = "x".repeat(64);
process.env.BINANCE_API_SECRET = "y".repeat(64);
process.env.KIWOOM_APPKEY = "ka";
process.env.KIWOOM_SECRETKEY = "ks";

type ExPos = { symbol: string; name?: string; quantity: number; avgPrice: number; currentPrice?: number; pnl?: number; pnlPercent?: number };
const state = vi.hoisted(() => ({
  kiwoomPositions: [] as ExPos[],     // 키움 거래소 실보유(테스트가 제어)
  kiwoomThrows: false,                 // getPositions throw 시뮬(조회 실패)
  kiwoomGetPosCalls: 0,
  binanceGetPosCalls: 0,
}));
const klinesMock = vi.hoisted(() => vi.fn());

vi.mock("../src/data/binance-public.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, fetchKlines: klinesMock };
});

vi.mock("../src/brokers/index.js", () => ({
  getAdapter: (broker: string) => {
    if (broker === "kiwoom") {
      return {
        adapter: {
          async normalizeQuantity(_s: string, q: number) { return Math.max(0, Math.floor(q)); },
          async placeOrder(o: Record<string, unknown>) { return { orderId: "kw", symbol: o.symbol, side: o.side, quantity: o.quantity, price: 0, status: "pending" as const, timestamp: new Date() }; },
          async getBalance() { return { totalAsset: 10_000_000, cashBalance: 10_000_000, currency: "KRW" }; },
          async getPositions() { state.kiwoomGetPosCalls++; if (state.kiwoomThrows) throw new Error("rate-limit(mock)"); return state.kiwoomPositions; },
          // getOrderByClientId 의도적 미정의 → reconcile 진입 대상(키움 실제 상태).
          async getCandles() { return klinesMock(); },
        },
      };
    }
    return {
      adapter: {
        async placeOrder(o: Record<string, unknown>) { return { orderId: "bn", symbol: o.symbol, side: o.side, quantity: o.quantity, price: 100, status: "filled" as const, timestamp: new Date() }; },
        async getOrderByClientId() { return null; },               // 지원 → reconcile 미진입
        async cancelOrder() { return true; },
        async getBalance() { return { totalAsset: 100000, cashBalance: 100000, currency: "USDT" }; },
        async getPositions() { state.binanceGetPosCalls++; return []; },
      },
    };
  },
}));

import * as store from "../src/store/db.js";
import { tickBot, __clearReconCache, type PaperPosition } from "../src/runner/runner.js";
import type { StrategyNode } from "../src/core/types/strategy.js";

// buy: sma(1)<95 / sell: sma(1)>105.
function mkLeaf(symbol: string): StrategyNode {
  return { id: "l", type: "leaf", name: "bl", strategy: { id: "s", userId: "u", name: "s", description: "", symbol,
    rules: [
      { id: "b", action: "buy", conditions: [{ id: "c", indicator: "sma", params: { period: 1 }, operator: "lt", value: 95 }], quantityPercent: 100 },
      { id: "se", action: "sell", conditions: [{ id: "c2", indicator: "sma", params: { period: 1 }, operator: "gt", value: 105 }], quantityPercent: 100 },
    ], isActive: true, createdAt: new Date(), updatedAt: new Date() } };
}
function krBars(n: number, price: number) {
  return Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10); return { date: d, datetime: `${d}T00:00:00+09:00`, open: price, high: price + 1, low: price - 1, close: price, volume: 1000 }; });
}
function mkBot(name: string, broker: "kiwoom" | "binance", symbol: string) {
  const comp = store.insertComposite({ name, root_node: mkLeaf(symbol), symbol, market: "spot", leverage: 1, stop_loss_percent: null, take_profit_percent: null, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
  return store.insertBot({ name, symbol, composite_strategy_id: comp.id, mode: "live", capital: 1_000_000, broker, interval_seconds: 86400 }).id;
}

beforeEach(() => { state.kiwoomPositions = []; state.kiwoomThrows = false; state.kiwoomGetPosCalls = 0; state.binanceGetPosCalls = 0; __clearReconCache(); });

describe("키움 체결 reconcile(거래소 실보유 → 장부 동기화)", () => {
  it("① adopt: 봇 장부 0 + 거래소 보유 5주(지연체결) → 장부에 5주 반영(거래소 진실)", async () => {
    klinesMock.mockResolvedValue(krBars(50, 100)); // 신호 없음(100=중립, buy<95·sell>105 미발동) → reconcile만 관찰
    const id = mkBot("kw-adopt", "kiwoom", "005930");
    state.kiwoomPositions = [{ symbol: "005930", name: "삼성", quantity: 5, avgPrice: 71000, currentPrice: 71000 }];
    await tickBot(id);
    const ps = store.getBot(id)?.position_state as PaperPosition | null;
    expect(ps?.status).toBe("open");
    expect(ps?.qty).toBe(5);          // 거래소 실보유 정수 채택
    expect(ps?.entryAvg).toBe(71000);
    expect(ps?.live).toBe(true);
    expect(state.kiwoomGetPosCalls).toBeGreaterThanOrEqual(1);
  });

  it("② clear 보수화: 라이브 장부 보유 ↔ 거래소 부재 → 연속 3틱 후에만 정정(지연체결 오삭제 방지)", async () => {
    klinesMock.mockResolvedValue(krBars(50, 100));
    const id = mkBot("kw-clear", "kiwoom", "005930");
    store.setBotPositionState(id, { status: "open", entryAvg: 71000, qty: 5, openedAt: new Date().toISOString(), live: true, peakPrice: 71000, protectiveIds: [], protFails: 0 } as PaperPosition, true, false);
    state.kiwoomPositions = []; // 거래소 부재
    await tickBot(id);
    expect((store.getBot(id)?.position_state as PaperPosition | null)?.qty).toBe(5); // 1틱: 유지(misses 1)
    await tickBot(id);
    expect((store.getBot(id)?.position_state as PaperPosition | null)?.qty).toBe(5); // 2틱: 유지(misses 2)
    await tickBot(id);
    expect(store.getBot(id)?.position_state).toBeNull();                              // 3틱: 정정(거래소 진실=무보유)
  });

  it("③ 회귀-크립토: 바이낸스(getOrderByClientId 지원)는 reconcile 미진입(getPositions 미호출)", async () => {
    klinesMock.mockResolvedValue(Array.from({ length: 50 }, (_, i) => { const iso = new Date(Date.UTC(2025, 0, 1) + i * 3600000).toISOString(); return { date: iso.slice(0, 10), datetime: iso, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 }; }));
    const id = mkBot("bn-norecon", "binance", "BTCUSDT");
    await tickBot(id);
    expect(state.binanceGetPosCalls).toBe(0); // reconcile 술어 미충족 → getPositions 미호출(거동/오버헤드 0)
  });

  it("④ 조회 실패(레이트리밋 throw) → 장부 임의 변경 금지(보수, 다음 틱 재시도)", async () => {
    klinesMock.mockResolvedValue(krBars(50, 100));
    const id = mkBot("kw-throw", "kiwoom", "005930");
    store.setBotPositionState(id, { status: "open", entryAvg: 71000, qty: 5, openedAt: new Date().toISOString(), live: true, peakPrice: 71000, protectiveIds: [], protFails: 0 } as PaperPosition, true, false);
    state.kiwoomThrows = true;
    await tickBot(id);
    expect((store.getBot(id)?.position_state as PaperPosition | null)?.qty).toBe(5); // 조회 실패 → 기존 보유 유지(삭제/생성 안 함)
  });
});
