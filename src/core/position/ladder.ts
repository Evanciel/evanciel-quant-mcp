/**
 * 포지션 라이프사이클 — 다단계 부분익절(TP 라더) + 스케일인(물타기) 단일 출처 (Design Ref: tp-ladder §2 Option C).
 *
 * ★ backtest≡live 핵심: 이 순수함수를 라이브(bot-runner)와 백테(engine)가 "동일 호출" → 발산 원천 차단.
 *   (기존 weightedChildRatios/computePerfMetric/computeIndicator 공용 헬퍼 패턴 계승.)
 * I/O 없음. DB 로드/저장(live)·in-memory(backtest)는 호출부 책임.
 *
 * 우선순위(한 틱): ① 손절 ② 전략 매도신호 ③ TP 라더(가격↑ 부분청산) ④ 스케일인(가격↓ 물타기 추가매수).
 *   ①~④는 가격 구간이 배타적(↑=TP, ↓past SL=손절, ↓above SL=물타기)이라 한 틱에 청산·추가가 동시 발생 안 함.
 * v1=스케일아웃(진입1회+부분익절). v2=스케일인(물타기 평단낮추기, 총포지션 배수캡=마틴게일 폭발 방지).
 */
import { floorQty } from "./qty";

/** TP 라더 레벨: pct=익절선 상승률(%), sellPct=그 시점 "남은 수량" 대비 매도 비율(%). */
export interface LadderLevel {
  pct: number;
  sellPct: number;
}

/** 스케일인(물타기) 레벨: dropPct=평단 대비 하락률(%), addPct="base(최초) 수량" 대비 추가매수 비율(%). */
export interface ScaleInLevel {
  dropPct: number;
  addPct: number;
}

/** 스케일인 설정: ladder 레벨 + 총포지션 상한 배수(remaining+add ≤ baseQty×maxMultiple). */
export interface ScaleInConfig {
  ladder: ScaleInLevel[];
  maxMultiple: number;
}

/** 피라미딩 레벨: 평단 대비 +risePct 상승 시 base의 addPct% 추가매수(승자에 더 태움). */
export interface PyramidLevel {
  risePct: number;
  addPct: number;
}

/** 피라미딩 설정(승자 추가매수, scale-in의 상승 미러). ⚠️ tp_ladder와 상호배타(둘 다 가격↑ 발동). */
export interface PyramidConfig {
  ladder: PyramidLevel[];
  maxMultiple: number;
}

/** 봇별 포지션 라이프사이클 상태 (bots.position_state jsonb로 영속). */
export interface PositionState {
  status: "open" | "closed";
  entryAvg: number; // 평단가 (스케일인 시 가중평균 갱신)
  originalQty: number; // 최초 진입 수량
  baseQty: number; // 스케일인 addPct 기준 base 수량(=최초 진입). v1 상태엔 없을 수 있음(폴백 originalQty).
  remainingQty: number; // 현재 남은 수량
  filledLevels: number[]; // 체결된 tp_ladder 인덱스 (멱등)
  filledScaleInLevels: number[]; // 체결된 scale_in_ladder 인덱스 (멱등)
  filledPyramidLevels?: number[]; // 체결된 pyramid_ladder 인덱스 (멱등). 구버전 상태엔 없을 수 있음(폴백 []).
  slPct: number | null; // 진입 손절률(%). 스케일인으로 평단 바뀌면 slPrice 재계산용. v1 상태엔 없을 수 있음.
  trailPct?: number | null; // 트레일링 스탑(%). 설정 시 손절가가 고점 대비 -trailPct%로 따라 오름(이익 길게).
  slPrice: number; // 손절 가격(파생/표시용). 실제 비교는 slPct/trailPct 있으면 평단·고점에서 재계산.
  peakPrice: number; // 고점 (트레일링 기준)
  openedAt: string;
}

/** 한 틱에서 발생한 청산 액션. */
export interface LadderExit {
  qty: number;
  reason: string; // "ladder L1 +5%" | "stop-loss @..." | "strategy-sell"
  levelIndex?: number;
  closesPosition: boolean;
}

/** 한 틱에서 발생한 추가매수(스케일인) 액션. */
export interface LadderAdd {
  qty: number;
  reason: string; // "scale-in S1 -5%"
  levelIndex: number;
  newAvg: number; // 추가 후 갱신 평단가
}

