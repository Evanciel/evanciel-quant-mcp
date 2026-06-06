import { z } from "zod";

// ── 기본 타입 ──

const IndicatorTypeSchema = z.enum(["sma", "ema", "rsi", "macd", "bollinger", "volume", "stochastic", "atr", "obv", "williams_r", "stochastic_rsi", "cci", "adx", "supertrend", "vwap", "mfi", "parabolic_sar", "ichimoku", "roc", "donchian", "aroon"]);
const ConditionOperatorSchema = z.enum(["gt", "lt", "gte", "lte", "cross_above", "cross_below"]);
const ActionTypeSchema = z.enum(["buy", "sell"]);

// 지표 파라미터: 모든 값 유한 + 기간(period류) 키는 1 이상 정수.
// 과거: z.number()만이라 음수/분수/-Infinity period가 통과 → 지표 배열 인덱스 어긋남(조용한 무거래) 또는
// rsi/stochasticRsi에서 'Invalid array length' throw. 검증 단계에서 차단(silent/throw → loud reject).
const PERIOD_KEYS = new Set(["period", "stochPeriod", "kPeriod", "dPeriod", "fast", "slow", "signal"]);
const ParamsSchema = z.record(z.string(), z.number()).refine(
  (p) => Object.entries(p).every(([k, v]) => Number.isFinite(v) && (!PERIOD_KEYS.has(k) || (Number.isInteger(v) && v >= 1))),
  { message: "지표 파라미터의 기간(period류) 값은 1 이상의 정수여야 합니다" }
);

const ConditionSchema = z.object({
  id: z.string(),
  indicator: IndicatorTypeSchema,
  params: ParamsSchema,
  operator: ConditionOperatorSchema,
  value: z.union([z.number(), IndicatorTypeSchema]),
  valueParams: ParamsSchema.optional(),
});

const StrategyRuleSchema = z.object({
  id: z.string(),
  action: ActionTypeSchema,
  conditions: z.array(ConditionSchema).min(1),
  quantityPercent: z.number().min(0).max(100),
  orderType: z.enum(["market", "limit"]).optional(),
  limitPriceOffset: z.number().optional(),
});

const StrategySchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  description: z.string(),
  symbol: z.string(),
  rules: z.array(StrategyRuleSchema),
  stopLossPercent: z.number().optional(),
  takeProfitPercent: z.number().optional(),
  maxPositionSize: z.number().optional(),
  isActive: z.boolean(),
  createdAt: z.any(), // Date | string (JSON 역직렬화 시 string)
  updatedAt: z.any(),
});

// ── 노드 조건 ──

const IndicatorConditionSchema = z.object({
  type: z.literal("indicator"),
  indicator: IndicatorTypeSchema,
  params: ParamsSchema,
  operator: ConditionOperatorSchema,
  value: z.number(),
  timeframe: z.string().optional(), // 멀티타임프레임(상위TF 평가). 미지정 시 봇 기본 TF.
});

const TimeConditionSchema = z
  .object({
    type: z.literal("time"),
    // month/quarter/dayOfWeek + 시간대(hour 0~23, minute 0~59). 시각은 인트라데이 봉(datetime) 필요.
    field: z.enum(["month", "quarter", "dayOfWeek", "hour", "minute"]),
    operator: z.enum(["eq", "in", "between"]),
    values: z.array(z.number()),
    // 시장 현지시각 변환(예: "Asia/Seoul" → KST 9시). 없으면 UTC. hour/minute에만 의미.
    tz: z.string().optional(),
  })
  // between은 [최솟값, 최댓값] 2값(min ≤ max) 필수. 과거: 길이 무제한 → between [5]/[]도 통과하면
  // engine.ts(383)는 values[1] undefined 비교(우연히 false), live(route.ts 295)는 length>=2 가드(false)로
  // 둘 다 false에 수렴하나 구현이 비대칭 → 향후 한쪽 변경 시 라우팅 발산 위험. 검증 단계에서 loud reject.
  // eq/in은 includes() 기반이라 길이 무관 → 제약 없음(빈 배열도 안전).
  .refine(
    (c) => c.operator !== "between" || (c.values.length >= 2 && c.values[0] <= c.values[1]),
    { message: "between 연산자는 values에 [최솟값, 최댓값] 두 값(최솟값 ≤ 최댓값)이 필요합니다", path: ["values"] }
  );

