/**
 * toss-adapter.test.ts — 토스증권 어댑터 단위 검증(실 네트워크 0, global fetch 모킹).
 *
 * 토스는 모의 호스트가 없어 라이브 주문 검증이 불가하므로, 이 단위 테스트가 주문-쓰기 안전·파싱의 1차 방어선이다.
 * 커버: ① envelope/[http:N] 분류 ② decimal(no-abs 음수 pnl) ③ 주문본문(KR 틱정렬/US passthrough)
 *   ④ 보호주문 throw ⑤ orderId 부재 throw ⑥ quoteCurrencyFor 회귀가드 ⑦ 🔴 라이브-쓰기 하드블록
 *   ⑧ getOrderByClientId===undefined(reconcile 라우팅 불변식) ⑨ per-method 필드검증(잘린 2xx→throw) ⑩ 미체결/상세 매핑.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TossBrokerAdapter } from "../src/brokers/toss.js";
import { quoteCurrencyFor, loadCredentials } from "../src/brokers/safety.js";
import { isKrSymbol, roundToKrxTick } from "../src/brokers/krx-tick.js";

// ── fetch 모킹 헬퍼 ──
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

/** URL 부분일치 라우팅 모킹. /oauth2/token은 항상 토큰 OK. captured에 마지막 주문 바디 기록. */
function mockFetch(routes: [string, (url: string, opts: { body?: string }) => Resp][]) {
  const captured: { lastBody?: Record<string, unknown>; calls: string[] } = { calls: [] };
  const fn = vi.fn(async (url: unknown, opts?: { body?: string }) => {
    const u = String(url);
    captured.calls.push(u);
    if (u.includes("/oauth2/token")) return res(200, TOKEN_OK);
    if (opts?.body) { try { captured.lastBody = JSON.parse(opts.body) as Record<string, unknown>; } catch { /* form */ } }
    for (const [m, r] of routes) if (u.includes(m)) return r(u, opts ?? {});
    return res(404, { error: { code: "edge-blocked" } });
  });
  vi.stubGlobal("fetch", fn);
  return captured;
}

const LIVE = { env: "live", clientId: "c_x", clientSecret: "s_y", accountSeq: "1" };

beforeEach(() => { delete process.env.LIVE_TRADING_ENABLED; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete process.env.LIVE_TRADING_ENABLED; });

describe("quoteCurrencyFor — 통화 판정(회귀가드)", () => {
  it("기존 브로커는 바이트 동일", () => {
    expect(quoteCurrencyFor("binance", "BTCUSDT")).toBe("USDT");
    expect(quoteCurrencyFor("kis", "005930")).toBe("KRW");
    expect(quoteCurrencyFor("kiwoom", "005930")).toBe("KRW");
  });
  it("토스는 심볼별(KR 6자리→KRW / US 티커→USD / 무심볼→KRW)", () => {
    expect(quoteCurrencyFor("toss", "005930")).toBe("KRW");
    expect(quoteCurrencyFor("toss", "AAPL")).toBe("USD");
    expect(quoteCurrencyFor("toss")).toBe("KRW");
  });
  it("isKrSymbol 단일 진실원", () => {
    expect(isKrSymbol("005930")).toBe(true);
    expect(isKrSymbol(" 000660 ")).toBe(true);
    expect(isKrSymbol("AAPL")).toBe(false);
    expect(isKrSymbol("0059301")).toBe(false); // 7자리
  });
});

describe("getPrice — decimal 파싱", () => {
  it("lastPrice 문자열 → number", async () => {
    mockFetch([["/api/v1/prices", () => res(200, { result: [{ symbol: "005930", lastPrice: "72000", currency: "KRW" }] })]]);
    const px = await new TossBrokerAdapter(LIVE).getPrice("005930");
    expect(px.price).toBe(72000);
    expect(px.symbol).toBe("005930");
  });
  it("빈 결과는 fail-closed throw(가격 0 둔갑 금지)", async () => {
    mockFetch([["/api/v1/prices", () => res(200, { result: [] })]]);
    await expect(new TossBrokerAdapter(LIVE).getPrice("005930")).rejects.toThrow(/price/i);
  });
  it("400 invalid-request → [http:400] 마커로 throw(비재시도)", async () => {
    mockFetch([["/api/v1/prices", () => res(400, { error: { code: "invalid-request" } })]]);
    await expect(new TossBrokerAdapter(LIVE).getPrice("005930")).rejects.toThrow(/\[http:400\]/);
  });
});

