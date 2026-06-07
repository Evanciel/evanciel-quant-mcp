/**
 * execution.test.ts — P0 실행 레이어 순수 코어: 상주 보호주문 계획/정합 + 드리프트/사이징/체결판정.
 */
import { describe, it, expect } from "vitest";
import { planProtectiveOrders, reconcileProtective, syncProtective, type ProtectiveOrder } from "../src/core/execution/protective.js";
import { computePositionDrift, sizeFromBalance, classifyFillStatus } from "../src/core/execution/reconcile.js";

const base = { botId: "b1", symbol: "BTCUSDT", qty: 0.5, entryAvg: 100 };

describe("planProtectiveOrders", () => {
  it("롱: SL=평단×(1-sl%) sell stop, TP=평단×(1+tp%) sell take_profit, reduceOnly", () => {
    const o = planProtectiveOrders({ ...base, positionSide: "long", stopLossPercent: 5, takeProfitPercent: 10 });
    const sl = o.find((x) => x.kind === "stop_loss")!;
    const tp = o.find((x) => x.kind === "take_profit")!;
    expect(sl).toMatchObject({ type: "stop_market", side: "sell", reduceOnly: true, quantity: 0.5 });
    expect(sl.stopPrice).toBeCloseTo(95, 6);
    expect(tp).toMatchObject({ type: "take_profit_market", side: "sell" });
    expect(tp.stopPrice).toBeCloseTo(110, 6);
  });

  it("숏: 부호 반전(SL 위, TP 아래, buy 보호)", () => {
    const o = planProtectiveOrders({ ...base, positionSide: "short", stopLossPercent: 5, takeProfitPercent: 10 });
    expect(o.find((x) => x.kind === "stop_loss")!.stopPrice).toBeCloseTo(105, 6);
    expect(o.find((x) => x.kind === "stop_loss")!.side).toBe("buy");
    expect(o.find((x) => x.kind === "take_profit")!.stopPrice).toBeCloseTo(90, 6);
  });

  it("트레일링: 롱은 고점×(1-trail%)와 고정SL 중 높은 값(타이트)", () => {
    // 고점 120, trail 5% → 트레일 114. 고정 SL 5% → 95. max=114.
    const o = planProtectiveOrders({ ...base, positionSide: "long", stopLossPercent: 5, trailingStopPercent: 5, extremeSinceEntry: 120 });
    expect(o.find((x) => x.kind === "stop_loss")!.stopPrice).toBeCloseTo(114, 6);
  });

  it("리스크 미설정 → 보호주문 0 / qty·평단 비정상 → 0", () => {
    expect(planProtectiveOrders({ ...base, positionSide: "long" })).toHaveLength(0);
    expect(planProtectiveOrders({ ...base, positionSide: "long", qty: 0, stopLossPercent: 5 })).toHaveLength(0);
  });
});

describe("reconcileProtective", () => {
  const sl: ProtectiveOrder = { kind: "stop_loss", type: "stop_market", side: "sell", quantity: 0.5, stopPrice: 95, reduceOnly: true, clientOrderId: "b1-BTCUSDT-sl-9500" };
  it("이미 걸린 동일 주문은 유지(멱등), 없는 건 신규, desired 밖 resting은 취소", () => {
    const d1 = reconcileProtective([sl], []);
    expect(d1.toPlace).toHaveLength(1);
    expect(d1.toCancel).toHaveLength(0);
    const d2 = reconcileProtective([sl], ["b1-BTCUSDT-sl-9500"]);
    expect(d2.toPlace).toHaveLength(0); // 이미 있음 → 멱등
    const d3 = reconcileProtective([sl], ["b1-BTCUSDT-sl-9000"]); // 옛 트레일 가격
    expect(d3.toPlace).toHaveLength(1); // 새 가격 신규
    expect(d3.toCancel).toEqual(["b1-BTCUSDT-sl-9000"]); // 옛 것 취소
  });
});

describe("syncProtective (mock 어댑터)", () => {
  const sl: ProtectiveOrder = { kind: "stop_loss", type: "stop_market", side: "sell", quantity: 0.5, stopPrice: 95, reduceOnly: true, clientOrderId: "b1-BTCUSDT-sl-9500" };
  it("신규 배치: place 호출 + resting 갱신", async () => {
    const placed: string[] = [];
    const r = await syncProtective([sl], [], async (o) => { placed.push(o.clientOrderId); return o.clientOrderId; }, async () => true);
    expect(r.placed).toBe(1);
    expect(r.restingIds).toEqual(["b1-BTCUSDT-sl-9500"]);
    expect(placed).toEqual(["b1-BTCUSDT-sl-9500"]);
  });
  it("트레일링 갱신: 옛 것 취소 + 새 것 신규", async () => {
    const cancelled: string[] = [];
    const r = await syncProtective([sl], ["b1-BTCUSDT-sl-9000"], async (o) => o.clientOrderId, async (id) => { cancelled.push(id); return true; });
    expect(r.cancelled).toBe(1);
    expect(r.placed).toBe(1);
    expect(cancelled).toEqual(["b1-BTCUSDT-sl-9000"]);
    expect(r.restingIds).toEqual(["b1-BTCUSDT-sl-9500"]);
  });
  it("place 실패는 삼키고 failed 집계(부분 성공)", async () => {
    const r = await syncProtective([sl], [], async () => null, async () => true);
    expect(r.placed).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.restingIds).toEqual([]); // 실패 → resting 미추가
  });
});

describe("computePositionDrift", () => {
  it("동기화: 허용오차 내 inSync", () => {
    expect(computePositionDrift(10, 10).inSync).toBe(true);
    expect(computePositionDrift(10, 10.05).inSync).toBe(true); // 0.5% < 1%
  });
  it("major 발산: 상대 5% 초과 또는 부호 불일치 → 거래소 채택 권고", () => {
    const d = computePositionDrift(10, 0); // 로컬 보유, 거래소 0
    expect(d.inSync).toBe(false);
    expect(d.severity).toBe("major");
    expect(d.recommended).toBe("adopt_exchange");
    expect(d.driftQty).toBe(-10);
  });
});

describe("sizeFromBalance", () => {
  it("가용현금×비율/가격 lot 절사", () => {
    expect(sizeFromBalance(10000, 100, 50, 0)).toBe(50); // 5000/100
    expect(sizeFromBalance(10000, 333, 100, 0)).toBeCloseTo(30.03003003, 6); // 분수(정수 floor 아님)
    expect(sizeFromBalance(50, 60000, 99, 0)).toBeCloseTo(0.000825, 6); // 소액 BTC = 분수(이전 정수floor면 0)
    expect(sizeFromBalance(0, 100, 50)).toBe(0); // 현금 0
    expect(sizeFromBalance(10000, 100, 50, 5)).toBe(50); // lot 5 정렬
  });
});

describe("classifyFillStatus", () => {
  it("체결/미체결/미주문/거부/조회불가 판정", () => {
    expect(classifyFillStatus({ status: "filled" })).toBe("filled");
    expect(classifyFillStatus({ status: "pending" })).toBe("open");
    expect(classifyFillStatus({ status: "rejected" })).toBe("rejected");
    expect(classifyFillStatus(null)).toBe("not_placed");      // 거래소에 없음 → 재시도 안전
    expect(classifyFillStatus(undefined)).toBe("unknown");     // 조회 미지원 → 보수적
  });
});
