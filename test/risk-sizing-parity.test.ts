/**
 * risk-sizing-parity.test.ts — 리스크 사이징 backtest≡live 패리티 + legacy 회귀(SC1/SC2/SC4).
 *
 * 핵심: 엔진(runCompositeBacktest)이 진입 수량 결정 → 러너는 derivePosition(want.qty)로 그대로 라이브 반영.
 * 따라서 "엔진 진입 qty == computeOrderQty(같은 입력)" + "legacy 미설정 = 기존 공식 바이트 동일"을 증명하면
 * backtest≡live가 구조적으로 보장됨.
 */
import { describe, it, expect } from "vitest";
import type { StrategyNode, Strategy, BacktestConfig } from "../src/core/types/strategy.js";
import { runCompositeBacktest } from "../src/core/backtest/engine.js";
import { computeOrderQty, type RiskSizingConfig } from "../src/core/risk/order-sizing.js";
import { floorQty } from "../src/core/position/qty.js";

// 항상 매수(rsi<200) 단일 leaf. bar1에서 진입(첫 봉은 지표 워밍업 후).
const strat = (): Strategy => ({ id: "s", userId: "u", name: "s", description: "", symbol: "X",
  rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: 200 }], quantityPercent: 100 }],
  isActive: true, createdAt: new Date(), updatedAt: new Date() });
const leaf: StrategyNode = { id: "a", type: "leaf", name: "always", strategy: strat() };

type B = { date: string; datetime: string; open: number; high: number; low: number; close: number; volume: number };
// 변동성 있는 30봉(±2% 진동, 일자별 고유 date) — realizedVol > 0 + 진입봉 인덱스 식별 가능.
const bars: B[] = Array.from({ length: 30 }, (_, i) => {
  const iso = new Date(Date.UTC(2025, 0, 1 + i)).toISOString();
  const c = 100 * (1 + (i % 2 ? 0.02 : -0.02));
  return { date: iso.slice(0, 10), datetime: iso, open: c, high: c * 1.005, low: c * 0.995, close: c, volume: 1000 };
});

const baseCfg = (riskSizing?: RiskSizingConfig | null): BacktestConfig => ({
  strategyId: "t", symbol: "X", startDate: bars[0].date, endDate: bars[bars.length - 1].date,
  initialCapital: 100_000, commission: 0.1, slippage: 0.05, timeframe: "1h", riskSizing,
});
const run = (riskSizing?: RiskSizingConfig | null) =>
  runCompositeBacktest(leaf, bars as unknown as Parameters<typeof runCompositeBacktest>[1], baseCfg(riskSizing));

describe("리스크 사이징 패리티 — legacy 회귀(SC2)", () => {
  it("riskSizing 미설정 → 진입 qty가 기존 공식(balance×qp/100, 수수료·슬리피지 반영) 그대로", () => {
    const res = run(null);
    const entry = res.trades.find((t) => t.action === "buy")!;
    expect(entry).toBeTruthy();
    // 기존 엔진 공식 재현: buyPrice = price×(1+slip); qty = floorQty(balance×1 / (buyPrice×(1+comm)))
    const slip = 0.05 / 100, comm = 0.1 / 100;
    const buyPrice = entry.price; // 엔진이 기록한 체결가(=price×(1+slip))
    const expected = floorQty(100_000 / (buyPrice * (1 + comm)));
    expect(entry.quantity).toBe(expected);
  });
});

describe("리스크 사이징 패리티 — vol_target 효과 + 함수 동치(SC1/SC4)", () => {
  const vt: RiskSizingConfig = { method: "vol_target", targetVolAnnual: 0.2, leverageCap: 1.0 };

  it("vol_target 진입 qty == computeOrderQty(엔진과 동일 입력)", () => {
    const res = run(vt);
    const entry = res.trades.find((t) => t.action === "buy")!;
    expect(entry).toBeTruthy();
    // 엔진은 진입 봉 인덱스 i에서 closes=prices.slice(0,i+1)로 사이징. date가 봉별 고유라 진입봉 식별.
    const closesAll = bars.map((b) => b.close);
    const idx = bars.findIndex((b) => b.date === entry.date);
    expect(idx).toBeGreaterThanOrEqual(0);
    // 엔진 진입가(buyPrice=price×(1+slip))로 동일 함수 호출 → 동일 qty
    const direct = computeOrderQty({
      equity: 100_000, price: entry.price, commissionPct: 0.1,
      closes: closesAll.slice(0, idx + 1), timeframe: "1h",
      legacyQuantityPercent: 100, riskSizing: vt,
    }).qty;
    expect(entry.quantity).toBe(direct);
  });

  it("vol_target qty < legacy qty (변동성 타게팅이 노출 축소, leverageCap≤1)", () => {
    const legacy = run(null).trades.find((t) => t.action === "buy")!;
    const sized = run(vt).trades.find((t) => t.action === "buy")!;
    expect(sized.quantity).toBeLessThanOrEqual(legacy.quantity);
  });
});

describe("리스크 사이징 패리티 — atr 진입 qty == computeOrderQty(엔진과 동일 입력)", () => {
  const atrCfg: RiskSizingConfig = { method: "atr", riskPct: 0.01, atrMult: 2, atrPeriod: 14 };

  it("엔진 ATR 진입 수량이 동일 슬라이스(closes/highs/lows) computeOrderQty와 일치 → backtest≡live", () => {
    const res = run(atrCfg);
    const entry = res.trades.find((t) => t.action === "buy")!;
    expect(entry).toBeTruthy();
    const idx = bars.findIndex((b) => b.date === entry.date);
    expect(idx).toBeGreaterThanOrEqual(0);
    // 엔진은 진입 봉 i에서 closes/highs/lows = slice(0, i+1)로 ATR 사이징. 동일 입력으로 직접 호출 → 동일 qty.
    const closes = bars.map((b) => b.close), highs = bars.map((b) => b.high), lows = bars.map((b) => b.low);
    const direct = computeOrderQty({
      equity: 100_000, price: entry.price, commissionPct: 0.1,
      closes: closes.slice(0, idx + 1), highs: highs.slice(0, idx + 1), lows: lows.slice(0, idx + 1),
      timeframe: "1h", legacyQuantityPercent: 100, riskSizing: atrCfg,
    }).qty;
    expect(direct).toBeGreaterThan(0);
    expect(entry.quantity).toBe(direct);
  });
});

describe("리스크 사이징 패리티 — kelly 진입 qty == computeOrderQty(엔진과 동일 입력)", () => {
  // 정적 통계(에이전트 선언) → 엔진·러너 동일 config → 발산원 없음. fraction-of-equity 사이징.
  const kCfg: RiskSizingConfig = { method: "kelly", winRate: 0.6, avgWin: 2, avgLoss: 1, fraction: 0.5, sampleSize: 200 };

  it("엔진 Kelly 진입 수량이 동일 입력 computeOrderQty와 일치 → backtest≡live", () => {
    const res = run(kCfg);
    const entry = res.trades.find((t) => t.action === "buy")!;
    expect(entry).toBeTruthy();
    const direct = computeOrderQty({
      equity: 100_000, price: entry.price, commissionPct: 0.1,
      closes: bars.map((b) => b.close), timeframe: "1h", legacyQuantityPercent: 100, riskSizing: kCfg,
    }).qty;
    expect(direct).toBeGreaterThan(0);
    expect(entry.quantity).toBe(direct);
  });
});
