/**
 * risk-sizing-schema.test.ts — save_strategy의 riskSizing 입력 스키마(SDK 경계) 검증.
 * 디스크리미네이티드 유니언(vol_target | atr | kelly) 수용 + 잘못된 페이로드 거절을 확인.
 * 스키마가 통과시킨 값이 RiskSizingConfig(엔진 입력)와 형상 일치해야 backtest≡live가 성립.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { riskSizingSchema } from "../src/mcp-server/schemas.js";
import type { RiskSizingConfig } from "../src/core/risk/order-sizing.js";

// 스키마는 ZodRawShape가 아니라 ZodType(discriminatedUnion)이므로 직접 parse 가능.
const schema = riskSizingSchema as z.ZodType<RiskSizingConfig>;

describe("riskSizingSchema — 모드별 수용", () => {
  it("vol_target 정상 수용(+ 타입 형상 일치)", () => {
    const v = schema.parse({ method: "vol_target", targetVolAnnual: 0.2, leverageCap: 1 });
    expect(v.method).toBe("vol_target");
    // 타입 레벨: 파싱 결과가 RiskSizingConfig에 대입 가능(컴파일 시 검증).
    const _cfg: RiskSizingConfig = v;
    expect(_cfg).toBeTruthy();
  });

  it("atr 정상 수용(riskPct 필수)", () => {
    const v = schema.parse({ method: "atr", riskPct: 0.01, atrMult: 2, atrPeriod: 14 });
    expect(v.method).toBe("atr");
    const _cfg: RiskSizingConfig = v;
    expect(_cfg).toBeTruthy();
  });

  it("kelly 정상 수용(winRate/avgWin/avgLoss 필수)", () => {
    const v = schema.parse({ method: "kelly", winRate: 0.6, avgWin: 2, avgLoss: 1, fraction: 0.5, sampleSize: 200 });
    expect(v.method).toBe("kelly");
    const _cfg: RiskSizingConfig = v;
    expect(_cfg).toBeTruthy();
  });
});

describe("riskSizingSchema — 거절(fail-closed)", () => {
  it("미지원 method 거절", () => {
    expect(schema.safeParse({ method: "martingale", x: 1 }).success).toBe(false);
  });
  it("atr: riskPct 누락 거절", () => {
    expect(schema.safeParse({ method: "atr", atrMult: 2 }).success).toBe(false);
  });
  it("atr: riskPct 새너티 상한(>0.5) 거절", () => {
    expect(schema.safeParse({ method: "atr", riskPct: 0.9 }).success).toBe(false);
  });
  it("kelly: avgWin 음수 거절", () => {
    expect(schema.safeParse({ method: "kelly", winRate: 0.6, avgWin: -2, avgLoss: 1 }).success).toBe(false);
  });
  it("kelly: winRate 범위 밖(>1) 거절", () => {
    expect(schema.safeParse({ method: "kelly", winRate: 1.5, avgWin: 2, avgLoss: 1 }).success).toBe(false);
  });
  it("vol_target: targetVolAnnual 상한(>2) 거절", () => {
    expect(schema.safeParse({ method: "vol_target", targetVolAnnual: 3 }).success).toBe(false);
  });
});
