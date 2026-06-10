/**
 * futures-sizing.test.ts — 선물(레버리지) 사이징 검증.
 *
 * 불변식:
 *  ① backtest≡live: 엔진(runShortBacktest 레버리지 경로)이 computeOrderQty 선물 경로를 사용 → 단일 사이징 소스.
 *  ② legacy/현물 바이트 동일: market 미지정/spot/leverage≤1이면 기존 결과 불변(회귀 0).
 *  ③ 머니패스 안전: notional≤equity×leverage(정규화-후-캡), margin≤equity, 레버리지 [1,maxLeverage] 클램프.
 *
 * 정직: 레버리지는 노출 배율(알파 아님, 손실도 배가). 청산가/마진은 정보 제공 + short.ts 라이프사이클이 강제.
 */
import { describe, it, expect } from "vitest";
import { computeFuturesSize, computePositionSize, longLiquidationPrice } from "../src/core/risk/sizing.js";
import { computeOrderQty, type OrderQtyInput, type RiskSizingConfig } from "../src/core/risk/order-sizing.js";
import { floorQty } from "../src/core/position/qty.js";
import { shortLiquidationPrice } from "../src/core/position/short.js";

const base = (over: Partial<OrderQtyInput> = {}): OrderQtyInput => ({
  equity: 10000, price: 100, commissionPct: 0.1, closes: [], timeframe: "1d",
  legacyQuantityPercent: 100, riskSizing: null, ...over,
});

// ─────────────────────────── computeFuturesSize (순수) ───────────────────────────
describe("computeFuturesSize — 명목/마진/청산가", () => {
  it("notional = baseNotional×leverage, margin = notional/leverage (= baseNotional)", () => {
    const r = computeFuturesSize({ equity: 10000, price: 100, leverage: 5, baseNotional: 10000 });
    expect(r.leverage).toBe(5);
    expect(r.notional).toBe(50000);        // 10000 × 5
    expect(r.margin).toBe(10000);          // 50000 / 5 = 투입 증거금(=equity)
    expect(r.units).toBe(500);             // 50000 / 100
  });

  it("baseNotional 미지정 → equity 풀노출(1배 base) → notional=equity×leverage", () => {
    const r = computeFuturesSize({ equity: 10000, price: 100, leverage: 3 });
    expect(r.notional).toBe(30000);
    expect(r.margin).toBe(10000);
  });

  it("margin은 항상 equity를 넘지 않음(baseNotional≤equity ⇒ margin≤equity)", () => {
    // baseNotional이 equity의 절반이면 margin도 절반.
    const r = computeFuturesSize({ equity: 10000, price: 100, leverage: 10, baseNotional: 5000 });
    expect(r.notional).toBe(50000);        // 5000 × 10
    expect(r.margin).toBe(5000);
    expect(r.margin).toBeLessThanOrEqual(10000);
  });

  it("정규화-후-캡: rawNotional > equity×leverage면 equity×leverage로 캡 → margin=equity", () => {
    // baseNotional을 equity보다 크게 줘도 명목은 equity×leverage 상한.
    const r = computeFuturesSize({ equity: 10000, price: 100, leverage: 4, baseNotional: 999999 });
    expect(r.notional).toBe(40000);        // min(999999×4, 10000×4)=40000
    expect(r.margin).toBe(10000);          // 캡 시 증거금=equity(풀 마진)
  });

  it("레버리지 클램프: maxLeverage 상한 적용(20배 기본)", () => {
    const r = computeFuturesSize({ equity: 10000, price: 100, leverage: 999 });
    expect(r.leverage).toBe(20);           // 기본 maxLeverage=20으로 클램프
    expect(r.notional).toBe(200000);       // 10000 × 20
  });

  it("maxLeverage 커스텀 상한", () => {
    const r = computeFuturesSize({ equity: 10000, price: 100, leverage: 50, maxLeverage: 10 });
    expect(r.leverage).toBe(10);
    expect(r.notional).toBe(100000);
  });

  it("leverage≤1/NaN → 현물 동치(leverage=1, notional≤equity)", () => {
    expect(computeFuturesSize({ equity: 10000, price: 100, leverage: 1 }).leverage).toBe(1);
    expect(computeFuturesSize({ equity: 10000, price: 100, leverage: 0 }).leverage).toBe(1);
    expect(computeFuturesSize({ equity: 10000, price: 100, leverage: NaN }).leverage).toBe(1);
    const r = computeFuturesSize({ equity: 10000, price: 100, leverage: 1, baseNotional: 10000 });
    expect(r.notional).toBe(10000);        // 1배 → 명목=base
    expect(r.margin).toBe(10000);
  });

  it("equity/price≤0 → 전부 0(예외 없음)", () => {
    expect(computeFuturesSize({ equity: 0, price: 100, leverage: 5 }).notional).toBe(0);
    expect(computeFuturesSize({ equity: 10000, price: 0, leverage: 5 }).units).toBe(0);
  });

  it("롱 청산가: entry×(1−1/lev+mmr), 진입 '아래'(하락 시 청산). lev=1이면 0(현물 무청산)", () => {
    const liq = longLiquidationPrice(100, 5); // 100×(1−0.2+0.005)=80.5
    expect(liq).toBeCloseTo(80.5, 6);
    expect(liq).toBeLessThan(100);            // 롱 청산은 진입 아래
    expect(longLiquidationPrice(100, 1)).toBe(0); // 무레버리지 = 청산 없음
    // computeFuturesSize.liqPrice가 longLiquidationPrice와 일치
    expect(computeFuturesSize({ equity: 10000, price: 100, leverage: 5 }).liqPrice).toBeCloseTo(80.5, 6);
  });

  it("롱/숏 청산가 부호 미러(short.ts shortLiquidationPrice와 대칭)", () => {
    const longLiq = longLiquidationPrice(100, 4);   // 100×(1−0.25+0.005)=75.5 (아래)
    const shortLiq = shortLiquidationPrice(100, 4);  // 100×(1+0.25−0.005)=124.5 (위)
    expect(longLiq).toBeLessThan(100);
    expect(shortLiq).toBeGreaterThan(100);
    // 대칭: (entry−longLiq) ≈ (shortLiq−entry) (동일 mmr·leverage)
    expect(100 - longLiq).toBeCloseTo(shortLiq - 100, 6);
  });
});

