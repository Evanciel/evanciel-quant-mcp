/**
 * scanner-live-guard.test.ts — P1-23: 스캐너 라이브 거절 + 부분체결 발산 버그 수정.
 *
 * (A) start_bot: 스캐너 봇 mode=live → 명시 거절(조용한 페이퍼 폴백 금지). 페이퍼는 허용.
 * (B) tickScanner 부분체결: 라이브 진입/청산이 부분만 체결되면 장부도 체결분만 기록(의도수량 기록 시 발산).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-scanner-guard-${process.pid}`);
process.env.BINANCE_ENV = "testnet";
process.env.BINANCE_API_KEY = "x".repeat(64);
process.env.BINANCE_API_SECRET = "y".repeat(64);

const calls = vi.hoisted(() => ({ fillRatio: 1.0 }));
const klinesMock = vi.hoisted(() => vi.fn());
vi.mock("../src/data/binance-public.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, fetchKlines: klinesMock, buildAuxSeries: actual.buildAuxSeries };
});
vi.mock("../src/brokers/index.js", () => ({
  getAdapter: () => ({
    adapter: {
      async placeOrder(o: { type: string; symbol: string; side: string; quantity: number; price?: number }) {
        const exec = o.type === "market" ? o.quantity * calls.fillRatio : o.quantity;
        return { orderId: "o-" + o.symbol + o.side, symbol: o.symbol, side: o.side, quantity: exec, executedQty: exec, origQty: o.quantity, price: o.price ?? 100, status: "filled", timestamp: new Date() };
      },
      async getBalance() { return { totalAsset: 1e9, cashBalance: 1e9, currency: "USDT" }; },
      async getPositions() { return []; },
    },
  }),
  configuredBrokers: () => [],
}));

import * as store from "../src/store/db.js";
import { tickBot } from "../src/runner/runner.js";
import { startBot } from "../src/mcp-server/bot-handlers.js";

const bar = (i: number, c: number) => { const iso = new Date(Date.UTC(2025, 0, 1) + i * 3600000).toISOString(); return { date: iso.slice(0, 10), datetime: iso, open: c, high: c + 1, low: c - 1, close: c, volume: 1000 }; };
// roc 상승 유니버스(진입 유도) — then은 항상 보유 희망(rsi<200)
const upBars = (n: number, base: number) => Array.from({ length: n }, (_, i) => bar(i, base + i));

const scannerNode = {
  id: "sc", type: "scanner", name: "급등", universe: ["AAAUSDT", "BBBUSDT", "CCCUSDT"],
  rank: { metric: "roc", top: 2 },
  then: { id: "l", type: "leaf", name: "hold", strategy: { id: "s", userId: "u", name: "s", description: "", symbol: "X",
    rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: 200 }], quantityPercent: 100 }],
    isActive: true, createdAt: new Date(), updatedAt: new Date() } },
};

function mkScannerBot(mode: "paper" | "live") {
  const comp = store.insertComposite({ name: `sc-${mode}`, root_node: scannerNode, symbol: "AAAUSDT", market: "spot", leverage: 1, stop_loss_percent: null, take_profit_percent: null, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
  return store.insertBot({ name: `sc-${mode}`, symbol: "AAAUSDT", composite_strategy_id: comp.id, mode, capital: 100000, broker: "binance", interval_seconds: 3600 });
}

describe("P1-23 (A) 스캐너 라이브 거절", () => {
  it("scanner + live → start_bot 거절", () => {
    const b = mkScannerBot("live");
    const r = startBot({ botId: b.id }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("스캐너");
  });
  it("scanner + paper → 허용", () => {
    const b = mkScannerBot("paper");
    const r = startBot({ botId: b.id }) as { ok: boolean };
    expect(r.ok).toBe(true);
  });
});

describe("P1-23 (B) 스캐너 부분체결 장부 정합", () => {
  let liveBotId: string;
  beforeAll(() => {
    // 라이브 스캐너는 start_bot이 막지만, tickScanner 자체의 부분체결 처리는 게이트 통과(testnet) 시 동작하므로
    // tickBot을 직접 호출해 검증(실제 운영은 start_bot 거절이 1차 방어, 이 경로는 심층 방어).
    liveBotId = mkScannerBot("live").id;
    klinesMock.mockImplementation((sym: string) => Promise.resolve(upBars(50, sym === "AAAUSDT" ? 100 : sym === "BBBUSDT" ? 90 : 80)));
  });
  it("부분체결(50%) 진입 → 장부 qty = 체결분", async () => {
    calls.fillRatio = 0.5;
    const r = await tickBot(liveBotId);
    expect(r.action).toBe("buy");
    const ps = store.getBot(liveBotId)?.position_state as Record<string, { qty: number }>;
    const syms = Object.keys(ps);
    expect(syms.length).toBeGreaterThanOrEqual(1);
    // 각 보유 심볼의 trade.qty와 position.qty가 일치(체결분) — 의도수량(2배)이 아님
    for (const sym of syms) {
      const buy = store.recentTrades(liveBotId, 50).find((t) => t.side === "buy" && t.reason.includes(sym));
      expect(buy).toBeTruthy();
      expect(ps[sym].qty).toBeCloseTo(buy!.qty, 8); // 장부=거래소 체결분 일치
    }
  });
});
