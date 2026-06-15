/**
 * open-orders-kr.test.ts — KR 미체결 조회(getOpenOrders) 회귀. audit P1-10.
 *   ① 키움 ka10075('oso' 배열) 매핑(orderId/side/잔량/부분체결)
 *   ② fail-closed: 조회 실패(return_code≠0 / 비정형)는 빈 배열 금지 → throw
 *   ③ KIS는 fail-closed 미지원 throw
 *   ④ reconcile 판별자 불변: KR 어댑터의 getOrderByClientId는 undefined 유지(runner.ts:323) — 추가 시 KR reconcile 꺼짐.
 * 실거래소 호출 0 — global.fetch 스텁 + 더미 mock 키. ka10075 행 구조는 probe-kiwoom-open-orders.ts 실응답 캡처.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { KiwoomBrokerAdapter } from "../src/brokers/kiwoom.js";
import { KisBrokerAdapter } from "../src/brokers/kis.js";

const ok = (body: unknown) => ({ ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() });

function kiwoom() {
  return new KiwoomBrokerAdapter({ appkey: "ak", secretkey: "sk", env: "mock" });
}
function kis() {
  return new KisBrokerAdapter({ appkey: "ak", appsecret: "as", account: "12345678-01", env: "mock" });
}

/** 토큰 콜(/oauth2/token) + ka10075 데이터 콜(/api/dostk/acnt)을 URL로 분기 모킹. */
function stubKiwoom(osoBody: unknown) {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes("/oauth2/token")) return ok({ token: "tkn", expires_in: 86400 });
    return ok(osoBody);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** 모의 E2E로 확정된 실제 ka10075 'oso' 행 구조(probe 캡처). */
