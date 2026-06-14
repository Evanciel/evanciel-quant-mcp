/**
 * unknown-reconcile.test.ts — P1-2: 주문 결과불명(unknown) 누적 → 강제 reconcile.
 *
 * 시나리오: 라이브 보유 포지션의 매도가 모호 실패(placeOrder throw + getOrderByClientId throw=unknown)로
 *   반복 → unknownCount 누적 → UNKNOWN_MAX_COUNT 도달 시 강제 getPositions reconcile로 거래소 진실 수렴.
 *   reconcileLivePosition(KR 전용 가드)이 못 덮는 바이낸스 발산을 보완.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-unknown-${process.pid}`);
process.env.BINANCE_ENV = "testnet";
process.env.BINANCE_API_KEY = "x".repeat(64);
process.env.BINANCE_API_SECRET = "y".repeat(64);
// UNKNOWN_MAX_COUNT는 runner 모듈 로드 시 평가(ESM import 호이스팅으로 env 후설정이 안 먹음) → 기본 5로 검증.
const MAX = 5;

const calls = vi.hoisted(() => ({ exchangeQty: 0.01, getPositionsCount: 0 }));
const klinesMock = vi.hoisted(() => vi.fn());
vi.mock("../src/data/binance-public.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, fetchKlines: klinesMock, buildAuxSeries: actual.buildAuxSeries };
});
vi.mock("../src/brokers/index.js", () => ({
  getAdapter: () => ({
    adapter: {
      // 매도 placeOrder는 항상 throw(네트워크 모호 실패)
      async placeOrder() { throw new Error("network timeout(mock)"); },
      // getOrderByClientId도 throw → fillOrder verdict=unknown
      async getOrderByClientId() { throw new Error("requery timeout(mock)"); },
      async cancelOrderByClientId() { return true; },
      async cancelOrder() { return true; },
      async getBalance() { return { totalAsset: 1e6, cashBalance: 1e6, currency: "USDT" }; },
      async getPositions() { calls.getPositionsCount++; return calls.exchangeQty > 0 ? [{ symbol: "BTC", quantity: calls.exchangeQty, avgPrice: 100 }] : []; },
    },
  }),
  configuredBrokers: () => [],
}));

import * as store from "../src/store/db.js";
import { tickBot } from "../src/runner/runner.js";
import type { StrategyNode } from "../src/core/types/strategy.js";

const bar = (i: number, c: number) => { const iso = new Date(Date.UTC(2025, 0, 1) + i * 3600000).toISOString(); return { date: iso.slice(0, 10), datetime: iso, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000 }; };
// 저가 매수(sma<95) → 고가 매도(sma>105). 엔진이 윈도 내에서 매수+매도 → want=flat, res.trades>0
//   (윈도우 안전장치 통과). 주입된 라이브 보유와의 델타가 '매도'가 되어 sell 분기로 진입.
const buyLowSellHigh: StrategyNode = { id: "l", type: "leaf", name: "s", strategy: { id: "s", userId: "u", name: "s", description: "", symbol: "BTCUSDT",
  rules: [
    { id: "b", action: "buy", conditions: [{ id: "c", indicator: "sma", params: { period: 1 }, operator: "lt", value: 95 }], quantityPercent: 100 },
    { id: "se", action: "sell", conditions: [{ id: "c2", indicator: "sma", params: { period: 1 }, operator: "gt", value: 105 }], quantityPercent: 100 },
  ], isActive: true, createdAt: new Date(), updatedAt: new Date() } };

let botId: string;
beforeAll(() => {
  const comp = store.insertComposite({ name: "u", root_node: buyLowSellHigh, symbol: "BTCUSDT", market: "spot", leverage: 1, stop_loss_percent: null, take_profit_percent: null, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
  botId = store.insertBot({ name: "u-bot", symbol: "BTCUSDT", composite_strategy_id: comp.id, mode: "live", capital: 1000, broker: "binance", interval_seconds: 3600 }).id;
});
// 앞 40봉 저가(90, 매수) + 뒤 9봉 고가(110, 매도) → 엔진 want=flat, trades>0. 마지막은 형성봉(슬라이스 제거).
beforeEach(() => { calls.getPositionsCount = 0; klinesMock.mockResolvedValue(Array.from({ length: 50 }, (_, i) => bar(i, i < 40 ? 90 : 110))); });

describe("P1-2 unknown 누적 → 강제 reconcile", () => {
  it("매도 결과불명 반복 → unknownCount 누적 후 임계서 강제 getPositions reconcile", async () => {
    // 라이브 보유 포지션 주입(거래소에도 0.01 존재)
    store.setBotPositionState(botId, { status: "open", entryAvg: 100, qty: 0.01, openedAt: new Date().toISOString(), live: true }, true, false);
    calls.exchangeQty = 0.01;

    // 틱1~MAX: 매도 unknown → 누적 1..MAX
    for (let i = 1; i <= MAX; i++) {
      const r = await tickBot(botId);
      expect(r.action).toBe("hold"); // 매도 실패 → 동결
      const ps = store.getBot(botId)?.position_state as { unknownCount?: number };
      expect(ps?.unknownCount).toBe(i);
    }
    // 다음 틱: 임계(MAX) 도달 상태로 진입 → 강제 reconcile 호출(getPositions) → 거래소 0.01 채택 + 카운트 리셋
    const before = calls.getPositionsCount;
    await tickBot(botId);
    expect(calls.getPositionsCount).toBeGreaterThan(before); // 강제 reconcile이 getPositions 호출
    const ps = store.getBot(botId)?.position_state as { unknownCount?: number; qty: number };
    // 강제 reconcile이 0으로 리셋 → 같은 틱의 매도 재실패로 1. (리셋 없었다면 MAX+1=6이었을 것 → 리셋 증거)
    expect(ps.unknownCount).toBe(1);
    expect(ps.qty).toBeCloseTo(0.01); // 거래소 진실 유지(adopt, 매도 실패로 보유 지속)
  });
});
