/**
 * execution/protective.ts — 거래소 상주 보호주문(손절/익절/트레일링) 계획 + 정합(순수함수).
 *
 * 왜 중요한가(P0): 현재 봇은 폴링으로 SL/TP를 평가→시장가 청산한다. 봇이 죽거나 봉 사이엔 손절이 작동 안 한다.
 * **거래소에 상주(resting) STOP/TP 주문을 걸면** 봇 가동 여부·300봉 윈도우와 무관하게 거래소가 손절을 지킨다.
 * 이 모듈은 "어떤 보호주문을 어느 가격에 걸어야 하는가"(planProtectiveOrders)와 "지금 걸린 것과 비교해
 * 무엇을 취소/신규(reconcileProtective)"를 순수하게 계산한다. 실제 거래소 전송은 러너(키 게이트)가 한다.
 *
 * 정직: 보호주문은 '리스크 통제'의 핵심이지 알파가 아니다. 슬리피지·갭·부분체결은 여전히 존재.
 */

export interface ProtectiveOrder {
  kind: "stop_loss" | "take_profit";
  type: "stop_market" | "take_profit_market";
  side: "buy" | "sell";    // 롱 보호=sell, 숏 보호=buy(reduceOnly)
  quantity: number;
  stopPrice: number;       // 트리거 가격(소수 자리 보정은 어댑터 normalizeQuantity/가격필터에서)
  reduceOnly: true;
  clientOrderId: string;   // 멱등 슬롯: botId-symbol-kind-stopPrice (가격 바뀌면 새 주문 = 트레일링 갱신)
}

export interface ProtectiveInput {
  botId: string;
  symbol: string;
  positionSide: "long" | "short";
  qty: number;
  entryAvg: number;
  extremeSinceEntry?: number;      // 롱=진입 후 고점, 숏=진입 후 저점(트레일링 기준). 없으면 entryAvg.
  stopLossPercent?: number | null;
  takeProfitPercent?: number | null;
  trailingStopPercent?: number | null;
}

const r8 = (x: number) => +x.toFixed(8);

/**
 * 현재 포지션에 걸어야 할 상주 보호주문 목록 계산(순수, 룩어헤드 없음 — 현재 평단/극값만 사용).
 * 롱: SL=평단×(1−sl%), 트레일=고점×(1−trail%), 유효SL=둘 중 높은 값(더 타이트=이익보호). TP=평단×(1+tp%). 보호=sell.
 * 숏: 부호 반전. SL=평단×(1+sl%), 트레일=저점×(1+trail%), 유효SL=둘 중 낮은 값. TP=평단×(1−tp%). 보호=buy.
 */
export function planProtectiveOrders(input: ProtectiveInput): ProtectiveOrder[] {
  const { botId, symbol, positionSide, qty, entryAvg } = input;
  if (!(qty > 0) || !(entryAvg > 0)) return [];
  const long = positionSide === "long";
  const protectSide: "buy" | "sell" = long ? "sell" : "buy";
  const sl = num(input.stopLossPercent);
  const tp = num(input.takeProfitPercent);
  const trail = num(input.trailingStopPercent);
  const extreme = Number.isFinite(input.extremeSinceEntry as number) && (input.extremeSinceEntry as number) > 0 ? (input.extremeSinceEntry as number) : entryAvg;

  const orders: ProtectiveOrder[] = [];

  // 손절(고정 + 트레일링 결합)
  let stopPrice: number | null = null;
  if (sl != null) stopPrice = long ? entryAvg * (1 - sl / 100) : entryAvg * (1 + sl / 100);
  if (trail != null) {
    const trailStop = long ? extreme * (1 - trail / 100) : extreme * (1 + trail / 100);
    // 롱: 더 높은(타이트한) 손절 채택 / 숏: 더 낮은
    stopPrice = stopPrice == null ? trailStop : long ? Math.max(stopPrice, trailStop) : Math.min(stopPrice, trailStop);
  }
  if (stopPrice != null && stopPrice > 0) {
    orders.push({ kind: "stop_loss", type: "stop_market", side: protectSide, quantity: qty, stopPrice: r8(stopPrice), reduceOnly: true, clientOrderId: coid(botId, symbol, "sl", stopPrice) });
  }

  // 익절(고정)
  if (tp != null) {
    const tpPrice = long ? entryAvg * (1 + tp / 100) : entryAvg * (1 - tp / 100);
    if (tpPrice > 0) orders.push({ kind: "take_profit", type: "take_profit_market", side: protectSide, quantity: qty, stopPrice: r8(tpPrice), reduceOnly: true, clientOrderId: coid(botId, symbol, "tp", tpPrice) });
  }

  return orders;
}

