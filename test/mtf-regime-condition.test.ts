/**
 * mtf-regime-condition.test.ts — 멀티타임프레임 regime 조건("1h 추세 레짐 + 5m 진입").
 * 상위TF 레짐 라벨 전방채움(룩어헤드0) + 트리 수집 + 엔진 게이팅 + 미주입 fail-closed + backtest≡live 패리티 + 스키마.
 *
 * 설계: regime은 raw OHLC를 LTF로 전방채움하면 같은 HTF 종가가 LTF 봉마다 반복되어 ER/MA기울기가 평탄=0으로 붕괴 →
 *   HTF 추세를 영영 감지 못 함. 따라서 'HTF 봉별 진짜 HTF 시계열'로 레짐 라벨을 계산(단일TF 엔진과 동일 의미) 후 라벨만
 *   전방채움한다(alignMtfRegimeLabels). 룩어헤드0=닫힌 HTF만 노출. 엔진·러너 공유 → backtest≡live.
 */
import { describe, it, expect } from "vitest";
import type { StrategyNode, Strategy, BacktestConfig } from "../src/core/types/strategy.js";
import type { RegimeLabel } from "../src/core/backtest/regime.js";
import { runCompositeBacktest, regimeMtfKey } from "../src/core/backtest/engine.js";
import { collectMtfRegimeConditions, alignMtfRegimeLabels, buildMtfRegimeSeries, type MtfBar, type MtfRegimeSeries } from "../src/core/strategy/mtf.js";
import { validateRootNode } from "../src/core/validation/composite-node.js";

const iso = (ms: number) => new Date(ms).toISOString();
const H = (openMs: number, c: number): MtfBar => ({ datetime: iso(openMs), open: c, high: c + 1, low: c - 1, close: c, volume: 1000 });
const HOUR = 3600000, MIN5 = 300000, DAY = 86400000;
const base = Date.UTC(2025, 0, 1, 0); // 00:00

// HTF 일봉 60개. 강한 상승추세(ER≈1, ADX↑, slope up → trend_up). regime-condition.test.ts trendBars 산식.
const htfTrend: MtfBar[] = Array.from({ length: 60 }, (_, i) => H(base + i * DAY, 100 + i * 2));
// HTF 일봉 60개. 횡보(지그재그) → ER≈0 → range/high_vol(trend_up 아님). regime-condition.test.ts rangeBars 산식.
const htfRange: MtfBar[] = Array.from({ length: 60 }, (_, i) => H(base + i * DAY, 100 + (i % 2) * 2));

describe("alignMtfRegimeLabels (HTF 레짐 라벨→LTF, 룩어헤드 없음)", () => {
  // HTF 1h 3봉(닫힘 윈도우가 짧아 라벨은 range로 수렴 — 여기선 '전방채움 타이밍'만 검증). LTF 5m 36봉.
  const htf3 = [H(base, 10), H(base + HOUR, 20), H(base + 2 * HOUR, 30)];
  const ltf = Array.from({ length: 36 }, (_, k) => H(base + k * MIN5, 100));
  const a = alignMtfRegimeLabels(ltf, htf3);

  it("정렬 길이 = LTF 길이", () => {
    expect(a.length).toBe(ltf.length);
  });
  it("HTF 봉이 닫히기 전엔 null(룩어헤드 차단)", () => {
    expect(a[0]).toBeNull();   // 00:00 — 아무 HTF도 안 닫힘
    expect(a[11]).toBeNull();  // 00:55 — 여전히 미닫힘
  });
  it("HTF 봉이 닫힌 직후부터 라벨 전방채움(비-null)", () => {
    expect(a[12]).not.toBeNull(); // 01:00 — HTF[00:00] 닫힘 → 라벨 존재
    expect(a[24]).not.toBeNull(); // 02:00 — HTF[01:00] 닫힘
    // 02:55(인덱스 35)는 여전히 HTF[01:00] 라벨(HTF[02:00]은 03:00에 닫힘=미사용) → 비-null이되 03:00 라벨과 무관
    expect(a[35]).not.toBeNull();
  });
  it("HTF 빈 배열 → 전부 null", () => {
    const e = alignMtfRegimeLabels(ltf, []);
    expect(e.length).toBe(36);
    expect(e.every((x) => x === null)).toBe(true);
  });
  it("HTF 추세 일봉 → 후반 라벨 trend_up(진짜 HTF 시계열로 판정, 반복값 붕괴 아님)", () => {
    // LTF를 일봉과 동일 길이·시각으로 두면 라벨이 HTF 봉별 라벨과 1:1(전방채움). 후반=trend_up.
    const ltfDaily = htfTrend.map((b) => ({ ...b })); // 같은 시각이면 직전 닫힌 HTF 라벨이 채워짐
    const labels = alignMtfRegimeLabels(ltfDaily, htfTrend);
    expect(labels.filter((x) => x === "trend_up").length).toBeGreaterThan(0);
    expect(labels.filter((x) => x === "trend_up").length).toBeGreaterThan(20); // 추세 구간 다수
  });
});

