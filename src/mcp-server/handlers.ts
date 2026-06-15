/**
 * handlers.ts — MCP 툴 핸들러(순수 async 함수). stock-autotrade/scripts/agent-cli.ts 의 8개
 * 커맨드 바디를 그대로 이식 → backtest≡live 의미 보존. 각 핸들러는 plain object 반환(서버가 JSON 직렬화).
 * 데이터=binance-public(키 불필요), 계산=core 순수함수. 부수효과 0(네트워크 fetch만).
 */
import type { StrategyNode, BacktestConfig } from "../core/types/strategy.js";
import { runCompositeBacktest } from "../core/backtest/engine.js";
import { runShortBacktest } from "../core/backtest/short-engine.js";
import { calcReturnMoments } from "../core/backtest/metrics.js";
import { probabilisticSharpe, deflatedSharpe, sharpeVariance } from "../core/backtest/deflated-sharpe.js";
import { computeRegime, type RegimeParams } from "../core/backtest/regime.js";
import { atr } from "../core/strategy/indicators.js";
import { computeEwmaVol, annualizeVol, toLogReturns, computePositionSize, type SizingMethod } from "../core/risk/sizing.js";
import { evaluatePortfolioRisk } from "../core/risk/portfolio.js";
import { allocatePortfolio, type AllocationMethod } from "../core/risk/allocation.js";
import { summarizeDerivatives } from "../core/signals/derivatives.js";
import { validateRootNode } from "../core/validation/composite-node.js";
import { collectSpreadSymbols } from "../core/strategy/spread-symbols.js";
import { collectMtfConditions, buildMtfSeries, collectMtfRegimeConditions, buildMtfRegimeSeries, type MtfBar, type MtfRegimeSeries } from "../core/strategy/mtf.js";
import { collectEventCalendars, buildEventCalendars, BUILTIN_CALENDARS } from "../core/calendar/calendars.js";
import { rankUniverse, computeRankMetric, type RankBar, type RankMetric } from "../core/scanner/rank.js";
import { fetchKlines, fetchDerivatives, buildAuxSeries, type Bar } from "../data/binance-public.js";
import { validateCandleContiguity } from "../util/candle.js";

const cfg = (d: Bar[], symbol: string, interval: string, auxSeries?: Record<string, number[]>, mtfSeries?: Record<string, number[]>, eventCalendars?: Record<string, number[]>, mtfRegimeSeries?: Record<string, MtfRegimeSeries>): BacktestConfig => ({
  strategyId: "quant-mcp", symbol, startDate: d[0].date, endDate: d[d.length - 1].date,
  initialCapital: 1_000_000, commission: 0.1, timeframe: interval, auxSeries, mtfSeries, mtfRegimeSeries, eventCalendars,
});
/** auxSeries(전체 data 기준)를 [start,end) 슬라이스에 맞춰 잘라 정렬 유지. 없으면 undefined. */
const sliceAux = (aux: Record<string, number[]> | undefined, start: number, end: number): Record<string, number[]> | undefined => {
  if (!aux) return undefined;
  const out: Record<string, number[]> = {};
  for (const k of Object.keys(aux)) out[k] = aux[k].slice(start, end);
  return out;
};
/** mtfRegime(전체 data 기준 라벨 배열)을 [start,end) 슬라이스에 맞춰 잘라 정렬 유지(룩어헤드0, 경계 null은 fail-closed). 없으면 undefined. */
const sliceMtfRegime = (reg: Record<string, MtfRegimeSeries> | undefined, start: number, end: number): Record<string, MtfRegimeSeries> | undefined => {
  if (!reg) return undefined;
  const out: Record<string, MtfRegimeSeries> = {};
  for (const k of Object.keys(reg)) out[k] = reg[k].slice(start, end);
  return out;
};
const statOf = (r: ReturnType<typeof runCompositeBacktest>) => ({
  totalReturnPercent: +r.totalReturnPercent.toFixed(3), maxDrawdownPercent: +r.maxDrawdown.toFixed(3),
  winRate: +r.winRate.toFixed(1), totalTrades: r.totalTrades, profitFactor: +r.profitFactor.toFixed(3), sharpeRatio: +r.sharpeRatio.toFixed(3),
});