describe("getPositions — no-abs 음수 pnl 보존 + 필드검증", () => {
  it("items 매핑, 음수 pnl 보존, rate×100", async () => {
    mockFetch([["/api/v1/holdings", () => res(200, { result: { marketValue: { amount: { krw: "7200000" } }, items: [
      { symbol: "005930", name: "삼성전자", quantity: "100", averagePurchasePrice: "65000", lastPrice: "72000", profitLoss: { amount: "700000", rate: "0.1077" } },
      { symbol: "AAPL", name: "Apple", quantity: "5", averagePurchasePrice: "200", lastPrice: "190", profitLoss: { amount: "-50", rate: "-0.05" } },
    ] } })]]);
    const pos = await new TossBrokerAdapter(LIVE).getPositions();
    expect(pos).toHaveLength(2);
    expect(pos[0]).toMatchObject({ symbol: "005930", quantity: 100, avgPrice: 65000, currentPrice: 72000, pnl: 700000 });
    expect(pos[0].pnlPercent).toBeCloseTo(10.77);
    expect(pos[1].pnl).toBe(-50); // ⚠️ no-abs: 음수 손실 보존(abs 적용 시 +50으로 둔갑 → 서킷 오작동)
    expect(pos[1].pnlPercent).toBeCloseTo(-5);
  });
  it("items 배열 부재(잘린 2xx) → fail-closed throw", async () => {
    mockFetch([["/api/v1/holdings", () => res(200, { result: { marketValue: { amount: { krw: "0" } } } })]]);
    await expect(new TossBrokerAdapter(LIVE).getPositions()).rejects.toThrow();
  });
});

describe("placeOrder — 🔴 라이브-쓰기 하드블록", () => {
  it("env=mock → throw(모의 호스트 없음)", async () => {
    mockFetch([["/api/v1/orders", () => res(200, { result: { orderId: "x" } })]]);
    const ad = new TossBrokerAdapter({ ...LIVE, env: "mock" });
    await expect(ad.placeOrder({ symbol: "005930", side: "buy", type: "market", quantity: 1 })).rejects.toThrow(/차단|live/i);
  });
  it("env=live + 마스터 OFF → throw(페이퍼)", async () => {
    mockFetch([["/api/v1/orders", () => res(200, { result: { orderId: "x" } })]]);
    const ad = new TossBrokerAdapter(LIVE); // LIVE_TRADING_ENABLED 미설정
    await expect(ad.placeOrder({ symbol: "005930", side: "buy", type: "market", quantity: 1 })).rejects.toThrow(/차단|LIVE_TRADING_ENABLED/);
  });
  it("env=live + 마스터 ON → 주문 접수(orderId, status=pending)", async () => {
    process.env.LIVE_TRADING_ENABLED = "true";
    mockFetch([["/api/v1/orders", () => res(200, { result: { orderId: "ord-1", clientOrderId: "qm-1" } })]]);
    const r = await new TossBrokerAdapter(LIVE).placeOrder({ symbol: "005930", side: "buy", type: "market", quantity: 1 });
    expect(r).toMatchObject({ orderId: "ord-1", status: "pending", side: "buy" });
  });
});

