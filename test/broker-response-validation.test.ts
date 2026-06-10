/**
 * broker-response-validation.test.ts — 거래소 응답 런타임 검증(Zod safeParse, fail-closed) 회귀.
 *
 * 머니패스 임계 응답(주문/체결/잔고/포지션)이 형식변형/에러바디일 때 어댑터가 유령 OrderResult("pending+요청수량")나
 * "잔고/포지션 0"으로 둔갑시키지 않고 throw 하는지 고정. 정상 응답(문자열 숫자·빈 배열 포함)은 그대로 통과해야 한다.
 *
 * 실거래소 호출 0 — global.fetch 를 스텁하고 더미 testnet 키로 어댑터 인스턴스화.
 *   - Binance: signed 요청은 fetch 한 번(시장가 주문/조회/잔고/포지션 각 1콜) → URL 경로로 응답 분기.
 *   - KIS: /oauth2/token + /uapi/hashkey + 주문 경로를 순서로 모킹(live-fail-safety 패턴 재사용).
 *
 * 핵심 위험(F1): 키움 P0-3(유령 pending)와 동형의 구멍이 binance에 미수정으로 남아있었고, binance가 유일하게
 *   라이브 머니패스에 배선됨 → 최우선. 각 케이스는 '형식변형→throw / 정상(빈배열 포함)→통과' 쌍.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { BinanceBrokerAdapter } from "../src/brokers/binance.js";
import { KisBrokerAdapter } from "../src/brokers/kis.js";

/** fetch 응답 헬퍼(HTTP 200 + JSON 바디). 거래소가 200으로 에러/형식변형을 줄 수 있음을 재현. */
const ok = (body: unknown) => ({ ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() });

