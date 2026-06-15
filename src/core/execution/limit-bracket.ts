/**
 * limit-bracket.ts — 지속형 지정가 봇의 순수 결정 로직(I/O 0, 단위테스트 가능).
 * runner.tickLimitBracket가 이 리듀서를 감싸 실제 조회(getOpenOrders/getPositions)·주문(fillOrder)·영속을 수행한다.
 *
 * 적대검증(ultracode 3렌즈) 픽스 내장:
 *  - [kr#1] 체결 수량 = 봇 시작 baseline 대비 증가분(ownHeldDelta) + 자기 주문 체결분(cntr) 1차. 계좌 넷 보유 절대 직접사용 금지(오버셀 방지).
 *  - [kr#2/races#4] '주문 소멸'을 단독으로 체결/만료로 단정 금지 — 보유증가 교차확인 + N틱 디바운스. 만료 재주문은 세션 전환 시 캡 안에서만.
 *  - [safety#5] 멱등=세션키(벽시계 금지) + 주문 직후 placeCooldown(인덱싱 지연 흡수). 세션당 재주문 캡(스팸/거부 폭주 차단).
 *  - [safety#6] 재시작 첫 틱 bootGrace=관측·입양만(신규 주문 금지) — 거래소 진실 수렴 시간.
 *  - [safety#2] LimitBracketState가 PaperPosition 호환 공통필드(status/qty/live) 보유 → emergencyStopAll/exposuresOf 자동 인식.
 *  - [races#2] entryOrderId/exitOrderId 덮어쓰기 금지(입양은 미설정일 때만).
 *  - [kr#3/races#7] findMyRestingOrder: orderId 1차, 가격매칭은 tick정렬 동일가 + 후보 정확히 1건일 때만(ambiguous=보류).
 */

export interface LimitBracketState {
  phase: "awaiting_buy" | "buy_resting" | "bought" | "sell_resting" | "done";
  // ── 비상청산/exposuresOf 호환 공통필드(PaperPosition와 동일 의미) ──
  status: "open" | "closed"; // 봇 귀속 보유분>0이면 'open'
  qty: number;               // 현 봇 귀속 보유분(filledQty - soldQty). 비상청산 대상 수량.
  entryAvg?: number; live?: boolean;
  // ── 주문 추적 ──
  entryOrderId?: string; entryCid?: string;
  exitOrderId?: string; exitCid?: string;
  baselineQty: number;       // 봇 시작 시 계좌 보유(체결분 = max(0, 계좌보유 - baseline))
  filledQty: number;         // 누적 매수 체결분
  soldQty: number;           // 누적 매도 체결분
  // ── 멱등·디바운스·생존 ──
  reorderSessionKey?: string; // 재주문 카운트 기준 세션(KST 날짜). 세션 전환 시 카운트 리셋.
  reorderCount: number;       // 현 세션 주문 횟수(캡). 벽시계 아님.
  placeCooldown: number;      // 주문 직후 N틱 재주문 금지(인덱싱 지연 흡수)
  fillMisses: number;         // 매수 '소멸·미증가' 디바운스
  sellMisses: number;         // 매도 '소멸·미감소' 디바운스
  doneMisses: number;         // 종료(보유0+매도소멸) 디바운스
  bootGraceDone?: boolean;    // 재시작 첫 틱 관측-only 소진
  openedAt: string;
}

export interface LbNode { symbol: string; buyPrice: number; qty: number; sellPrice?: number }

/** 거래소에 떠있는 내 미체결 주문(getOpenOrders→findMyRestingOrder로 추린 것). */
export interface RestingOrder { orderId: string; remainingQty: number; executedQty: number }

/** 한 틱의 거래소 관측(wrapper가 I/O로 채워 주입). */
export interface LbObservation {
  marketOpen: boolean;
  sessionKey: string;
  paper: boolean;               // 페이퍼 채널(거래소 진실 없음 → refLow/refHigh 가격교차 시뮬)
  restingBuy: RestingOrder | null;
  restingSell: RestingOrder | null;
  ownHeldDelta: number;         // max(0, 계좌보유 - baseline). 봇 귀속 보유(넷 아님). 라이브 전용.
  refLow?: number;              // 페이퍼: 닫힌봉 저가(매수 교차 판정)
  refHigh?: number;             // 페이퍼: 닫힌봉 고가(매도 교차 판정)
}

