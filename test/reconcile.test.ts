/**
 * reconcile.test.ts — P0-4 체결 reconcile 순수 결정 로직(reconcilePositionFromExchange).
 *
 * 배경(키움 모의서버 지연체결): 매수 시장가가 주문 시점엔 pending+price0(체결 미확인)→fail-closed 동결(장부 0)되나
 *   키움이 잠시 후 실제 체결 → 거래소엔 실보유·장부엔 0(역방향 발산). 다음 틱 이 함수가 거래소 진실을 채택(adopt).
 *   대칭 위험: 방금 산 정상 포지션도 거래소에 잠시 안 떠 빈배열로 보일 수 있어 → 빈배열 즉시 clear 금지(no_exchange_pos만).
 *
 * 전부 순수(어댑터 mock 불필요). computePositionDrift 재사용 → 드리프트 임계는 기존과 동일.
 */
import { describe, it, expect } from "vitest";
import { reconcilePositionFromExchange, type ExchangePos } from "../src/core/execution/reconcile.js";

const ex = (symbol: string, quantity: number, avgPrice = 71000): ExchangePos => ({ symbol, quantity, avgPrice });

describe("reconcilePositionFromExchange (P0-4 순수)", () => {
  it("(a) 장부 0 + 거래소 5주(지연체결) → adopt, next.qty=5, drift major(부호 0↔양수)", () => {
    const r = reconcilePositionFromExchange(null, [ex("005930", 5, 71000)], "005930");
    expect(r.action).toBe("adopt");
    expect(r.next).toEqual({ qty: 5, entryAvg: 71000 });
    expect(r.drift.severity).toBe("major"); // sign(0)≠sign(5)
    expect(r.ambiguous).toBe(false);
  });

  it("(b) 장부 5 + 거래소 빈배열(가짜보유 후보) → no_exchange_pos, next=null (clear는 호출측 정책)", () => {
    const r = reconcilePositionFromExchange({ qty: 5 }, [], "005930");
    expect(r.action).toBe("no_exchange_pos");
    expect(r.next).toBeNull();
    expect(r.drift.exchangeQty).toBe(0);
  });

  it("(c) 장부 5 + 거래소 5 → in_sync(무동작)", () => {
    const r = reconcilePositionFromExchange({ qty: 5 }, [ex("005930", 5)], "005930");
    expect(r.action).toBe("in_sync");
    expect(r.next).toBeNull();
    expect(r.drift.inSync).toBe(true);
  });

  it("(d) 장부 5 + 거래소 4(부분체결) → adopt, next.qty=4(거래소 실수량 채택)", () => {
    const r = reconcilePositionFromExchange({ qty: 5 }, [ex("005930", 4, 70500)], "005930");
    expect(r.action).toBe("adopt");
    expect(r.next).toEqual({ qty: 4, entryAvg: 70500 });
    expect(r.drift.severity).toBe("major"); // 20% > 5%
  });

  it("(e) symbol 미매칭(거래소에 다른 종목만) → exchangeQty=0 경로(no_exchange_pos)", () => {
    const r = reconcilePositionFromExchange({ qty: 5 }, [ex("035720", 10)], "005930");
    expect(r.action).toBe("no_exchange_pos");
    expect(r.next).toBeNull();
  });

  it("(f) 정규화 매칭: bot.symbol='A005930' ↔ 거래소 '005930'(6자리 환원)", () => {
    const r = reconcilePositionFromExchange(null, [ex("005930", 7, 70000)], "A005930");
    expect(r.action).toBe("adopt");
    expect(r.next?.qty).toBe(7);
  });

  it("(f2) 정규화 매칭: 거래소 '005930.KS' ↔ bot '005930'(접미 제거)", () => {
    const r = reconcilePositionFromExchange(null, [ex("005930.KS", 3)], "005930");
    expect(r.action).toBe("adopt");
    expect(r.next?.qty).toBe(3);
  });

  it("(g) 종목당 다중 매칭(거래소에 같은 종목 2건) → ambiguous=true, 첫 건 채택", () => {
    const r = reconcilePositionFromExchange(null, [ex("005930", 5, 71000), ex("005930", 2, 72000)], "005930");
    expect(r.ambiguous).toBe(true);
    expect(r.action).toBe("adopt");
    expect(r.next).toEqual({ qty: 5, entryAvg: 71000 }); // matched[0]
  });

  it("(h) 장부 0 + 거래소 0 → no_exchange_pos(자명 동기, next=null)", () => {
    const r = reconcilePositionFromExchange(null, [], "005930");
    expect(r.action).toBe("no_exchange_pos");
    expect(r.next).toBeNull();
  });

  it("(i) 거래소 평단 누락/0 → entryAvg=0(호출측 폴백 — null 아님, adopt는 수량이 진실)", () => {
    const r = reconcilePositionFromExchange(null, [ex("005930", 5, 0)], "005930");
    expect(r.action).toBe("adopt");
    expect(r.next).toEqual({ qty: 5, entryAvg: 0 });
  });

  it("(j) 크립토 심볼은 원형 매칭(BTCUSDT는 6자리 환원 비적용 — 동일 심볼끼리만)", () => {
    const r = reconcilePositionFromExchange({ qty: 0.5 }, [{ symbol: "BTCUSDT", quantity: 0.5, avgPrice: 60000 }], "BTCUSDT");
    expect(r.action).toBe("in_sync");
    const miss = reconcilePositionFromExchange({ qty: 0.5 }, [{ symbol: "ETHUSDT", quantity: 10, avgPrice: 3000 }], "BTCUSDT");
    expect(miss.action).toBe("no_exchange_pos");
  });

  it("(k) 거래소 미세 잔량(<1e-9)은 무보유로 간주(no_exchange_pos)", () => {
    const r = reconcilePositionFromExchange({ qty: 5 }, [ex("005930", 1e-12)], "005930");
    expect(r.action).toBe("no_exchange_pos");
  });
});