/**
 * 백테스트용 캔들 페치 + 무결성 검증(audit P1-22-02). 라이브 러너(runner.ts tickBot)가 동일 fetch를 contiguity
 * 게이트로 막으므로 백테스트도 동일하게 거부 → backtest≡live 패리티 보존(간극/형식깨짐 데이터로 신호 생성 금지).
 * 데이터=binance-public(crypto, 24/7) → mode 'crypto'(엄격 연속). 무효 시 throw(상위 guard가 에러로 변환).
 */
async function fetchKlinesChecked(symbol: string, interval: string, days: number): Promise<Bar[]> {
  const data = await fetchKlines(symbol, interval, days);
  const contig = validateCandleContiguity(data, interval, "crypto");
  if (!contig.valid) throw new Error(`캔들 무결성 실패(${symbol} ${interval}): ${contig.reason}`);
  return data;
}

// ── 1. validate_strategy ──
export function validateStrategy(args: { tree: unknown }) {
  const err = validateRootNode(args.tree);
  return { ok: err === null, valid: err === null, error: err };
}

// ── list_events: 내장 이벤트 캘린더 조회(읽기전용) ──
// 에이전트가 FOMC 등 일정 이벤트 날짜를 확인 → event 조건(calendar 또는 인라인 times)으로 전략 구성.
export function listEvents(args: { calendar?: string; from?: string; to?: string }) {
  const names = args.calendar ? [args.calendar] : Object.keys(BUILTIN_CALENDARS);
  const fromMs = args.from ? Date.parse(args.from) : Number.NEGATIVE_INFINITY;
  const toMs = args.to ? Date.parse(args.to) : Number.POSITIVE_INFINITY;
  const calendars: Record<string, string[]> = {};
  for (const n of names) {
    const iso = BUILTIN_CALENDARS[n];
    if (!iso) continue;
    calendars[n] = iso.filter((s) => { const t = Date.parse(s); return Number.isFinite(t) && t >= fromMs && t <= toMs; });
  }
  return {
    ok: true, calendars, available: Object.keys(BUILTIN_CALENDARS),
    note: "내장 캘린더는 근사 시각(미 동부 오후 2시 발표). 라이브 전 verify 권장. 정밀/기타 이벤트(실적 등)는 event 조건의 인라인 times(정확한 ISO)를 쓰면 외부데이터 0으로 backtest≡live.",
  };
}

// ── allocate_portfolio: 다자산 자본 배분 제안(읽기전용) ──
// equal/inverse_vol(리스크패리티 대각근사)/vol_target. 실시세 로그수익률로 EWMA 변동성 산출.
export async function allocatePortfolioTool(args: { symbols: string[]; method?: AllocationMethod; interval?: string; days?: number; targetVolAnnual?: number; lambda?: number }) {
  const symbols = Array.isArray(args.symbols) ? [...new Set(args.symbols.filter((s) => typeof s === "string" && s))] : [];
  if (symbols.length < 2) return { ok: false, error: "symbols는 최소 2개가 필요합니다" };
  const method = (args.method || "inverse_vol") as AllocationMethod;
  const interval = args.interval || "1d";
  const days = Math.max(20, Math.floor(args.days || 120));
  const fetched = await Promise.all(symbols.map(async (sym) => {
    try { const b = await fetchKlines(sym, interval, days); return { symbol: sym, returns: toLogReturns(b.map((x) => x.close)) }; }
    catch { return { symbol: sym, returns: [] as number[] }; }
  }));
  const res = allocatePortfolio(fetched, method, { timeframe: interval, targetVolAnnual: args.targetVolAnnual ?? 0.2, lambda: args.lambda ?? 0.94 });
  return { ok: true, interval, days, ...res };
}

