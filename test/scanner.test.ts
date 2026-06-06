/**
 * scanner.test.ts — 유니버스 스크리닝/랭킹 순수 코어 + 스캐너 노드 검증.
 * "아침 9시 급등주 스크리닝→단타"의 검증 가능한 코어(랭킹·액션결정·검증). 러너 I/O는 별도.
 */
import { describe, it, expect } from "vitest";
import { computeRankMetric, rankUniverse, decideScannerActions, type RankBar } from "../src/core/scanner/rank.js";
import { validateScannerNode, validateBotRoot, validateRootNode } from "../src/core/validation/composite-node.js";

const mk = (o: number, h: number, l: number, c: number, v: number): RankBar => ({ open: o, high: h, low: l, close: c, volume: v });
// 종가 100→106 (roc 6%), 마지막봉 갭: prevClose 105 → open 107 (≈1.9%)
const flat = (c: number, v = 1000): RankBar => mk(c, c + 1, c - 1, c, v);

describe("computeRankMetric", () => {
  const bars = Array.from({ length: 20 }, (_, i) => flat(100 + i)); // 100..119
  it("roc: period봉 전 대비 변화율%", () => {
    const r = computeRankMetric(bars, "roc", 10)!;
    expect(r).toBeCloseTo(((119 - 109) / 109) * 100, 5);
  });
  it("gapPct: 최신봉 시가 vs 직전봉 종가", () => {
    const b = [...bars.slice(0, 19), mk(125, 126, 124, 125, 1000)]; // prevClose=118, open=125
    expect(computeRankMetric(b, "gapPct")!).toBeCloseTo(((125 - 118) / 118) * 100, 5);
  });
  it("relVolume: 최신 거래량/직전 평균", () => {
    const b = [...Array.from({ length: 15 }, () => flat(100, 1000)), flat(100, 3000)];
    expect(computeRankMetric(b, "relVolume", 14)!).toBeCloseTo(3, 5);
  });
  it("rangePct: (고−저)/저", () => {
    expect(computeRankMetric([flat(100), mk(100, 110, 100, 105, 1000)], "rangePct")!).toBeCloseTo(10, 5);
  });
  it("데이터 부족/0분모 → null", () => {
    expect(computeRankMetric([flat(100)], "roc")).toBeNull(); // n<2
    expect(computeRankMetric([flat(100), flat(101)], "roc", 10)).toBeNull(); // period 초과
    expect(computeRankMetric([mk(0, 0, 0, 0, 0), flat(100)], "gapPct")).toBeNull(); // prevClose 0
  });
});

describe("rankUniverse", () => {
  const up = Array.from({ length: 20 }, (_, i) => flat(100 + i * 2)); // roc 큼
  const mid = Array.from({ length: 20 }, (_, i) => flat(100 + i)); // roc 중간
  const down = Array.from({ length: 20 }, (_, i) => flat(120 - i)); // roc 음수
  it("desc: 상위 N = 점수 높은순", () => {
    const r = rankUniverse([{ symbol: "MID", bars: mid }, { symbol: "UP", bars: up }, { symbol: "DOWN", bars: down }], "roc", 2, "desc", 10);
    expect(r.map((x) => x.symbol)).toEqual(["UP", "MID"]);
  });
  it("asc: 점수 낮은순(역추세 스크리닝)", () => {
    const r = rankUniverse([{ symbol: "MID", bars: mid }, { symbol: "UP", bars: up }, { symbol: "DOWN", bars: down }], "roc", 1, "asc", 10);
    expect(r[0].symbol).toBe("DOWN");
  });
  it("산출 불가 종목 제외 + 동점 사전순", () => {
    const a = Array.from({ length: 20 }, () => flat(100)); // roc 0
    const b = Array.from({ length: 20 }, () => flat(100)); // roc 0 동점
    const r = rankUniverse([{ symbol: "ZB", bars: b }, { symbol: "ZA", bars: a }, { symbol: "SHORT", bars: [flat(1)] }], "roc", 5, "desc", 10);
    expect(r.map((x) => x.symbol)).toEqual(["ZA", "ZB"]); // SHORT 제외, 동점 사전순
  });
});

describe("decideScannerActions", () => {
  it("상위N 이탈 → 청산, 신규 매수희망 → 진입, 유지", () => {
    const d = decideScannerActions(["A", "B", "C"], ["B", "X"], { A: true, B: true, C: false, X: true });
    expect(d.toClose).toEqual(["X"]); // X는 상위N 이탈
    expect(d.toOpen).toEqual(["A"]); // A 신규+매수희망. C는 매수희망 false → 진입 안 함
    expect(d.hold).toEqual(["B"]); // B 보유+상위N+희망
  });
  it("보유 종목이 then 청산희망(false)이면 청산", () => {
    const d = decideScannerActions(["A"], ["A"], { A: false });
    expect(d.toClose).toEqual(["A"]);
    expect(d.hold).toEqual([]);
  });
  it("비활성(상위N 비어있음) → 보유 전부 청산, 신규 0", () => {
    const d = decideScannerActions([], ["A", "B"], { A: true, B: true });
    expect(d.toClose.sort()).toEqual(["A", "B"]);
    expect(d.toOpen).toEqual([]);
  });
});

describe("scanner 노드 검증", () => {
  const goodThen = { id: "l", type: "leaf", name: "t", strategy: { id: "s", userId: "u", name: "s", description: "", symbol: "X", rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 14 }, operator: "lt", value: 30 }], quantityPercent: 100 }], isActive: true, createdAt: new Date(), updatedAt: new Date() } };
  const scanner = (over: Record<string, unknown> = {}) => ({ id: "sc", type: "scanner", name: "급등주", universe: ["BTCUSDT", "ETHUSDT", "SOLUSDT"], rank: { metric: "roc", top: 2 }, then: goodThen, ...over });
  it("정상 스캐너 통과", () => {
    expect(validateScannerNode(scanner())).toBeNull();
    expect(validateScannerNode(scanner({ schedule: { hour: [9, 10], tz: "Asia/Seoul" } }))).toBeNull();
  });
  it("universe<2 / 잘못된 metric / then 누락 거부", () => {
    expect(validateScannerNode(scanner({ universe: ["BTCUSDT"] }))).not.toBeNull();
    expect(validateScannerNode(scanner({ rank: { metric: "bogus", top: 2 } }))).not.toBeNull();
    expect(validateScannerNode(scanner({ then: undefined }))).not.toBeNull();
    expect(validateScannerNode(scanner({ schedule: { hour: [25] } }))).not.toBeNull(); // hour 0~23
  });
  it("validateBotRoot 분기: scanner=스캐너검증, 일반=루트검증", () => {
    expect(validateBotRoot(scanner())).toBeNull();
    expect(validateBotRoot(goodThen)).toBeNull(); // 일반 트리도 통과
    // validateRootNode는 scanner를 거부(일반 트리 검증기)
    expect(validateRootNode(scanner())).not.toBeNull();
  });
});
