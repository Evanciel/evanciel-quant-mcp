/**
 * limit-bracket-machine.test.ts — 지속형 지정가 봇 순수 리듀서 검증(I/O 0). 적대검증 불변식 고정.
 */
import { describe, it, expect } from "vitest";
import { decideLimitBracket, initLimitBracketState, findMyRestingOrder, LB_FILL_DEBOUNCE, type LimitBracketState, type LbObservation, type LbNode } from "../src/core/execution/limit-bracket.js";

const NODE: LbNode = { symbol: "005930", buyPrice: 70000, qty: 5, sellPrice: 80000 };
const mkState = (p: Partial<LimitBracketState> = {}): LimitBracketState => ({ ...initLimitBracketState(0, "2026-06-15T00:00:00Z"), bootGraceDone: true, reorderSessionKey: "2026-06-15", ...p });
const mkObs = (p: Partial<LbObservation> = {}): LbObservation => ({ marketOpen: true, sessionKey: "2026-06-15", paper: false, restingBuy: null, restingSell: null, ownHeldDelta: 0, ...p });

describe("decideLimitBracket — 매수 단계", () => {
  it("장중 awaiting_buy → 매수 지정가 주문(첫 주문 즉시)", () => {
    const { state, action } = decideLimitBracket(NODE, mkState({ phase: "awaiting_buy" }), mkObs());
    expect(action.kind).toBe("place");
    if (action.kind === "place") { expect(action.side).toBe("buy"); expect(action.price).toBe(70000); expect(action.qty).toBe(5); }
    expect(state.phase).toBe("buy_resting"); expect(state.reorderCount).toBe(1); expect(state.placeCooldown).toBeGreaterThan(0);
  });

  it("장마감 → 주문 안 함(모니터만)", () => {
    const { state, action } = decideLimitBracket(NODE, mkState({ phase: "awaiting_buy" }), mkObs({ marketOpen: false }));
    expect(action.kind).toBe("noop"); expect(state.reorderCount).toBe(0);
  });

  it("재시작 그레이스: 첫 틱 관측만(주문 금지), 둘째 틱 주문", () => {
    const s0 = mkState({ phase: "awaiting_buy", bootGraceDone: false });
    const r1 = decideLimitBracket(NODE, s0, mkObs());
    expect(r1.action.kind).toBe("noop"); expect(r1.state.bootGraceDone).toBe(true);
    const r2 = decideLimitBracket(NODE, r1.state, mkObs());
    expect(r2.action.kind).toBe("place");
  });

  it("이중매수 차단: 내 매수주문이 떠있으면 절대 재주문 안 함", () => {
    const { action } = decideLimitBracket(NODE, mkState({ phase: "buy_resting", entryOrderId: "A" }), mkObs({ restingBuy: { orderId: "A", remainingQty: 5, executedQty: 0 } }));
    expect(action.kind).toBe("noop");
  });

  it("매수 체결(주문 소멸 + 보유 증가) → fill, phase=bought", () => {
    const { state, action } = decideLimitBracket(NODE, mkState({ phase: "buy_resting" }), mkObs({ restingBuy: null, ownHeldDelta: 5 }));
    expect(action.kind).toBe("fill");
    if (action.kind === "fill") { expect(action.side).toBe("buy"); expect(action.qty).toBe(5); }
    expect(state.phase).toBe("bought"); expect(state.filledQty).toBe(5); expect(state.qty).toBe(5); expect(state.status).toBe("open");
  });

  it("★오버셀/이중매수 방지: 주문 소멸 + 보유 증가 없음 = 체결 아님(디바운스, 즉시 재주문 금지)", () => {
    let s = mkState({ phase: "buy_resting", reorderCount: 1, placeCooldown: 0 });
    // 3틱 연속 '소멸+미증가' → 처음 2틱 noop(디바운스), 3틱째에 재주문(미반영 체결 배제 후)
    let r = decideLimitBracket(NODE, s, mkObs({ restingBuy: null, ownHeldDelta: 0 }));
    expect(r.action.kind).toBe("noop"); expect(r.state.fillMisses).toBe(1);
    r = decideLimitBracket(NODE, r.state, mkObs({ restingBuy: null, ownHeldDelta: 0 }));
    expect(r.action.kind).toBe("noop"); expect(r.state.fillMisses).toBe(2);
    r = decideLimitBracket(NODE, r.state, mkObs({ restingBuy: null, ownHeldDelta: 0 }));
    expect(r.action.kind).toBe("place"); expect(r.state.fillMisses).toBe(0); // 재주문 후 리셋
  });

  it("부분체결(cntr) → filledQty 갱신, phase는 buy_resting 유지(완전체결 전)", () => {
    const { state, action } = decideLimitBracket(NODE, mkState({ phase: "buy_resting", entryOrderId: "A" }), mkObs({ restingBuy: { orderId: "A", remainingQty: 3, executedQty: 2 } }));
    expect(action.kind).toBe("fill");
    if (action.kind === "fill") expect(action.qty).toBe(2);
    expect(state.filledQty).toBe(2); expect(state.phase).toBe("buy_resting");
  });

  it("세션 재주문 캡 도달 → 동결(noop)", () => {
    const { action } = decideLimitBracket(NODE, mkState({ phase: "buy_resting", reorderCount: 8, fillMisses: LB_FILL_DEBOUNCE }), mkObs({ restingBuy: null }));
    expect(action.kind).toBe("noop");
  });
});