describe("placeOrder — 본문 매핑(마스터 ON)", () => {
  beforeEach(() => { process.env.LIVE_TRADING_ENABLED = "true"; });
  it("KR 지정가는 KRX 틱 정렬", async () => {
    const cap = mockFetch([["/api/v1/orders", () => res(200, { result: { orderId: "o" } })]]);
    await new TossBrokerAdapter(LIVE).placeOrder({ symbol: "005930", side: "buy", type: "limit", quantity: 3, price: 70123 });
    expect(cap.lastBody).toMatchObject({ symbol: "005930", side: "BUY", orderType: "LIMIT", quantity: "3" });
    expect(cap.lastBody!.price).toBe(String(roundToKrxTick(70123))); // 70100
  });
  it("US 지정가(LIMIT)는 정수 수량(스펙 quantity=^d+$) + 가격 passthrough", async () => {
    const cap = mockFetch([["/api/v1/orders", () => res(200, { result: { orderId: "o" } })]]);
    await new TossBrokerAdapter(LIVE).placeOrder({ symbol: "AAPL", side: "sell", type: "limit", quantity: 1.5, price: 185.5 });
    // 1.5 → floor 1: US LIMIT은 소수 수량 불가(스펙). 소수주는 MARKET(아래)만. 적대검증 M2.
    expect(cap.lastBody).toMatchObject({ symbol: "AAPL", side: "SELL", orderType: "LIMIT", quantity: "1", price: "185.5" });
  });
  it("US 시장가(MARKET)만 소수주 허용", async () => {
    const cap = mockFetch([["/api/v1/orders", () => res(200, { result: { orderId: "o" } })]]);
    await new TossBrokerAdapter(LIVE).placeOrder({ symbol: "AAPL", side: "buy", type: "market", quantity: 1.5 });
    expect(cap.lastBody).toMatchObject({ symbol: "AAPL", orderType: "MARKET", quantity: "1.5" });
  });
  it("보호주문(stop_market) → fail-closed throw", async () => {
    mockFetch([["/api/v1/orders", () => res(200, { result: { orderId: "o" } })]]);
    await expect(new TossBrokerAdapter(LIVE).placeOrder({ symbol: "005930", side: "sell", type: "stop_market", quantity: 1, stopPrice: 1 })).rejects.toThrow(/보호주문|market\/limit/);
  });
  it("orderId 부재 응답 → 유령주문 차단(throw)", async () => {
    mockFetch([["/api/v1/orders", () => res(200, { result: { clientOrderId: "x" } })]]);
    await expect(new TossBrokerAdapter(LIVE).placeOrder({ symbol: "005930", side: "buy", type: "market", quantity: 1 })).rejects.toThrow(/orderId/i);
  });
});

describe("placeOrder — 금액기반(orderAmount, US MARKET 전용)", () => {
  beforeEach(() => { process.env.LIVE_TRADING_ENABLED = "true"; });
  it("US MARKET + orderAmount → amount-based 본문(quantity 없음)", async () => {
    const cap = mockFetch([["/api/v1/orders", () => res(200, { result: { orderId: "o" } })]]);
    await new TossBrokerAdapter(LIVE).placeOrder({ symbol: "AAPL", side: "buy", type: "market", quantity: 0, orderAmount: 100.5 });
    expect(cap.lastBody).toMatchObject({ symbol: "AAPL", side: "BUY", orderType: "MARKET", orderAmount: "100.5" });
    expect(cap.lastBody!.quantity).toBeUndefined();
  });
  it("KR + orderAmount → fail-closed throw", async () => {
    mockFetch([["/api/v1/orders", () => res(200, { result: { orderId: "o" } })]]);
    await expect(new TossBrokerAdapter(LIVE).placeOrder({ symbol: "005930", side: "buy", type: "market", quantity: 0, orderAmount: 100 })).rejects.toThrow(/US MARKET|금액/);
  });
  it("US LIMIT + orderAmount → fail-closed throw(금액은 MARKET만)", async () => {
    mockFetch([["/api/v1/orders", () => res(200, { result: { orderId: "o" } })]]);
    await expect(new TossBrokerAdapter(LIVE).placeOrder({ symbol: "AAPL", side: "buy", type: "limit", quantity: 0, price: 100, orderAmount: 100 })).rejects.toThrow(/US MARKET|금액/);
  });
});

describe("cancelOrder — env=live 요구, 4xx=false", () => {
  it("env=mock → throw", async () => {
    mockFetch([["/cancel", () => res(200, { result: { orderId: "n" } })]]);
    await expect(new TossBrokerAdapter({ ...LIVE, env: "mock" }).cancelOrder("o1", "005930")).rejects.toThrow(/차단|live/i);
  });
  it("2xx → true", async () => {
    mockFetch([["/cancel", () => res(200, { result: { orderId: "new" } })]]);
    expect(await new TossBrokerAdapter(LIVE).cancelOrder("o1", "005930")).toBe(true);
  });
  it("409 already-filled → false(거부, 시스템오류 아님)", async () => {
    mockFetch([["/cancel", () => res(409, { error: { code: "already-filled" } })]]);
    expect(await new TossBrokerAdapter(LIVE).cancelOrder("o1", "005930")).toBe(false);
  });
});