// ── scan_universe: 유니버스 스크리닝 + 크로스섹셔널 랭킹(읽기전용) ──
// "아침 9시 급등주" 스크리닝의 읽기 절반. 상위 N + 점수 반환. 데이터부족 종목은 제외.
export async function scanUniverse(args: { universe: string[]; metric?: RankMetric; top?: number; order?: "desc" | "asc"; interval?: string; period?: number; bars?: number }) {
  const universe = Array.isArray(args.universe) ? [...new Set(args.universe.filter((s) => typeof s === "string" && s))] : [];
  if (universe.length < 2) return { ok: false, error: "universe는 최소 2개 심볼이 필요합니다" };
  const metric = (args.metric || "roc") as RankMetric;
  const top = Math.max(1, Math.floor(args.top || 5));
  const order = args.order === "asc" ? "asc" : "desc";
  const interval = args.interval || "1d";
  const period = Math.max(1, Math.floor(args.period || 14));
  const want = Math.max(period + 2, Math.floor(args.bars || 60));
  const fetched = await Promise.all(universe.map(async (sym) => {
    try { const b = await fetchKlines(sym, interval, want); return { symbol: sym, bars: b }; }
    catch { return null; }
  }));
  const entries = fetched.filter((x): x is { symbol: string; bars: Bar[] } => !!x && x.bars.length >= 2);
  const skipped = universe.filter((s) => !entries.some((e) => e.symbol === s));
  const ranked = rankUniverse(entries.map((e) => ({ symbol: e.symbol, bars: e.bars as unknown as RankBar[] })), metric, top, order, period);
  // 전체 점수(랭킹 밖 포함)도 투명하게 노출
  const allScores = entries.map((e) => ({ symbol: e.symbol, score: computeRankMetric(e.bars as unknown as RankBar[], metric, period) }))
    .filter((x) => x.score !== null).map((x) => ({ symbol: x.symbol, score: +(x.score as number).toFixed(4) }));
  return {
    ok: true, metric, order, interval, top, evaluated: entries.length, skipped,
    ranked: ranked.map((r) => ({ symbol: r.symbol, score: +r.score.toFixed(4) })),
    allScores,
    note: "스크리닝은 아이디어 후보 생성이지 알파 보장이 아님. 인트라데이일수록 수수료·슬리피지·과적합 리스크↑.",
  };
}

