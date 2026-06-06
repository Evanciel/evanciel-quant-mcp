/**
 * runner-integration.test.ts — tickBot 통합(임시 스토어 + fetchKlines 모킹).
 * 검증: ① 형성봉 재틱(같은 닫힌봉 윈도우 반복) → 중복 체결 없음(멱등) ② 보유 중 엔진 무체결 → 청산 안 함(윈도우 가드).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 임시 데이터 디렉토리(격리). 스토어 첫 호출 전에 설정.
process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-itest-${process.pid}`);

// fetchKlines만 모킹(나머지 실제). vi.hoisted로 호이스팅된 mock fn 선언.
const klinesMock = vi.hoisted(() => vi.fn());
vi.mock("../src/data/binance-public.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, fetchKlines: klinesMock };
});

import * as store from "../src/store/db.js";
import { tickBot } from "../src/runner/runner.js";
import type { StrategyNode } from "../src/core/types/strategy.js";

// 종가 상승 봉 N개 + 마지막 '형성 중' 봉 1개. RSI 진입 전략.
function makeBars(n: number, start = 100, step = 0.5) {
  return Array.from({ length: n }, (_, i) => {
    const c = start + i * step;
    const ms = Date.UTC(2025, 0, 1) + i * 3600000;
    const isoFull = new Date(ms).toISOString();
    return { date: isoFull.slice(0, 10), datetime: isoFull, open: c, high: c * 1.001, low: c * 0.999, close: c, volume: 1000 };
  });
}

const rsiStrat: StrategyNode = {
  id: "l", type: "leaf", name: "rsi", strategy: {
    id: "s", userId: "u", name: "s", description: "", symbol: "TESTUSDT",
    rules: [
      { id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: 200 }], quantityPercent: 100 }, // 항상 매수
      { id: "se", action: "sell", conditions: [{ id: "c2", indicator: "rsi", params: { period: 2 }, operator: "gt", value: 200 }], quantityPercent: 100 }, // 절대 매도 안 함
    ], isActive: true, createdAt: new Date(), updatedAt: new Date(),
  },
};

let botId: string;
beforeAll(() => {
  const comp = store.insertComposite({ name: "t", root_node: rsiStrat, symbol: "TESTUSDT", market: "spot", leverage: 1, stop_loss_percent: null, take_profit_percent: null, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
  const bot = store.insertBot({ name: "tbot", symbol: "TESTUSDT", composite_strategy_id: comp.id, mode: "paper", capital: 1_000_000, broker: "binance", interval_seconds: 3600 });
  botId = bot.id;
});

describe("tickBot 통합", () => {
  it("형성봉 재틱: 같은 봉 데이터 반복 → 1회만 체결(멱등, 중복 없음)", async () => {
    const bars = makeBars(50); // 49 닫힘 + 1 형성
    klinesMock.mockResolvedValue(bars);
    const r1 = await tickBot(botId); // 첫 틱: 진입
    const r2 = await tickBot(botId); // 같은 형성봉 재틱: 닫힌봉 윈도우 동일 → 멱등 → 추가 체결 없음
    const r3 = await tickBot(botId);
    expect(r1.action).toBe("buy");
    expect(r2.action).toBe("hold"); // 중복 진입 안 함
    expect(r3.action).toBe("hold");
    const buys = store.recentTrades(botId, 50).filter((t) => t.side === "buy");
    expect(buys).toHaveLength(1); // 단 1회 진입 기록(닫힌봉 datetime 기준 멱등)
  });

  it("(B) 보유 중 엔진이 윈도우 내 무체결 → 청산 안 함(보유 유지)", async () => {
    // RSI 기간을 윈도우보다 크게 만들어 지표 NaN → 무체결이 되게: 봉 35개(닫힘 34)면 rsi period 2는 체결되므로,
    // 대신 '관망' 전략(절대 매수 안 함) 봇을 만들어 보유상태를 강제 주입 후 무체결 윈도우를 준다.
    const noTradeStrat: StrategyNode = { id: "l2", type: "leaf", name: "noop", strategy: { id: "s2", userId: "u", name: "s2", description: "", symbol: "TESTUSDT", rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: -999 }], quantityPercent: 100 }], isActive: true, createdAt: new Date(), updatedAt: new Date() } };
    const comp2 = store.insertComposite({ name: "t2", root_node: noTradeStrat, symbol: "TESTUSDT", market: "spot", leverage: 1, stop_loss_percent: null, take_profit_percent: null, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
    const bot2 = store.insertBot({ name: "tbot2", symbol: "TESTUSDT", composite_strategy_id: comp2.id, mode: "paper", capital: 1_000_000, broker: "binance", interval_seconds: 3600 });
    // 보유 상태 강제 주입
    store.setBotPositionState(bot2.id, { status: "open", entryAvg: 100, qty: 10, openedAt: new Date().toISOString() });
    klinesMock.mockResolvedValue(makeBars(50));
    const r = await tickBot(bot2.id);
    expect(r.action).toBe("hold"); // 무체결(엔진 trades=0) → 청산 안 함
    const sells = store.recentTrades(bot2.id, 50).filter((t) => t.side === "sell");
    expect(sells).toHaveLength(0); // 덤핑 없음
    const st = store.getBot(bot2.id)?.position_state as { qty?: number } | null;
    expect(st?.qty).toBe(10); // 보유 유지
  });
});
