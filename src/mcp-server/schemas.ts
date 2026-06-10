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

// 사이징 설정(opt-in). 3모드 디스크리미네이티드 유니언 — 전부 "리스크 통제"이지 알파원이 아님(정직 포지셔닝).
// 미지정 시 기존 quantityPercent(legacy) 그대로. computeOrderQty가 엔진·러너 공용 → backtest≡live.
// vol_target: 현물 leverageCap≤1 강제, targetVol 상한 200% 새너티.
const volTargetSizingSchema = z.object({
  method: z.literal("vol_target"),
  targetVolAnnual: z.number().positive().max(2).describe("목표 연환산 변동성(예: 0.2=20%)"),
  leverageCap: z.number().positive().max(1).optional().describe("레버리지 상한(현물 기본 1.0)"),
  lookback: z.number().int().positive().optional().describe("realizedVol 계산 봉수(기본=가용분)"),
});
// atr: 트레이드당 리스크를 equity의 riskPct로 고정(notional≤equity 캡). 자산/변동성 무관 손실 일정 → 다심볼 혼합 적합.
const atrSizingSchema = z.object({
  method: z.literal("atr"),
  riskPct: z.number().positive().max(0.5).describe("트레이드당 리스크 비중(예: 0.01=1%). 새너티 상한 50%"),
  atrMult: z.number().positive().max(20).optional().describe("스톱거리=ATR×atrMult(기본 2.0)"),
  atrPeriod: z.number().int().positive().max(500).optional().describe("ATR 계산 기간(기본 14)"),
  lookback: z.number().int().positive().optional().describe("ATR 계산용 최근 봉수(기본=가용분)"),
});
// kelly: fractional Kelly. 통계(winRate/avgWin/avgLoss)는 에이전트 선언(정적) — 표본<minSample이면 fallback. capFraction 25% 내부 상한.
const kellySizingSchema = z.object({
  method: z.literal("kelly"),
  winRate: z.number().min(0).max(1).describe("승률(0~1)"),
  avgWin: z.number().positive().describe("평균 이익 크기(양수)"),
  avgLoss: z.number().positive().describe("평균 손실 크기(양수)"),
  fraction: z.number().positive().max(1).optional().describe("켈리 분율(기본 0.5=Half-Kelly)"),
  sampleSize: z.number().int().nonnegative().optional().describe("통계 표본수(기본 0 → 100 미만이면 보수적 fallback)"),
});
export const riskSizingSchema = z.discriminatedUnion("method", [
  volTargetSizingSchema,
  atrSizingSchema,
  kellySizingSchema,
]);

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
  riskSizing: riskSizingSchema.optional().describe("사이징 모드(리스크 통제, 알파 아님): vol_target=변동성 타게팅 / atr=ATR 트레이드당 리스크 고정 / kelly=fractional Kelly. 생략 시 기존 quantityPercent"),
};
export const createBotShape = {
  // 심층방어: 불신 입력(MCP 클라/LLM)을 입구에서 좁힘 — 대시보드는 String(s) esc()로 1차 차단하되, 스키마에서 길이·charset·enum까지 강제(저장형 XSS·DoS 표면 축소).
  name: z.string().trim().min(1).max(120).describe("봇 이름"),
  compositeStrategyId: z.string().describe("save_composite가 반환한 전략 id"),
  symbol: z.string().trim().max(40).regex(/^[A-Za-z0-9._/-]*$/, "심볼은 영숫자·._/- 만 허용").optional(),
  capital: z.number().default(1_000_000).describe("운용 자본(페이퍼)"),
  mode: z.enum(["paper", "live"]).default("paper").describe("paper만 가능(live=v2.5, 키+게이트 필요)"),
  broker: z.enum(["binance", "kis", "kiwoom"]).default("binance").describe("브로커(enum 고정 — 임의 문자열 거부)"),
  intervalSeconds: z.number().int().default(60).describe("평가 주기(최소 15초)"),
};
export const listEventsShape = {
  calendar: z.string().optional().describe("캘린더 이름(예: FOMC). 생략 시 전체 내장 캘린더"),
  from: z.string().optional().describe("ISO 시작 필터(예: 2025-01-01)"),
  to: z.string().optional().describe("ISO 끝 필터"),
};
export const allocatePortfolioShape = {
  symbols: z.array(z.string()).min(2).describe("배분할 심볼 리스트(최소 2)"),
  method: z.enum(["equal", "inverse_vol", "vol_target"]).default("inverse_vol").describe("equal=동등, inverse_vol=변동성역가중(리스크패리티 대각근사), vol_target=목표변동성"),
  interval, days: z.number().int().positive().default(120).describe("변동성 추정용 봉 수"),
  targetVolAnnual: z.number().positive().default(0.2).describe("vol_target: 목표 연환산 변동성(0.2=20%)"),
  lambda: z.number().optional().describe("EWMA 감쇠(기본 0.94)"),
};
export const scanUniverseShape = {
  universe: z.array(z.string()).min(2).describe("스크리닝할 심볼 리스트(최소 2). 예: [\"BTCUSDT\",\"ETHUSDT\",\"SOLUSDT\"]"),
  metric: z.enum(["gapPct", "roc", "relVolume", "rangePct"]).default("roc").describe("랭킹 메트릭(gapPct=갭, roc=모멘텀, relVolume=거래량급증, rangePct=장중변동성)"),
  top: z.number().int().positive().default(5).describe("상위 N개"),
  order: z.enum(["desc", "asc"]).default("desc"),
  interval, period: z.number().int().positive().default(14).describe("roc/relVolume 룩백 봉수"),
  bars: z.number().int().positive().default(60).describe("페치할 봉 수"),
};
export const botIdShape = { botId: z.string().describe("봇 id") };
export const listBotsShape = {};
export const openDashboardShape = { port: z.number().int().default(7788).describe("대시보드 로컬 포트(127.0.0.1)") };

// ── v2.5: 라이브 거래(BYOK, 안전게이트) ──
const brokerEnum = z.enum(["binance", "kis", "kiwoom"]).default("binance");
const marketEnum = z.enum(["spot", "futures"]).default("spot");
export const liveStatusShape = {};
export const brokerReadShape = { broker: brokerEnum, market: marketEnum };
export const placeOrderShape = {
  broker: brokerEnum,
  market: marketEnum,
  symbol: z.string().describe("종목/심볼 (BTCUSDT, 005930 등)"),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["market", "limit"]).default("market"),
  quantity: z.number().positive(),
  price: z.number().optional().describe("지정가 시 가격(시장가는 생략)"),
  confirmToken: z.string().optional().describe("프리뷰가 반환한 토큰. 없으면 프리뷰만(실주문 안 함=fail-closed)"),
};