const PerformanceConditionSchema = z.object({
  type: z.literal("performance"),
  metric: z.enum(["returnPercent", "drawdown", "winRate"]),
  lookbackDays: z.number().int().min(1), // 정수≥1(분수 시 backtest N+1 윈도우 vs live slice 가드가 비대칭 → 라우팅 발산)
  operator: ConditionOperatorSchema,
  value: z.number(),
});

// 레짐 조건: 허용 레짐 화이트리스트(최소 1). params는 computeRegime 임계값 오버라이드(유한수만).
const RegimeConditionSchema = z.object({
  type: z.literal("regime"),
  in: z.array(z.enum(["trend_up", "trend_down", "range", "high_vol"])).min(1),
  params: z.record(z.string(), z.number().refine(Number.isFinite, { message: "params 값은 유한수여야 합니다" })).optional(),
});

// 세션 앵커 조건: price를 세션 기준값×multiplier와 비교. multiplier 유한(0/음수 허용 안 함 — 가격 배수).
const AnchorConditionSchema = z.object({
  type: z.literal("anchor"),
  source: z.literal("price").optional(),
  anchor: z.enum(["dayOpen", "prevClose", "sessionHigh", "sessionLow", "vwapFromOpen"]),
  operator: ConditionOperatorSchema,
  multiplier: z.number().refine((n) => Number.isFinite(n) && n > 0, { message: "multiplier는 0보다 큰 유한수여야 합니다" }).optional(),
  tz: z.string().optional(),
});

// 스프레드 조건(페어): symbolB 필수, zscore는 lookback≥2 정수. backtest/live가 같은 윈도우라야 발산 없음.
const SpreadConditionSchema = z.object({
  type: z.literal("spread"),
  symbolB: z.string().min(1),
  expr: z.enum(["ratio", "diffPct", "zscore"]),
  lookback: z.number().int().min(2).optional(),
  operator: ConditionOperatorSchema,
  value: z.number().refine(Number.isFinite, { message: "value는 유한수여야 합니다" }),
});

const NodeConditionSchema = z.discriminatedUnion("type", [
  IndicatorConditionSchema,
  TimeConditionSchema,
  PerformanceConditionSchema,
  RegimeConditionSchema,
  AnchorConditionSchema,
  SpreadConditionSchema,
]);

// ── 재귀 노드 트리 ──

const LeafNodeSchema: z.ZodType<unknown> = z.object({
  id: z.string(),
  type: z.literal("leaf"),
  name: z.string(),
  strategy: StrategySchema,
});

const ConditionNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    id: z.string(),
    type: z.literal("condition"),
    name: z.string(),
    condition: NodeConditionSchema,
    thenNode: StrategyNodeSchema,
    elseNode: StrategyNodeSchema.optional(),
  })
);

const CompositeNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    id: z.string(),
    type: z.literal("composite"),
    name: z.string(),
    mode: z.enum(["priority", "weighted"]),
    children: z.array(StrategyNodeSchema).min(1),
    weights: z.array(z.number()).optional(),
  })
);

export const StrategyNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("type", [
    LeafNodeSchema as z.ZodObject<z.ZodRawShape>,
    ConditionNodeSchema as z.ZodObject<z.ZodRawShape>,
    CompositeNodeSchema as z.ZodObject<z.ZodRawShape>,
  ])
);

// eval 깊이 가드(MAX_*_RECURSION_DEPTH=10)보다 충분히 크되, 스택오버플로/사이클을 막는 상한.
const MAX_NODE_DEPTH = 20;
const MAX_NODE_COUNT = 10000;

