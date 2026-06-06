/**
 * mcp-server.test.ts — MCP 서버 계층 검증. 네트워크 0(순수 핸들러 + 프로토콜 왕복).
 * ① 순수 핸들러 직접 호출  ② 서버 빌드  ③ InMemory transport로 validate_strategy 프로토콜 실호출.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp-server/index.js";
import { validateStrategy, portfolioRisk } from "../src/mcp-server/handlers.js";

const leaf = {
  id: "leaf", type: "leaf", name: "RSI",
  strategy: {
    id: "s", userId: "u", name: "RSI", description: "", symbol: "BTCUSDT",
    rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 14 }, operator: "lt", value: 30 }], quantityPercent: 100 }],
    isActive: true, createdAt: new Date("2025-01-01"), updatedAt: new Date("2025-01-01"),
  },
};

describe("quant-mcp server layer", () => {
  it("validateStrategy handler: valid tree → ok", () => {
    const r = validateStrategy({ tree: leaf });
    expect(r.ok).toBe(true);
    expect(r.valid).toBe(true);
  });

  it("validateStrategy handler: malformed tree → not ok", () => {
    const r = validateStrategy({ tree: { id: "x", type: "leaf", name: "bad" } });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("portfolioRisk handler: pure calc", () => {
    const r = portfolioRisk({ positions: [{ symbol: "BTCUSDT", riskFraction: 0.05 }], equity: 95_000, peakEquity: 100_000 });
    expect(r.ok).toBe(true);
    expect(Number.isFinite(r.heat)).toBe(true);
  });

  it("buildServer registers tools without throwing", () => {
    expect(() => buildServer()).not.toThrow();
  });

  it("protocol round-trip: client calls validate_strategy through MCP", async () => {
    const server = buildServer();
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      [
        // v1 분석 8툴 + scan_universe(스크리닝) + allocate_portfolio(배분)
        "backtest", "backtest_short", "derivatives_signal", "detect_regime", "portfolio_risk", "strategy_factory", "suggest_position_size", "validate_strategy", "scan_universe", "allocate_portfolio",
        // v2 봇/전략/대시보드 7툴
        "create_bot", "get_bot_status", "list_bots", "open_dashboard", "save_strategy", "start_bot", "stop_bot",
        // v2.5 라이브 4툴
        "live_status", "get_positions", "get_balance", "place_order",
      ].sort()
    );

    const res = await client.callTool({ name: "validate_strategy", arguments: { tree: leaf } });
    const payload = JSON.parse((res.content as { type: string; text: string }[])[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.valid).toBe(true);

    await client.close();
    await server.close();
  });
});