// ── 2. backtest (70/30 hold-out OOS + PSR) ── 단일 홀드아웃 분할(롤링/확장 워크포워드 아님: split=floor(len*0.7), train=앞 70%, test=뒤 30%).
export async function backtest(args: { tree: StrategyNode; symbol?: string; interval?: string; days?: number; gapHandling?: "close" | "worst" }) {
  const err = validateRootNode(args.tree);
  if (err) return { ok: false, error: `검증 실패: ${err}` };
  const symbol = args.symbol || "BTCUSDT", interval = args.interval || "1d", days = Number(args.days || 200);
  const data = await fetchKlinesChecked(symbol, interval, days);
  if (data.length < 30) return { ok: false, error: `데이터 부족(${data.length}봉)` };
  // 스프레드/MTF 조건이 있으면 상대심볼·상위TF를 동일 봉에 정렬해 주입(전체→슬라이스). 없으면 undefined(기존 동작).
  const spreadSyms = collectSpreadSymbols(args.tree);
  const aux = spreadSyms.length ? await buildAuxSeries(data, spreadSyms, interval) : undefined;
  const mtfNeeds = collectMtfConditions(args.tree);
  const mtf = mtfNeeds.length ? await buildMtfSeries(data as unknown as MtfBar[], mtfNeeds, (tf, lim) => fetchKlines(symbol, tf, lim) as unknown as Promise<MtfBar[]>) : undefined;
  // MTF regime: timeframe 지정 regime 조건의 상위TF 레짐 라벨 배열(LTF 전방채움). OOS는 sliceMtfRegime로 라벨 배열 동일 분할(경계 null=fail-closed).
  const mtfRegNeeds = collectMtfRegimeConditions(args.tree);
  const mtfReg = mtfRegNeeds.length ? await buildMtfRegimeSeries(data as unknown as MtfBar[], mtfRegNeeds, (tf, lim) => fetchKlines(symbol, tf, lim) as unknown as Promise<MtfBar[]>) : undefined;
  // 이벤트 캘린더는 절대 epoch 타임스탬프 → 윈도우 슬라이스 불필요(엔진이 각 봉 시각을 전체 이벤트와 대조).
  const calNames = collectEventCalendars(args.tree);
  const ev = calNames.length ? buildEventCalendars(calNames) : undefined;
  const full = runCompositeBacktest(args.tree, data, { ...cfg(data, symbol, interval, aux, mtf, ev, mtfReg), gapHandling: args.gapHandling ?? "worst" });
  let oos: Record<string, unknown> | null = null;
  const split = Math.floor(data.length * 0.7);
  if (split >= 30 && data.length - split >= 20) {
    const train = data.slice(0, split), test = data.slice(split);
    const tr = runCompositeBacktest(args.tree, train, { ...cfg(train, symbol, interval, sliceAux(aux, 0, split), sliceAux(mtf, 0, split), ev, sliceMtfRegime(mtfReg, 0, split)), gapHandling: args.gapHandling ?? "worst" });
    const te = runCompositeBacktest(args.tree, test, { ...cfg(test, symbol, interval, sliceAux(aux, split, data.length), sliceAux(mtf, split, data.length), ev, sliceMtfRegime(mtfReg, split, data.length)), gapHandling: args.gapHandling ?? "worst" });
    const m = calcReturnMoments(te.equityCurve);
    const psr = probabilisticSharpe(m.perBarSharpe, m.n, m.skewness, m.kurtosis, 0);
    oos = {
      split: 0.7, trainBars: train.length, testBars: test.length, train: statOf(tr), test: statOf(te),
      testPsr: +psr.toFixed(4), testPerBarSharpe: +m.perBarSharpe.toFixed(5),
      robust: tr.totalReturnPercent > 0 && te.totalReturnPercent > 0 && te.totalTrades >= 1,
    };
  }
  return {
    ok: true, symbol, interval, bars: data.length, stats: statOf(full), oos,
    verdict: { profitable: full.totalReturnPercent > 0 && full.totalTrades > 0, oosRobust: oos ? oos.robust : null, oosPsr: oos ? oos.testPsr : null },
  };
}

// ── 3. backtest_short (sell=숏진입, buy=커버) ──
export async function backtestShort(args: { tree: StrategyNode; symbol?: string; interval?: string; days?: number; risk?: Parameters<typeof runShortBacktest>[3] }) {
  const err = validateRootNode(args.tree);
  if (err) return { ok: false, error: `검증 실패: ${err}` };
  const symbol = args.symbol || "BTCUSDT", interval = args.interval || "1d", days = Number(args.days || 200);
  const data = await fetchKlinesChecked(symbol, interval, days);
  if (data.length < 30) return { ok: false, error: `데이터 부족(${data.length}봉)` };
  const res = runShortBacktest(args.tree, data, cfg(data, symbol, interval), args.risk ?? {});
  return {
    ok: true, side: "short", symbol, interval, bars: data.length, stats: statOf(res),
    verdict: { profitable: res.totalReturnPercent > 0 && res.totalTrades > 0 },
  };
}