describe("collectMtfRegimeConditions + regimeMtfKey", () => {
  const strat: Strategy = { id: "s", userId: "u", name: "s", description: "", symbol: "X", rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: 200 }], quantityPercent: 100 }], isActive: true, createdAt: new Date(), updatedAt: new Date() };
  const leaf: StrategyNode = { id: "l", type: "leaf", name: "x", strategy: strat };

  it("timeframe 지정 regime 조건 수집(1개)", () => {
    const tree: StrategyNode = { id: "cn", type: "condition", name: "1h 추세", condition: { type: "regime", in: ["trend_up"], timeframe: "1h" } as never, thenNode: leaf };
    const needs = collectMtfRegimeConditions(tree);
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ timeframe: "1h" });
  });
  it("timeframe 없는 regime은 0개(단일TF)", () => {
    const tree: StrategyNode = { id: "cn", type: "condition", name: "x", condition: { type: "regime", in: ["trend_up"] } as never, thenNode: leaf };
    expect(collectMtfRegimeConditions(tree)).toHaveLength(0);
  });
  it("indicator+timeframe은 0개(regime만 수집)", () => {
    const tree: StrategyNode = { id: "cn", type: "condition", name: "x", condition: { type: "indicator", indicator: "sma", params: { period: 50 }, operator: "gt", value: 0, timeframe: "1h" } as never, thenNode: leaf };
    expect(collectMtfRegimeConditions(tree)).toHaveLength(0);
  });
  it("동일 timeframe+params 두 노드 → 중복 제거(1개)", () => {
    const inner: StrategyNode = { id: "cn2", type: "condition", name: "y", condition: { type: "regime", in: ["trend_up"], timeframe: "1h", params: { adxTrend: 25 } } as never, thenNode: leaf };
    const tree: StrategyNode = { id: "cn", type: "condition", name: "x", condition: { type: "regime", in: ["trend_up"], timeframe: "1h", params: { adxTrend: 25 } } as never, thenNode: leaf, elseNode: inner };
    expect(collectMtfRegimeConditions(tree)).toHaveLength(1);
  });
  it("regimeMtfKey: params 순서 무관 동일 키", () => {
    expect(regimeMtfKey("1h", { adxTrend: 25, erTrend: 0.35 } as never)).toBe(regimeMtfKey("1h", { erTrend: 0.35, adxTrend: 25 } as never));
  });
  it("regimeMtfKey: params 없음/timeframe 다름 구분", () => {
    expect(regimeMtfKey("1h")).not.toBe(regimeMtfKey("4h"));
    expect(regimeMtfKey("1h")).toBe(regimeMtfKey("1h", undefined));
  });
});