export type LbAction =
  | { kind: "noop"; reason: string }
  | { kind: "place"; side: "buy" | "sell"; price: number; qty: number; reason: string }
  | { kind: "fill"; side: "buy" | "sell"; qty: number; price: number; reason: string }
  | { kind: "done"; reason: string };

export interface LbDecision { state: LimitBracketState; action: LbAction }

export const LB_FILL_DEBOUNCE = 3;   // 체결/만료/종료 단정 전 연속 동일관측 횟수(RECON_CLEAR_MISSES 패턴)
export const LB_PLACE_COOLDOWN = 3;  // 주문 직후 재주문 금지 틱(인덱싱 지연 흡수)
export const LB_REORDER_CAP = 8;     // 세션당 주문 횟수 상한(환경무관 스팸 차단)
const EPS = 1e-9;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function initLimitBracketState(baselineQty: number, nowIso: string): LimitBracketState {
  return {
    phase: "awaiting_buy", status: "closed", qty: 0, baselineQty: Math.max(0, baselineQty),
    filledQty: 0, soldQty: 0, reorderCount: 0, placeCooldown: 0, fillMisses: 0, sellMisses: 0, doneMisses: 0, openedAt: nowIso,
  };
}

/** 매수 체결 감지(자기주문 cntr 1차, 소멸 시 보유델타 교차 + 디바운스). 페이퍼는 닫힌봉 저가 교차. */
function detectBuyFill(node: LbNode, s: LimitBracketState, obs: LbObservation): { newFill: number; total: number; misses: number; reason: string } {
  if (obs.paper) {
    const crossed = obs.refLow != null && obs.refLow <= node.buyPrice;
    if (crossed && s.filledQty < node.qty - EPS) return { newFill: node.qty - s.filledQty, total: node.qty, misses: 0, reason: "페이퍼 매수 가격교차 체결" };
    return { newFill: 0, total: s.filledQty, misses: 0, reason: "페이퍼 미교차" };
  }
  if (obs.restingBuy) { // 주문 유지 → cntr(체결분)이 귀속 권위
    const total = clamp(Math.max(s.filledQty, obs.restingBuy.executedQty), 0, node.qty);
    if (total > s.filledQty + EPS) return { newFill: total - s.filledQty, total, misses: 0, reason: `매수 부분체결(cntr=${obs.restingBuy.executedQty})` };
    return { newFill: 0, total: s.filledQty, misses: 0, reason: "매수 미체결(주문 유지)" };
  }
  // 주문 소멸: 보유델타 증가로만 체결 확정(소멸 단독 금지). 증가 없으면 만료 후보(디바운스).
  if (obs.ownHeldDelta > s.filledQty + EPS) {
    const total = clamp(obs.ownHeldDelta, 0, node.qty);
    return { newFill: total - s.filledQty, total, misses: 0, reason: `매수 체결 확인(보유델타=${obs.ownHeldDelta})` };
  }
  return { newFill: 0, total: s.filledQty, misses: s.fillMisses + 1, reason: "매수주문 소멸·보유증가 없음(만료 후보, 디바운스)" };
}

/** 매도 체결 감지(보유 감소 = filledQty - 계좌보유). cntr 교차. 페이퍼는 닫힌봉 고가 교차. */
function detectSellFill(node: LbNode, s: LimitBracketState, obs: LbObservation): { newSold: number; total: number; misses: number; reason: string } {
  const sellPrice = node.sellPrice ?? 0;
  if (obs.paper) {
    const crossed = obs.refHigh != null && obs.refHigh >= sellPrice && sellPrice > 0;
    if (crossed && s.soldQty < s.filledQty - EPS) return { newSold: s.filledQty - s.soldQty, total: s.filledQty, misses: 0, reason: "페이퍼 매도 가격교차 체결" };
    return { newSold: 0, total: s.soldQty, misses: 0, reason: "페이퍼 미교차" };
  }
  // 봇 귀속 보유 감소분으로 매도 확인: 소진 = filledQty - 현 보유(ownHeldDelta). cntr과 max.
  const soldObserved = clamp(s.filledQty - obs.ownHeldDelta, 0, s.filledQty);
  const cntr = obs.restingSell ? obs.restingSell.executedQty : 0;
  const total = clamp(Math.max(s.soldQty, soldObserved, cntr), 0, s.filledQty);
  if (total > s.soldQty + EPS) return { newSold: total - s.soldQty, total, misses: 0, reason: `매도 체결(cntr=${cntr}, 보유감소=${soldObserved.toFixed(8)})` };
  if (!obs.restingSell) return { newSold: 0, total: s.soldQty, misses: s.sellMisses + 1, reason: "매도주문 소멸·보유 그대로(만료 후보, 디바운스)" };
  return { newSold: 0, total: s.soldQty, misses: 0, reason: "매도 미체결(주문 유지)" };
}