// ── 4. detect_regime ──
export async function detectRegime(args: { symbol?: string; interval?: string; days?: number; params?: RegimeParams }) {
  const symbol = args.symbol || "BTCUSDT", interval = args.interval || "1d", days = Number(args.days || 200);
  const data = await fetchKlines(symbol, interval, days);
  if (data.length < 50) return { ok: false, error: `데이터 부족(${data.length}봉, 레짐은 50+ 필요)` };
  const r = computeRegime(data.map((d) => d.close), data.map((d) => d.high), data.map((d) => d.low), args.params ?? {});
  return { ok: true, symbol, interval, bars: data.length, ...r };
}

// ── 5. derivatives_signal (fapi 부분 degrade 허용) ──
export async function derivativesSignal(args: { symbol?: string; period?: string; lookback?: number }) {
  const symbol = args.symbol || "BTCUSDT", period = args.period || "1h", lookback = Number(args.lookback || 24);
  const { input, nextFundingTime } = await fetchDerivatives(symbol, period, lookback);
  const summary = summarizeDerivatives(input);
  const fetched = { funding: input.fundingRate != null, oi: input.oiNow != null, topLS: summary.topTraderTilt != null, retail: summary.retailContrarian != null, taker: summary.takerFlow != null };
  return { ok: true, period, lookback, nextFundingTime, fetched, ...summary };
}

// ── 6. suggest_position_size (ATR/volTarget/Kelly) ──
export async function suggestPositionSize(args: {
  symbol?: string; interval?: string; days?: number; equity?: number; method?: SizingMethod;
  riskPct?: number; targetVolAnnual?: number; atrMult?: number; leverageCap?: number; lambda?: number;
  winRate?: number; avgWin?: number; avgLoss?: number; kellyFraction?: number; sampleSize?: number;
}) {
  const symbol = args.symbol || "BTCUSDT", interval = args.interval || "1d", days = Number(args.days || 200);
  const data = await fetchKlines(symbol, interval, days);
  if (data.length < 30) return { ok: false, error: `데이터 부족(${data.length}봉)` };
  const closes = data.map((d) => d.close), highs = data.map((d) => d.high), lows = data.map((d) => d.low);
  const atrArr = atr(closes, highs, lows, 14);
  const atrNow = atrArr[atrArr.length - 1] || 0;
  const perBarVol = computeEwmaVol(toLogReturns(closes), args.lambda ?? 0.94);
  const realizedVolAnnual = annualizeVol(perBarVol, interval);
  const price = closes[closes.length - 1];
  const sized = computePositionSize({
    method: args.method || "atr", equity: Number(args.equity ?? 1_000_000), price,
    riskPct: args.riskPct, targetVolAnnual: args.targetVolAnnual, realizedVolAnnual,
    leverageCap: args.leverageCap, atr: atrNow, atrMult: args.atrMult,
    winRate: args.winRate, avgWin: args.avgWin, avgLoss: args.avgLoss, kellyFraction: args.kellyFraction, sampleSize: args.sampleSize,
  });
  return { ok: true, symbol, interval, price, atr: +atrNow.toFixed(4), realizedVolAnnual: +realizedVolAnnual.toFixed(4), ...sized };
}

// ── 7. portfolio_risk (순수 — caller가 positions 제공) ──
export function portfolioRisk(args: Parameters<typeof evaluatePortfolioRisk>[0]) {
  const inp = { ...args };
  if (!Array.isArray(inp.positions)) inp.positions = [];
  return { ok: true, ...evaluatePortfolioRisk(inp) };
}