// 비재귀(반복) DFS로 트리 깊이·크기를 사전 검사 — safeParse가 스택오버플로로 throw하기 전에 차단.
// in-memory 사이클(jarvis가 잘못 만든 객체 그래프)도 노드 수 상한으로 방어.
function exceedsBounds(node: unknown): string | null {
  const stack: Array<{ n: unknown; d: number }> = [{ n: node, d: 0 }];
  let count = 0;
  while (stack.length) {
    const top = stack.pop()!;
    if (top.d > MAX_NODE_DEPTH) return `트리가 너무 깊습니다 (최대 깊이 ${MAX_NODE_DEPTH})`;
    if (++count > MAX_NODE_COUNT) return `트리 노드 수가 너무 많거나 순환 구조입니다 (최대 ${MAX_NODE_COUNT})`;
    if (!top.n || typeof top.n !== "object") continue;
    const o = top.n as Record<string, unknown>;
    if (Array.isArray(o.children)) for (const c of o.children) stack.push({ n: c, d: top.d + 1 });
    if (o.thenNode) stack.push({ n: o.thenNode, d: top.d + 1 });
    if (o.elseNode) stack.push({ n: o.elseNode, d: top.d + 1 });
  }
  return null;
}

// ── 스캐너 노드(봇 최상위 전용) ──
const ScannerNodeSchema = z.object({
  id: z.string(),
  type: z.literal("scanner"),
  name: z.string(),
  universe: z.array(z.string().min(1)).min(2).max(50), // 2~50종목. 상한=틱마다 심볼당 1페치라 폭주/레이트리밋 방지.
  rank: z.object({
    metric: z.enum(["gapPct", "roc", "relVolume", "rangePct"]),
    top: z.number().int().min(1),
    order: z.enum(["desc", "asc"]).optional(),
    period: z.number().int().min(1).optional(),
  }),
  then: StrategyNodeSchema, // 선정 종목에 적용할 복합전략(재귀 검증)
  schedule: z.object({
    hour: z.array(z.number().int().min(0).max(23)),
    tz: z.string().optional(),
  }).optional(),
});

/**
 * 스캐너 노드 검증. 실패 시 에러 메시지, 성공 시 null. then 트리는 깊이/사이클 사전차단 후 검증.
 */
export function validateScannerNode(data: unknown): string | null {
  const o = data as { then?: unknown } | null;
  if (o && typeof o === "object" && o.then) {
    const bound = exceedsBounds(o.then);
    if (bound) return `스캐너 검증 실패: then ${bound}`;
  }
  let result: ReturnType<typeof ScannerNodeSchema.safeParse>;
  try {
    result = ScannerNodeSchema.safeParse(data);
  } catch (e) {
    return `스캐너 검증 실패: 구조 파싱 오류 (${e instanceof Error ? e.message : String(e)})`;
  }
  if (result.success) return null;
  const first = result.error.issues[0];
  return first ? `스캐너 검증 실패: ${first.path.join(".")} — ${first.message}` : "스캐너 구조가 올바르지 않습니다";
}

/**
 * 봇 root_node 검증 — scanner면 validateScannerNode, 아니면 validateRootNode. 봇 생성/배포의 단일 게이트.
 */
export function validateBotRoot(data: unknown): string | null {
  if (data && typeof data === "object" && (data as { type?: unknown }).type === "scanner") {
    return validateScannerNode(data);
  }
  return validateRootNode(data);
}

/**
 * root_node를 검증하고, 실패 시 첫 번째 에러 메시지를 반환.
 * 성공 시 null 반환. 어떤 입력에도 throw하지 않는다(깊이/사이클 사전차단 + safeParse try/catch).
 */
export function validateRootNode(data: unknown): string | null {
  const bound = exceedsBounds(data);
  if (bound) return `노드 검증 실패: ${bound}`;
  let result: ReturnType<typeof StrategyNodeSchema.safeParse>;
  try {
    result = StrategyNodeSchema.safeParse(data);
  } catch (e) {
    return `노드 검증 실패: 구조 파싱 오류 (${e instanceof Error ? e.message : String(e)})`;
  }
  if (result.success) return null;
  const first = result.error.issues[0];
  return first ? `노드 검증 실패: ${first.path.join(".")} — ${first.message}` : "노드 구조가 올바르지 않습니다";
}
