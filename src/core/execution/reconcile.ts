/**
 * execution/reconcile.ts — 실잔고/실포지션 동기화 + 체결 확인의 순수 결정 로직.
 *
 * 왜 중요한가(P0): 현재 봇은 거래소 실잔고/실포지션을 한 번도 안 본다. capital은 가상값이고, 라이브 주문이
 * 부분체결/거부되면 로컬 장부와 거래소 진실이 소리없이 발산한다. 이 모듈은 "거래소 진실 vs 로컬"을 비교해
 * 드리프트를 정량화(computePositionDrift)하고, 실잔고 기반 사이징(sizeFromBalance), 모호한 주문의 체결여부
 * 판정(classifyFillStatus)을 순수하게 계산한다. 어댑터 호출(getBalance/getPositions/getOrderByClientId)은 러너가.
 */

export interface DriftResult {
  inSync: boolean;
  localQty: number;
  exchangeQty: number;
  driftQty: number;          // exchange - local (양수=거래소가 더 많이 보유)
  severity: "ok" | "minor" | "major";
  recommended: "none" | "adopt_exchange"; // 정정 권고: 거래소 진실 채택
}

/**
 * 로컬 장부 수량 vs 거래소 실제 수량 비교(순수). 절대/상대 허용오차 내면 동기화로 간주.
 * 발산 시 '거래소 진실 채택' 권고(거래소가 사실). major=상대 5% 초과 또는 부호 불일치.
 */
export function computePositionDrift(localQty: number, exchangeQty: number, absTol = 1e-8, relTol = 0.01): DriftResult {
  const lq = Number.isFinite(localQty) ? localQty : 0;
  const eq = Number.isFinite(exchangeQty) ? exchangeQty : 0;
  const drift = eq - lq;
  const scale = Math.max(Math.abs(lq), Math.abs(eq), 1e-12);
  const rel = Math.abs(drift) / scale;
  const inSync = Math.abs(drift) <= absTol || rel <= relTol;
  let severity: DriftResult["severity"] = "ok";
  if (!inSync) severity = rel > 0.05 || Math.sign(lq) !== Math.sign(eq) ? "major" : "minor";
  return { inSync, localQty: lq, exchangeQty: eq, driftQty: +drift.toFixed(10), severity, recommended: inSync ? "none" : "adopt_exchange" };
}

/**
 * 실잔고 기반 주문 수량 산정(순수). 가용현금×비율/가격 → lot 절사. 현금 부족/비정상 입력이면 0.
 * 라이브에서 정적 capital이 아니라 실제 cashBalance로 사이징 → 잔고초과 주문(거래소 거부) 방지.
 */
export function sizeFromBalance(cashBalance: number, price: number, fractionPercent: number, lotStep = 0): number {
  if (!(cashBalance > 0) || !(price > 0) || !(fractionPercent > 0)) return 0;
  const budget = cashBalance * (Math.min(100, fractionPercent) / 100);
  let qty = budget / price;
  // lotStep 지정 시 그 격자로, 아니면 8자리(크립토 분수 — 정수 floor 금지: BTC 소액=0 방지).
  qty = lotStep > 0 ? Math.floor(qty / lotStep) * lotStep : Math.floor(qty * 1e8) / 1e8;
  return qty > 0 ? qty : 0;
}

/**
 * 종목코드 정규화(reconcile 매칭 전용, 순수). 거래소(키움/KIS) Position.symbol과 bot.symbol을 동일 키로.
 * KR 종목은 접두 'A'(예: A005930) / 접미 거래소코드(005930.KS, 005930_AL) 변형이 있어 6자리 숫자코드로 환원.
 * 크립토(BTCUSDT 등 6자리 패턴 불일치)는 대문자 트림만(원형 유지) → 동일 심볼끼리만 매칭.
 */
function normSym(symbol: string): string {
  const s = String(symbol ?? "").trim().toUpperCase();
  const noPrefix = /^[A-Z]\d{6}$/.test(s) ? s.slice(1) : s; // 'A005930' → '005930'
  const m = noPrefix.match(/^(\d{6})\b/);                    // '005930.KS' → '005930'
  return m ? m[1] : noPrefix;
}

export interface ExchangePos { symbol: string; quantity: number; avgPrice: number }
export type ReconAction = "in_sync" | "adopt" | "no_exchange_pos";
export interface ReconResult {
  action: ReconAction;
  drift: DriftResult;
  /** 채택할 거래소 진실(adopt 시) — 거래소 실수량/평단. 그 외 null. */
  next: { qty: number; entryAvg: number } | null;
  /** 거래소에서 같은 종목 보유가 2건 이상 매칭(종목당 다중봇 등) → 귀속 모호. 첫 건 채택 + 호출측 경고. */
  ambiguous: boolean;
}

