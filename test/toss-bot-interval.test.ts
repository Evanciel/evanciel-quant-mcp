/**
 * toss-bot-interval.test.ts — 적대검증 #12: 토스는 캔들 1m/1d만 지원 → 그 외 인터벌 봇은 러너에서 매 틱
 * getCandles throw로 '러닝이지만 평가 불가'한 유령봇이 된다. create_bot이 사전 거절하는지 + secsToInterval 경계.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

const saved = process.env.QUANT_MCP_DATA_DIR;
beforeEach(() => { process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `qmc-tossiv-${process.pid}-${Date.now()}`); });
afterEach(() => { if (saved === undefined) delete process.env.QUANT_MCP_DATA_DIR; else process.env.QUANT_MCP_DATA_DIR = saved; });

const leafTree = {
  id: "l", type: "leaf", name: "x",
  strategy: {
    id: "s", userId: "u", name: "s", description: "", symbol: "005930",
    rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "sma", params: { period: 1 }, operator: "lt", value: 1 }], quantityPercent: 100 }],
    isActive: true, createdAt: new Date(), updatedAt: new Date(),
  },
};

describe("토스 봇 인터벌 검증(#12 silent dead bot 방지)", () => {
  it("secsToInterval: 토스 지원은 1m(<=60)·1d(14400<s<=86400)뿐, 그 사이는 미지원 인트라데이", async () => {
    const { secsToInterval } = await import("../src/runner/runner.js");
    expect(secsToInterval(60)).toBe("1m");
    expect(secsToInterval(3600)).toBe("1h");  // 미지원(토스)
    expect(secsToInterval(900)).toBe("15m");  // 미지원(토스)
    expect(secsToInterval(86400)).toBe("1d");
  });

  it("createBot: 토스 + 1h(3600s) 거절, 1m/1d 허용", async () => {
    const H = await import("../src/mcp-server/bot-handlers.js");
    const comp = H.saveComposite({ name: "c", tree: leafTree, symbol: "005930" }) as { ok: boolean; compositeStrategyId?: string };
    expect(comp.ok).toBe(true);
    const cid = comp.compositeStrategyId as string;

    const bad = H.createBot({ name: "bad", compositeStrategyId: cid, broker: "toss", intervalSeconds: 3600 }) as { ok: boolean; error?: string };
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain("1m/1d");

    const good1m = H.createBot({ name: "g1", compositeStrategyId: cid, broker: "toss", intervalSeconds: 60 }) as { ok: boolean };
    expect(good1m.ok).toBe(true);
    const good1d = H.createBot({ name: "g2", compositeStrategyId: cid, broker: "toss", intervalSeconds: 86400 }) as { ok: boolean };
    expect(good1d.ok).toBe(true);
  });

  it("createBot: binance는 어떤 인터벌도 허용(토스 전용 제약)", async () => {
    const H = await import("../src/mcp-server/bot-handlers.js");
    const comp = H.saveComposite({ name: "c2", tree: { ...leafTree, strategy: { ...leafTree.strategy, symbol: "BTCUSDT" } }, symbol: "BTCUSDT" }) as { ok: boolean; compositeStrategyId?: string };
    const r = H.createBot({ name: "bn", compositeStrategyId: comp.compositeStrategyId as string, broker: "binance", intervalSeconds: 3600 }) as { ok: boolean };
    expect(r.ok).toBe(true);
  });
});