/** Binance 더미 testnet 어댑터(현물/선물). 키 present → signed 경로 동작(네트워크는 fetch 모킹). */
function binance(market: "spot" | "futures" = "spot") {
  return new BinanceBrokerAdapter({ apiKey: "k".repeat(64), apiSecret: "s".repeat(64), env: "testnet", market });
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// ───────────────────────── F1: Binance 주문/체결 응답 ─────────────────────────
describe("F1 Binance 주문 응답 검증(유령 pending 차단)", () => {
  /** 시장가 주문 1콜 → 주어진 바디를 반환하는 fetch 스텁. */
  function stubOrder(body: unknown) {
    const fetchMock = vi.fn(async () => ok(body));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  const mkt = { symbol: "BTCUSDT", side: "buy" as const, type: "market" as const, quantity: 5 };

  it("(a) 정상 시장가 체결 → status filled, quantity/price 정상", async () => {
    stubOrder({ orderId: 123, status: "FILLED", executedQty: "5", cummulativeQuoteQty: "320", transactTime: 1700000000000 });
    const r = await binance().placeOrder(mkt);
    expect(r.status).toBe("filled");
    expect(r.quantity).toBe(5);
    expect(r.price).toBeCloseTo(320 / 5); // 시장가 평단 = 체결금액/체결수량
    expect(r.orderId).toBe("123");
  });

  it("(b) 에러바디 {code,msg}(orderId/status 없음) → throw, 절대 pending 반환 안 함", async () => {
    stubOrder({ code: -2010, msg: "Account has insufficient balance for requested action." });
    await expect(binance().placeOrder(mkt)).rejects.toThrow(/형식 오류|fail-closed/);
  });

  it("(c) status 누락 응답 {orderId, executedQty} → throw", async () => {
    stubOrder({ orderId: 1, executedQty: "1" });
    await expect(binance().placeOrder(mkt)).rejects.toThrow(/형식 오류|fail-closed/);
  });

  it("(d) 미지의 status {orderId, status:'WEIRD'} → throw(유령 pending 금지)", async () => {
    stubOrder({ orderId: 1, status: "WEIRD" });
    await expect(binance().placeOrder(mkt)).rejects.toThrow(/미지의 주문 상태|fail-closed/);
  });

  it("(e) 정상 지정가 NEW 응답 → status pending + orderId(회귀)", async () => {
    // 지정가는 normalizePrice(exchangeInfo) 1콜 후 주문 1콜 → URL로 분기.
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("exchangeInfo")
        ? ok({ symbols: [{ symbol: "BTCUSDT", filters: [{ filterType: "PRICE_FILTER", tickSize: "0.01" }] }] })
        : ok({ orderId: 999, status: "NEW", origQty: "1", price: "60000" }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await binance().placeOrder({ symbol: "BTCUSDT", side: "buy", type: "limit", quantity: 1, price: 60000 });
    expect(r.status).toBe("pending");
    expect(r.orderId).toBe("999");
  });

  it("(f) 숫자형 orderId/executedQty(문자열 아님)도 관용 통과(union)", async () => {
    stubOrder({ orderId: 42, status: "FILLED", executedQty: 2, cummulativeQuoteQty: 200, transactTime: 1700000000000 });
    const r = await binance().placeOrder(mkt);
    expect(r.orderId).toBe("42");
    expect(r.quantity).toBe(2);
    expect(r.price).toBeCloseTo(100);
  });
});

describe("F1 Binance getOrderByClientId 검증(잘못된 입양 차단)", () => {
  it("-2013(does not exist) → null(정상: 주문 없음)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, statusText: "Bad Request", text: async () => "-2013 Order does not exist.", json: async () => ({}), headers: new Headers() })));
    const r = await binance().getOrderByClientId("BTCUSDT", "cid-x");
    expect(r).toBeNull();
  });

  it("형식변형 응답(orderId는 있으나 status 미지) → throw(reconcile가 모호로 보수처리)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ orderId: 7, status: "BOGUS" })));
    await expect(binance().getOrderByClientId("BTCUSDT", "cid-x")).rejects.toThrow(/미지의 주문 상태|형식 오류|fail-closed/);
  });

  it("빈 응답({}) → null(주문 없음, throw 아님)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({})));
    const r = await binance().getOrderByClientId("BTCUSDT", "cid-x");
    expect(r).toBeNull();
  });

  it("정상 조회(orderId+FILLED) → OrderResult 정상", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ orderId: 5, status: "FILLED", side: "SELL", executedQty: "3", price: "100", updateTime: 1700000000000 })));
    const r = await binance().getOrderByClientId("BTCUSDT", "cid-x");
    expect(r?.orderId).toBe("5");
    expect(r?.side).toBe("sell");
    expect(r?.status).toBe("filled");
  });
});

// ─────────────────────── F2: Binance 잔고/포지션 응답 ───────────────────────
describe("F2 Binance 잔고 검증(0 둔갑 차단)", () => {
  it("(a) 정상 선물 잔고 → totalAsset/cashBalance 정상", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ totalWalletBalance: "1000", totalUnrealizedProfit: "5", availableBalance: "995" })));
    const b = await binance("futures").getBalance();
    expect(b.totalAsset).toBeCloseTo(1005);
    expect(b.cashBalance).toBeCloseTo(995);
  });

  it("(b) 선물 잔고 형식변형(세 필드 전무, 예 {code:-1022}) → throw(0 둔갑 금지)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ code: -1022, msg: "Signature for this request is not valid." })));
    await expect(binance("futures").getBalance()).rejects.toThrow(/형식 오류|fail-closed/);
  });

  it("(c) 현물 balances 부재 응답 → throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ code: -2015, msg: "Invalid API-key, IP, or permissions." })));
    await expect(binance("spot").getBalance()).rejects.toThrow(/형식 오류|fail-closed/);
  });

  it("(d) balances:[](정상 빈 잔고) → totalAsset 0, throw 아님(회귀)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ balances: [] })));
    const b = await binance("spot").getBalance();
    expect(b.totalAsset).toBe(0);
    expect(b.cashBalance).toBe(0);
  });

  it("(d2) 정상 현물 잔고(USDT free) → cashBalance 매핑", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ balances: [{ asset: "USDT", free: "500", locked: "0" }, { asset: "BTC", free: "0", locked: "0" }] })));
    const b = await binance("spot").getBalance();
    expect(b.cashBalance).toBeCloseTo(500);
    expect(b.totalAsset).toBeCloseTo(500);
  });
});

