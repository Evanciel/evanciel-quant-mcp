/**
 * core/execution/entry.ts — 봇 지정가 진입 체결 모델(audit P1-5). 순수함수 → 백테 엔진(runCompositeBacktest)·
 *   라이브 러너(resolvePendingEntry)가 동일 로직 공유 → backtest≡live.
 *
 * 핵심 불변(never-more-optimistic): 백테 진입 체결가는 항상 ≥ limitPrice = 라이브 최선가(floor).
 *   - TOUCH: 윈도우 내 봉이 지정가를 strict 통과(low<limit)하면 limit 체결(maker, 슬리피지 0). = floor(동등).
 *   - TIMEOUT: 끝까지 미교차면 시장가 폴백 close*(1+cap) (> limit, 엄격 보수). 라이브는 캡 초과 시 freeze(무체결/후속 더 나쁨).
 *   ⇒ 모든 분기에서 백테가 라이브보다 낙관일 수 없음. 증명: docs/02-design/p1-5-limit-entry-design.md §3.
 *   잔차(OHLCV 불가피·정직): 체결 "빈도" — 백테는 교차 시 maker 체결 가정, 라이브는 큐로 미스 가능 → 라이브가 덜 진입(보수쪽).
 */
import type { EntryExecution } from "../types/strategy.js";

export const TIMEOUT_BARS_MIN = 1;
export const TIMEOUT_BARS_MAX = 50;
export const TIMEOUT_BARS_DEFAULT = 3;
export const MAX_SLIPPAGE_MIN = 0;
export const MAX_SLIPPAGE_MAX = 5;
export const MAX_SLIPPAGE_DEFAULT = 0.5;
export const LIMIT_OFFSET_MIN = -5;
export const LIMIT_OFFSET_MAX = 0;

const clamp = (n: number, lo: number, hi: number, dflt: number): number =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;

export const clampTimeoutBars = (n: number | undefined): number =>
  Math.round(clamp(n ?? TIMEOUT_BARS_DEFAULT, TIMEOUT_BARS_MIN, TIMEOUT_BARS_MAX, TIMEOUT_BARS_DEFAULT));
export const clampMaxSlippagePct = (n: number | undefined): number =>
  clamp(n ?? MAX_SLIPPAGE_DEFAULT, MAX_SLIPPAGE_MIN, MAX_SLIPPAGE_MAX, MAX_SLIPPAGE_DEFAULT);
/** 매수 maker는 현재가 이하(≤0)만 허용 — 양수 오프셋(현재가 위 매수)은 즉시 체결되는 taker라 maker 의미 없음 → 0으로 클램프. */
export const clampLimitOffsetPct = (n: number | undefined): number =>
  clamp(n ?? 0, LIMIT_OFFSET_MIN, LIMIT_OFFSET_MAX, 0);

/** 매수 지정가 = close*(1+offsetPct/100), offsetPct≤0(maker, 현재가 이하). */
export function computeLimitPrice(close: number, offsetPct: number): number {
  return close * (1 + clampLimitOffsetPct(offsetPct) / 100);
}

/**
 * 닫힌봉 경과수(placedIso~curIso, intervalMs 격자). 라이브 타임아웃 판정용(Date.now 아님 — 봉 정렬 유지로 backtest≡live).
 * 백테는 인덱스 차(i-signalIdx)가 곧 경과 봉수라 이 함수 불요; 라이브 러너가 placedBarIso vs lastIso로 동일 단위 산출.
 */
export function elapsedClosedBars(placedIso: string, curIso: string, intervalMs: number): number {
  if (!(intervalMs > 0)) return 0;
  const a = Date.parse(placedIso), b = Date.parse(curIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.floor((b - a) / intervalMs));
}

/**
 * 슬리피지 캡 검사(라이브 폴백 시장가 제출 "전" 게이트). deviation=(quote-limit)/limit*100 > capPct면 차단(freeze).
 * 백테 타임아웃 슬립도 동일 capPct 사용 → 폴백 레그도 라이브보다 싸지 않음.
 */
export function checkSlippageCap(limitPrice: number, quote: number, capPct: number): { ok: boolean; deviationPct: number } {
  if (!(limitPrice > 0) || !(quote > 0)) return { ok: false, deviationPct: Number.POSITIVE_INFINITY };
  const deviationPct = ((quote - limitPrice) / limitPrice) * 100;
  return { ok: deviationPct <= clampMaxSlippagePct(capPct) + 1e-12, deviationPct };
}

/**
 * 백테 봇 진입 체결 해소(worse-of clamp). 신호 bar signalIdx에서:
 *   - market/미설정 → { fillPrice: close*(1+slip/100), entryBarIndex: signalIdx } (레거시 바이트 동일).
 *   - limit → 윈도우 [s, s+timeoutBars-1]서 strict-cross(low<limit) 시 첫 봉 j에서 limit 체결(maker),
 *     미교차 시 봉 t=min(s+timeoutBars,last)서 max(limit, close_t*(1+cap/100)) 폴백.
 * entryBarIndex(지연)는 호출측(엔진)이 포지션 개시 봉으로 사용 → SL/TP/에쿼티가 그 봉부터 시작(풀 충실).
 */
export function resolveEntryFill(
  data: { low: number; close: number }[],
  signalIdx: number,
  entryExec: EntryExecution | undefined,
  slippagePct: number,
): { fillPrice: number; entryBarIndex: number } {
  const close_s = data[signalIdx].close;
  if (!entryExec || entryExec.type !== "limit") {
    return { fillPrice: close_s * (1 + slippagePct / 100), entryBarIndex: signalIdx };
  }
  const limitPrice = computeLimitPrice(close_s, entryExec.limitOffsetPct ?? 0);
  const timeoutBars = clampTimeoutBars(entryExec.timeoutBars);
  const cap = clampMaxSlippagePct(entryExec.maxSlippagePct);
  const last = data.length - 1;
  const windowEnd = Math.min(signalIdx + timeoutBars - 1, last);
  for (let j = signalIdx; j <= windowEnd; j++) {
    if (data[j].low < limitPrice) return { fillPrice: limitPrice, entryBarIndex: j }; // strict cross = 통과(tag 아님)
  }
  const t = Math.min(signalIdx + timeoutBars, last);
  const fallback = data[t].close * (1 + cap / 100);
  return { fillPrice: Math.max(limitPrice, fallback), entryBarIndex: t }; // worse-of: 폴백 ≥ limit(never-optimistic 못박기)
}
