/**
 * getOpenOco.test.ts — 상주 OCO 보호주문 read-back 검증(적대검증 #15 회귀).
 *
 * getOpenOco는 placeOco가 생성 시 강제하는 "정확히 2-leg(익절 LIMIT_MAKER + 손절 STOP)" 불변을
 * 조회 시에도 강제해야 한다. 편다리/유령 OCO(한 leg만 남거나 가격 0)를 active로 둔갑시키면
 * placeProtective가 재보호를 거절(silent 미보호)하거나 getProtective가 '보호됨'을 오표시한다 →
 * 정확히 2-leg + 양 가격(>0)일 때만 유효, 그 외 null(=보호 없음 → 재보호 허용, fail-closed).
 *
 * 실거래소 호출 0 — global.fetch 스텁 + 더미 testnet 키. (broker-response-validation.test.ts 패턴 재사용)
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { BinanceBrokerAdapter } from "../src/brokers/binance.js";

const ok = (body: unknown) => ({ ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() });
const binance = (market: "spot" | "futures" = "spot") =>
  new BinanceBrokerAdapter({ apiKey: "k".repeat(64), apiSecret: "s".repeat(64), env: "testnet", market });

/** openOrders GET 1콜 → 주어진 배열 반환. */
function stubOpenOrders(arr: unknown) {
  const fetchMock = vi.fn(async () => ok(arr));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("getOpenOco read-back 2-leg 검증(#15 fail-closed)", () => {
  it("(a) 유효 2-leg OCO(LIMIT_MAKER 익절 + STOP_LOSS_LIMIT 손절) → {orderListId,tpPrice,slPrice}", async () => {
    stubOpenOrders([
      { orderId: 1, orderListId: 77, type: "LIMIT_MAKER", price: "70000", stopPrice: "0" },
      { orderId: 2, orderListId: 77, type: "STOP_LOSS_LIMIT", price: "59900", stopPrice: "60000" },
    ]);
    const r = await binance().getOpenOco("BTCUSDT");
    expect(r).not.toBeNull();
    expect(r!.orderListId).toBe("77");
    expect(r!.tpPrice).toBeCloseTo(70000);
    expect(r!.slPrice).toBeCloseTo(60000);
  });

  it("(b) 1-leg만(익절만 남음, 손절 체결/취소됨) → null(편다리 OCO 거부)", async () => {
    stubOpenOrders([{ orderId: 1, orderListId: 77, type: "LIMIT_MAKER", price: "70000", stopPrice: "0" }]);
    expect(await binance().getOpenOco("BTCUSDT")).toBeNull();
  });

  it("(c) 2-leg이나 손절 트리거가 0(가격 누락/형식변형) → null(slPrice<=0 거부)", async () => {
    stubOpenOrders([
      { orderId: 1, orderListId: 77, type: "LIMIT_MAKER", price: "70000" },
      { orderId: 2, orderListId: 77, type: "STOP_LOSS_LIMIT", price: "0", stopPrice: "0" },
    ]);
    expect(await binance().getOpenOco("BTCUSDT")).toBeNull();
  });

  it("(d) 2-leg이나 익절가가 0 → null(tpPrice<=0 거부)", async () => {
    stubOpenOrders([
      { orderId: 1, orderListId: 77, type: "LIMIT_MAKER", price: "0" },
      { orderId: 2, orderListId: 77, type: "STOP_LOSS_LIMIT", price: "59900", stopPrice: "60000" },
    ]);
    expect(await binance().getOpenOco("BTCUSDT")).toBeNull();
  });

  it("(e) OCO 아님(전부 orderListId=-1 단일 주문) → null", async () => {
    stubOpenOrders([
      { orderId: 1, orderListId: -1, type: "LIMIT", price: "70000" },
      { orderId: 2, orderListId: -1, type: "LIMIT", price: "59900" },
    ]);
    expect(await binance().getOpenOco("BTCUSDT")).toBeNull();
  });

  it("(f) 빈 배열(미체결 주문 없음) → null", async () => {
    stubOpenOrders([]);
    expect(await binance().getOpenOco("BTCUSDT")).toBeNull();
  });

  it("(g) 선물(market=futures)은 OCO 미지원 → 항상 null(fetch 미호출)", async () => {
    const fetchMock = stubOpenOrders([{ orderId: 1, orderListId: 77, type: "STOP" }]);
    expect(await binance("futures").getOpenOco("BTCUSDT")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("(h) 3-leg(유령/형식변형) → null(정확히 2-leg만 유효)", async () => {
    stubOpenOrders([
      { orderId: 1, orderListId: 77, type: "LIMIT_MAKER", price: "70000" },
      { orderId: 2, orderListId: 77, type: "STOP_LOSS_LIMIT", price: "59900", stopPrice: "60000" },
      { orderId: 3, orderListId: 77, type: "STOP_LOSS_LIMIT", price: "58000", stopPrice: "58100" },
    ]);
    expect(await binance().getOpenOco("BTCUSDT")).toBeNull();
  });
});
