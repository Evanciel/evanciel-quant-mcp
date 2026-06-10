/**
 * live-protective-mcp.test.ts — OCO 보호주문이 MCP 툴 3개로 '노출'됐고, 그 노출이
 * 머니패스 불변식(2단계 confirmToken·fail-closed·read-only 분리)을 보존하는지 검증(mock 어댑터, 키 불필요).
 * 핸들러 단위 안전로직은 live-protective.test.ts(봇 배선)·safety.test.ts(토큰)가 커버 → 여기선 'MCP 노출 계약'에 집중.
 * 실거래소 OCO 계약은 scripts/verify-*-e2e가 testnet 실검증.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-protmcp-${process.pid}`);
// 라이브 게이트 통과용(testnet 가짜 키 — 실거래소 호출 안 함, 어댑터는 모킹).
process.env.BINANCE_ENV = "testnet";
process.env.BINANCE_API_KEY = "x".repeat(64);
process.env.BINANCE_API_SECRET = "y".repeat(64);

// OCO 어댑터 모킹: place_protective가 preview 단계까지 도달하려면 getPositions(보유)·getPrice(현재가)·placeOco·baseAssetOf 필요.
const oco = vi.hoisted(() => ({ placed: [] as any[], cancelled: [] as Array<{ symbol: string; orderListId: string }>, open: null as { orderListId: string; tpPrice: number; slPrice: number } | null }));
vi.mock("../src/brokers/index.js", () => ({
  configuredBrokers: () => [{ broker: "binance", market: "spot", env: "testnet", live: false }],
  getAdapter: () => ({
    env: "testnet",
    adapter: {
      async baseAssetOf(sym: string) { return sym.replace(/USDT$/i, ""); },
      async getPositions() { return [{ symbol: "BTC", name: "BTC", quantity: 1, free: 1, avgPrice: 100, currentPrice: 100, pnl: 0, pnlPercent: 0 }]; },
      async getPrice(symbol: string) { return { symbol, price: 100, change: 0, changePercent: 0, volume: 0, timestamp: new Date() }; },
      async normalizeQuantity(_s: string, q: number) { return q; },
      async getOpenOco() { return oco.open; },
      async placeOco(p: any) { oco.placed.push(p); return { orderListId: "ocoL-" + oco.placed.length, orders: [] }; },
      async cancelOco(symbol: string, orderListId: string) { oco.cancelled.push({ symbol, orderListId }); return true; },
    },
  }),
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp-server/index.js";

async function connect() {
  const server = buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { server, client };
}
const callJson = async (client: Client, name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse((res.content as { type: string; text: string }[])[0].text);
};

describe("OCO 보호주문 MCP 노출(머니패스 불변식 보존)", () => {
  let client: Client;
  let server: Awaited<ReturnType<typeof connect>>["server"];
  beforeAll(async () => { const c = await connect(); client = c.client; server = c.server; });

  it("① 세 보호주문 툴이 MCP 툴 목록에 노출됨", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("place_protective");
    expect(names).toContain("get_protective");
    expect(names).toContain("cancel_protective");
  });

  it("② place_protective: confirmToken 없이 호출 → preview + confirmToken(2단계 1차 보존)", async () => {
    oco.placed.length = 0;
    const p = await callJson(client, "place_protective", { symbol: "BTCUSDT", quantity: 1, takeProfitPrice: 110, stopPrice: 90 });
    expect(p.ok).toBe(true);
    expect(p.phase).toBe("preview");
    expect(p.needConfirm).toBe(true);
    expect(typeof p.confirmToken).toBe("string");
    expect(oco.placed.length).toBe(0); // 프리뷰는 실주문 안 함(fail-closed)
  });

  it("③ place_protective: 잘못된 confirmToken으로 2차 호출 → 거절(consumeToken fail-closed 보존)", async () => {
    oco.placed.length = 0;
    const p = await callJson(client, "place_protective", { symbol: "BTCUSDT", quantity: 1, takeProfitPrice: 110, stopPrice: 90, confirmToken: "deadbeefdeadbeef" });
    expect(p.ok).toBe(false);
    expect(oco.placed.length).toBe(0); // 무효 토큰 → 주문 안 나감
  });

  it("④ get_protective: read-only 경로(active 필드 + 키 미노출)", async () => {
    oco.open = { orderListId: "ocoL-X", tpPrice: 110, slPrice: 90 };
    const p = await callJson(client, "get_protective", { symbol: "BTCUSDT" });
    expect(p.ok).toBe(true);
    expect(p.active).toBe(true);
    expect(p.orderListId).toBe("ocoL-X");
    expect(JSON.stringify(p)).not.toContain("x".repeat(64)); // API 키 절대 미노출
    oco.open = null;
  });

  it("⑤ cancel_protective: orderListId 누락 → 거절", async () => {
    const p = await callJson(client, "cancel_protective", { symbol: "BTCUSDT", orderListId: "" });
    expect(p.ok).toBe(false);
    expect(String(p.error)).toContain("orderListId");
  });

  it("⑥ cancel_protective: 정상 orderListId → 어댑터 cancelOco 경유 + audit", async () => {
    oco.cancelled.length = 0;
    const p = await callJson(client, "cancel_protective", { symbol: "BTCUSDT", orderListId: "ocoL-1" });
    expect(p.ok).toBe(true);
    expect(p.canceled).toBe(true);
    expect(oco.cancelled).toEqual([{ symbol: "BTCUSDT", orderListId: "ocoL-1" }]);
    await client.close(); await server.close();
  });
});