/** 새 포지션 오픈 상태 생성. slPct=진입 손절률(%), trailingStopPercent=트레일링 스탑(%) (없으면 각각 미적용). */
export function openPosition(args: {
  entryPrice: number;
  qty: number;
  stopLossPercent?: number | null;
  trailingStopPercent?: number | null;
  openedAt: string;
}): PositionState {
  const { entryPrice, qty, stopLossPercent, trailingStopPercent, openedAt } = args;
  const slPct = stopLossPercent && stopLossPercent > 0 ? stopLossPercent : null;
  const trailPct = trailingStopPercent && trailingStopPercent > 0 ? trailingStopPercent : null;
  const slPrice = slPct ? entryPrice * (1 - slPct / 100) : 0;
  return {
    status: "open",
    entryAvg: entryPrice,
    originalQty: qty,
    baseQty: qty,
    remainingQty: qty,
    filledLevels: [],
    filledScaleInLevels: [],
    filledPyramidLevels: [],
    slPct,
    trailPct,
    slPrice,
    peakPrice: entryPrice,
    openedAt,
  };
}

/**
 * 현재 유효 손절가 = max(고정/본전 손절, 트레일링 스탑). peakPrice는 이번 틱 반영분을 전달.
 * - 고정: slPct 기준(첫 익절 후 본전이동). 없으면 저장값(v1 폴백).
 * - 트레일링: trailPct 있으면 고점×(1-trailPct/100). 고점이 오르면 손절선도 따라 오름 → 이익 보호.
 */
function effectiveStopLoss(state: PositionState, peakPrice: number): number {
  let base: number;
  if (state.slPct != null && state.slPct > 0) {
    base = state.filledLevels.length > 0 ? state.entryAvg : state.entryAvg * (1 - state.slPct / 100);
  } else {
    base = state.slPrice; // v1 폴백
  }
  const trail = state.trailPct != null && state.trailPct > 0 ? peakPrice * (1 - state.trailPct / 100) : 0;
  return Math.max(base, trail);
}

/**
 * 매 틱 평가: 현재가 + TP 라더 + (옵션)전략 매도신호 + (옵션)스케일인 → 청산/추가 액션 + 갱신 상태.
 * 순수: 입력 state를 변형하지 않고 next를 새로 반환.
 */
