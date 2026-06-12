/**
 * retry-layer.test.ts — 공통 재시도 레이어(audit P1-3) + 부분체결 정직 처리(P1-1) + OCO 양다리(P1-4) 회귀.
 *
 * P1-3: 429/5xx/타임아웃은 지수백오프 재시도(GET 한정), 잔고부족 등 4xx는 즉시 전파.
 *   비멱등 쓰기(주문 POST)는 transport 재시도 금지 — 이중주문 방지(재시도는 상위 cid-reconcile 담당).
 * P1-1: 시장가 부분체결 후 EXPIRED(유동성 부족)를 rejected로 둔갑시키면 장부 0/거래소 실보유 발산 →
 *   체결분>0인 종료 상태는 filled(부분)로 반환해야 한다. executedQty/origQty 분리 노출.
 * P1-4: OCO 응답에 거부된 leg가 섞이면(편다리 보호) 전체 throw.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { withRetry, classifyRetryableError } from "../src/brokers/base.js";
import { BinanceBrokerAdapter } from "../src/brokers/binance.js";

const ok = (body: unknown) => ({ ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() });
const err = (status: number, headers: Record<string, string> = {}) => ({ ok: false, status, statusText: "ERR", json: async () => ({}), text: async () => `{"code":-1003,"msg":"rate limit"}`, headers: new Headers(headers) });

function binance() {
  return new BinanceBrokerAdapter({ apiKey: "k".repeat(64), apiSecret: "s".repeat(64), env: "testnet", market: "spot" });
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("P1-3: classifyRetryableError", () => {
  it("[http:429] + [retry-after:2] → 재시도 가능 + 2000ms", () => {
    const c = classifyRetryableError(new Error("Binance API error: 429 ... [http:429] [retry-after:2]"));
    expect(c.retryable).toBe(true);
    expect(c.retryAfterMs).toBe(2000);
  });
  it("[http:503] → 재시도 가능 / [http:400](검증 거부) → 불가", () => {
    expect(classifyRetryableError(new Error("x [http:503]")).retryable).toBe(true);
    expect(classifyRetryableError(new Error("Binance API error: 400 ... insufficient balance [http:400]")).retryable).toBe(false);
  });
  it("타임아웃/네트워크 단절 → 재시도 가능", () => {
    const te = new Error("The operation was aborted due to timeout"); te.name = "TimeoutError";
    expect(classifyRetryableError(te).retryable).toBe(true);
    expect(classifyRetryableError(new TypeError("fetch failed")).retryable).toBe(true);
  });
  it("마커 없는 일반 에러 → 불가(추측 금지)", () => {
    expect(classifyRetryableError(new Error("Kiwoom order rejected")).retryable).toBe(false);
  });
});

describe("P1-3: withRetry", () => {
  it("재시도 가능 에러 → 재시도 후 성공", async () => {
    let n = 0;
    const r = await withRetry(async () => {
      if (++n < 3) throw new Error("x [http:500]");
      return "ok";
    }, { baseDelayMs: 1 });
    expect(r).toBe("ok");
    expect(n).toBe(3);
  });
  it("재시도 불가 에러 → 즉시 전파(1회만 시도)", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new Error("no [http:400]"); }, { baseDelayMs: 1 })).rejects.toThrow();
    expect(n).toBe(1);
  });
  it("attempts 소진 → 마지막 에러 전파", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new Error("x [http:429]"); }, { attempts: 3, baseDelayMs: 1 })).rejects.toThrow();
    expect(n).toBe(3);
  });
});

describe("P1-3: Binance transport 재시도 정책", () => {
  it("GET(잔고)은 429 후 재시도 → 성공", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => (++n === 1 ? err(429, { "retry-after": "0" }) : ok({ balances: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const r = await binance().getPositions();
    expect(r).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("POST(주문)은 429에도 재시도 없음(이중주문 방지) — 1회 시도 후 전파", async () => {
    const fetchMock = vi.fn(async () => err(429));
    vi.stubGlobal("fetch", fetchMock);
    await expect(binance().placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", quantity: 1 })).rejects.toThrow(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("P1-1: 부분체결 정직 처리", () => {
  it("시장가 EXPIRED + executedQty>0 → status filled(부분), executedQty/origQty 분리", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ orderId: 9, status: "EXPIRED", executedQty: "0.4", origQty: "1.0", cummulativeQuoteQty: "40", transactTime: 1700000000000 })));
    const r = await binance().placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", quantity: 1 });
    expect(r.status).toBe("filled"); // 체결분은 사실 — rejected 둔갑 금지
    expect(r.executedQty).toBeCloseTo(0.4);
    expect(r.origQty).toBeCloseTo(1.0);
    expect(r.quantity).toBeCloseTo(0.4);
  });
  it("EXPIRED + executedQty 0 → rejected(기존 동작 유지)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ orderId: 9, status: "EXPIRED", executedQty: "0", origQty: "1.0", transactTime: 1700000000000 })));
    const r = await binance().placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", quantity: 1 });
    expect(r.status).toBe("rejected");
  });
});

describe("P1-4: OCO 양다리 상태 검증", () => {
  function stubOco(reports: Array<Record<string, unknown>>) {
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("exchangeInfo")) return ok({ symbols: [{ symbol: "BTCUSDT", filters: [{ filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" }, { filterType: "PRICE_FILTER", tickSize: "0.01" }, { filterType: "NOTIONAL", minNotional: "0" }] }] });
      if (u.includes("/api/v3/order/oco")) return ok({ orderListId: 77, orderReports: reports });
      return ok({});
    }));
  }
  const leg = (id: number, status: string) => ({ orderId: id, status, origQty: "1", price: "110", transactTime: 1700000000000 });

  it("양다리 NEW → 정상 통과", async () => {
    stubOco([leg(1, "NEW"), leg(2, "NEW")]);
    const r = await binance().placeOco({ symbol: "BTCUSDT", quantity: 1, takeProfitPrice: 110, stopPrice: 90 });
    expect(r.orderListId).toBe("77");
    expect(r.orders).toHaveLength(2);
  });
  it("한 leg REJECTED → 전체 throw(편다리 보호 금지)", async () => {
    stubOco([leg(1, "NEW"), leg(2, "REJECTED")]);
    await expect(binance().placeOco({ symbol: "BTCUSDT", quantity: 1, takeProfitPrice: 110, stopPrice: 90 })).rejects.toThrow(/부분 성공 OCO 금지|leg 거부/);
  });
});
