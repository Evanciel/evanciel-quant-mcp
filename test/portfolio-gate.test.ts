/**
 * portfolio-gate.test.ts — 포트폴리오 레벨 캡(opt-in) 순수 게이트 검증(네트워크 0, 키 0).
 *
 * 핵심 불변식: env 미설정 = 완전 OFF(allow=true, mult=1, no-op) → legacy 바이트 동일.
 * 활성 시: heat>maxHeat / effectiveRisk>riskBudget / MDD halt → 진입 차단, MDD reduced → 수량 축소(<1).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { loadPortfolioGateConfig, portfolioGate } from "../src/brokers/safety.js";

const KEYS = [
  "QUANT_MCP_PORTFOLIO_MAX_HEAT", "QUANT_MCP_PORTFOLIO_RISK_BUDGET",
  "QUANT_MCP_PORTFOLIO_AVG_CORR", "QUANT_MCP_PORTFOLIO_MDD",
];
beforeEach(() => { for (const k of KEYS) delete process.env[k]; });

const snap = (positions: { symbol: string; riskFraction: number }[], equity = 100, peakEquity = 100) => ({ positions, equity, peakEquity });

describe("loadPortfolioGateConfig — env opt-in", () => {
  it("env 전부 미설정 → enabled=false (완전 OFF)", () => {
    const c = loadPortfolioGateConfig();
    expect(c.enabled).toBe(false);
    expect(c.maxHeat).toBeUndefined();
    expect(c.riskBudget).toBeUndefined();
    expect(c.mdd).toBe(false);
    expect(c.avgCorr).toBe(0.7); // 기본값(미설정은 Number("")=0과 구분되어 0.7)
  });

  it("maxHeat만 설정 → enabled=true", () => {
    process.env.QUANT_MCP_PORTFOLIO_MAX_HEAT = "0.2";
    const c = loadPortfolioGateConfig();
    expect(c.enabled).toBe(true);
    expect(c.maxHeat).toBe(0.2);
  });

  it("riskBudget만 설정 → enabled=true", () => {
    process.env.QUANT_MCP_PORTFOLIO_RISK_BUDGET = "0.1";
    expect(loadPortfolioGateConfig().enabled).toBe(true);
  });

  it("MDD=true만 설정 → enabled=true", () => {
    process.env.QUANT_MCP_PORTFOLIO_MDD = "true";
    const c = loadPortfolioGateConfig();
    expect(c.enabled).toBe(true);
    expect(c.mdd).toBe(true);
  });

  it("avgCorr 명시값 채택(범위 내), 범위 밖/잘못된 값은 기본 0.7", () => {
    process.env.QUANT_MCP_PORTFOLIO_MAX_HEAT = "0.2";
    process.env.QUANT_MCP_PORTFOLIO_AVG_CORR = "0.9";
    expect(loadPortfolioGateConfig().avgCorr).toBe(0.9);
    process.env.QUANT_MCP_PORTFOLIO_AVG_CORR = "5"; // 범위 밖
    expect(loadPortfolioGateConfig().avgCorr).toBe(0.7);
    process.env.QUANT_MCP_PORTFOLIO_AVG_CORR = "abc"; // NaN
    expect(loadPortfolioGateConfig().avgCorr).toBe(0.7);
    process.env.QUANT_MCP_PORTFOLIO_AVG_CORR = "0"; // 명시 0은 채택(미설정과 구분)
    expect(loadPortfolioGateConfig().avgCorr).toBe(0);
  });

  it("0/음수/비정상 캡은 무시(undefined → 미활성 취급)", () => {
    process.env.QUANT_MCP_PORTFOLIO_MAX_HEAT = "0";
    process.env.QUANT_MCP_PORTFOLIO_RISK_BUDGET = "-1";
    const c = loadPortfolioGateConfig();
    expect(c.maxHeat).toBeUndefined();
    expect(c.riskBudget).toBeUndefined();
    expect(c.enabled).toBe(false); // 유효한 캡/MDD 없음
  });
});

describe("portfolioGate — OFF(미설정)는 완전 통과(no-op)", () => {
  it("enabled=false면 극단 포지션·MDD에도 allow=true, mult=1", () => {
    const cfg = loadPortfolioGateConfig(); // 전부 미설정
    const r = portfolioGate(cfg, snap([{ symbol: "X", riskFraction: 0.99 }], 50, 200)); // heat 99%, dd 75%
    expect(r.enabled).toBe(false);
    expect(r.allow).toBe(true);
    expect(r.sizeMultiplier).toBe(1);
    expect(r.reasons).toEqual([]);
  });
});

describe("portfolioGate — heat 캡", () => {
  it("heat > maxHeat → 진입 차단(allow=false)", () => {
    process.env.QUANT_MCP_PORTFOLIO_MAX_HEAT = "0.2";
    const r = portfolioGate(loadPortfolioGateConfig(), snap([{ symbol: "X", riskFraction: 0.3 }]));
    expect(r.allow).toBe(false);
    expect(r.sizeMultiplier).toBe(0);
    expect(r.heat).toBeCloseTo(0.3, 9);
    expect(r.reasons.join()).toContain("총노출");
  });

  it("heat ≤ maxHeat → 통과(allow=true, mult=1)", () => {
    process.env.QUANT_MCP_PORTFOLIO_MAX_HEAT = "0.2";
    const r = portfolioGate(loadPortfolioGateConfig(), snap([{ symbol: "X", riskFraction: 0.1 }]));
    expect(r.allow).toBe(true);
    expect(r.sizeMultiplier).toBe(1);
  });

  it("riskBudget 미설정이면 heat만 검사(effectiveRisk 무한대 취급 → 미차단)", () => {
    process.env.QUANT_MCP_PORTFOLIO_MAX_HEAT = "0.5";
    // 4개 0.1 → heat 0.4 ≤ 0.5 통과. riskBudget 미설정이라 상관보정 실효리스크는 검사 안 함.
    const r = portfolioGate(loadPortfolioGateConfig(), snap([
      { symbol: "A", riskFraction: 0.1 }, { symbol: "B", riskFraction: 0.1 },
      { symbol: "C", riskFraction: 0.1 }, { symbol: "D", riskFraction: 0.1 },
    ]));
    expect(r.allow).toBe(true);
  });
});

describe("portfolioGate — riskBudget(상관보정 실효리스크) 캡", () => {
  it("effectiveRisk > riskBudget → 진입 차단", () => {
    // 고상관(0.9)에서 0.1×4의 실효리스크가 riskBudget 0.15를 넘게.
    process.env.QUANT_MCP_PORTFOLIO_RISK_BUDGET = "0.15";
    process.env.QUANT_MCP_PORTFOLIO_AVG_CORR = "0.9";
    const r = portfolioGate(loadPortfolioGateConfig(), snap([
      { symbol: "A", riskFraction: 0.1 }, { symbol: "B", riskFraction: 0.1 },
      { symbol: "C", riskFraction: 0.1 }, { symbol: "D", riskFraction: 0.1 },
    ]));
    expect(r.effectiveRisk).toBeGreaterThan(0.15);
    expect(r.allow).toBe(false);
    expect(r.reasons.join()).toContain("실효리스크");
  });
});

describe("portfolioGate — MDD 단계적 디리스킹", () => {
  it("dd 10% → reduced, sizeMultiplier 0.5(축소, 진입 허용)", () => {
    process.env.QUANT_MCP_PORTFOLIO_MDD = "true";
    const r = portfolioGate(loadPortfolioGateConfig(), snap([], 90, 100));
    expect(r.state).toBe("reduced");
    expect(r.allow).toBe(true);
    expect(r.sizeMultiplier).toBe(0.5);
  });

  it("dd 20% → halt, 진입 차단(allow=false)", () => {
    process.env.QUANT_MCP_PORTFOLIO_MDD = "true";
    const r = portfolioGate(loadPortfolioGateConfig(), snap([], 80, 100));
    expect(r.state).toBe("halt");
    expect(r.allow).toBe(false);
    expect(r.sizeMultiplier).toBe(0);
  });

  it("dd 5% → normal, 통과(mult=1)", () => {
    process.env.QUANT_MCP_PORTFOLIO_MDD = "true";
    const r = portfolioGate(loadPortfolioGateConfig(), snap([], 95, 100));
    expect(r.state).toBe("normal");
    expect(r.allow).toBe(true);
    expect(r.sizeMultiplier).toBe(1);
  });

  it("MDD 미활성(=true 아님)이면 깊은 낙폭에도 normal(MDD 검사 안 함)", () => {
    process.env.QUANT_MCP_PORTFOLIO_MAX_HEAT = "0.5"; // heat만 활성, MDD 비활성
    const r = portfolioGate(loadPortfolioGateConfig(), snap([], 50, 100)); // dd 50%
    expect(r.state).toBe("normal");
    expect(r.allow).toBe(true);
    expect(r.sizeMultiplier).toBe(1);
  });
});

describe("portfolioGate — sizeMultiplier는 절대 증액 안 함(축소만)", () => {
  it("모든 결과에서 0 ≤ sizeMultiplier ≤ 1", () => {
    process.env.QUANT_MCP_PORTFOLIO_MDD = "true";
    process.env.QUANT_MCP_PORTFOLIO_MAX_HEAT = "0.3";
    for (const [eq, pk] of [[100, 100], [90, 100], [80, 100], [120, 100]] as const) {
      const r = portfolioGate(loadPortfolioGateConfig(), snap([{ symbol: "X", riskFraction: 0.1 }], eq, pk));
      expect(r.sizeMultiplier).toBeGreaterThanOrEqual(0);
      expect(r.sizeMultiplier).toBeLessThanOrEqual(1);
    }
  });
});
