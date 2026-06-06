/**
 * allocation.ts — 포트폴리오 자본 배분(순수). equal / inverse_vol(리스크패리티 대각근사) / vol_target.
 * 기존 risk/sizing(EWMA 변동성·연환산) 재사용. 여러 자산에 자본을 어떻게 나눌지 '제안'(자동 리밸런스 아님).
 *
 * 정직: inverse_vol은 상관 0 가정의 리스크패리티 근사(대각). 진짜 리스크패리티는 공분산 필요 — 과도한 정밀도 주장 안 함.
 * 배분은 리스크 통제 도구이지 알파 생성기가 아니다.
 */
import { computeEwmaVol, annualizeVol } from "./sizing";

export type AllocationMethod = "equal" | "inverse_vol" | "vol_target";
export interface AssetReturns { symbol: string; returns: number[] } // 봉별 로그수익률
export interface AllocationResult {
  method: AllocationMethod;
  weights: Record<string, number>;   // 합 1 (배분 비율)
  volsAnnual: Record<string, number>; // 자산별 연환산 변동성
  grossLeverage?: number;            // vol_target: 총 노출 배수(목표 변동성 달성용)
  skipped: string[];                 // 데이터 부족 제외 심볼
  note: string;
}

/**
 * 자본 배분 비율 산출. equal=동등, inverse_vol=변동성 역가중(저변동에 더), vol_target=인버스볼 후 총노출을 목표변동성에 맞춤.
 */
export function allocatePortfolio(
  assets: AssetReturns[], method: AllocationMethod,
  opts: { timeframe?: string; targetVolAnnual?: number; lambda?: number } = {}
): AllocationResult {
  const { timeframe = "1d", targetVolAnnual = 0.2, lambda = 0.94 } = opts;
  const valid = assets.filter((a) => Array.isArray(a.returns) && a.returns.length >= 2);
  const skipped = assets.filter((a) => !valid.includes(a)).map((a) => a.symbol);
  const volsAnnual: Record<string, number> = {};
  for (const a of valid) volsAnnual[a.symbol] = +annualizeVol(computeEwmaVol(a.returns, lambda), timeframe).toFixed(5);

  const n = valid.length;
  const weights: Record<string, number> = {};
  if (n === 0) return { method, weights: {}, volsAnnual, skipped, note: "유효 자산 없음(각 자산 최소 2개 수익률 필요)" };

  if (method === "equal") {
    for (const a of valid) weights[a.symbol] = +(1 / n).toFixed(6);
  } else {
    // inverse_vol / vol_target 공통: 변동성 역가중(합 1)
    const inv: Record<string, number> = {};
    let sum = 0;
    for (const a of valid) { const v = volsAnnual[a.symbol]; inv[a.symbol] = v > 0 ? 1 / v : 0; sum += inv[a.symbol]; }
    if (sum <= 0) { for (const a of valid) weights[a.symbol] = +(1 / n).toFixed(6); }
    else { for (const a of valid) weights[a.symbol] = +(inv[a.symbol] / sum).toFixed(6); }
  }

  let grossLeverage: number | undefined;
  let note = method === "equal" ? "동등 배분(1/N)." : "변동성 역가중(저변동 자산에 더 배분 = 리스크패리티 대각근사, 상관 무시).";
  if (method === "vol_target") {
    // 포트 변동성 추정(상관 0 가정, 보수적): sqrt(Σ (w_i·σ_i)^2). leverage = 목표/추정.
    let estVar = 0;
    for (const a of valid) { const w = weights[a.symbol], v = volsAnnual[a.symbol]; estVar += (w * v) * (w * v); }
    const estVol = Math.sqrt(estVar);
    grossLeverage = estVol > 0 ? +(targetVolAnnual / estVol).toFixed(3) : 1;
    note = `인버스볼 가중 후 총 노출 ×${grossLeverage}로 연환산 변동성 ${(targetVolAnnual * 100).toFixed(0)}% 목표(상관 0 가정 → 실제 상관>0이면 보수적=과소레버리지).`;
  }
  return { method, weights, volsAnnual, grossLeverage, skipped, note };
}
