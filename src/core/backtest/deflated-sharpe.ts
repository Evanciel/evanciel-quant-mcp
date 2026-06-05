/**
 * Deflated Sharpe Ratio (DSR) + Probabilistic Sharpe Ratio (PSR) + 기대 최대 Sharpe(SR0) + MinTRL.
 *
 * 정직한 포지셔닝(리서치 결론): 이 모듈은 "수익을 만드는 알파 도구"가 아니라 "가짜 전략의 라이브 배포를
 * 차단하는 거짓발견(false-positive) 필터"다. López de Prado/Bailey: 다중검정 하에서 관측된 높은 Sharpe는
 * 대부분 selection bias(시도를 많이 하면 운으로도 높은 SR이 나옴)다. DSR은 그 운을 디플레이트한 확률(0~1).
 *
 * 입력 SR은 모두 "비연환산 per-bar Sharpe"(metrics.calcReturnMoments.perBarSharpe), T=봉 개수.
 * 외부 라이브러리 0 — 정규 CDF는 Abramowitz-Stegun erf 근사, 역CDF는 Acklam 유리근사.
 */

const EULER_MASCHERONI = 0.5772156649015329;
const E = Math.E;

/** 표준정규 누적분포 Φ(x). Abramowitz-Stegun 7.1.26 erf 근사(오차 < 1.5e-7). */
export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly =
    t * (0.254829592 +
      t * (-0.284496736 +
        t * (1.421413741 +
          t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/** 표준정규 역CDF Φ⁻¹(p), p∈(0,1). Acklam 유리근사(오차 ~1.15e-9). 경계는 ±클램프. */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q: number, r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
}

/**
 * 표준편차 단위 Sharpe의 표준오차 분모: √(1 − γ3·SR + ((γ4−1)/4)·SR²).
 * 음수 방지 클램프(두꺼운 꼬리/짧은 표본에서 음수 가능 → 작은 양수로).
 */
function shStdDenom(sr: number, skew: number, kurt: number): number {
  const v = 1 - skew * sr + ((kurt - 1) / 4) * sr * sr;
  return Math.sqrt(Math.max(v, 1e-9));
}

/**
 * Probabilistic Sharpe Ratio: 관측 SR이 벤치마크 SR*를 초과할 확률.
 * PSR(SR*) = Φ( (SR_hat − SR*)·√(T−1) / √(1 − γ3·SR_hat + ((γ4−1)/4)·SR_hat²) ).
 */
export function probabilisticSharpe(
  srHat: number, n: number, skew = 0, kurt = 3, srBenchmark = 0
): number {
  if (n < 2) return 0;
  const z = ((srHat - srBenchmark) * Math.sqrt(n - 1)) / shStdDenom(srHat, skew, kurt);
  return normCdf(z);
}

/**
 * 기대 최대 Sharpe SR0 (False Strategy Theorem, Bailey-López de Prado).
 * SR0 = √V · ( (1−γ)·Φ⁻¹[1 − 1/N] + γ·Φ⁻¹[1 − 1/(N·e)] ).
 * V=시도들의 (비연환산) Sharpe 횡단면 분산, N=유효 독립 시도수, γ=오일러-마스케로니.
 * N≤1 또는 V≤0이면 다중검정 보정 불필요 → 0(=PSR로 환원).
 */
export function expectedMaxSharpe(varSR: number, nTrials: number): number {
  if (nTrials <= 1 || varSR <= 0) return 0;
  const sqrtV = Math.sqrt(varSR);
  return sqrtV * (
    (1 - EULER_MASCHERONI) * normInv(1 - 1 / nTrials) +
    EULER_MASCHERONI * normInv(1 - 1 / (nTrials * E))
  );
}

/**
 * Deflated Sharpe Ratio: SR0를 벤치마크로 한 PSR. 다중검정(N 시도) 하에서 관측 SR이 운으로
 * 설명되지 않을 확률(0~1). DSR≥0.95(또는 0.90)면 통과. N=1/varSR=0이면 SR0=0 → 일반 PSR.
 */
export function deflatedSharpe(opts: {
  srHat: number;       // 관측 per-bar Sharpe
  n: number;           // 표본수 T (봉)
  skew?: number;       // 수익 왜도 γ3
  kurt?: number;       // 수익 첨도 γ4 (정규=3)
  varSR?: number;      // 시도들의 per-bar Sharpe 분산 V[SR_n]
  nTrials?: number;    // 유효 독립 시도수 N
}): { dsr: number; sr0: number; psr: number } {
  const { srHat, n, skew = 0, kurt = 3, varSR = 0, nTrials = 1 } = opts;
  const sr0 = expectedMaxSharpe(varSR, nTrials);
  const dsr = probabilisticSharpe(srHat, n, skew, kurt, sr0);
  const psr = probabilisticSharpe(srHat, n, skew, kurt, 0);
  return { dsr, sr0, psr };
}

/**
 * Minimum Track Record Length: SR_hat이 SR0를 목표신뢰도로 초과한다고 말하려면 필요한 최소 표본수(봉).
 * MinTRL = 1 + (1 − γ3·SR + ((γ4−1)/4)·SR²) · ( Φ⁻¹(conf) / (SR − SR0) )².
 * SR_hat ≤ SR0이면 도달 불가 → Infinity.
 */
export function minTrackRecordLength(
  srHat: number, sr0 = 0, skew = 0, kurt = 3, targetConf = 0.95
): number {
  if (srHat <= sr0) return Infinity;
  const num = normInv(targetConf);
  const denomSr = srHat - sr0;
  const factor = 1 - skew * srHat + ((kurt - 1) / 4) * srHat * srHat;
  return 1 + Math.max(factor, 1e-9) * (num / denomSr) ** 2;
}

/**
 * 시도들의 per-bar Sharpe 배열에서 V[SR_n](횡단면 분산)을 추정. 전략 팩토리/OOS 게이트에서
 * N개 후보 백테 SR로부터 SR0 계산 시 입력. NaN/Inf/sentinel(±9999) 방어.
 */
export function sharpeVariance(sharpes: number[]): number {
  const clean = sharpes.filter((s) => Number.isFinite(s) && Math.abs(s) < 1000);
  if (clean.length < 2) return 0;
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  return clean.reduce((s, x) => s + (x - mean) ** 2, 0) / (clean.length - 1);
}
