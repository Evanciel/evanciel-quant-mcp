/**
 * 포트폴리오 리스크 매니저 — MDD 서킷브레이커 + 총노출(heat) 한도 + 상관 보정. 순수함수(backtest≡live).
 *
 * 정직한 포지셔닝(리서치): 가장 견고하고 backtest≡live 구현이 쉬운 검증된 리스크 통제.
 * 단계적 MDD 디리스킹(peak 대비 -10%→사이즈50%, -20%→청산)은 단순·강력. 크립토는 급락장에서 알트 상관이
 * 1로 수렴 → 상관보정 없으면 실효리스크를 크게 과소평가. 알파가 아니라 '파산위험 통제'로 포지셔닝.
 */

export interface DdTier { dd: number; mult: number } // dd=peak대비 낙폭(0~1), mult=사이즈 배수
export const DEFAULT_DD_TIERS: DdTier[] = [
  { dd: 0.10, mult: 0.5 }, // -10% → 절반
  { dd: 0.20, mult: 0.0 }, // -20% → 청산/신규중단
];

export type CircuitState = "normal" | "reduced" | "halt";

/**
 * MDD 서킷브레이커. equity가 peak 대비 낙폭에 따라 단계적 디리스킹.
 * peakEquity는 영속 상태(DB)로 추적 — 여기선 입력으로 받아 갱신값도 반환(호출측이 저장).
 */
export function evaluateMddCircuitBreaker(opts: {
  equity: number; peakEquity: number; tiers?: DdTier[];
}): {
  ddPct: number; peakEquity: number; state: CircuitState;
  sizeMultiplier: number; allowNewEntry: boolean;
} {
  const { equity } = opts;
  const tiers = (opts.tiers ?? DEFAULT_DD_TIERS).slice().sort((a, b) => a.dd - b.dd);
  const peakEquity = Math.max(opts.peakEquity ?? equity, equity); // 신고점 갱신
  const ddPct = peakEquity > 0 ? Math.max(0, (peakEquity - equity) / peakEquity) : 0;

  // 가장 깊은(가장 큰 dd 임계를 넘은) 티어의 배수 적용
  let sizeMultiplier = 1.0;
  for (const t of tiers) if (ddPct >= t.dd) sizeMultiplier = t.mult;

  const state: CircuitState = sizeMultiplier <= 0 ? "halt" : sizeMultiplier < 1 ? "reduced" : "normal";
  return { ddPct, peakEquity, state, sizeMultiplier, allowNewEntry: sizeMultiplier > 0 };
}

/** 총노출(heat) = 오픈 포지션 리스크의 단순 합(상관 무시 명목치). risks = 각 포지션의 equity대비 리스크 비율. */
export function computePortfolioHeat(risks: number[]): number {
  return risks.filter((r) => Number.isFinite(r) && r > 0).reduce((a, b) => a + b, 0);
}

/**
 * 상관 보정 실효리스크 — 동일 평균상관 가정(rigorous): √(Σrᵢ² + ρ·((Σr)² − Σrᵢ²)).
 * ρ=0 → √Σr²(완전분산), ρ=1 → Σr(선형합). 크립토 고상관(0.7~0.9)에서 명목합보다 크게 작지 않음.
 */
export function effectiveRiskEqualCorr(risks: number[], avgCorr: number): number {
  const r = risks.filter((x) => Number.isFinite(x) && x > 0);
  if (r.length === 0) return 0;
  if (r.length === 1) return r[0];
  const sum = r.reduce((a, b) => a + b, 0);
  const sumSq = r.reduce((a, b) => a + b * b, 0);
  const rho = Math.max(0, Math.min(avgCorr, 1));
  return Math.sqrt(Math.max(0, sumSq + rho * (sum * sum - sumSq)));
}

/**
 * 상관행렬 기반 실효리스크 = √(rᵀ C r). corrMatrix[i][j]=ρ. 대각=1 가정. NxN 일치 안 하면 0.
 */
export function effectiveRiskMatrix(risks: number[], corrMatrix: number[][]): number {
  const n = risks.length;
  if (n === 0 || corrMatrix.length !== n) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    if (corrMatrix[i]?.length !== n) return 0;
    for (let j = 0; j < n; j++) {
      const rho = i === j ? 1 : corrMatrix[i][j];
      acc += risks[i] * risks[j] * (Number.isFinite(rho) ? rho : 0);
    }
  }
  return Math.sqrt(Math.max(0, acc));
}

export interface PortfolioPosition { symbol: string; riskFraction: number } // riskFraction=equity 대비 리스크(예: 포지션손절거리×수량/equity, 없으면 노출/equity)

/**
 * 종합 포트폴리오 리스크 평가. MDD 서킷 + heat 캡 + 상관보정 실효리스크 캡 → 신규진입 허용/사이즈배수.
 * 신규진입 차단 조건(OR): MDD halt / heat>maxHeat / effectiveRisk>riskBudget.
 */
export function evaluatePortfolioRisk(opts: {
  positions: PortfolioPosition[]; equity: number; peakEquity: number;
  avgCorr?: number; maxHeat?: number; riskBudget?: number; tiers?: DdTier[];
}): {
  heat: number; effectiveRisk: number; ddPct: number; state: CircuitState;
  sizeMultiplier: number; allowNewEntry: boolean; peakEquity: number; reasons: string[];
} {
  const { positions, equity, peakEquity, avgCorr = 0.7, maxHeat = 0.2, riskBudget = 0.1, tiers } = opts;
  const risks = positions.map((p) => p.riskFraction);
  const heat = computePortfolioHeat(risks);
  const effectiveRisk = effectiveRiskEqualCorr(risks, avgCorr);
  const mdd = evaluateMddCircuitBreaker({ equity, peakEquity, tiers });

  const reasons: string[] = [];
  let allowNewEntry = true;
  if (!mdd.allowNewEntry) { allowNewEntry = false; reasons.push(`MDD 서킷 halt(낙폭 ${(mdd.ddPct * 100).toFixed(1)}%)`); }
  if (heat > maxHeat) { allowNewEntry = false; reasons.push(`총노출 한도 초과(heat ${(heat * 100).toFixed(1)}% > ${(maxHeat * 100).toFixed(0)}%)`); }
  if (effectiveRisk > riskBudget) { allowNewEntry = false; reasons.push(`상관보정 실효리스크 초과(${(effectiveRisk * 100).toFixed(1)}% > ${(riskBudget * 100).toFixed(0)}%, 평균상관 ${avgCorr})`); }
  if (mdd.state === "reduced") reasons.push(`MDD 디리스킹 사이즈×${mdd.sizeMultiplier}`);

  return {
    heat, effectiveRisk, ddPct: mdd.ddPct, state: mdd.state,
    sizeMultiplier: mdd.sizeMultiplier, allowNewEntry, peakEquity: mdd.peakEquity, reasons,
  };
}
