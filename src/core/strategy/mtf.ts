/**
 * mtf.ts — 멀티타임프레임(상위TF 확인) 조건의 트리 수집 + HTF→LTF 정렬(순수).
 * "1h 추세 + 5m 진입" 같은 MTF 전략 해금. 러너/백테스트 툴이 HTF 봉을 페치해 alignMtfSeries로 정렬→config.mtfSeries 주입.
 *
 * 룩어헤드 방지가 핵심: LTF 봉 시각 t에는 't 이전에 완전히 닫힌' 상위TF 봉의 지표값만 사용(전방채움).
 */
import type { StrategyNode, IndicatorType } from "../types/strategy";
import { computeIndicator } from "../backtest/indicators";
import { mtfKey } from "../backtest/engine";

const MAX_DEPTH = 50;

export interface MtfBar { datetime: string; open: number; high: number; low: number; close: number; volume: number }
export interface MtfNeed { timeframe: string; indicator: IndicatorType; params: Record<string, number> }

/** root_node를 순회해 timeframe이 지정된 indicator 조건들을 수집(중복 제거 = timeframe|indicator|params). */
export function collectMtfConditions(root: StrategyNode): MtfNeed[] {
  const seen = new Map<string, MtfNeed>();
  const stack: Array<{ n: StrategyNode; d: number }> = [{ n: root, d: 0 }];
  while (stack.length) {
    const { n, d } = stack.pop()!;
    if (!n || typeof n !== "object" || d > MAX_DEPTH) continue;
    if (n.type === "condition") {
      const c = n.condition;
      if (c && c.type === "indicator" && typeof c.timeframe === "string" && c.timeframe) {
        const key = `${c.timeframe}|${c.indicator}|${JSON.stringify(c.params)}`;
        if (!seen.has(key)) seen.set(key, { timeframe: c.timeframe, indicator: c.indicator, params: c.params });
      }
      if (n.thenNode) stack.push({ n: n.thenNode, d: d + 1 });
      if (n.elseNode) stack.push({ n: n.elseNode, d: d + 1 });
    } else if (n.type === "composite" && Array.isArray(n.children)) {
      for (const child of n.children) stack.push({ n: child, d: d + 1 });
    }
  }
  return [...seen.values()];
}

/**
 * 상위TF 지표값을 LTF 봉에 정렬(전방채움, 룩어헤드 없음). 반환 길이 = ltfBars.length.
 * 각 LTF 봉 시각 t에는 'open + htf주기 <= t'(완전히 닫힌) 가장 최근 HTF 봉의 지표값을 채운다. 아직 없으면 NaN(엔진 fail-closed).
 */
export function alignMtfSeries(ltfBars: MtfBar[], htfBars: MtfBar[], indicator: IndicatorType, params: Record<string, number>): number[] {
  const n = ltfBars.length;
  if (htfBars.length === 0) return new Array(n).fill(NaN);
  const htfCloses = htfBars.map((b) => b.close);
  const htfVolumes = htfBars.map((b) => b.volume);
  const htfHighs = htfBars.map((b) => b.high);
  const htfLows = htfBars.map((b) => b.low);
  const htfVals = computeIndicator(htfCloses, htfVolumes, indicator, params, htfHighs, htfLows);
  const htfOpenMs = htfBars.map((b) => Date.parse(b.datetime));
  // HTF 주기(ms): 연속 봉 오픈시각 차의 최빈/첫값. 1봉뿐이면 안전하게 큰 값(다음 봉 없음=마지막봉은 close 추정 불가→그 봉 close 시각 모름).
  const htfMs = htfBars.length >= 2 ? (htfOpenMs[1] - htfOpenMs[0]) : Number.POSITIVE_INFINITY;
  const out = new Array<number>(n);
  let j = -1; // 현재까지 '닫힌' 가장 최근 HTF 인덱스
  for (let i = 0; i < n; i++) {
    const t = Date.parse(ltfBars[i].datetime);
    // 봉 j는 open+htf주기 <= t 일 때 완전히 닫힘. j+1봉이 닫혔으면 전진.
    while (j + 1 < htfBars.length && htfOpenMs[j + 1] + htfMs <= t) j++;
    out[i] = j >= 0 ? htfVals[j] : NaN;
  }
  return out;
}

/**
 * MtfNeed들에 대해 상위TF 봉을 페치(timeframe별 1회 캐시)해 LTF로 정렬한 mtfSeries(mtfKey→값) 구축.
 * fetchFn은 caller가 주입(데이터 레이어 fetchKlines) → core 순수성 유지. 페치 실패 종목은 전부 NaN(fail-closed).
 */
export async function buildMtfSeries(
  ltfBars: MtfBar[], needs: MtfNeed[],
  fetchFn: (timeframe: string, limit: number) => Promise<MtfBar[]>, limit = 300
): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {};
  const cache = new Map<string, MtfBar[]>();
  for (const need of needs) {
    let htf = cache.get(need.timeframe);
    if (!htf) { try { htf = await fetchFn(need.timeframe, limit); } catch { htf = []; } cache.set(need.timeframe, htf); }
    out[mtfKey(need.timeframe, need.indicator, need.params)] = alignMtfSeries(ltfBars, htf, need.indicator, need.params);
  }
  return out;
}