/**
 * 한 틱 결정(순수). prev 상태 + 관측 → 다음 상태 + 단일 액션. 액션은 wrapper가 수행(place는 결과 orderId를 state에 패치).
 * 한 틱 1액션(체결기록 OR 주문 OR 종료 OR 대기). 다음 틱 재관측 → 다단계 진행.
 */
export function decideLimitBracket(node: LbNode, prev: LimitBracketState, obs: LbObservation): LbDecision {
  const s: LimitBracketState = { ...prev };
  if (s.reorderSessionKey !== obs.sessionKey) { s.reorderCount = 0; s.reorderSessionKey = obs.sessionKey; } // 세션 전환=캡 리셋
  if (s.placeCooldown > 0) s.placeCooldown -= 1;
  const grace = !s.bootGraceDone; // 재시작 첫 틱: 관측·입양만(신규 주문 금지)
  s.bootGraceDone = true;
  // 입양(미설정일 때만, 덮어쓰기 금지)
  if (obs.restingBuy && !s.entryOrderId) s.entryOrderId = obs.restingBuy.orderId;
  if (obs.restingSell && !s.exitOrderId) s.exitOrderId = obs.restingSell.orderId;

  const canPlace = !grace && obs.marketOpen && s.placeCooldown <= 0 && s.reorderCount < LB_REORDER_CAP;
  const reasonBlocked = !obs.marketOpen ? "장마감 — 모니터(장 열리면 재주문)" : grace ? "재시작 그레이스(관측만)" : s.placeCooldown > 0 ? `주문 쿨다운(${s.placeCooldown})` : s.reorderCount >= LB_REORDER_CAP ? "세션 재주문 캡 도달(동결)" : "대기";

  // ── 매수 단계 ──
  if (s.phase === "awaiting_buy" || s.phase === "buy_resting") {
    const det = detectBuyFill(node, s, obs);
    if (det.newFill > EPS) {
      s.filledQty = det.total; s.qty = s.filledQty - s.soldQty; s.entryAvg = node.buyPrice;
      s.status = s.qty > EPS ? "open" : "closed"; s.live = !obs.paper; s.fillMisses = 0;
      if (s.filledQty >= node.qty - EPS) s.phase = "bought"; // 완전체결 → 매도 단계(부분은 buy_resting 유지하며 잔량 재주문)
      else s.phase = "buy_resting";
      return { state: s, action: { kind: "fill", side: "buy", qty: det.newFill, price: node.buyPrice, reason: det.reason } };
    }
    s.fillMisses = det.misses;
    if (obs.restingBuy) { if (s.phase === "awaiting_buy") s.phase = "buy_resting"; return { state: s, action: { kind: "noop", reason: "매수 지정가 대기중(체결 대기)" } }; }
    const remaining = node.qty - s.filledQty;
    // 첫 주문(awaiting_buy)=즉시. 재주문(주문 소멸)=디바운스 후만 — 체결 직후 getPositions 미반영 찰나의 이중매수 차단(kr#2).
    const okToReorder = s.phase === "awaiting_buy" || s.fillMisses >= LB_FILL_DEBOUNCE;
    if (canPlace && remaining > EPS && okToReorder) {
      s.phase = "buy_resting"; s.placeCooldown = LB_PLACE_COOLDOWN; s.reorderCount += 1; s.fillMisses = 0;
      return { state: s, action: { kind: "place", side: "buy", price: node.buyPrice, qty: remaining, reason: `매수 지정가 주문(세션 ${s.reorderCount}/${LB_REORDER_CAP})` } };
    }
    return { state: s, action: { kind: "noop", reason: !okToReorder ? `매수 체결 확인중(${s.fillMisses}/${LB_FILL_DEBOUNCE})` : reasonBlocked } };
  }

  // ── 매수 완료 → 매도 단계 진입 ──
  if (s.phase === "bought") {
    if (node.sellPrice == null) { s.phase = "done"; s.status = "closed"; return { state: s, action: { kind: "done", reason: "매수전용 봇(매도가 없음) — 보유 유지, 봇 종료" } }; }
    if (canPlace && !obs.restingSell && s.qty > EPS) {
      s.phase = "sell_resting"; s.placeCooldown = LB_PLACE_COOLDOWN; s.reorderCount += 1;
      return { state: s, action: { kind: "place", side: "sell", price: node.sellPrice, qty: s.qty, reason: "매도 지정가 주문" } };
    }
    if (s.qty <= EPS) { s.phase = "done"; s.status = "closed"; return { state: s, action: { kind: "done", reason: "보유 없음 — 종료" } }; }
    return { state: s, action: { kind: "noop", reason: reasonBlocked } };
  }

  // ── 매도 대기 ──
  if (s.phase === "sell_resting") {
    const det = detectSellFill(node, s, obs);
    if (det.newSold > EPS) {
      s.soldQty = det.total; s.qty = s.filledQty - s.soldQty; s.sellMisses = 0;
      if (s.qty <= EPS) s.status = "closed";
      return { state: s, action: { kind: "fill", side: "sell", qty: det.newSold, price: node.sellPrice ?? 0, reason: det.reason } };
    }
    s.sellMisses = det.misses;
    if (s.qty <= EPS && !obs.restingSell) { // 보유0 + 매도소멸 → 디바운스 후 종료
      s.doneMisses += 1;
      if (s.doneMisses >= LB_FILL_DEBOUNCE) { s.phase = "done"; s.status = "closed"; return { state: s, action: { kind: "done", reason: "매도 체결 완료 — 자동 종료" } }; }
      return { state: s, action: { kind: "noop", reason: `매도 체결 확인중(${s.doneMisses}/${LB_FILL_DEBOUNCE})` } };
    }
    s.doneMisses = 0;
    if (obs.restingSell) return { state: s, action: { kind: "noop", reason: "매도 지정가 대기중" } };
    const okSellReorder = s.sellMisses >= LB_FILL_DEBOUNCE; // 매도 재주문도 디바운스 후만(체결 미반영 이중매도 차단)
    if (canPlace && s.qty > EPS && okSellReorder) {
      s.placeCooldown = LB_PLACE_COOLDOWN; s.reorderCount += 1; s.sellMisses = 0;
      return { state: s, action: { kind: "place", side: "sell", price: node.sellPrice ?? 0, qty: s.qty, reason: `매도 지정가 재주문(세션 ${s.reorderCount}/${LB_REORDER_CAP})` } };
    }
    return { state: s, action: { kind: "noop", reason: !okSellReorder ? `매도 체결 확인중(${s.sellMisses}/${LB_FILL_DEBOUNCE})` : reasonBlocked } };
  }

  return { state: s, action: { kind: "done", reason: "완료됨" } };
}

