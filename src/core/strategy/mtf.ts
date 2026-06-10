/**
 * mtf.ts — 멀티타임프레임(상위TF 확인) 조건의 트리 수집 + HTF→LTF 정렬(순수).
 * "1h 추세 + 5m 진입" 같은 MTF 전략 해금. 러너/백테스트 툴이 HTF 봉을 페치해 alignMtfSeries로 정렬→config.mtfSeries 주입.
 *
 * 룩어헤드 방지가 핵심: LTF 봉 시각 t에는 't 이전에 완전히 닫힌' 상위TF 봉의 지표값만 사용(전방채움).
 */
import type { StrategyNode, IndicatorType } from "../types/strategy";
import type { RegimeParams, RegimeLabel } from "../backtest/regime";
import { computeIndicator } from "../backtest/indicators";
import { computeRegime } from "../backtest/regime";
import { mtfKey, regimeMtfKey } from "../backtest/engine";

const MAX_DEPTH = 50;

export interface MtfBar { datetime: string; open: number; high: number; low: number; close: number; volume: number }
export interface MtfNeed { timeframe: string; indicator: IndicatorType; params: Record<string, number> }
/** 멀티타임프레임 regime 조건 수집 단위. regime은 지표 1개가 아니라 OHLC로 레짐을 판정하므로 indicator 없음. */
export interface MtfRegimeNeed { timeframe: string; params?: RegimeParams }
/** 상위TF 레짐 라벨을 LTF 인덱스에 전방채움 정렬한 시리즈(닫힌 HTF 없으면 null=fail-closed). 길이=ltfBars.length. */
export type MtfRegimeSeries = (RegimeLabel | null)[];

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
  // HTF 주기(ms): 연속 봉 오픈시각 차의 '중앙값'(단일 이상 간격에 강건). 첫 간격만 쓰면 첫 봉이 비정상적으로
  // 짧을 때 htfMs가 과소추정→아직 안 닫힌 봉을 닫힌 것으로 오인(룩어헤드). 중앙값은 그 위험을 막는다.
  let htfMs = Number.POSITIVE_INFINITY;
  if (htfBars.length >= 2) {
    const deltas: number[] = [];
    for (let k = 1; k < htfOpenMs.length; k++) { const d = htfOpenMs[k] - htfOpenMs[k - 1]; if (d > 0) deltas.push(d); }
    if (deltas.length) { deltas.sort((a, b) => a - b); htfMs = deltas[Math.floor(deltas.length / 2)]; }
  }
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

// ── 멀티타임프레임 regime (상위TF 레짐 게이트: "1h 추세 레짐 + 5m 진입") ──
// 설계: 레짐 '라벨'을 상위TF 봉에서 미리 계산(rolling window)한 뒤 LTF로 전방채움 — alignMtfSeries(지표값을 HTF에서
//   계산 후 전방채움)와 동일 철학. raw OHLC를 전방채움해 엔진에서 computeRegime을 호출하면 같은 HTF 종가가 LTF 봉마다
//   반복되어(예: 일봉 종가가 24개 시간봉에 동일 복제) Kaufman ER·MA기울기가 평탄=0으로 붕괴 → HTF 추세를 영영 감지 못 함.
//   따라서 'HTF 봉별로 그 시점까지의 진짜 HTF 시계열로 레짐을 판정'(단일TF 엔진의 computeRegime(prices.slice(0,index+1))과
//   동일 의미)하고 그 라벨만 전방채움한다. 룩어헤드0=닫힌 HTF만 노출(j-포인터). 엔진·러너 공유 → backtest≡live.

