/**
 * kr-protective-reject.test.ts — KR 브로커(KIS/키움) 보호주문 silent 둔갑 차단(audit P0-3)
 *   + KIS 지정가 KRX 호가단위 정렬(audit P0-4) 회귀.
 *
 * P0-3: KIS/키움 placeOrder가 stop_market/take_profit_market/stop_limit을 일반 지정가로
 *   조용히 바꿔 전송하던 구멍 — 이제 명시 throw(fail-closed)여야 하고, 네트워크 호출 0이어야 한다
 *   (거절이 거래소까지 가면 안 됨).
 * P0-4: KIS 지정가는 전송 직전 KRX 틱으로 정렬되어야 한다(미정렬 직송 → 예측 가능한 RC4003 거부).
 *   기존엔 kiwoom만 정렬 — 공용 모듈(krx-tick.ts) 추출 후 양쪽 적용 검증.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { KisBrokerAdapter } from "../src/brokers/kis.js";
import { KiwoomBrokerAdapter } from "../src/brokers/kiwoom.js";

const ok = (body: unknown) => ({ ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() });

function kis() {
  return new KisBrokerAdapter({ appkey: "ak", appsecret: "as", account: "12345678-01", env: "mock" });
}
function kiwoom() {
  return new KiwoomBrokerAdapter({ appkey: "ak", secretkey: "sk", env: "mock" });
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const PROTECTIVE_TYPES = ["stop_market", "take_profit_market", "stop_limit"] as const;

describe("P0-3: KR 브로커 보호주문 명시 거절(silent 지정가 둔갑 금지)", () => {
  for (const type of PROTECTIVE_TYPES) {
    it(`KIS placeOrder(${type}) → throw + 네트워크 호출 0`, async () => {
      const fetchMock = vi.fn(async () => ok({}));
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        kis().placeOrder({ symbol: "005930", side: "sell", type, quantity: 1, stopPrice: 60000 }),
      ).rejects.toThrow(/미지원.*fail-closed|fail-closed.*미지원/s);
      expect(fetchMock).not.toHaveBeenCalled(); // 거절은 거래소 도달 전(입력 검증 단계)
    });

    it(`Kiwoom placeOrder(${type}) → throw + 네트워크 호출 0`, async () => {
      const fetchMock = vi.fn(async () => ok({}));
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        kiwoom().placeOrder({ symbol: "005930", side: "sell", type, quantity: 1, stopPrice: 60000 }),
      ).rejects.toThrow(/미지원.*fail-closed|fail-closed.*미지원/s);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("market/limit은 거절 없이 정상 경로 진행(회귀 0)", async () => {
    // KIS 시장가 — 토큰/해시키/주문 순서 모킹(기존 F3 패턴).
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/oauth2/tokenP")) return ok({ access_token: "tkn", expires_in: 86400 });
      if (u.includes("/uapi/hashkey")) return ok({ HASH: "h".repeat(32) });
      return ok({ rt_cd: "0", output: { ODNO: "0001234", ORD_TMD: "100000" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await kis().placeOrder({ symbol: "005930", side: "buy", type: "market", quantity: 1 });
    expect(r.status).toBe("pending");
  });
});

describe("P0-4: KIS 지정가 KRX 호가단위 정렬", () => {
  /** order-cash 요청 바디를 캡처하는 fetch 스텁. */
  function stubKisCapture() {
    const captured: Record<string, string>[] = [];
    const fetchMock = vi.fn(async (url: unknown, init?: { body?: string }) => {
      const u = String(url);
      if (u.includes("/oauth2/tokenP")) return ok({ access_token: "tkn", expires_in: 86400 });
      if (u.includes("/uapi/hashkey")) return ok({ HASH: "h".repeat(32) });
      if (u.includes("/trading/order-cash")) {
        captured.push(JSON.parse(init?.body ?? "{}"));
        return ok({ rt_cd: "0", output: { ODNO: "0001234", ORD_TMD: "100000" } });
      }
      return ok({});
    });
    vi.stubGlobal("fetch", fetchMock);
    return captured;
  }

  it("미정렬 지정가 71549 → ORD_UNPR '71500' (100원 틱 내림) + 결과 price도 정렬가", async () => {
    const captured = stubKisCapture();
    const r = await kis().placeOrder({ symbol: "005930", side: "buy", type: "limit", quantity: 1, price: 71549 });
    const orderBody = captured.find((b) => b.ORD_UNPR != null);
    expect(orderBody?.ORD_UNPR).toBe("71500");
    expect(r.price).toBe(71500); // 장부/감사에는 실제 전송가(정직성)
  });

  it("미정렬 지정가 250250 → ORD_UNPR '250500' (500원 틱 반올림)", async () => {
    const captured = stubKisCapture();
    await kis().placeOrder({ symbol: "005930", side: "sell", type: "limit", quantity: 1, price: 250250 });
    const orderBody = captured.find((b) => b.ORD_UNPR != null);
    expect(orderBody?.ORD_UNPR).toBe("250500");
  });

  it("이미 정렬된 지정가는 그대로 전송(불필요 변형 금지)", async () => {
    const captured = stubKisCapture();
    await kis().placeOrder({ symbol: "005930", side: "buy", type: "limit", quantity: 1, price: 71500 });
    const orderBody = captured.find((b) => b.ORD_UNPR != null);
    expect(orderBody?.ORD_UNPR).toBe("71500");
  });

  it("시장가는 ORD_UNPR '0' 유지(정렬 미적용)", async () => {
    const captured = stubKisCapture();
    await kis().placeOrder({ symbol: "005930", side: "buy", type: "market", quantity: 1 });
    const orderBody = captured.find((b) => b.ORD_UNPR != null);
    expect(orderBody?.ORD_UNPR).toBe("0");
  });
});