describe("F2 Binance 포지션 검증(빈배열/비배열 구분)", () => {
  it("(e) 선물 positionRisk 정상 배열 → 포지션 정상", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok([{ symbol: "BTCUSDT", positionAmt: "-0.01", entryPrice: "60000", markPrice: "59000", unRealizedProfit: "10" }])));
    const ps = await binance("futures").getPositions();
    expect(ps).toHaveLength(1);
    expect(ps[0].quantity).toBeCloseTo(0.01); // 절대값
    expect(ps[0].pnlPercent).toBeGreaterThan(0); // 숏 + 가격하락 = 양(+)
  });

  it("(e2) 선물 positionRisk 비배열(객체=형식변형) → throw(무포지션 둔갑 금지)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ code: -1121, msg: "Invalid symbol." })));
    await expect(binance("futures").getPositions()).rejects.toThrow(/형식 오류|fail-closed/);
  });

  it("(e3) 선물 positionRisk 빈배열 [] → 무포지션(throw 아님, 회귀)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok([])));
    const ps = await binance("futures").getPositions();
    expect(ps).toHaveLength(0);
  });

  it("(f) 현물 getPositions balances 부재 → throw / 정상 → 보유 매핑", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ code: -2015 })));
    await expect(binance("spot").getPositions()).rejects.toThrow(/형식 오류|fail-closed/);

    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => ok({ balances: [{ asset: "BTC", free: "0.5", locked: "0.1" }] })));
    const ps = await binance("spot").getPositions();
    expect(ps).toHaveLength(1);
    expect(ps[0].quantity).toBeCloseTo(0.6);
    expect(ps[0].free).toBeCloseTo(0.5);
  });
});

// ───────────────────────────── F3: KIS 주문 응답 ─────────────────────────────
describe("F3 KIS 주문 응답 검증(유령 접수 차단)", () => {
  /** 토큰 + hashkey + 주문 경로를 순서대로 모킹. 주문 바디만 가변(orderBody). */
  function stubKis(orderBody: unknown) {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/oauth2/tokenP")) return ok({ access_token: "tkn", expires_in: 86400 });
      if (u.includes("/uapi/hashkey")) return ok({ HASH: "h".repeat(32) });
      return ok(orderBody); // order-cash
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  function kis() {
    return new KisBrokerAdapter({ appkey: "ak", appsecret: "as", account: "12345678-01", env: "mock" });
  }
  const buy = { symbol: "005930", side: "buy" as const, type: "market" as const, quantity: 1 };

  it("(a) 정상 주문 {rt_cd:'0', output:{ODNO}} → pending + orderId", async () => {
    stubKis({ rt_cd: "0", output: { ODNO: "0001234", ORD_TMD: "100000" } });
    const r = await kis().placeOrder(buy);
    expect(r.status).toBe("pending");
    expect(r.orderId).toBe("0001234");
  });

  it("(b) rt_cd:'0'인데 output 없음 → throw(유령 접수 금지)", async () => {
    stubKis({ rt_cd: "0" });
    await expect(kis().placeOrder(buy)).rejects.toThrow(/ODNO missing|fail-closed/);
  });

  it("(b2) rt_cd:'0'인데 ODNO 빈값 → throw", async () => {
    stubKis({ rt_cd: "0", output: { ODNO: "" } });
    await expect(kis().placeOrder(buy)).rejects.toThrow(/ODNO missing|fail-closed/);
  });

  it("(c) rt_cd:'1'(거부) → rejected(throw 아님, 회귀)", async () => {
    stubKis({ rt_cd: "1", msg_cd: "40610000", msg1: "주문가능금액 부족" });
    const r = await kis().placeOrder(buy);
    expect(r.status).toBe("rejected");
    expect(r.orderId).toBe(""); // 거부는 ODNO 없는 게 정상
  });
});
