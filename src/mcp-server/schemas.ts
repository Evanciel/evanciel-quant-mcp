/**
 * schemas.ts — MCP 툴 입력 스키마(zod ZodRawShape). registerTool({ inputSchema }) 에 그대로 전달.
 * 전략 트리(tree)는 z.unknown()으로 받고 핸들러 내부 validateRootNode가 정식 검증(스키마 중복정의 회피).
 */
import { z } from "zod";

const symbol = z.string().default("BTCUSDT").describe("거래쌍 (예: BTCUSDT, ETHUSDT)");
const interval = z.string().default("1d").describe("봉 주기 (1m,5m,15m,1h,4h,1d 등)");
const days = z.number().int().positive().default(200).describe("백테스트 봉 수(과거)");

export const validateStrategyShape = {
  tree: z.unknown().describe("복합 전략 트리(leaf/composite/condition 노드). validateRootNode로 검증됨."),
};

export const backtestShape = {
  tree: z.unknown().describe("검증·백테스트할 전략 트리"),
  symbol, interval, days,
};

export const backtestShortShape = {
  tree: z.unknown().describe("숏 백테스트할 전략 트리 (sell=숏진입, buy=커버)"),
  symbol, interval, days,
  risk: z.object({
    stopLossPercent: z.number().optional(),
    takeProfitPercent: z.number().optional(),
    trailingStopPercent: z.number().optional(),
    fundingRatePerInterval: z.number().optional(),
  }).partial().optional().describe("숏 리스크 파라미터"),
};

export const detectRegimeShape = {
  symbol, interval, days,
  params: z.record(z.string(), z.number()).optional().describe("RegimeParams 오버라이드(선택)"),
};

export const derivativesSignalShape = {
  symbol,
  period: z.string().default("1h").describe("OI/롱숏 집계 주기"),
  lookback: z.number().int().positive().default(24).describe("OI 변화 룩백 구간 수"),
};

export const suggestPositionSizeShape = {
  symbol, interval, days,
  equity: z.number().positive().default(1_000_000).describe("계좌 자본"),
  method: z.enum(["fixed", "vol_target", "atr", "kelly"]).default("atr").describe("사이징 방식"),
  riskPct: z.number().optional(),
  targetVolAnnual: z.number().optional(),
  atrMult: z.number().optional(),
  leverageCap: z.number().optional(),
  lambda: z.number().optional().describe("EWMA 변동성 감쇠(기본 0.94)"),
  winRate: z.number().optional(),
  avgWin: z.number().optional(),
  avgLoss: z.number().optional(),
  kellyFraction: z.number().optional(),
  sampleSize: z.number().optional(),
};

export const portfolioRiskShape = {
  positions: z.array(z.object({ symbol: z.string(), riskFraction: z.number() })).default([]).describe("보유 포지션(자본대비 리스크 비중)"),
  equity: z.number().describe("현재 자본"),
  peakEquity: z.number().describe("고점 자본(MDD 서킷 기준)"),
  avgCorr: z.number().optional(),
  maxHeat: z.number().optional(),
  riskBudget: z.number().optional(),
  tiers: z.array(z.object({ dd: z.number(), mult: z.number() })).optional().describe("MDD 디리스킹 티어 오버라이드(dd=고점대비낙폭 0~1, mult=사이즈배수. 기본 -10%→0.5, -20%→0.0)"),
};

export const strategyFactoryShape = {
  candidates: z.array(z.object({
    id: z.string().optional(),
    tree: z.unknown(),
    symbol: z.string().optional(),
    interval: z.string().optional(),
    days: z.number().optional(),
  })).describe("후보 전략 배열"),
  symbol: z.string().optional(),
  interval: z.string().optional(),
  days: z.number().optional(),
  minDsr: z.number().default(0.95).describe("생존 DSR 임계(기본 0.95, 다중검정 보정)"),
};

// ── v2: 봇/전략/대시보드 (로컬 스토어 + 페이퍼 러너) ──
export const saveCompositeShape = {
  name: z.string().describe("전략 이름"),
  tree: z.unknown().describe("복합 전략 트리(validateRootNode 검증)"),
  symbol: z.string().default("BTCUSDT"),
  market: z.enum(["spot", "futures"]).default("spot"),
  leverage: z.number().default(1),
  stopLossPercent: z.number().optional(),
  takeProfitPercent: z.number().optional(),
  tpLadder: z.array(z.object({ pct: z.number() })).optional().describe("다단계 부분익절 라더"),
  scaleIn: z.unknown().optional(),
  pyramid: z.unknown().optional(),
  trailingStopPercent: z.number().optional(),
};
export const createBotShape = {
  name: z.string().describe("봇 이름"),
  compositeStrategyId: z.string().describe("save_composite가 반환한 전략 id"),
  symbol: z.string().optional(),
  capital: z.number().default(1_000_000).describe("운용 자본(페이퍼)"),
  mode: z.enum(["paper", "live"]).default("paper").describe("paper만 가능(live=v2.5, 키+게이트 필요)"),
  broker: z.string().default("binance"),
  intervalSeconds: z.number().int().default(60).describe("평가 주기(최소 15초)"),
};
export const botIdShape = { botId: z.string().describe("봇 id") };
export const listBotsShape = {};
export const openDashboardShape = { port: z.number().int().default(7788).describe("대시보드 로컬 포트(127.0.0.1)") };