// ── 엔진 통합 + backtest≡live 패리티 ──
// gated regime{in:['trend_up'], timeframe:'1d'} → HTF가 trend_up으로 확정된 구간에서만 LTF 매매.
const ALWAYS = (): Strategy => ({ id: "s", userId: "u", name: "s", description: "", symbol: "X",
  rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: 200 }], quantityPercent: 100 },
          { id: "se", action: "sell", conditions: [{ id: "c2", indicator: "rsi", params: { period: 2 }, operator: "gt", value: 200 }], quantityPercent: 100 }],
  isActive: true, createdAt: new Date(), updatedAt: new Date() });
const ALWAYS_NODE: StrategyNode = { id: "a", type: "leaf", name: "always", strategy: ALWAYS() };

// LTF 시간봉: 60일 × 24시간 = 1440봉. 종가는 완만 상승(매매 게이트는 HTF regime이 결정, LTF 가격은 진입신호만 — ALWAYS가 보장).
const ltfBars = Array.from({ length: 60 * 24 }, (_, k) => {
  const c = 1000 + k * 0.01;
  return { date: iso(base + k * HOUR).slice(0, 10), datetime: iso(base + k * HOUR), open: c, high: c * 1.001, low: c * 0.999, close: c, volume: 1000 };
});

const gated = (cond: unknown): StrategyNode => ({ id: "cn", type: "condition", name: "regime gate", condition: cond as never, thenNode: ALWAYS_NODE });
const cfg = (reg?: Record<string, MtfRegimeSeries>): BacktestConfig => ({ strategyId: "t", symbol: "X", startDate: ltfBars[0].date, endDate: ltfBars[ltfBars.length - 1].date, initialCapital: 1e6, commission: 0.1, timeframe: "1h", mtfRegimeSeries: reg });

describe("엔진 통합: MTF regime 게이팅 + 미주입 fail-closed", () => {
  const cond = { type: "regime" as const, in: ["trend_up"] as RegimeLabel[], timeframe: "1d" };

  it("HTF trend_up 주입 시: 추세 확정 구간에서 매매(totalTrades>0)", async () => {
    const needs = collectMtfRegimeConditions(gated(cond));
    expect(needs).toHaveLength(1);
    const reg = await buildMtfRegimeSeries(ltfBars as unknown as MtfBar[], needs, async (tf) => (tf === "1d" ? htfTrend : []));
    const res = runCompositeBacktest(gated(cond), ltfBars as unknown as Parameters<typeof runCompositeBacktest>[1], cfg(reg));
    expect(res.totalTrades).toBeGreaterThan(0);
  });

  it("HTF range 주입 시: trend_up 요구 미충족 → 무거래", async () => {
    const needs = collectMtfRegimeConditions(gated(cond));
    const reg = await buildMtfRegimeSeries(ltfBars as unknown as MtfBar[], needs, async (tf) => (tf === "1d" ? htfRange : []));
    const res = runCompositeBacktest(gated(cond), ltfBars as unknown as Parameters<typeof runCompositeBacktest>[1], cfg(reg));
    expect(res.totalTrades).toBe(0);
  });

  it("MTF 미주입 시: fail-closed(무거래)", () => {
    const res = runCompositeBacktest(gated(cond), ltfBars as unknown as Parameters<typeof runCompositeBacktest>[1], cfg(undefined));
    expect(res.totalTrades).toBe(0);
  });

  it("timeframe 없는 동일 regime은 단일TF 경로(회귀): 전 레짐 허용 시 매매", () => {
    const single = { type: "regime" as const, in: ["trend_up", "range", "high_vol", "trend_down"] as RegimeLabel[] }; // 전 레짐 허용 → 단일TF 경로 항상 통과
    const res = runCompositeBacktest(gated(single), ltfBars as unknown as Parameters<typeof runCompositeBacktest>[1], cfg(undefined));
    expect(res.totalTrades).toBeGreaterThan(0); // mtfRegime 미주입이어도 단일TF는 정상(회귀 0)
  });
});