/**
 * 내 미체결 주문 식별(getOpenOrders 결과에서). orderId 1차 매칭, 미상이면 side+가격(정렬값) 동일 후보가 '정확히 1건'일 때만 입양.
 * 후보 2건↑=ambiguous(수동주문/타봇 오입양 위험)→null. 가격은 호출측이 KRX 틱 정렬해 넘김(roundToKrxTick(buyPrice)).
 */
export function findMyRestingOrder(
  orders: { orderId: string; side: "buy" | "sell"; price: number; quantity: number; executedQty?: number }[],
  side: "buy" | "sell", targetPrice: number, knownId?: string,
): { order: RestingOrder | null; ambiguous: boolean } {
  if (knownId) {
    const m = orders.find((o) => o.orderId === knownId);
    if (m) return { order: { orderId: m.orderId, remainingQty: m.quantity, executedQty: m.executedQty ?? 0 }, ambiguous: false };
  }
  const cand = orders.filter((o) => o.side === side && targetPrice > 0 && Math.abs(o.price - targetPrice) / targetPrice < 0.0005);
  if (cand.length === 1) return { order: { orderId: cand[0].orderId, remainingQty: cand[0].quantity, executedQty: cand[0].executedQty ?? 0 }, ambiguous: false };
  if (cand.length > 1) return { order: null, ambiguous: true }; // 오입양 방지(fail-closed)
  return { order: null, ambiguous: false };
}