const row = (over: Record<string, unknown> = {}) => ({
  acnt_no: "8128080011", ord_no: "0054263", stk_cd: "005930", stk_nm: "삼성전자",
  ord_stt: "접수", ord_qty: "1", ord_pric: "288500", oso_qty: "1", cntr_qty: "0",
  cntr_pric: "0", orig_ord_no: "0000000", io_tp_nm: "+매수", trde_tp: "보통",
  tm: "095647", cur_prc: "+339500", stex_tp: "1", stex_tp_txt: "KRX", stop_pric: "0", ...over,
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("키움 getOpenOrders(ka10075) — 미체결 매핑", () => {
  it("정상 'oso' 응답 → OrderResult[] (orderId/side/잔량/pending)", async () => {
    stubKiwoom({ return_code: 0, return_msg: "조회 완료", oso: [row()] });
    const r = await kiwoom().getOpenOrders("005930");
    expect(r).toHaveLength(1);
    expect(r[0].orderId).toBe("0054263");
    expect(r[0].symbol).toBe("005930");
    expect(r[0].side).toBe("buy"); // io_tp_nm "+매수"
    expect(r[0].quantity).toBe(1); // oso_qty(미체결 잔량)
    expect(r[0].price).toBe(288500);
    expect(r[0].status).toBe("pending");
    expect(r[0].origQty).toBe(1);
  });

  it("매도 주문(io_tp_nm '-매도') → side sell (trde_tp '보통'은 주문유형이라 방향 아님)", async () => {
    stubKiwoom({ return_code: 0, oso: [row({ io_tp_nm: "-매도", ord_no: "0054999" })] });
    expect((await kiwoom().getOpenOrders("005930"))[0].side).toBe("sell");
  });

  it("부분체결 행(oso_qty<원수량) → quantity=잔량, executedQty=체결분, origQty=원수량", async () => {
    stubKiwoom({ return_code: 0, oso: [row({ ord_qty: "10", cntr_qty: "3", oso_qty: "7" })] });
    const o = (await kiwoom().getOpenOrders("005930"))[0];
    expect(o.quantity).toBe(7);
    expect(o.executedQty).toBe(3);
    expect(o.origQty).toBe(10);
  });

  it("oso_qty<=0(체결완료) 또는 ord_no 없는 행 스킵(유령 orderId 금지)", async () => {
    stubKiwoom({ return_code: 0, oso: [row({ oso_qty: "0" }), row({ ord_no: "", oso_qty: "5" }), row({ ord_no: "0055000", oso_qty: "2" })] });
    const r = await kiwoom().getOpenOrders("005930");
    expect(r).toHaveLength(1);
    expect(r[0].orderId).toBe("0055000");
  });

  it("요청 종목만 반환(서버가 타종목 섞어도 클라 필터)", async () => {
    stubKiwoom({ return_code: 0, oso: [row(), row({ stk_cd: "000660", ord_no: "0055001" })] });
    const r = await kiwoom().getOpenOrders("005930");
    expect(r).toHaveLength(1);
    expect(r[0].symbol).toBe("005930");
  });

  it("빈 'oso'(미체결 없음) → [] (정상 빈 결과, 에러-빈과 구분)", async () => {
    stubKiwoom({ return_code: 0, oso: [] });
    expect(await kiwoom().getOpenOrders("005930")).toEqual([]);
  });

  it("fail-closed: return_code≠0 → throw(빈 배열로 둔갑 금지)", async () => {
    stubKiwoom({ return_code: 2, return_msg: "입력 값 오류" });
    await expect(kiwoom().getOpenOrders("005930")).rejects.toThrow(/open orders|return_code/);
  });

  it("fail-closed: return_code 부재 + oso 배열 부재(만료토큰/게이트웨이 블롭) → throw", async () => {
    stubKiwoom({ some: "garbage" });
    await expect(kiwoom().getOpenOrders("005930")).rejects.toThrow(/open orders|missing return_code/);
  });
});

describe("KIS getOpenOrders — fail-closed 미지원", () => {
  it("throw(빈 배열로 둔갑 금지)", async () => {
    await expect(kis().getOpenOrders("005930")).rejects.toThrow(/미지원|fail-closed|P1-10/);
  });
});

describe("키움 getCandles 재시도(audit P1-22-01) — Binance fetchKlines와 대칭", () => {
  it("일시적 503 → withRetry로 재시도 후 성공(틱 전체가 죽지 않음)", async () => {
    let chartCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/oauth2/token")) return ok({ token: "tkn", expires_in: 86400 });
      chartCalls++;
      if (chartCalls === 1) return { ok: false, status: 503, statusText: "Service Unavailable", json: async () => ({}), text: async () => "", headers: new Headers() };
      return ok({ return_code: 0, stk_dt_pole_chart_qry: [] });
    }));
    const r = await kiwoom().getCandles("005930", "1d", 10);
    expect(Array.isArray(r)).toBe(true);
    expect(chartCalls).toBeGreaterThanOrEqual(2); // 503 1회 + 재시도
  });

  it("4xx(400)는 재시도 안 함(비재시도 — 같은 입력은 재요청해도 동일)", async () => {
    let chartCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/oauth2/token")) return ok({ token: "tkn", expires_in: 86400 });
      chartCalls++;
      return { ok: false, status: 400, statusText: "Bad Request", json: async () => ({}), text: async () => "", headers: new Headers() };
    }));
    await expect(kiwoom().getCandles("005930", "1d", 10)).rejects.toThrow(/400/);
    expect(chartCalls).toBe(1); // 400=비재시도 → 단발
  });
});

describe("reconcile 판별자 불변(audit P1-10 criticalConstraint)", () => {
  it("KR 어댑터의 getOrderByClientId는 undefined 유지(추가 시 KR reconcile 꺼짐→유령 포지션)", () => {
    expect((kiwoom() as { getOrderByClientId?: unknown }).getOrderByClientId).toBeUndefined();
    expect((kis() as { getOrderByClientId?: unknown }).getOrderByClientId).toBeUndefined();
  });
  it("KR 어댑터는 getOpenOrders를 제공(키움 실구현 / KIS throw)", () => {
    expect(typeof (kiwoom() as { getOpenOrders?: unknown }).getOpenOrders).toBe("function");
    expect(typeof (kis() as { getOpenOrders?: unknown }).getOpenOrders).toBe("function");
  });
});