describe("backtest≡live 패리티: 빌더 재호출 결정론(러너/백테툴 동일 데이터)", () => {
  it("동일 (LTF,HTF) → 두 번 빌드한 시리즈 주입 결과가 완전 동일", async () => {
    const cond = { type: "regime" as const, in: ["trend_up"] as RegimeLabel[], timeframe: "1d" };
    const needs = collectMtfRegimeConditions(gated(cond));
    const fetchFn = async (tf: string) => (tf === "1d" ? htfTrend : []);
    const regA = await buildMtfRegimeSeries(ltfBars as unknown as MtfBar[], needs, fetchFn);
    const resA = runCompositeBacktest(gated(cond), ltfBars as unknown as Parameters<typeof runCompositeBacktest>[1], cfg(regA));
    const regB = await buildMtfRegimeSeries(ltfBars as unknown as MtfBar[], needs, fetchFn);
    const resB = runCompositeBacktest(gated(cond), ltfBars as unknown as Parameters<typeof runCompositeBacktest>[1], cfg(regB));
    expect(resA.totalTrades).toBe(resB.totalTrades);
    expect(resA.totalReturnPercent).toBeCloseTo(resB.totalReturnPercent, 9);
    expect(JSON.stringify(resA.trades)).toBe(JSON.stringify(resB.trades));
  });

  it("OOS 슬라이스(sliceMtfRegime 모사): split 경계로 라벨 잘라도 정렬 유지(경계 null=fail-closed)", async () => {
    const cond = { type: "regime" as const, in: ["trend_up"] as RegimeLabel[], timeframe: "1d" };
    const needs = collectMtfRegimeConditions(gated(cond));
    const reg = await buildMtfRegimeSeries(ltfBars as unknown as MtfBar[], needs, async (tf) => (tf === "1d" ? htfTrend : []));
    const split = Math.floor(ltfBars.length * 0.7);
    const testLtf = ltfBars.slice(split);
    // 라벨도 동일 경계로 슬라이스 → test 구간 길이와 정합
    const testReg: Record<string, MtfRegimeSeries> = {};
    for (const k of Object.keys(reg)) testReg[k] = reg[k].slice(split);
    const cfgTest: BacktestConfig = { strategyId: "t", symbol: "X", startDate: testLtf[0].date, endDate: testLtf[testLtf.length - 1].date, initialCapital: 1e6, commission: 0.1, timeframe: "1h", mtfRegimeSeries: testReg };
    const res = runCompositeBacktest(gated(cond), testLtf as unknown as Parameters<typeof runCompositeBacktest>[1], cfgTest);
    // test 구간(후반 30%)은 HTF가 trend_up 확정 → 매매 발생. 길이 정합(라벨.length===prices.length)이 깨지면 fail-closed로 0이 됨.
    expect(res.totalTrades).toBeGreaterThan(0);
    expect(testReg[Object.keys(testReg)[0]].length).toBe(testLtf.length); // 슬라이스 정렬 유지
  });
});

describe("스키마: regime timeframe 허용", () => {
  it("timeframe 지정 regime 검증 통과", () => {
    expect(validateRootNode(gated({ type: "regime", in: ["trend_up"], timeframe: "1h" }))).toBeNull();
  });
  it("timeframe 없는 기존 regime도 통과(회귀)", () => {
    expect(validateRootNode(gated({ type: "regime", in: ["trend_up"] }))).toBeNull();
  });
  it("in:[] / in:['bogus']는 reject 유지(회귀)", () => {
    expect(validateRootNode(gated({ type: "regime", in: [], timeframe: "1h" }))).not.toBeNull();
    expect(validateRootNode(gated({ type: "regime", in: ["bogus"], timeframe: "1h" }))).not.toBeNull();
  });
  it("timeframe 타입 오류(숫자)는 reject", () => {
    expect(validateRootNode(gated({ type: "regime", in: ["trend_up"], timeframe: 60 }))).not.toBeNull();
  });
});