// ─────────────────────────── computeOrderQty 선물 경로 ───────────────────────────
describe("computeOrderQty — 선물 레버리지 활성", () => {
  it("legacy + futures leverage=5 → notional=capital×5, qty=floorQty(notional/px)", () => {
    const px = 100 * 1.001;
    const r = computeOrderQty(base({ equity: 10000, price: 100, legacyQuantityPercent: 100, market: "futures", leverage: 5 }));
    expect(r.notional).toBe(50000);                 // 10000 × (100/100) × 5
    expect(r.qty).toBe(floorQty(50000 / px));
    expect(r.detail.market).toBe("futures");
    expect(r.detail.futuresLeverage).toBe(5);       // 선물 배율은 'futuresLeverage'(모드 고유 leverage와 충돌 회피)
    expect(r.detail.margin).toBe(10000);
    expect(r.detail.liqPrice).toBeCloseTo(longLiquidationPrice(px, 5), 6); // 청산가는 수수료반영가 기준
  });

  it("선물 qty == 현물 qty × leverage(동일 base) — 레버리지 배율 정확", () => {
    const spot = computeOrderQty(base({ equity: 10000, price: 100, legacyQuantityPercent: 100 }));
    const fut = computeOrderQty(base({ equity: 10000, price: 100, legacyQuantityPercent: 100, market: "futures", leverage: 3 }));
    expect(fut.notional).toBe(spot.notional * 3);
    // qty는 floor 단위라 정확 배수는 아닐 수 있으나 notional은 정확 배수.
    expect(fut.notional).toBe(30000);
  });

  it("vol_target도 레버리지배로 확대(리스크 타게팅 노출 × leverage)", () => {
    const highVol = Array.from({ length: 120 }, (_, j) => 100 * (1 + (j % 2 ? 0.05 : -0.05)));
    const vt: RiskSizingConfig = { method: "vol_target", targetVolAnnual: 0.2, leverageCap: 1.0 };
    const spot = computeOrderQty(base({ closes: highVol, riskSizing: vt }));
    const fut = computeOrderQty(base({ closes: highVol, riskSizing: vt, market: "futures", leverage: 4 }));
    expect(fut.notional).toBeCloseTo(spot.notional * 4, 6);
    expect(fut.detail.mode).toBe("vol_target"); // 원래 모드 detail 보존
    expect(fut.detail.market).toBe("futures");
  });

  it("notional 캡: 선물이어도 equity×leverage 상한(margin≤equity)", () => {
    const r = computeOrderQty(base({ equity: 10000, price: 100, legacyQuantityPercent: 100, market: "futures", leverage: 6 }));
    expect(r.notional).toBeLessThanOrEqual(10000 * 6 + 1e-6);
    expect(r.detail.margin as number).toBeLessThanOrEqual(10000 + 1e-6);
  });

  it("과도 레버리지 클램프(>maxLeverage)", () => {
    const r = computeOrderQty(base({ equity: 10000, price: 100, market: "futures", leverage: 1000, maxLeverage: 10 }));
    expect(r.detail.futuresLeverage).toBe(10);
    expect(r.notional).toBe(100000);
  });
});

