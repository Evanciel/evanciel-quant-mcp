/**
 * portfolio-cap-parity.test.ts — 포트폴리오 레벨 캡 배선(opt-in)의 backtest≡live·legacy 회귀 보장.
 *
 * 검증:
 *  1) [PARITY] env 미설정 → 진입 수량/포지션이 기존 공식 그대로(legacy 바이트 동일, 회귀 0).
 *  2) [BLOCK]  heat 캡 초과 → 진입 차단(거래 0, 보유 불변). 매도/청산 경로는 게이트 무관.
 *  3) [SCALE]  MDD 디리스킹(dd 10%) → 진입 수량이 0.5배로 축소(증액 아님), 보유 넷=실제 도달분.
 *
 * 핵심: 게이트는 엔진이 want.qty를 정한 '뒤' 라이브 진입 델타에만 적용되는 throttle →
 *  백테스트(포트폴리오 컨텍스트 없음)는 불변 → backtest≡live 유지. 캡은 '축소/차단'만(절대 증액 없음).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-portcap-${process.pid}`);

const klinesMock = vi.hoisted(() => vi.fn());
vi.mock("../src/data/binance-public.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, fetchKlines: klinesMock };
});

import * as store from "../src/store/db.js";
import { tickBot } from "../src/runner/runner.js";
import { floorQty } from "../src/core/position/qty.js";
import type { StrategyNode } from "../src/core/types/strategy.js";

// 항상 매수(rsi<200), 절대 매도 안 함 → 진입 1회. 종가 일정(평탄)이라 진입가 예측 가능.
const alwaysBuy: StrategyNode = {
  id: "l", type: "leaf", name: "rsi", strategy: {
    id: "s", userId: "u", name: "s", description: "", symbol: "TESTUSDT",
    rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: 200 }], quantityPercent: 100 }],
    isActive: true, createdAt: new Date(), updatedAt: new Date(),
  },
};

// 종가 100 고정 평탄 봉(워밍업 충족). 마지막은 형성 중(닫힌봉=N-1).
function flatBars(n: number, price = 100) {
  return Array.from({ length: n }, (_, i) => {
    const ms = Date.UTC(2025, 0, 1) + i * 3600000;
    const iso = new Date(ms).toISOString();
    return { date: iso.slice(0, 10), datetime: iso, open: price, high: price * 1.001, low: price * 0.999, close: price, volume: 1000 };
  });
}

const CAP = 100_000;
const PRICE = 100;

const ENV_KEYS = ["QUANT_MCP_PORTFOLIO_MAX_HEAT", "QUANT_MCP_PORTFOLIO_RISK_BUDGET", "QUANT_MCP_PORTFOLIO_AVG_CORR", "QUANT_MCP_PORTFOLIO_MDD"];
beforeEach(() => { for (const k of ENV_KEYS) delete process.env[k]; klinesMock.mockResolvedValue(flatBars(50, PRICE)); });
afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

function makeBot(name: string, capital = CAP): string {
  const comp = store.insertComposite({ name, root_node: alwaysBuy, symbol: "TESTUSDT", market: "spot", leverage: 1, stop_loss_percent: null, take_profit_percent: null, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
  return store.insertBot({ name, symbol: "TESTUSDT", composite_strategy_id: comp.id, mode: "paper", capital, broker: "binance", interval_seconds: 3600 }).id;
}

/**
 * 기준(legacy) 진입 수량을 '게이트 OFF'로 실제 1틱 실행해 관측(엔진 내부 슬리피지·수수료 규약을 그대로 반영).
 * 손으로 공식을 재현하지 않고 엔진의 실제 산출을 baseline으로 삼아 패리티를 비교 → 발산원 0.
 */
async function observeLegacyQty(capital: number): Promise<number> {
  for (const k of ENV_KEYS) delete process.env[k]; // 게이트 확실히 OFF
  const id = makeBot(`ref-${capital}-${Math.random().toString(36).slice(2)}`, capital);
  klinesMock.mockResolvedValue(flatBars(50, PRICE));
  const r = await tickBot(id);
  expect(r.action).toBe("buy");
  const q = store.recentTrades(id, 10).filter((t) => t.side === "buy")[0]?.qty;
  expect(q).toBeGreaterThan(0);
  return q!;
}

