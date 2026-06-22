/**
 * toss-safety-endpoints.test.ts — #5 실거래 준비: 토스 안전 보조 조회 + placeOrder 가드 배선 검증(실 네트워크 0).
 *
 * 두 층:
 *   A. 어댑터 메서드(global fetch 모킹) — getSellableQuantity/getPriceLimit/getMarketCalendar 파싱 + fail-closed.
 *   B. live-handlers placeOrder 가드(getAdapter 모킹) — 매도 오버셀(fail-closed)·지정가 상하한(fail-open)·휴장일(opt-in).
 * 토스는 모의 호스트가 없어 이 단위 테스트가 머니패스 안전의 1차 방어선(toss-adapter.test.ts와 동일 원칙).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-toss-safety-${process.pid}`);

// ── A. 어댑터 메서드(fetch 모킹) ──
type Resp = { ok: boolean; status: number; headers: { get: (k: string) => string | null }; text: () => Promise<string>; json: () => Promise<unknown> };
function res(status: number, body: unknown, headers: Record<string, string> = {}): Resp {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => h[k.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
  };
}
const TOKEN_OK = { access_token: "tok-abc", token_type: "Bearer", expires_in: 86400 };
function mockFetch(routes: [string, (url: string) => Resp][]) {
  const fn = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes("/oauth2/token")) return res(200, TOKEN_OK);
    for (const [m, r] of routes) if (u.includes(m)) return r(u);
    return res(404, { error: { code: "edge-blocked" } });
  });
  vi.stubGlobal("fetch", fn);
}
const LIVE = { env: "live", clientId: "c_x", clientSecret: "s_y", accountSeq: "1" };

describe("A. 토스 어댑터 안전 보조 조회", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  describe("getSellableQuantity", () => {
    it("KR 정수 문자열 → number", async () => {
      const { TossBrokerAdapter } = await import("../src/brokers/toss.js");
      mockFetch([["/api/v1/sellable-quantity", () => res(200, { result: { sellableQuantity: "100" } })]]);
      expect(await new TossBrokerAdapter(LIVE).getSellableQuantity("005930")).toBe(100);
    });
    it("US 소수 문자열 → number", async () => {
      const { TossBrokerAdapter } = await import("../src/brokers/toss.js");
      mockFetch([["/api/v1/sellable-quantity", () => res(200, { result: { sellableQuantity: "5.5" } })]]);
      expect(await new TossBrokerAdapter(LIVE).getSellableQuantity("AAPL")).toBe(5.5);
    });
    it('"0"은 정상(판매가능 없음) → 0', async () => {
      const { TossBrokerAdapter } = await import("../src/brokers/toss.js");
      mockFetch([["/api/v1/sellable-quantity", () => res(200, { result: { sellableQuantity: "0" } })]]);
      expect(await new TossBrokerAdapter(LIVE).getSellableQuantity("005930")).toBe(0);
    });
    it("sellableQuantity 부재(잘린 2xx) → fail-closed throw", async () => {
      const { TossBrokerAdapter } = await import("../src/brokers/toss.js");
      mockFetch([["/api/v1/sellable-quantity", () => res(200, { result: {} })]]);
      await expect(new TossBrokerAdapter(LIVE).getSellableQuantity("005930")).rejects.toThrow(/비정형|fail-closed/);
    });
  });

  describe("getPriceLimit", () => {
    it("KR 상/하한가 → number", async () => {
      const { TossBrokerAdapter } = await import("../src/brokers/toss.js");
      mockFetch([["/api/v1/price-limits", () => res(200, { result: { upperLimitPrice: "93000", lowerLimitPrice: "50400", currency: "KRW" } })]]);
      const pl = await new TossBrokerAdapter(LIVE).getPriceLimit("005930");
      expect(pl).toMatchObject({ upper: 93000, lower: 50400, currency: "KRW" });
    });
    it("US 가격제한 없음(null) → null(무제한)", async () => {
      const { TossBrokerAdapter } = await import("../src/brokers/toss.js");
      mockFetch([["/api/v1/price-limits", () => res(200, { result: { upperLimitPrice: null, lowerLimitPrice: null, currency: "USD" } })]]);
      const pl = await new TossBrokerAdapter(LIVE).getPriceLimit("AAPL");
      expect(pl.upper).toBeNull();
      expect(pl.lower).toBeNull();
    });
    it("result 부재 → fail-closed throw", async () => {
      const { TossBrokerAdapter } = await import("../src/brokers/toss.js");
      mockFetch([["/api/v1/price-limits", () => res(200, {})]]);
      await expect(new TossBrokerAdapter(LIVE).getPriceLimit("005930")).rejects.toThrow(/비정형|fail-closed/);
    });
  });

  describe("getMarketCalendar", () => {
    it("KR integrated!=null → open", async () => {
      const { TossBrokerAdapter } = await import("../src/brokers/toss.js");
      mockFetch([["/api/v1/market-calendar/KR", () => res(200, { result: { today: { date: "2026-06-23", integrated: { regularMarket: { startTime: "x", endTime: "y" } } } } })]]);
      expect(await new TossBrokerAdapter(LIVE).getMarketCalendar("KR")).toMatchObject({ open: true, date: "2026-06-23" });
    });
    it("KR integrated===null → 휴장(closed)", async () => {
      const { TossBrokerAdapter } = await import("../src/brokers/toss.js");
      mockFetch([["/api/v1/market-calendar/KR", () => res(200, { result: { today: { date: "2026-06-06", integrated: null } } })]]);
      expect((await new TossBrokerAdapter(LIVE).getMarketCalendar("KR")).open).toBe(false);
    });
    it("US 4세션 모두 null → 휴장", async () => {
      const { TossBrokerAdapter } = await import("../src/brokers/toss.js");
      mockFetch([["/api/v1/market-calendar/US", () => res(200, { result: { today: { date: "2026-07-04", dayMarket: null, preMarket: null, regularMarket: null, afterMarket: null } } })]]);
      expect((await new TossBrokerAdapter(LIVE).getMarketCalendar("US")).open).toBe(false);
    });
    it("US 한 세션이라도 있으면 open", async () => {
      const { TossBrokerAdapter } = await import("../src/brokers/toss.js");
      mockFetch([["/api/v1/market-calendar/US", () => res(200, { result: { today: { date: "2026-06-23", regularMarket: { startTime: "x", endTime: "y" } } } })]]);
      expect((await new TossBrokerAdapter(LIVE).getMarketCalendar("US")).open).toBe(true);
    });
    it("today 부재 → fail-closed throw", async () => {
      const { TossBrokerAdapter } = await import("../src/brokers/toss.js");
      mockFetch([["/api/v1/market-calendar/KR", () => res(200, { result: {} })]]);
      await expect(new TossBrokerAdapter(LIVE).getMarketCalendar("KR")).rejects.toThrow(/비정형|fail-closed/);
    });
  });
});

// ── B. live-handlers placeOrder 가드(getAdapter 모킹) ──
const ctl = vi.hoisted(() => ({
  sellable: 100 as number | "throw",
  priceLimit: { upper: null, lower: null, currency: "KRW" } as { upper: number | null; lower: number | null; currency: string },
  calendarOpen: true,
}));
vi.mock("../src/brokers/index.js", () => ({
  configuredBrokers: () => [{ broker: "toss", market: "spot", env: "live", live: true }],
  getAdapter: () => ({
    env: "live",
    adapter: {
      async getPrice(symbol: string) { return { symbol, price: 100, change: 0, changePercent: 0, volume: 0, timestamp: new Date() }; },
      async normalizeQuantity(_s: string, q: number) { return Math.floor(q); },
      async getSellableQuantity() { if (ctl.sellable === "throw") throw new Error("조회실패"); return ctl.sellable; },
      async getPriceLimit() { return ctl.priceLimit; },
      async getMarketCalendar() { return { open: ctl.calendarOpen, date: "2026-06-23" }; },
      async placeOrder(o: { symbol: string; side: string; type: string; quantity: number; price?: number }) {
        return { orderId: "o1", symbol: o.symbol, side: o.side, quantity: o.quantity, price: o.price ?? 0, status: "pending", timestamp: new Date() };
      },
    },
  }),
}));

describe("B. placeOrder 가드(토스 라이브, 마스터 ON)", () => {
  beforeEach(() => {
    process.env.TOSS_API_KEY = "cid"; process.env.TOSS_SECRET_KEY = "sec"; process.env.TOSS_ACCOUNT_SEQ = "1";
    process.env.LIVE_TRADING_ENABLED = "true";
    ctl.sellable = 100; ctl.priceLimit = { upper: null, lower: null, currency: "KRW" }; ctl.calendarOpen = true;
    delete process.env.QUANT_TOSS_HOLIDAY_GATE;
    delete process.env.LIVE_MAX_NOTIONAL; delete process.env.LIVE_SYMBOL_ALLOWLIST;
  });
  afterEach(() => {
    for (const k of ["TOSS_API_KEY", "TOSS_SECRET_KEY", "TOSS_ACCOUNT_SEQ", "LIVE_TRADING_ENABLED", "QUANT_TOSS_HOLIDAY_GATE", "LIVE_MAX_NOTIONAL", "LIVE_SYMBOL_ALLOWLIST"]) delete process.env[k];
  });

  describe("매도 오버셀 가드(fail-closed)", () => {
    it("effQty > 판매가능 → 거절", async () => {
      const { placeOrder } = await import("../src/mcp-server/live-handlers.js");
      ctl.sellable = 10;
      const r = await placeOrder({ broker: "toss", symbol: "005930", side: "sell", type: "market", quantity: 50 });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/오버셀|판매가능/);
    });
    it("판매가능 0(미보유) → 거절", async () => {
      const { placeOrder } = await import("../src/mcp-server/live-handlers.js");
      ctl.sellable = 0;
      const r = await placeOrder({ broker: "toss", symbol: "005930", side: "sell", type: "market", quantity: 1 });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/판매가능수량 0|미보유/);
    });
    it("판매가능수량 조회 실패 → fail-closed 거절", async () => {
      const { placeOrder } = await import("../src/mcp-server/live-handlers.js");
      ctl.sellable = "throw";
      const r = await placeOrder({ broker: "toss", symbol: "005930", side: "sell", type: "market", quantity: 1 });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/조회 실패|fail-closed/);
    });
    it("effQty ≤ 판매가능 → 통과(preview 도달)", async () => {
      const { placeOrder } = await import("../src/mcp-server/live-handlers.js");
      ctl.sellable = 100;
      const r = await placeOrder({ broker: "toss", symbol: "005930", side: "sell", type: "market", quantity: 50 });
      expect(r.ok).toBe(true);
      expect(r.phase).toBe("preview");
    });
    it("매수는 오버셀 가드 면제", async () => {
      const { placeOrder } = await import("../src/mcp-server/live-handlers.js");
      ctl.sellable = 0; // 매수엔 무관해야 함
      const r = await placeOrder({ broker: "toss", symbol: "005930", side: "buy", type: "market", quantity: 1 });
      expect(r.ok).toBe(true);
      expect(r.phase).toBe("preview");
    });
  });

  describe("지정가 상/하한가 가드(fail-open)", () => {
    it("지정가 > 상한가 → 거절", async () => {
      const { placeOrder } = await import("../src/mcp-server/live-handlers.js");
      ctl.priceLimit = { upper: 93000, lower: 50400, currency: "KRW" };
      // notional=100000 < KR 캡(150000)이라 checkLimits 통과 → 상한가 가드가 잡아야 함
      const r = await placeOrder({ broker: "toss", symbol: "005930", side: "buy", type: "limit", quantity: 1, price: 100000 });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/상한가|price-out-of-range/);
    });
    it("지정가 < 하한가 → 거절", async () => {
      const { placeOrder } = await import("../src/mcp-server/live-handlers.js");
      ctl.priceLimit = { upper: 93000, lower: 50400, currency: "KRW" };
      const r = await placeOrder({ broker: "toss", symbol: "005930", side: "buy", type: "limit", quantity: 1, price: 100 });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/하한가|price-out-of-range/);
    });
    it("상하한 null(US/무제한) → 통과", async () => {
      const { placeOrder } = await import("../src/mcp-server/live-handlers.js");
      ctl.priceLimit = { upper: null, lower: null, currency: "USD" };
      const r = await placeOrder({ broker: "toss", symbol: "005930", side: "buy", type: "limit", quantity: 1, price: 70000 });
      expect(r.ok).toBe(true);
      expect(r.phase).toBe("preview");
    });
  });

  describe("휴장일 게이트(opt-in)", () => {
    it("QUANT_TOSS_HOLIDAY_GATE=1 + 휴장 → 거절", async () => {
      const { placeOrder } = await import("../src/mcp-server/live-handlers.js");
      process.env.QUANT_TOSS_HOLIDAY_GATE = "1";
      ctl.calendarOpen = false;
      const r = await placeOrder({ broker: "toss", symbol: "005930", side: "buy", type: "market", quantity: 1 });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/휴장/);
    });
    it("게이트 OFF(기본) → 휴장이어도 통과", async () => {
      const { placeOrder } = await import("../src/mcp-server/live-handlers.js");
      ctl.calendarOpen = false; // 게이트 OFF라 무관
      const r = await placeOrder({ broker: "toss", symbol: "005930", side: "buy", type: "market", quantity: 1 });
      expect(r.ok).toBe(true);
      expect(r.phase).toBe("preview");
    });
  });
});
