/**
 * scanner/rank.ts — 유니버스 스크리닝 + 크로스섹셔널 랭킹 (순수함수, backtest≡live).
 * "아침 9시 급등주 단타"의 핵심: 여러 종목을 메트릭으로 평가→랭킹→상위 N 선정.
 *
 * 정직한 포지셔닝: 스크리닝은 '아이디어 후보 생성'이지 알파 보장이 아니다. 인트라데이 스크리닝일수록
 * 과적합·수수료·슬리피지·체결 리스크가 커진다(리서치: 리테일 방향성 알파≈0). OOS/DSR/factory가 여전히 거짓발견을 거른다.
 */
export interface RankBar { open: number; high: number; low: number; close: number; volume: number }
export type RankMetric = "gapPct" | "roc" | "relVolume" | "rangePct";

/**
 * 한 종목의 랭킹 메트릭(최신 봉 기준, 룩어헤드 없음). 산출 불가(데이터 부족/0분모)면 null.
 * - gapPct: 최신봉 시가 vs 직전봉 종가 갭%. 갭앤고 스크리닝.
 * - roc: period봉 전 대비 변화율%. 모멘텀/급등주.
 * - relVolume: 최신봉 거래량 / 직전 period봉 평균거래량. 거래량 급증.
 * - rangePct: 최신봉 (고−저)/저 ×100. 장중 변동성.
 */
export function computeRankMetric(bars: RankBar[], metric: RankMetric, period = 14): number | null {
  const n = bars.length;
  if (n < 2) return null;
  const last = bars[n - 1];
  switch (metric) {
    case "gapPct": {
      const prevClose = bars[n - 2].close;
      if (!Number.isFinite(prevClose) || prevClose === 0) return null;
      return ((last.open - prevClose) / prevClose) * 100;
    }
    case "roc": {
      if (n < period + 1) return null;
      const past = bars[n - 1 - period].close;
      if (!Number.isFinite(past) || past === 0) return null;
      return ((last.close - past) / past) * 100;
    }
    case "relVolume": {
      if (n < period + 1) return null;
      let sum = 0;
      for (let i = n - 1 - period; i < n - 1; i++) sum += bars[i].volume;
      const avg = sum / period;
      if (!Number.isFinite(avg) || avg === 0) return null;
      return last.volume / avg;
    }
    case "rangePct": {
      if (!Number.isFinite(last.low) || last.low === 0) return null;
      return ((last.high - last.low) / last.low) * 100;
    }
    default:
      return null;
  }
}

export interface RankEntry { symbol: string; bars: RankBar[] }
export interface RankResult { symbol: string; score: number }

/**
 * 유니버스를 메트릭으로 랭킹해 상위 top개 반환. 산출 불가(null) 종목은 제외(스크리닝에서 빠짐).
 * order desc=높은순(급등주/거래량), asc=낮은순(역추세/과매도 스크리닝). 동점은 symbol 사전순(결정론적).
 */
export function rankUniverse(
  entries: RankEntry[], metric: RankMetric, top: number, order: "desc" | "asc" = "desc", period = 14
): RankResult[] {
  const scored: RankResult[] = [];
  for (const e of entries) {
    const score = computeRankMetric(e.bars, metric, period);
    if (score !== null && Number.isFinite(score)) scored.push({ symbol: e.symbol, score });
  }
  scored.sort((a, b) => (a.score === b.score ? a.symbol.localeCompare(b.symbol) : order === "desc" ? b.score - a.score : a.score - b.score));
  return scored.slice(0, Math.max(0, Math.floor(top)));
}

// ── 스캐너 액션 결정 (순수함수: 보유/선정 상태 → 진입·청산 목록) ──

export interface ScannerDecision {
  toOpen: string[];   // 신규 진입(상위 N에 들고 then 신호 매수)
  toClose: string[];  // 청산(상위 N 이탈 또는 then 신호 매도/플랫)
  hold: string[];     // 유지
}

/**
 * 스캐너 1틱 액션 결정(순수). 룩어헤드 없음.
 * @param topSymbols 이번 틱 상위 N 심볼
 * @param held 현재 페이퍼 보유 심볼
 * @param wantHold 심볼별 then 전략의 "보유 희망" 여부(상위 N에 한해 평가). 상위 N 밖은 무관.
 *
 * 규칙: 상위N 이탈 종목은 무조건 청산(자본 회수). 상위N 유지 종목은 then 신호(wantHold)로 진입/청산/유지.
 */
export function decideScannerActions(topSymbols: string[], held: string[], wantHold: Record<string, boolean>): ScannerDecision {
  const topSet = new Set(topSymbols);
  const heldSet = new Set(held);
  const toOpen: string[] = [];
  const toClose: string[] = [];
  const hold: string[] = [];
  // 보유 종목 처리: 상위N 이탈 or then이 청산 희망 → 청산, 아니면 유지
  for (const s of held) {
    if (!topSet.has(s) || wantHold[s] === false) toClose.push(s);
    else hold.push(s);
  }
  // 상위N 신규 진입: 미보유 + then 매수 희망
  for (const s of topSymbols) {
    if (!heldSet.has(s) && wantHold[s] === true) toOpen.push(s);
  }
  return { toOpen, toClose, hold };
}