/** root_node를 순회해 timeframe이 지정된 regime 조건들을 수집(중복 제거 = timeframe|JSON(params)). */
export function collectMtfRegimeConditions(root: StrategyNode): MtfRegimeNeed[] {
  const seen = new Map<string, MtfRegimeNeed>();
  const stack: Array<{ n: StrategyNode; d: number }> = [{ n: root, d: 0 }];
  while (stack.length) {
    const { n, d } = stack.pop()!;
    if (!n || typeof n !== "object" || d > MAX_DEPTH) continue;
    if (n.type === "condition") {
      const c = n.condition;
      if (c && c.type === "regime" && typeof c.timeframe === "string" && c.timeframe) {
        const key = `${c.timeframe}|${JSON.stringify(c.params ?? {})}`;
        if (!seen.has(key)) seen.set(key, { timeframe: c.timeframe, params: c.params });
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
 * 상위TF 레짐 라벨을 LTF 봉에 정렬(전방채움, 룩어헤드 없음). 반환 길이 = ltfBars.length.
 * 단계: ① HTF 봉별 라벨 = computeRegime(htfCloses.slice(0,k+1), ...) (단일TF 엔진과 동일한 '현재봉까지' 윈도우).
 *       ② 각 LTF 봉 시각 t에는 'open + htf주기 <= t'(완전히 닫힌) 가장 최근 HTF 봉의 라벨을 채운다.
 * 아직 닫힌 HTF 없으면 null(엔진 fail-closed). HTF 빈 배열 → 전부 null.
 * j-포인터 전진 조건(htfOpenMs[j+1] + htfMs <= t)은 alignMtfSeries와 글자 그대로 동일(검증된 룩어헤드0 불변식).
 */
export function alignMtfRegimeLabels(ltfBars: MtfBar[], htfBars: MtfBar[], params?: RegimeParams): MtfRegimeSeries {
  const n = ltfBars.length;
  if (htfBars.length === 0) return new Array(n).fill(null);
  const htfCloses = htfBars.map((b) => b.close);
  const htfHighs = htfBars.map((b) => b.high);
  const htfLows = htfBars.map((b) => b.low);
  // ① HTF 봉별 레짐 라벨(rolling window). 닫힌 봉만 LTF에 노출되므로(아래 j-포인터) 미래 누수 없음.
  const htfLabels: RegimeLabel[] = new Array(htfBars.length);
  for (let k = 0; k < htfBars.length; k++) {
    htfLabels[k] = computeRegime(htfCloses.slice(0, k + 1), htfHighs.slice(0, k + 1), htfLows.slice(0, k + 1), params).label;
  }
  const htfOpenMs = htfBars.map((b) => Date.parse(b.datetime));
  // HTF 주기(ms): 연속 봉 오픈시각 차의 '중앙값'(alignMtfSeries와 동일 — 첫 봉 비정상 단축 시 과소추정→조기노출 방지).
  let htfMs = Number.POSITIVE_INFINITY;
  if (htfBars.length >= 2) {
    const deltas: number[] = [];
    for (let k = 1; k < htfOpenMs.length; k++) { const d = htfOpenMs[k] - htfOpenMs[k - 1]; if (d > 0) deltas.push(d); }
    if (deltas.length) { deltas.sort((a, b) => a - b); htfMs = deltas[Math.floor(deltas.length / 2)]; }
  }
  const out: MtfRegimeSeries = new Array(n);
  let j = -1; // 현재까지 '닫힌' 가장 최근 HTF 인덱스
  for (let i = 0; i < n; i++) {
    const t = Date.parse(ltfBars[i].datetime);
    // 봉 j는 open+htf주기 <= t 일 때 완전히 닫힘. j+1봉이 닫혔으면 전진(='완전히 닫힌' HTF만 노출).
    while (j + 1 < htfBars.length && htfOpenMs[j + 1] + htfMs <= t) j++;
    out[i] = j >= 0 ? htfLabels[j] : null;
  }
  return out;
}

/**
 * MtfRegimeNeed들에 대해 상위TF 봉을 페치(timeframe별 1회 캐시)해 LTF로 정렬한 라벨 시리즈(regimeMtfKey→라벨배열) 구축.
 * fetchFn은 caller가 주입(데이터 레이어 fetchKlines) → core 순수성 유지. 페치 실패 timeframe은 전부 null(fail-closed).
 */
export async function buildMtfRegimeSeries(
  ltfBars: MtfBar[], needs: MtfRegimeNeed[],
  fetchFn: (timeframe: string, limit: number) => Promise<MtfBar[]>, limit = 300
): Promise<Record<string, MtfRegimeSeries>> {
  const out: Record<string, MtfRegimeSeries> = {};
  const cache = new Map<string, MtfBar[]>();
  for (const need of needs) {
    let htf = cache.get(need.timeframe);
    if (!htf) { try { htf = await fetchFn(need.timeframe, limit); } catch { htf = []; } cache.set(need.timeframe, htf); }
    out[regimeMtfKey(need.timeframe, need.params)] = alignMtfRegimeLabels(ltfBars, htf, need.params);
  }
  return out;
}