describe("decideLimitBracket — 매도 단계", () => {
  it("bought → 매도 지정가 주문", () => {
    const { state, action } = decideLimitBracket(NODE, mkState({ phase: "bought", filledQty: 5, qty: 5, status: "open" }), mkObs());
    expect(action.kind).toBe("place");
    if (action.kind === "place") { expect(action.side).toBe("sell"); expect(action.price).toBe(80000); expect(action.qty).toBe(5); }
    expect(state.phase).toBe("sell_resting");
  });

  it("매도전용 봇(sellPrice 없음): bought → 즉시 done", () => {
    const node2: LbNode = { symbol: "005930", buyPrice: 70000, qty: 5 };
    const { state, action } = decideLimitBracket(node2, mkState({ phase: "bought", filledQty: 5, qty: 5 }), mkObs());
    expect(action.kind).toBe("done"); expect(state.phase).toBe("done");
  });

  it("매도 체결(보유 감소) → fill sell, qty 0", () => {
    const { state, action } = decideLimitBracket(NODE, mkState({ phase: "sell_resting", filledQty: 5, soldQty: 0, qty: 5, status: "open", exitOrderId: "B" }), mkObs({ restingSell: null, ownHeldDelta: 0 }));
    expect(action.kind).toBe("fill");
    if (action.kind === "fill") { expect(action.side).toBe("sell"); expect(action.qty).toBe(5); }
    expect(state.qty).toBe(0); expect(state.soldQty).toBe(5); expect(state.status).toBe("closed");
  });

  it("종료 디바운스: 보유0 + 매도소멸 3틱 → done(자동 종료)", () => {
    let s = mkState({ phase: "sell_resting", filledQty: 5, soldQty: 5, qty: 0, status: "closed" });
    let r = decideLimitBracket(NODE, s, mkObs({ restingSell: null, ownHeldDelta: 0 }));
    expect(r.action.kind).toBe("noop"); expect(r.state.doneMisses).toBe(1);
    r = decideLimitBracket(NODE, r.state, mkObs({ restingSell: null, ownHeldDelta: 0 }));
    expect(r.action.kind).toBe("noop");
    r = decideLimitBracket(NODE, r.state, mkObs({ restingSell: null, ownHeldDelta: 0 }));
    expect(r.action.kind).toBe("done"); expect(r.state.phase).toBe("done");
  });

  it("매도 주문 떠있으면 재주문 안 함", () => {
    // 보유 5 미매도 → ownHeldDelta=5(계좌보유=baseline+5). soldObserved=filledQty-ownHeldDelta=0 → 미체결.
    const { action } = decideLimitBracket(NODE, mkState({ phase: "sell_resting", filledQty: 5, qty: 5, exitOrderId: "B" }), mkObs({ restingSell: { orderId: "B", remainingQty: 5, executedQty: 0 }, ownHeldDelta: 5 }));
    expect(action.kind).toBe("noop");
  });
});

describe("decideLimitBracket — 페이퍼 채널(가격교차 시뮬)", () => {
  it("페이퍼 매수: 닫힌봉 저가 ≤ 매수가 → 체결", () => {
    const { state, action } = decideLimitBracket(NODE, mkState({ phase: "buy_resting", live: false }), mkObs({ paper: true, refLow: 69000 }));
    expect(action.kind).toBe("fill"); expect(state.filledQty).toBe(5); expect(state.live).toBe(false);
  });
  it("페이퍼 매수: 저가 > 매수가 → 미체결", () => {
    const { action } = decideLimitBracket(NODE, mkState({ phase: "buy_resting" }), mkObs({ paper: true, refLow: 71000 }));
    expect(action.kind === "noop" || action.kind === "place").toBe(true);
  });
});

describe("findMyRestingOrder — 오입양 방지", () => {
  const orders = [
    { orderId: "A", side: "buy" as const, price: 70000, quantity: 5, executedQty: 0 },
    { orderId: "C", side: "buy" as const, price: 70000, quantity: 3, executedQty: 0 },
  ];
  it("knownId 1차 매칭", () => {
    const r = findMyRestingOrder(orders, "buy", 70000, "A");
    expect(r.order?.orderId).toBe("A"); expect(r.ambiguous).toBe(false);
  });
  it("id 미상 + 같은가격 후보 2건 → ambiguous(입양 보류, fail-closed)", () => {
    const r = findMyRestingOrder(orders, "buy", 70000);
    expect(r.order).toBeNull(); expect(r.ambiguous).toBe(true);
  });
  it("id 미상 + 후보 정확히 1건 → 입양", () => {
    const r = findMyRestingOrder([orders[0]], "buy", 70000);
    expect(r.order?.orderId).toBe("A"); expect(r.ambiguous).toBe(false);
  });
  it("가격 불일치 → 매칭 없음", () => {
    const r = findMyRestingOrder(orders, "buy", 60000);
    expect(r.order).toBeNull(); expect(r.ambiguous).toBe(false);
  });
});