describe("포트폴리오 캡 — [PARITY] env 미설정 = legacy 바이트 동일", () => {
  it("게이트 OFF → 진입 수량/보유 넷이 엔진 기준 수량과 동일(축소/차단 없음)", async () => {
    const expected = await observeLegacyQty(CAP); // 동일 자본의 게이트 OFF 기준 수량 관측
    const botId = makeBot("parity", CAP);
    const r = await tickBot(botId);
    expect(r.action).toBe("buy");
    const buys = store.recentTrades(botId, 10).filter((t) => t.side === "buy");
    expect(buys).toHaveLength(1);
    expect(buys[0].qty).toBe(expected); // 정확히 기준 수량(바이트 동일)
    const ps = store.getBot(botId)?.position_state as { qty?: number } | null;
    expect(ps?.qty).toBe(expected); // 보유 넷도 기준 그대로
  });
});

describe("포트폴리오 캡 — [BLOCK] heat 초과 시 진입 차단", () => {
  let botId: string;
  beforeAll(() => { botId = makeBot("block"); });

  it("maxHeat 아주 작게 → 진입 노셔널만으로 heat≫cap → 차단(거래 0, 보유 없음)", async () => {
    process.env.QUANT_MCP_PORTFOLIO_MAX_HEAT = "0.01"; // 진입 노셔널(~capital)/equity ≈ 1.0 ≫ 0.01
    store.setBotStatus(botId, "running"); // 스냅샷 equity = 가동 봇 capital 합
    const r = await tickBot(botId);
    expect(r.action).toBe("hold");
    expect(r.detail).toContain("포트폴리오 캡");
    expect(store.recentTrades(botId, 10).filter((t) => t.side === "buy")).toHaveLength(0); // 진입 안 됨
    expect(store.getBot(botId)?.position_state).toBeNull(); // 보유 없음
  });
});

describe("포트폴리오 캡 — [SCALE] MDD 디리스킹으로 진입 수량 축소", () => {
  it("dd 10%(reduced) → 진입 델타가 0.5배로 축소(증액 아님), 보유 넷=실제 도달분", async () => {
    const SCALE_CAP = 1000; // 소액 자본 → dd 제어 쉬움
    const localLegacyQty = await observeLegacyQty(SCALE_CAP); // 게이트 OFF 기준 수량(엔진 산출) 먼저 관측
    const botId = makeBot("scale", SCALE_CAP);

    process.env.QUANT_MCP_PORTFOLIO_MDD = "true";
    // 이 봇만 가동(다른 테스트/관측이 running으로 남긴 봇 정지) → baseCapital=이 봇 capital(1000)만. dd 결정적.
    for (const b of store.listRunningBots()) store.setBotStatus(b.id, "stopped");
    store.setBotStatus(botId, "running");
    // 실현손익 곡선에 -100 손실 주입(equity=base+realized=1000-100=900, peak=base=1000 → dd=100/1000=10%).
    // 기존 buy 거래는 pnl=0이라 누적곡선 고점=0 → dd 계산 불변(결정적).
    store.insertTrade({ bot_id: botId, side: "sell", price: 100, qty: 1, pnl: -100, is_paper: 1, reason: "seed-loss", idempotency_key: `${botId}:seed-loss` });

    const r = await tickBot(botId);
    expect(r.action).toBe("buy");
    const buys = store.recentTrades(botId, 10).filter((t) => t.side === "buy");
    expect(buys).toHaveLength(1);
    // 진입 델타 = floorQty(기준 × 0.5). 0 < scaled < 기준(증액 없음, 축소만).
    const expectedScaled = floorQty(localLegacyQty * 0.5);
    expect(buys[0].qty).toBe(expectedScaled);
    expect(buys[0].qty).toBeGreaterThan(0);
    expect(buys[0].qty).toBeLessThan(localLegacyQty);
    const ps = store.getBot(botId)?.position_state as { qty?: number } | null;
    expect(ps?.qty).toBe(expectedScaled); // 보유 넷 = 실제 도달분(엔진 목표 미도달 → 다음 틱 폭주 방지)
  });
});