/**
 * 로컬 장부 포지션 vs 거래소 실보유를 비교해 reconcile 행동을 결정(순수). 어댑터 호출(getPositions)은 러너가.
 *
 * 설계(키움 지연체결): 매수 시장가가 주문 시점엔 pending+price0(체결 미확인)→fail-closed 동결(장부 0)되나,
 *   키움 모의서버가 잠시 후 실제 체결 → 거래소엔 실보유, 장부엔 0(역방향 발산). 다음 틱 이 함수가 거래소
 *   진실(실수량/평단)을 채택(adopt)해 장부를 확정한다. computePositionDrift 재사용으로 드리프트 정량화.
 *
 * ⚠️ '가짜보유 정정'(장부 보유인데 거래소 빈배열)은 여기서 즉시 clear하지 **않는다** → action='no_exchange_pos'만
 *   반환. 이유: 지연체결 특성상 방금 라이브로 산 정상 포지션도 거래소에 아직 안 떠 빈배열로 보일 수 있어(=adopt의
 *   대칭 위험), 빈배열을 곧장 '가짜보유'로 단정하면 정상 포지션을 오삭제한다. 러너가 연속 N틱 부재를 카운트해
 *   보수적으로 처리(fail-closed). 즉 이 함수는 **거래소→장부 채움(adopt)만 권고**, 장부→0(clear)은 호출측 정책.
 *
 * 반환:
 *   - in_sync: 거래소 매칭 수량이 로컬과 허용오차 내(정상) → next=null(무동작).
 *   - adopt: 거래소 보유>0인데 로컬과 발산 → next={거래소 수량/평단} 채택 권고.
 *   - no_exchange_pos: 거래소에 그 종목 보유 없음(빈배열/미매칭) → next=null(러너가 보수 처리; 장부 0이면 자명 동기).
 */
export function reconcilePositionFromExchange(
  localPos: { qty: number } | null | undefined,
  exchangePositions: ExchangePos[],
  symbol: string,
): ReconResult {
  const localQty = localPos && Number.isFinite(localPos.qty) ? localPos.qty : 0;
  const target = normSym(symbol);
  const matched = (Array.isArray(exchangePositions) ? exchangePositions : []).filter(
    (p) => p && normSym(p.symbol) === target && Number.isFinite(p.quantity) && Math.abs(p.quantity) > 1e-9,
  );
  const ambiguous = matched.length > 1;
  const chosen = matched[0]; // 종목당 단일봇 가정 — 다중 매칭이면 첫 건 + ambiguous 플래그
  const exchangeQty = chosen ? chosen.quantity : 0;
  const drift = computePositionDrift(localQty, exchangeQty);

  if (exchangeQty <= 1e-9) {
    // 거래소에 해당 종목 보유 없음. 장부가 0이면 자명 동기(no-op), 장부가 양수면 '가짜보유 후보' →
    //   여기서 단정 clear 안 함(러너가 연속 부재 카운트로 보수 처리). 어느 쪽이든 action 동일.
    return { action: "no_exchange_pos", drift, next: null, ambiguous };
  }
  if (drift.inSync) {
    // 거래소 보유 == 로컬(허용오차 내) → 정상. 채택 불필요.
    return { action: "in_sync", drift, next: null, ambiguous };
  }
  // 거래소 보유>0 && 발산 → 거래소 진실 채택(지연체결 반영 / 부분체결 실수량 / 평단 거래소값).
  return {
    action: "adopt",
    drift,
    next: { qty: exchangeQty, entryAvg: Number.isFinite(chosen.avgPrice) && chosen.avgPrice > 0 ? chosen.avgPrice : 0 },
    ambiguous,
  };
}

export type FillVerdict = "filled" | "open" | "not_placed" | "rejected" | "unknown";

/**
 * 모호한 placeOrder(타임아웃/네트워크 실패) 후 getOrderByClientId 결과로 체결여부 판정(순수).
 * filled→확정 / pending(지정가 미체결)→open / null(주문없음)→재시도 안전 / rejected→실패 / 조회불가(undefined)→unknown(보수적).
 */
export function classifyFillStatus(order: { status: "filled" | "pending" | "rejected" } | null | undefined): FillVerdict {
  if (order === undefined) return "unknown";   // 어댑터가 조회 미지원 → 보수적
  if (order === null) return "not_placed";      // 거래소에 없음 → 주문 안 나감(재시도 안전)
  switch (order.status) {
    case "filled": return "filled";
    case "pending": return "open";
    case "rejected": return "rejected";
    default: return "unknown";
  }
}