export function evaluateLadderTick(
  state: PositionState,
  price: number,
  ladder: LadderLevel[],
  opts: { strategySell?: boolean; scaleIn?: ScaleInConfig | null; pyramid?: PyramidConfig | null } = {}
): { exits: LadderExit[]; adds: LadderAdd[]; next: PositionState } {
  if (state.status !== "open" || state.remainingQty <= 0) {
    return { exits: [], adds: [], next: { ...state, status: "closed" } };
  }
  const peakPrice = Math.max(state.peakPrice, price);
  const baseQty = state.baseQty ?? state.originalQty;
  const slNow = effectiveStopLoss(state, peakPrice);

  // ① 손절: 유효 손절가(>0) 이하 → 잔량 전량청산. 트레일링이 바인딩이면 reason=trailing-stop.
  if (slNow > 0 && price <= slNow) {
    const isTrail = state.trailPct != null && state.trailPct > 0 && peakPrice * (1 - state.trailPct / 100) >= slNow - 1e-9;
    return {
      exits: [{ qty: state.remainingQty, reason: `${isTrail ? "trailing-stop" : "stop-loss"} @${slNow.toFixed(2)}`, closesPosition: true }],
      adds: [],
      next: { ...state, peakPrice, slPrice: slNow, remainingQty: 0, status: "closed" },
    };
  }

  // ② 전략 매도신호: 잔량 전량청산
  if (opts.strategySell) {
    return {
      exits: [{ qty: state.remainingQty, reason: "strategy-sell", closesPosition: true }],
      adds: [],
      next: { ...state, peakPrice, slPrice: slNow, remainingQty: 0, status: "closed" },
    };
  }

  const gainPct = ((price - state.entryAvg) / state.entryAvg) * 100;
  let remaining = state.remainingQty;
  let entryAvg = state.entryAvg;
  const filled = [...state.filledLevels];
  const filledSI = [...(state.filledScaleInLevels ?? [])];
  const filledPy = [...(state.filledPyramidLevels ?? [])];
  const exits: LadderExit[] = [];
  const adds: LadderAdd[] = [];

  // ③ TP 라더(가격↑): 도달한 미체결 레벨을 인덱스 순으로 부분청산 (남은수량 기준 sellPct)
  for (let i = 0; i < ladder.length; i++) {
    if (filled.includes(i) || remaining <= 0) continue;
    if (gainPct + 1e-9 < ladder[i].pct) continue;
    const isLast = i === ladder.length - 1 || ladder[i].sellPct >= 100;
    let qty = isLast ? remaining : floorQty(remaining * (ladder[i].sellPct / 100));
    if (qty <= 0 && isLast) qty = remaining;
    if (qty <= 0) { filled.push(i); continue; }
    remaining -= qty;
    filled.push(i);
    exits.push({ qty, reason: `ladder L${i + 1} +${ladder[i].pct}%`, levelIndex: i, closesPosition: remaining <= 0 });
  }

  // ④ 스케일인(물타기, 가격↓): 평단 대비 -dropPct 도달 + 미체결 + 총포지션 배수캡 미초과 → 추가매수 + 평단 가중평균 갱신.
  //   TP가 발동한 틱(가격↑)에선 dropPct 미달이라 자연히 스킵 → 한 틱에 청산·추가 동시 없음.
  const si = opts.scaleIn;
  if (si && si.ladder.length > 0 && remaining > 0 && exits.length === 0) {
    const capQty = floorQty(baseQty * (si.maxMultiple > 0 ? si.maxMultiple : 1));
    for (let i = 0; i < si.ladder.length; i++) {
      if (filledSI.includes(i)) continue;
      // running 평단 기준 하락률(%) — 추가할수록 평단↓ → 다음 레벨 트리거가 더 깊어짐(자기-간격조정, 마틴게일 완화).
      const dropNow = ((entryAvg - price) / entryAvg) * 100;
      if (dropNow + 1e-9 < si.ladder[i].dropPct) continue; // -dropPct 도달?
      let addQty = floorQty(baseQty * (si.ladder[i].addPct / 100));
      const room = capQty - remaining; // 배수캡 잔여
      if (room <= 0) { filledSI.push(i); continue; } // 캡 도달 → 더 못 담음(레벨 마킹, 추가 없음)
      if (addQty > room) addQty = room; // 캡까지만
      if (addQty <= 0) { filledSI.push(i); continue; }
      // 평단 가중평균 갱신
      entryAvg = (entryAvg * remaining + price * addQty) / (remaining + addQty);
      remaining += addQty;
      filledSI.push(i);
      adds.push({ qty: addQty, reason: `scale-in S${i + 1} -${si.ladder[i].dropPct}%`, levelIndex: i, newAvg: +entryAvg.toFixed(8) });
    }
  }

  // ⑤ 피라미딩(승자 추가매수, 가격↑): 평단 대비 +risePct 도달 + 미체결 + 배수캡 미초과 → 추가매수 + 평단 가중평균 갱신(↑).
  //   scale-in(↓)의 상승 미러. ⚠️ tp_ladder와 상호배타(둘 다 가격↑ 발동, validation 거부). TP가 청산한 틱이면 스킵(exits.length>0).
  //   추가할수록 평단↑ → 다음 트리거가 더 높아짐(자기-간격조정). 트레일링 스탑과 조합 시 트렌드라이딩(고점 추종 청산).
  const py = opts.pyramid;
  if (py && py.ladder.length > 0 && remaining > 0 && exits.length === 0) {
    const capQtyP = floorQty(baseQty * (py.maxMultiple > 0 ? py.maxMultiple : 1));
    for (let i = 0; i < py.ladder.length; i++) {
      if (filledPy.includes(i)) continue;
      const riseNow = ((price - entryAvg) / entryAvg) * 100; // running 평단 기준 상승률
      if (riseNow + 1e-9 < py.ladder[i].risePct) continue; // +risePct 도달?
      let addQty = floorQty(baseQty * (py.ladder[i].addPct / 100));
      const room = capQtyP - remaining; // 배수캡 잔여
      if (room <= 0) { filledPy.push(i); continue; }
      if (addQty > room) addQty = room;
      if (addQty <= 0) { filledPy.push(i); continue; }
      entryAvg = (entryAvg * remaining + price * addQty) / (remaining + addQty); // 평단 가중평균(↑)
      remaining += addQty;
      filledPy.push(i);
      adds.push({ qty: addQty, reason: `pyramid P${i + 1} +${py.ladder[i].risePct}%`, levelIndex: i, newAvg: +entryAvg.toFixed(8) });
    }
  }

  const nextState: PositionState = {
    ...state,
    entryAvg,
    baseQty,
    peakPrice,
    remainingQty: remaining,
    filledLevels: filled,
    filledScaleInLevels: filledSI,
    filledPyramidLevels: filledPy,
    status: remaining <= 0 ? "closed" : "open",
  };
  nextState.slPrice = effectiveStopLoss(nextState, peakPrice); // 평단/고점 변경 반영(스케일인·본전이동·트레일링)
  return { exits, adds, next: nextState };
}