// ── 8. strategy_factory (대량 후보 → OOS + DSR 생존자, 거짓발견 필터) ──
export async function strategyFactory(args: {
  candidates: { id?: string; tree: StrategyNode; symbol?: string; interval?: string; days?: number }[];
  symbol?: string; interval?: string; days?: number; minDsr?: number;
}) {
  const cands = Array.isArray(args.candidates) ? args.candidates : [];
  if (!cands.length) return { ok: false, error: "candidates 배열 필요" };
  const symbol0 = args.symbol || "BTCUSDT", interval0 = args.interval || "1d", days0 = Number(args.days || 300);
  const minDsr = typeof args.minDsr === "number" ? args.minDsr : 0.95;
  const klineCache = new Map<string, Bar[]>();
  type FRow = { id: string; valid: boolean; error?: string; crashed?: boolean; sym?: string; tf?: string; trainReturn?: number; testReturn?: number; testTrades?: number; oosRobust?: boolean; dsr?: number; sr0?: number; testPerBarSharpe?: number; survivor?: boolean };
  const rows: FRow[] = [];
  const moments = new Map<string, ReturnType<typeof calcReturnMoments>>();
  for (let ci = 0; ci < cands.length; ci++) {
    const c = cands[ci]; const id = c.id || `cand${ci}`;
    try {
      const vErr = validateRootNode(c.tree);
      if (vErr) { rows.push({ id, valid: false, error: vErr }); continue; }
      const sym = c.symbol || symbol0, tf = c.interval || interval0, days = Number(c.days || days0);
      const key = `${sym}|${tf}|${days}`;
      let data = klineCache.get(key);
      if (!data) { data = await fetchKlinesChecked(sym, tf, days); klineCache.set(key, data); }
      if (data.length < 60) { rows.push({ id, valid: true, error: `데이터부족(${data.length})` }); continue; }
      const split = Math.floor(data.length * 0.7);
      // SL 체결 모델 'worst' 고정(audit P1-12 후속): OOS/DSR 생존자 선별이 러너(라이브)와 동일 보수 모델을 써야
      //   '낙관적 백테로 통과 → 라이브 더 후하게' 발산을 막는다(never-more-optimistic).
      const tr = runCompositeBacktest(c.tree, data.slice(0, split), { ...cfg(data.slice(0, split), sym, tf), gapHandling: "worst" });
      const te = runCompositeBacktest(c.tree, data.slice(split), { ...cfg(data.slice(split), sym, tf), gapHandling: "worst" });
      const m = calcReturnMoments(te.equityCurve);
      moments.set(id, m);
      rows.push({ id, valid: true, sym, tf, trainReturn: +tr.totalReturnPercent.toFixed(2), testReturn: +te.totalReturnPercent.toFixed(2), testTrades: te.totalTrades, oosRobust: tr.totalReturnPercent > 0 && te.totalReturnPercent > 0 && te.totalTrades >= 1 });
    } catch (e) { rows.push({ id, valid: true, crashed: true, error: e instanceof Error ? e.message : String(e) }); }
  }
  const sharpes = [...moments.values()].map((m) => m.perBarSharpe);
  const varSR = sharpeVariance(sharpes);
  const N = moments.size;
  for (const r of rows) {
    const m = moments.get(r.id); if (!m) continue;
    const d = deflatedSharpe({ srHat: m.perBarSharpe, n: m.n, skew: m.skewness, kurt: m.kurtosis, varSR, nTrials: N });
    r.dsr = +d.dsr.toFixed(4); r.sr0 = +d.sr0.toFixed(4); r.testPerBarSharpe = +m.perBarSharpe.toFixed(5);
    r.survivor = !!r.oosRobust && d.dsr >= minDsr;
  }
  const survivors = rows.filter((r) => r.survivor).sort((a, b) => (b.dsr ?? 0) - (a.dsr ?? 0));
  return {
    ok: true, total: cands.length, evaluated: N, varSR: +varSR.toFixed(6), minDsr,
    survivorCount: survivors.length, survivors, rows: rows.sort((a, b) => (b.dsr ?? -1) - (a.dsr ?? -1)),
    note: `다중검정 보정(N=${N} 시도) DSR≥${minDsr} AND OOS robust만 생존. 거짓발견 필터 — 대부분 기각이 정상(리서치: 알파 생성기 아님). 생존 전략도 실배포 전 추가 검증 권장.`,
  };
}