describe("getOpenOrders / getOrderById — 매핑", () => {
  it("OPEN: 미체결 잔량·부분체결", async () => {
    mockFetch([["/api/v1/orders", () => res(200, { result: { orders: [
      { orderId: "o1", symbol: "005930", side: "BUY", quantity: "10", price: "70000", execution: { filledQuantity: "3" }, orderedAt: "2026-03-29T09:30:00+09:00" },
    ], nextCursor: null, hasNext: false } })]]);
    const o = await new TossBrokerAdapter(LIVE).getOpenOrders("005930");
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ orderId: "o1", side: "buy", quantity: 7, executedQty: 3, origQty: 10, status: "pending" });
  });
  it("OPEN orders 부재 → fail-closed throw", async () => {
    mockFetch([["/api/v1/orders", () => res(200, { result: {} })]]);
    await expect(new TossBrokerAdapter(LIVE).getOpenOrders("005930")).rejects.toThrow();
  });
  it("getOrderById FILLED → status filled + 평균체결가", async () => {
    mockFetch([["/api/v1/orders/", () => res(200, { result: { orderId: "o1", symbol: "005930", side: "BUY", status: "FILLED", quantity: "10", execution: { filledQuantity: "10", averageFilledPrice: "70000" } } })]]);
    const r = await new TossBrokerAdapter(LIVE).getOrderById("005930", "o1");
    expect(r).toMatchObject({ orderId: "o1", status: "filled", price: 70000, executedQty: 10 });
  });
  it("getOrderById 404 → null", async () => {
    mockFetch([["/api/v1/orders/", () => res(404, { error: { code: "order-not-found" } })]]);
    expect(await new TossBrokerAdapter(LIVE).getOrderById("005930", "zzz")).toBeNull();
  });
});

describe("loadCredentials — 토스 키 별칭/선택 accountSeq", () => {
  afterEach(() => { for (const k of ["TOSS_CLIENT_ID", "TOSS_CLIENT_SECRET", "TOSS_API_KEY", "TOSS_SECRET_KEY", "TOSS_ACCOUNT_SEQ", "TOSS_ENV"]) delete process.env[k]; });
  it("표준명 TOSS_CLIENT_ID/SECRET 인식", () => {
    process.env.TOSS_CLIENT_ID = "cid"; process.env.TOSS_CLIENT_SECRET = "sec";
    const c = loadCredentials("toss") as Record<string, string> | null;
    expect(c?.clientId).toBe("cid"); expect(c?.clientSecret).toBe("sec"); expect(c?.env).toBe("live");
  });
  it("별칭 TOSS_API_KEY/TOSS_SECRET_KEY 인식(KIS 패턴, 설정 마찰 완화)", () => {
    process.env.TOSS_API_KEY = "cid2"; process.env.TOSS_SECRET_KEY = "sec2";
    const c = loadCredentials("toss") as Record<string, string> | null;
    expect(c?.clientId).toBe("cid2"); expect(c?.clientSecret).toBe("sec2");
  });
  it("accountSeq 없어도 로드(시세·캔들용 — 선택)", () => {
    process.env.TOSS_API_KEY = "cid"; process.env.TOSS_SECRET_KEY = "sec";
    expect(loadCredentials("toss")).not.toBeNull();
  });
  it("clientSecret 없으면 null", () => {
    process.env.TOSS_API_KEY = "cid";
    expect(loadCredentials("toss")).toBeNull();
  });
});

