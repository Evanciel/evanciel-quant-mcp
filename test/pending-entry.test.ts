/**
 * pending-entry.test.ts — audit P1-5 PR-3: 지정가 진입 pendingEntry 상태머신(라이브 러너).
 *   ① 신호 → LIMIT 배치 → pendingEntry 영속 + hold  ② 다음 틱 체결 → 포지션 개시·pendingEntry 해제
 *   ③ 타임아웃 → 취소 + 캡게이트 통과 시 시장가 폴백 개시  ④ 캡 초과 → freeze(시장가 안 냄, flat)
 *   ⑤ Q7: 대기 중 reconcile(getPositions) 미진입 + 중복 주문 없음  ⑥ KR limit start_bot 거절
 * 실거래 0 — getAdapter/fetchKlines 모킹. 시장가 경로는 entry 미전달이라 기존과 동일(별도 회귀 테스트 불요).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-pending-${process.pid}`);
process.env.BINANCE_ENV = "testnet";
process.env.BINANCE_API_KEY = "x".repeat(64);
process.env.BINANCE_API_SECRET = "y".repeat(64);

const ctl = vi.hoisted(() => ({ orderStatus: "pending" as "pending" | "filled" | "rejected" | "missing", restingQty: 0, executedQty: 0, quote: 100, limitCid: "", placeCalls: [] as { type: string; price?: number }[], cancelCalls: 0, getPositionsCount: 0 }));
const klinesMock = vi.hoisted(() => vi.fn());
vi.mock("../src/data/binance-public.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, fetchKlines: klinesMock, buildAuxSeries: actual.buildAuxSeries };
});
vi.mock("../src/brokers/index.js", () => ({
  getAdapter: () => ({ env: "testnet", adapter: {
    async placeOrder(o: { type: string; price?: number; quantity: number; clientOrderId: string }) {
      ctl.placeCalls.push({ type: o.type, price: o.price });
      if (o.type === "limit") { ctl.restingQty = o.quantity; ctl.limitCid = o.clientOrderId; return { orderId: "L1", symbol: "BTCUSDT", side: "buy", quantity: o.quantity, price: 0, status: "pending", timestamp: new Date() }; }
      return { orderId: "M1", symbol: "BTCUSDT", side: "buy", quantity: o.quantity, price: ctl.quote, status: "filled", executedQty: o.quantity, origQty: o.quantity, timestamp: new Date() };
    },
    async getOrderByClientId(_s: string, cid: string) {
      if (cid !== ctl.limitCid) return null; // 미발행 cid(사전체크/시장가 cid) → 거래소에 없음(실거래소 동형)
      if (ctl.orderStatus === "missing") return null; // 인덱싱 지연(testnet 실측): 방금 낸 주문이 조회 null
      const base = { orderId: "L1", symbol: "BTCUSDT", side: "buy" as const, origQty: ctl.restingQty, timestamp: new Date() };
      if (ctl.orderStatus === "filled") return { ...base, quantity: ctl.restingQty, executedQty: ctl.restingQty, price: 99, status: "filled" as const };
      if (ctl.orderStatus === "rejected") return { ...base, quantity: 0, executedQty: 0, price: 0, status: "rejected" as const };
      return { ...base, quantity: ctl.restingQty, executedQty: ctl.executedQty, price: 0, status: "pending" as const };
    },
    async cancelOrderByClientId() { ctl.cancelCalls++; return true; },
    async getPrice() { return { symbol: "BTCUSDT", price: ctl.quote, change: 0, changePercent: 0, volume: 0, timestamp: new Date() }; },
    async getBalance() { return { totalAsset: 1e6, cashBalance: 1e6, currency: "USDT" }; },
    async getPositions() { ctl.getPositionsCount++; return []; },
    async normalizeQuantity(_s: string, q: number) { return q; },
  } }),
  configuredBrokers: () => [],
}));

import * as store from "../src/store/db.js";
import { tickBot } from "../src/runner/runner.js";
import { startBot } from "../src/mcp-server/bot-handlers.js";
import type { StrategyNode } from "../src/core/types/strategy.js";

const HOUR = 3600000;
// fetched[n-2]=마지막 닫힌 봉(러너가 forming 마지막 1봉 슬라이스) → 그 datetime이 lastIso. close=100 고정(buy-always 발화).
const bars = (lastClosedMs: number, n = 40) => Array.from({ length: n }, (_, i) => { const t = lastClosedMs - (n - 2 - i) * HOUR; const iso = new Date(t).toISOString(); return { date: iso.slice(0, 10), datetime: iso, open: 100, high: 100.5, low: 100, close: 100, volume: 1000 }; });
const buyAlways: StrategyNode = { id: "l", type: "leaf", name: "x", strategy: { id: "s", userId: "u", name: "s", description: "", symbol: "BTCUSDT", rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "sma", params: { period: 1 }, operator: "lt", value: 99999 }], quantityPercent: 100 }], isActive: true, createdAt: new Date(), updatedAt: new Date() } };

function mkBot(entryExecution: unknown, broker = "binance") {
  const comp = store.insertComposite({ name: "pe", root_node: buyAlways, symbol: "BTCUSDT", market: "spot", leverage: 1, stop_loss_percent: null, take_profit_percent: null, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null, entry_execution: entryExecution });
  return store.insertBot({ name: "pe-bot", symbol: "BTCUSDT", composite_strategy_id: comp.id, mode: "live", capital: 1000, broker, interval_seconds: 3600 }).id;
}
const limitEE = { type: "limit", limitOffsetPct: -1, timeoutBars: 2, maxSlippagePct: 0.5 };
const baseMs = Date.UTC(2025, 0, 10, 0, 0, 0);

beforeEach(() => { ctl.orderStatus = "pending"; ctl.restingQty = 0; ctl.executedQty = 0; ctl.quote = 100; ctl.limitCid = ""; ctl.placeCalls = []; ctl.cancelCalls = 0; ctl.getPositionsCount = 0; });

describe("P1-5 pendingEntry 상태머신", () => {
  it("① 신호 → 지정가 배치 → pendingEntry 영속 + hold", async () => {
    const id = mkBot(limitEE);
    klinesMock.mockResolvedValue(bars(baseMs));
    const r = await tickBot(id);
    expect(r.action).toBe("hold");
    expect(ctl.placeCalls.filter((p) => p.type === "limit")).toHaveLength(1);
    expect(ctl.placeCalls[0].price).toBeCloseTo(99, 6); // 100*(1-1%)
    const ps = store.getBot(id)?.position_state as { pendingEntry?: { limitPrice: number } };
    expect(ps?.pendingEntry?.limitPrice).toBeCloseTo(99, 6);
  });

  it("② 다음 틱 체결 → 포지션 개시 + pendingEntry 해제", async () => {
    const id = mkBot(limitEE);
    klinesMock.mockResolvedValue(bars(baseMs));
    await tickBot(id);                       // 배치
    ctl.orderStatus = "filled";              // 거래소 체결
    klinesMock.mockResolvedValue(bars(baseMs + HOUR)); // 다음 봉
    const r = await tickBot(id);
    expect(r.action).toBe("hold");           // 같은 틱 추가행동 없음
    const ps = store.getBot(id)?.position_state as { qty: number; pendingEntry?: unknown };
    expect(ps.qty).toBeGreaterThan(0);       // 개시됨
    expect(ps.pendingEntry).toBeUndefined(); // 해제됨
    expect(ctl.placeCalls.filter((p) => p.type === "limit")).toHaveLength(1); // 중복 배치 없음
  });

  it("③ 타임아웃 → 취소 + 캡 통과 시장가 폴백 → 개시", async () => {
    const id = mkBot(limitEE);
    klinesMock.mockResolvedValue(bars(baseMs));
    await tickBot(id);                       // 배치(placedBarIso=baseMs)
    ctl.quote = 99;                          // 캡 통과(지정가 99 대비 0%)
    klinesMock.mockResolvedValue(bars(baseMs + 3 * HOUR)); // 3봉 경과 ≥ timeoutBars 2
    await tickBot(id);
    expect(ctl.cancelCalls).toBeGreaterThan(0);                       // 지정가 취소
    expect(ctl.placeCalls.filter((p) => p.type === "market")).toHaveLength(1); // 시장가 폴백
    const ps = store.getBot(id)?.position_state as { qty: number; pendingEntry?: unknown };
    expect(ps.qty).toBeGreaterThan(0);
    expect(ps.pendingEntry).toBeUndefined();
  });

  it("④ 타임아웃 + 캡 초과 → freeze(시장가 안 냄, flat)", async () => {
    const id = mkBot(limitEE);
    klinesMock.mockResolvedValue(bars(baseMs));
    await tickBot(id);
    ctl.quote = 105;                         // 지정가 99 대비 +6% > 캡 0.5%
    klinesMock.mockResolvedValue(bars(baseMs + 3 * HOUR));
    const r = await tickBot(id);
    expect(ctl.placeCalls.filter((p) => p.type === "market")).toHaveLength(0); // 시장가 미발사
    expect(store.getBot(id)?.position_state).toBeNull();                       // flat(대기 해제)
    expect(r.detail).toMatch(/캡 초과|freeze/);
  });

  it("⑤ Q7: 대기 중 reconcile(getPositions) 미진입 + 중복 주문 없음", async () => {
    const id = mkBot(limitEE);
    klinesMock.mockResolvedValue(bars(baseMs));
    await tickBot(id);                       // 배치(bootSeed가 getPositions 1회 호출)
    const after = ctl.getPositionsCount;
    klinesMock.mockResolvedValue(bars(baseMs + HOUR)); // 아직 timeout 전(1봉)
    await tickBot(id);                       // 대기 유지
    expect(ctl.getPositionsCount).toBe(after);                        // reconcile 미진입
    expect(ctl.placeCalls.filter((p) => p.type === "limit")).toHaveLength(1); // 중복 배치 없음(crash-restart 멱등 동형)
  });

  it("⑦ 인덱싱 지연(조회 null=not_placed) + 타임아웃 전 → 대기 유지(유령 주문 방지)", async () => {
    const id = mkBot(limitEE);
    klinesMock.mockResolvedValue(bars(baseMs));
    await tickBot(id);                       // 배치
    ctl.orderStatus = "missing";             // 방금 낸 주문이 조회 null(testnet 인덱싱 지연)
    klinesMock.mockResolvedValue(bars(baseMs + HOUR)); // 1봉(timeout 2 미만)
    const r = await tickBot(id);
    expect(r.action).toBe("hold");
    const ps = store.getBot(id)?.position_state as { pendingEntry?: unknown };
    expect(ps?.pendingEntry).toBeDefined();  // 해제 안 함(회귀 전 버그: not_placed 즉시 해제 → 유령 주문)
    expect(ctl.placeCalls.filter((p) => p.type === "market")).toHaveLength(0); // 타임아웃 전이라 폴백도 안 함
  });

  it("⑥ KR(키움) limit 봇 start_bot 거절(fail-closed)", () => {
    const id = mkBot(limitEE, "kiwoom");
    const r = startBot({ botId: id }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/지정가|limit|P1-5/);
  });
});
