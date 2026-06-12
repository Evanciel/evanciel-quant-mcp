/**
 * boot-seed.test.ts — P0-1 기동 포지션 시드 통합 회귀 ("재시작 + gate-off + state-null" 시나리오).
 *
 * 크래시 시그니처: 라이브 체결은 장부(trades, is_paper=0)에 남았는데 position_state=null.
 * 종전엔 liveGate OFF로 재기동하면 주기 reconcile(liveAdapterFor 경유)이 스킵돼 발산이 방치됐다 →
 * bootSeedLivePosition이 게이트와 무관하게(getAdapter 직접) read-only 조회로 1회 복원해야 한다.
 *
 * fail-closed 가드 회귀:
 *   - 라이브 체결 근거(liveOpenLedger) 없는 봇은 거래소 보유가 있어도 채택 금지(수동 보유 오입양 방지)
 *   - 채택 수량 = min(거래소, 장부) — 계좌에 섞인 수동 보유분 제외
 *   - ambiguous(다중 매칭) → 채택 보류
 * P1-8 회귀: 주기 reconcile에서 ambiguous 감지 시 봇 자동 정지(status=error).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-bootseed-${process.pid}`);

// getAdapter(거래소 read-only 스텁)와 liveGate(게이트 ON/OFF 제어)를 테스트에서 조작.
const adapterMock = vi.hoisted(() => ({
  positions: [] as { symbol: string; quantity: number; avgPrice: number }[],
  gateAllowed: false,
}));
vi.mock("../src/brokers/index.js", () => ({
  getAdapter: () => ({
    adapter: {
      // KR형 스텁: getOrderByClientId 없음(주기 reconcile 대상 브로커 모사)
      getPositions: async () => adapterMock.positions,
      getCandles: async () => makeBars(50),
    },
    env: "mock",
  }),
  configuredBrokers: () => [],
}));
vi.mock("../src/brokers/safety.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    liveGate: () => (adapterMock.gateAllowed ? { allowed: true, env: "mock", reason: "test" } : { allowed: false, reason: "test gate off" }),
  };
});

import * as store from "../src/store/db.js";
import { tickBot } from "../src/runner/runner.js";
import type { StrategyNode } from "../src/core/types/strategy.js";

function makeBars(n: number, start = 70000, step = 10) {
  return Array.from({ length: n }, (_, i) => {
    const c = start + i * step;
    const ms = Date.UTC(2025, 0, 1) + i * 3600000;
    const isoFull = new Date(ms).toISOString();
    return { date: isoFull.slice(0, 10), datetime: isoFull, open: c, high: c * 1.001, low: c * 0.999, close: c, volume: 1000 };
  });
}

// 절대 매매 안 하는 전략(시드/reconcile 동작만 관찰).
const noopStrat: StrategyNode = {
  id: "l", type: "leaf", name: "noop", strategy: {
    id: "s", userId: "u", name: "s", description: "", symbol: "005930",
    rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: -999 }], quantityPercent: 100 }],
    isActive: true, createdAt: new Date(), updatedAt: new Date(),
  },
};

function mkLiveBot(name: string): string {
  const comp = store.insertComposite({ name, root_node: noopStrat, symbol: "005930", market: "spot", leverage: 1, stop_loss_percent: null, take_profit_percent: null, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
  const bot = store.insertBot({ name, symbol: "005930", composite_strategy_id: comp.id, mode: "live", capital: 1_000_000, broker: "kiwoom", interval_seconds: 3600 });
  return bot.id;
}

beforeEach(() => { adapterMock.positions = []; adapterMock.gateAllowed = false; });

describe("P0-1 기동 포지션 시드 (재시작+gate-off+state-null)", () => {
  it("라이브 체결 근거 有 + 거래소 보유 → gate-off여도 장부 복원(adopt)", async () => {
    const botId = mkLiveBot("seed-adopt");
    // 크래시 시그니처: 라이브 매수 기록은 있는데 position_state=null
    store.insertTrade({ bot_id: botId, side: "buy", price: 70000, qty: 2, pnl: 0, is_paper: 0, reason: "진입", idempotency_key: `${botId}:b1` });
    adapterMock.positions = [{ symbol: "005930", quantity: 2, avgPrice: 70100 }];
    adapterMock.gateAllowed = false; // ★ 게이트 OFF — 종전엔 reconcile 스킵으로 발산 방치되던 시나리오

    await tickBot(botId);

    const ps = store.getBot(botId)?.position_state as { qty: number; entryAvg: number; live: boolean } | null;
    expect(ps).not.toBeNull();
    expect(ps!.qty).toBe(2);
    expect(ps!.entryAvg).toBe(70100); // 거래소 평단 우선
    expect(ps!.live).toBe(true);
  });

  it("거래소 보유가 장부 근거보다 많으면 min(거래소, 장부)만 채택 — 수동 보유 혼입 제외", async () => {
    const botId = mkLiveBot("seed-min");
    store.insertTrade({ bot_id: botId, side: "buy", price: 70000, qty: 1, pnl: 0, is_paper: 0, reason: "", idempotency_key: `${botId}:b1` });
    adapterMock.positions = [{ symbol: "005930", quantity: 5, avgPrice: 70100 }]; // 4주는 수동 보유

    await tickBot(botId);

    const ps = store.getBot(botId)?.position_state as { qty: number } | null;
    expect(ps!.qty).toBe(1); // 장부 근거 상한
  });

  it("거래소 평단 미상(0, 현물 잔고형) → 장부 가중평단 폴백", async () => {
    const botId = mkLiveBot("seed-avg-fallback");
    store.insertTrade({ bot_id: botId, side: "buy", price: 68000, qty: 1, pnl: 0, is_paper: 0, reason: "", idempotency_key: `${botId}:b1` });
    adapterMock.positions = [{ symbol: "005930", quantity: 1, avgPrice: 0 }];

    await tickBot(botId);

    const ps = store.getBot(botId)?.position_state as { entryAvg: number } | null;
    expect(ps!.entryAvg).toBe(68000);
  });

  it("라이브 체결 근거 無 → 거래소 보유가 있어도 채택 금지(수동 보유 오입양 방지, fail-closed)", async () => {
    const botId = mkLiveBot("seed-no-evidence");
    adapterMock.positions = [{ symbol: "005930", quantity: 10, avgPrice: 70000 }]; // 전부 수동 보유

    await tickBot(botId);

    expect(store.getBot(botId)?.position_state).toBeNull(); // 채택 안 함
  });

  it("ambiguous(거래소 다중 매칭) → 채택 보류", async () => {
    const botId = mkLiveBot("seed-ambiguous");
    store.insertTrade({ bot_id: botId, side: "buy", price: 70000, qty: 1, pnl: 0, is_paper: 0, reason: "", idempotency_key: `${botId}:b1` });
    adapterMock.positions = [
      { symbol: "005930", quantity: 1, avgPrice: 70000 },
      { symbol: "A005930", quantity: 2, avgPrice: 70500 }, // normSym 동일 → 다중 매칭
    ];

    await tickBot(botId);

    expect(store.getBot(botId)?.position_state).toBeNull();
  });

  it("시드는 프로세스 기동 후 봇당 1회만(같은 봇 재틱에 재채택 없음)", async () => {
    const botId = mkLiveBot("seed-once");
    store.insertTrade({ bot_id: botId, side: "buy", price: 70000, qty: 1, pnl: 0, is_paper: 0, reason: "", idempotency_key: `${botId}:b1` });
    adapterMock.positions = [{ symbol: "005930", quantity: 1, avgPrice: 70000 }];
    await tickBot(botId); // 1차: 시드
    store.setBotPositionState(botId, null, true, false); // 인위로 비움
    adapterMock.gateAllowed = false;
    adapterMock.positions = []; // 주기 reconcile도 무동작 조건
    await tickBot(botId); // 2차: 시드 재실행 안 됨
    expect(store.getBot(botId)?.position_state).toBeNull();
  });
});

describe("P1-8: 주기 reconcile ambiguous → 봇 자동 정지(error)", () => {
  it("gate-on에서 다중 매칭 감지 시 status=error로 전환", async () => {
    const botId = mkLiveBot("ambiguous-halt");
    store.setBotStatus(botId, "running");
    // 시드 비대상(장부 보유 존재) → 주기 reconcile 경로로 진입
    store.setBotPositionState(botId, { status: "open", entryAvg: 70000, qty: 1, openedAt: new Date().toISOString(), live: true }, true, false);
    adapterMock.gateAllowed = true; // 주기 reconcile은 게이트 통과 필요
    adapterMock.positions = [
      { symbol: "005930", quantity: 1, avgPrice: 70000 },
      { symbol: "005930.KS", quantity: 2, avgPrice: 70500 },
    ];

    await tickBot(botId);

    expect(store.getBot(botId)?.status).toBe("error"); // 경고만 하고 계속 돌던 종전 동작 금지
  });
});
