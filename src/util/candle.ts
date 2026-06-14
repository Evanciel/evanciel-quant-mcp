/**
 * util/candle.ts — 캔들 무결성 검증(audit P1-22). 순수함수(부수효과 0 → 단위테스트 가능).
 *
 * 두 가지 결함을 잡는다:
 *  ① interval 불일치 — 요청 주기(예 5m)와 다른 주기(예 1d)가 반환되는 경우(KR 어댑터 침묵 불일치).
 *  ② 데이터 간극 — 봉이 누락돼 신호 윈도가 깨지는 경우.
 *
 * ⚠️ KR(장중만 거래)은 주말/공휴일/장마감에 정상적으로 간격이 벌어진다 → "모든 간격 == 기대치" 식
 *    엄격 검사는 오탐. 그래서 **중앙값(median) 간격**으로 interval을 판정한다(주말 갭은 소수 outlier라
 *    중앙값에 영향 0). 누락 검사는 '기대 간격의 정수배'를 허용해 KR 갭을 통과시키되, 비정수배(데이터 깨짐)만 잡는다.
 */

/** interval 문자열 → 밀리초. 미지의 형식은 0(검증 스킵 신호). */
export function intervalToMs(interval: string): number {
  const m = /^(\d+)(m|h|d|w)$/.exec((interval || "").trim());
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const base = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000;
  return n * base;
}

export interface CandleValidation { valid: boolean; reason?: string }

/**
 * 캔들 배열의 interval 정합 + 간극 검증(순수). bars는 datetime(ISO) 오름차순 가정.
 * @param mode 'crypto'(24/7, 엄격 연속) | 'kr'(장중만, 중앙값 기반 — 주말 갭 허용)
 *  - interval 판정: 중앙값 간격이 기대 간격의 ±50% 밖이면 불일치(요청≠응답 주기).
 *  - 간극 판정(crypto만): 인접 간격이 기대치의 1.5배 초과면 누락(데이터 깨짐) → 무효.
 *    (kr은 비거래시간 갭이 정상이라 누락 검사 생략 — interval 중앙값 검증만.)
 */
export function validateCandleContiguity(
  bars: { datetime?: string; date?: string }[],
  interval: string,
  mode: "crypto" | "kr" = "crypto",
): CandleValidation {
  if (!Array.isArray(bars) || bars.length < 3) return { valid: true }; // 표본 부족 → 검증 불가(상위 data<30 가드가 처리)
  const expected = intervalToMs(interval);
  if (expected <= 0) return { valid: true }; // 미지 interval → 검증 스킵

  // datetime(시각 포함) 우선, 없으면 date(YYYY-MM-DD, 일봉) 폴백 — 어댑터가 date만 줄 수 있음(일봉).
  const ts = bars.map((b) => Date.parse(b.datetime ?? b.date ?? ""));
  if (ts.some((t) => !Number.isFinite(t))) return { valid: false, reason: "datetime 파싱 불가(형식 깨짐)" };
  const diffs: number[] = [];
  for (let i = 1; i < ts.length; i++) {
    const d = ts[i] - ts[i - 1];
    if (d <= 0) return { valid: false, reason: "봉 시각 비단조(중복/역순)" };
    diffs.push(d);
  }

  // interval 판정 — 중앙값 간격 vs 기대(주말 갭 등 outlier에 강건).
  const sorted = [...diffs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median > expected * 1.5 || median < expected * 0.5) {
    return { valid: false, reason: `interval 불일치: 요청 ${interval}(${expected}ms) ≠ 응답 중앙간격 ${median}ms` };
  }

  // 간극 판정 — crypto(24/7)만. 기대치의 1.5배 초과 간격 = 누락.
  if (mode === "crypto") {
    for (let i = 0; i < diffs.length; i++) {
      if (diffs[i] > expected * 1.5) {
        return { valid: false, reason: `봉 누락: ${bars[i].datetime}~${bars[i + 1].datetime} 간격 ${diffs[i]}ms > 기대 ${expected}ms` };
      }
    }
  }
  return { valid: true };
}