// ── 머니패스 footgun 회귀: 모드의 '의도적 무거래(baseNotional 0)'가 선물에서 풀노출로 둔갑하면 안 됨 ──
describe("computeOrderQty — 선물 zero-exposure 보존(머니패스 안전)", () => {
  it("음의 엣지 Kelly + 선물 → qty 0 (베팅 안 함이 레버리지 풀포지션으로 둔갑 금지)", () => {
    // winRate=0.3,b=1 → fFull<0 → fraction 0 → spot notional 0. 선물이어도 0이어야 함.
    const cfg: RiskSizingConfig = { method: "kelly", winRate: 0.3, avgWin: 1, avgLoss: 1, fraction: 0.5, sampleSize: 300 };
    const r = computeOrderQty(base({ equity: 10000, price: 100, riskSizing: cfg, market: "futures", leverage: 5 }));
    expect(r.qty).toBe(0);
    expect(r.notional).toBe(0);
    expect(r.detail.margin).toBe(0);
  });

  it("flat vol_target(무한레버리지 가드) + 선물 → qty 0", () => {
    const flat = Array.from({ length: 60 }, () => 100);
    const cfg: RiskSizingConfig = { method: "vol_target", targetVolAnnual: 0.2, leverageCap: 1 };
    const r = computeOrderQty(base({ equity: 10000, price: 100, closes: flat, riskSizing: cfg, market: "futures", leverage: 5 }));
    expect(r.qty).toBe(0);
    expect(r.notional).toBe(0);
  });

  it("zero-exposure 선물 결과가 현물(qty 0)과 명목·수량 동일(레버리지 무관)", () => {
    const cfg: RiskSizingConfig = { method: "kelly", winRate: 0.2, avgWin: 1, avgLoss: 2, fraction: 0.5, sampleSize: 300 };
    const spot = computeOrderQty(base({ equity: 10000, price: 100, riskSizing: cfg }));
    const fut = computeOrderQty(base({ equity: 10000, price: 100, riskSizing: cfg, market: "futures", leverage: 8 }));
    expect(spot.qty).toBe(0);
    expect(fut.qty).toBe(spot.qty);
    expect(fut.notional).toBe(spot.notional);
  });
});

// ─────────────────────────── 회귀: 현물/legacy 바이트 동일 ───────────────────────────
describe("computeOrderQty — 회귀(현물 경로 바이트 동일, 회귀 0)", () => {
  const highVol = Array.from({ length: 120 }, (_, j) => 100 * (1 + (j % 2 ? 0.05 : -0.05)));
  const cases: { name: string; over: Partial<OrderQtyInput> }[] = [
    { name: "legacy qp=100", over: { legacyQuantityPercent: 100 } },
    { name: "legacy qp=50", over: { legacyQuantityPercent: 50 } },
    { name: "vol_target", over: { closes: highVol, riskSizing: { method: "vol_target", targetVolAnnual: 0.2, leverageCap: 1 } } },
    { name: "kelly", over: { riskSizing: { method: "kelly", winRate: 0.6, avgWin: 2, avgLoss: 1, fraction: 0.5, sampleSize: 200 } } },
  ];

  for (const c of cases) {
    it(`${c.name}: market 미지정 == market="spot" == leverage 무시(동일 qty/notional/detail)`, () => {
      const plain = computeOrderQty(base({ ...c.over }));
      const spot = computeOrderQty(base({ ...c.over, market: "spot" }));
      // market=spot이면 leverage가 있어도 무시(leverageActive=false).
      const spotWithLev = computeOrderQty(base({ ...c.over, market: "spot", leverage: 5 }));
      // market=futures여도 leverage≤1이면 현물 경로(바이트 동일).
      const futLev1 = computeOrderQty(base({ ...c.over, market: "futures", leverage: 1 }));

      expect(spot.qty).toBe(plain.qty);
      expect(spot.notional).toBe(plain.notional);
      expect(spotWithLev.qty).toBe(plain.qty);
      expect(spotWithLev.notional).toBe(plain.notional);
      expect(futLev1.qty).toBe(plain.qty);
      expect(futLev1.notional).toBe(plain.notional);
      // detail에 선물 전용 필드(market/futuresLeverage/margin/liqPrice/baseNotional)가 추가되지 않음(현물 경로 = 회귀 0).
      // (vol_target은 모드 고유 'leverage'(변동성 레버리지)를 detail에 갖지만, 그건 선물 배율과 무관하며 현물에서도 동일.)
      for (const r of [plain, spot, spotWithLev, futLev1]) {
        expect(r.detail.market).toBeUndefined();
        expect(r.detail.futuresLeverage).toBeUndefined();
        expect(r.detail.margin).toBeUndefined();
        expect(r.detail.liqPrice).toBeUndefined();
        expect(r.detail.baseNotional).toBeUndefined();
      }
    });
  }
});