export interface ProtectiveDiff {
  toPlace: ProtectiveOrder[];        // 새로 걸 주문
  toCancel: string[];                // 취소할 기존 주문의 clientOrderId
}

/**
 * 원하는 보호주문(desired)과 현재 거래소에 걸린 것(resting clientOrderId 목록)을 비교 → 취소/신규 결정(순수).
 * 같은 clientOrderId가 이미 걸려 있으면 그대로 둔다(멱등). desired에 없는 resting은 취소. desired에 있는데
 * resting에 없으면 신규. 트레일링으로 stopPrice가 바뀌면 clientOrderId가 달라져 → 옛 것 취소 + 새 것 신규.
 */
export function reconcileProtective(desired: ProtectiveOrder[], restingClientOrderIds: string[]): ProtectiveDiff {
  const want = new Set(desired.map((o) => o.clientOrderId));
  const have = new Set(restingClientOrderIds);
  const toPlace = desired.filter((o) => !have.has(o.clientOrderId));
  const toCancel = restingClientOrderIds.filter((id) => !want.has(id));
  return { toPlace, toCancel };
}

/**
 * 보호주문 동기화 오케스트레이션(어댑터 콜백 주입 → 순수 테스트 가능). desired vs resting 차이만큼 취소/신규.
 * place는 성공 시 clientOrderId 반환(실패 null). 개별 실패는 삼켜 다음 주문 진행(부분 성공 허용). 새 resting 반환.
 * 러너가 adapter.placeOrder/cancelOrder를 콜백으로 넘겨 호출. 게이트 OFF면 러너가 아예 호출 안 함(dormant).
 */
export async function syncProtective(
  desired: ProtectiveOrder[],
  restingIds: string[],
  place: (o: ProtectiveOrder) => Promise<string | null>,
  cancel: (clientOrderId: string) => Promise<boolean>,
): Promise<{ restingIds: string[]; placed: number; cancelled: number; failed: number }> {
  const diff = reconcileProtective(desired, restingIds);
  const ids = new Set(restingIds);
  let placed = 0, cancelled = 0, failed = 0;
  for (const id of diff.toCancel) {
    try { if (await cancel(id)) { ids.delete(id); cancelled++; } else failed++; } catch { failed++; }
  }
  for (const o of diff.toPlace) {
    try { const r = await place(o); if (r) { ids.add(o.clientOrderId); placed++; } else failed++; } catch { failed++; }
  }
  return { restingIds: [...ids], placed, cancelled, failed };
}

function num(x: number | null | undefined): number | null {
  return typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null;
}
function coid(botId: string, symbol: string, kind: string, price: number): string {
  // 거래소 clientOrderId 한도(≤36자, [a-zA-Z0-9-_])라 botId(UUID 36자)+접미사를 그대로 못 씀.
  // (botId|symbol|kind|price)의 32비트 해시를 base36으로 → 가격 포함이라 트레일링 갱신 시 새 슬롯(취소+재배치). 안정적·짧음.
  const key = `${botId}|${symbol}|${kind}|${Math.round(price * 1e2)}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) >>> 0;
  return `p${kind === "sl" ? "S" : "T"}${h.toString(36)}`; // 예: pS1a2b3c (≤10자, kind는 해시키에도 포함)
}