describe("getCandles — interval/페이지네이션", () => {
  it("미지원 interval(5m) → fail-closed throw", async () => {
    mockFetch([["/api/v1/candles", () => res(200, { result: { candles: [] } })]]);
    await expect((new TossBrokerAdapter(LIVE) as unknown as { getCandles: (s: string, i: string, n: number) => Promise<unknown> }).getCandles("005930", "5m", 10)).rejects.toThrow(/미지원|interval/);
  });
  it("1d 단일 페이지 → 오래된→최신 정렬 매핑", async () => {
    mockFetch([["/api/v1/candles", () => res(200, { result: { candles: [
      { timestamp: "2026-03-25T09:00:00+09:00", openPrice: "100", highPrice: "110", lowPrice: "90", closePrice: "105", volume: "1000" },
      { timestamp: "2026-03-24T09:00:00+09:00", openPrice: "95", highPrice: "100", lowPrice: "90", closePrice: "98", volume: "900" },
    ], nextBefore: null } })]]);
    const c = await (new TossBrokerAdapter(LIVE) as unknown as { getCandles: (s: string, i: string, n: number) => Promise<{ date: string; close: number }[]> }).getCandles("005930", "1d", 5);
    expect(c.map((b) => b.date)).toEqual(["2026-03-24", "2026-03-25"]);
    expect(c[1].close).toBe(105);
  });
  it("count>200 → nextBefore 커서로 2페이지 페치 + dedup + slice(-target)", async () => {
    const gen = (n: number, off: number) => Array.from({ length: n }, (_, i) => ({
      timestamp: new Date(Date.parse("2024-01-01T00:00:00Z") + (off + i) * 86_400_000).toISOString(),
      openPrice: "100", highPrice: "110", lowPrice: "90", closePrice: "105", volume: "1000",
    }));
    let call = 0; let sawBefore = false;
    mockFetch([["/api/v1/candles", (u) => {
      call++;
      if (u.includes("before=")) sawBefore = true;
      if (call === 1) return res(200, { result: { candles: gen(200, 0), nextBefore: "cursor-1" } });
      return res(200, { result: { candles: gen(60, 199), nextBefore: null } }); // off=199 → 1봉 경계중복(dedup 대상)
    }]]);
    const c = await (new TossBrokerAdapter(LIVE) as unknown as { getCandles: (s: string, i: string, n: number) => Promise<{ datetime: string }[]> }).getCandles("005930", "1d", 250);
    expect(call).toBe(2);
    expect(sawBefore).toBe(true); // 2페이지에 before= 전달
    expect(c.length).toBe(250); // 259 unique → slice(-250)
    expect(new Set(c.map((b) => b.datetime)).size).toBe(c.length); // 중복 없음
  });
});

describe("getBalance — KRW 매핑", () => {
  it("holdings KRW 평가액 + buying-power 현금", async () => {
    mockFetch([
      ["/api/v1/holdings", () => res(200, { result: { marketValue: { amount: { krw: "5000000" } }, items: [] } })],
      ["/api/v1/buying-power", () => res(200, { result: { currency: "KRW", cashBuyingPower: "1000000" } })],
    ]);
    const b = await new TossBrokerAdapter(LIVE).getBalance();
    expect(b).toMatchObject({ totalAsset: 6000000, cashBalance: 1000000, currency: "KRW" });
  });
  it("marketValue·items 둘 다 부재(잘린 2xx) → fail-closed throw", async () => {
    mockFetch([
      ["/api/v1/holdings", () => res(200, { result: {} })],
      ["/api/v1/buying-power", () => res(200, { result: { cashBuyingPower: "0" } })],
    ]);
    await expect(new TossBrokerAdapter(LIVE).getBalance()).rejects.toThrow();
  });
});

describe("불변식 — reconcile 라우팅 보존", () => {
  it("getOrderByClientId는 미구현(undefined)이어야 한다", () => {
    const ad = new TossBrokerAdapter(LIVE) as unknown as Record<string, unknown>;
    expect(ad.getOrderByClientId).toBeUndefined();   // runner.ts:351 — 토스를 KR 포지션-reconcile 경로로 라우팅
    expect(ad.cancelOrderByClientId).toBeUndefined();
    expect(ad.placeOco).toBeUndefined();             // 토스 OCO 미지원
  });
  it("normalizeQuantity: KR 정수 floor / US 소수 허용", async () => {
    const ad = new TossBrokerAdapter(LIVE);
    expect(await ad.normalizeQuantity("005930", 10.7)).toBe(10);
    expect(await ad.normalizeQuantity("AAPL", 1.5)).toBe(1.5);
  });
});
