/**
 * runner/runner.ts — 로컬 페이퍼 봇 러너. bot-runner route.ts 평가루프를 standalone으로 이식.
 * core 엔진(runCompositeBacktest) 재사용 → backtest≡live. 페이퍼 가상체결을 스토어에 기록.
 * 라이브 실행은 v2.5(브로커 어댑터 + 2단계 토큰 + 하드게이트)에서. 현재는 paper만.
 */
import type { StrategyNode, ScannerNode, BacktestConfig } from "../core/types/strategy.js";
import { runCompositeBacktest } from "../core/backtest/engine.js";
import { fetchKlines, buildAuxSeries, type Bar } from "../data/binance-public.js";
import { collectSpreadSymbols } from "../core/strategy/spread-symbols.js";
import { collectMtfConditions, buildMtfSeries, type MtfBar } from "../core/strategy/mtf.js";
import { rankUniverse, decideScannerActions, type RankBar } from "../core/scanner/rank.js";
import * as store from "../store/db.js";
import { getAdapter } from "../brokers/index.js";
import { liveGate, checkLimits, audit, type Broker } from "../brokers/safety.js";

/**
 * 봇 체결: mode=live + 게이트 통과면 실주문(어댑터), 아니면 페이퍼. 자율봇이라 2단계토큰 없음
 * (생성 시 mode=live=사전승인). 안전=마스터스위치+testnet기본+하드리밋+멱등. 실패 시 페이퍼 폴백+로그.
 */
async function fillOrder(bot: store.BotRow, side: "buy" | "sell", qty: number, price: number): Promise<{ live: boolean; price: number; orderId?: string; note: string }> {
  if (bot.mode !== "live") return { live: false, price, note: "페이퍼" };
  const broker = (["binance", "kis", "kiwoom"].includes(bot.broker) ? bot.broker : "binance") as Broker;
  const market = (bot.symbol.endsWith("USDT") ? "spot" : "spot") as "spot" | "futures";
  const gate = liveGate(broker, market);
  if (!gate.allowed) { store.insertLog(bot.id, "gate", `라이브 차단(${gate.reason}) → 페이퍼`); return { live: false, price, note: "게이트 차단→페이퍼" }; }
  const lim = checkLimits({ symbol: bot.symbol, notional: price * qty });
  if (!lim.ok) { store.insertLog(bot.id, "gate", `하드리밋(${lim.reason}) → 페이퍼`); return { live: false, price, note: "리밋→페이퍼" }; }
  const got = getAdapter(broker, market);
  if (!got) { store.insertLog(bot.id, "gate", "어댑터 없음 → 페이퍼"); return { live: false, price, note: "어댑터없음→페이퍼" }; }
  audit({ event: "bot_order_attempt", botId: bot.id, broker, env: gate.env, symbol: bot.symbol, side, qty, price });
  try {
    const r = await got.adapter.placeOrder({ symbol: bot.symbol, side, type: "market", quantity: qty, clientOrderId: `${bot.id}-${side}-${Date.now()}` });
    audit({ event: "bot_order_result", botId: bot.id, env: gate.env, orderId: r.orderId, status: r.status });
    store.insertLog(bot.id, "live", `[${gate.env}] 실주문 ${side} qty=${qty} → ${r.status} (${r.orderId})`);
    return { live: true, price: r.price || price, orderId: r.orderId, note: `${gate.env} 실주문` };
  } catch (e) {
    audit({ event: "bot_order_error", botId: bot.id, error: e instanceof Error ? e.message : String(e) });
    store.insertLog(bot.id, "error", `실주문 실패(${e instanceof Error ? e.message : e}) → 페이퍼 폴백`);
    return { live: false, price, note: "실주문실패→페이퍼" };
  }
}

export interface PaperPosition { status: "open"; entryAvg: number; qty: number; openedAt: string; }

/** 폴링 주기(초) → Binance kline 타임프레임. 인트라데이 봉이라야 시간대(hour) 조건이 의미. */
function secsToInterval(s: number): string {
  if (s <= 60) return "1m"; if (s <= 180) return "3m"; if (s <= 300) return "5m"; if (s <= 900) return "15m";
  if (s <= 1800) return "30m"; if (s <= 3600) return "1h"; if (s <= 14400) return "4h"; if (s <= 86400) return "1d"; return "1d";
}

/**
 * 수량 델타 정합 계획(순수). 엔진 넷 포지션(want)을 라이브 보유수량(curQty)에 추종.
 * dq>0=매수(진입/스케일인/피라미딩), dq<0=매도(부분익절/청산), 0=유지. 라더류 부분체결을 라이브에 반영.
 */
export function planPositionDelta(
  curQty: number, want: { holding: boolean; qty: number; entryAvg: number }, price: number, capital: number
): { side: "buy" | "sell" | "hold"; qty: number; partial: boolean; wantQty: number } {
  const wantQty = want.holding ? (want.qty > 0 ? want.qty : Math.max(1, Math.floor(capital / price))) : 0;
  const EPS = 1e-9;
  const dq = wantQty - curQty;
  if (dq > EPS) return { side: "buy", qty: dq, partial: curQty > EPS, wantQty };   // partial=추가매수
  if (dq < -EPS) return { side: "sell", qty: -dq, partial: wantQty > EPS, wantQty }; // partial=부분익절
  return { side: "hold", qty: 0, partial: false, wantQty };
}

/** 백테스트 결과의 trade 시퀀스에서 "현재 보유 여부 + 평단/수량"을 도출(net). */
function derivePosition(trades: { action: string; price: number; quantity: number }[]): { holding: boolean; entryAvg: number; qty: number } {
  let qty = 0, cost = 0;
  for (const t of trades) {
    if (t.action === "buy") { cost += t.price * t.quantity; qty += t.quantity; }
    else { const sell = Math.min(t.quantity, qty); if (qty > 0) cost -= (cost / qty) * sell; qty -= sell; if (qty <= 1e-9) { qty = 0; cost = 0; } }
  }
  return { holding: qty > 1e-9, entryAvg: qty > 0 ? cost / qty : 0, qty };
}

/** 봇 1회 평가(틱). 신호 전이 시 페이퍼 체결 기록 + position_state 갱신. */
export async function tickBot(botId: string): Promise<{ action: "buy" | "sell" | "hold"; detail: string }> {
  const bot = store.getBot(botId);
  if (!bot) return { action: "hold", detail: "no bot" };
  const comp = store.getComposite(bot.composite_strategy_id);
  if (!comp) { store.insertLog(botId, "error", "복합전략 없음"); return { action: "hold", detail: "no composite" }; }

  // 스캐너 봇: root_node가 scanner면 멀티심볼 랭킹 경로로 분기.
  if ((comp.root_node as { type?: string })?.type === "scanner") {
    return tickScanner(bot, comp.root_node as ScannerNode);
  }

  const interval = secsToInterval(bot.interval_seconds); // 폴링 주기 → kline 타임프레임(인트라데이 자동). 시간대 조건 해금.
  const data = await fetchKlines(bot.symbol, interval, 300);
  if (data.length < 30) { store.setBotPositionState(botId, bot.position_state); return { action: "hold", detail: `데이터 부족(${data.length})` }; }
  const price = data[data.length - 1].close;

  // 스프레드 조건이 있으면 상대심볼(symbolB)을 동일 봉에 정렬해 주입 → 라이브에서도 spread 평가(backtest≡live).
  const root = comp.root_node as StrategyNode;
  const spreadSyms = collectSpreadSymbols(root);
  const auxSeries = spreadSyms.length ? await buildAuxSeries(data, spreadSyms, interval) : undefined;
  // 멀티타임프레임: timeframe 지정된 지표조건들의 상위TF 봉을 페치·정렬해 주입(라이브에서도 MTF 평가, backtest≡live).
  const mtfNeeds = collectMtfConditions(root);
  const mtfSeries = mtfNeeds.length ? await buildMtfSeries(data as unknown as MtfBar[], mtfNeeds, (tf, lim) => fetchKlines(bot.symbol, tf, lim) as unknown as Promise<MtfBar[]>) : undefined;

  const cfg: BacktestConfig = { strategyId: "runner", symbol: bot.symbol, startDate: data[0].date, endDate: data[data.length - 1].date, initialCapital: bot.capital, commission: 0.1, timeframe: interval, auxSeries, mtfSeries };
  const risk = {
    stopLossPercent: comp.stop_loss_percent, takeProfitPercent: comp.take_profit_percent,
    tpLadder: comp.tp_ladder as never, scaleIn: comp.scale_in as never, pyramid: comp.pyramid as never,
    trailingStopPercent: comp.trailing_stop_percent,
  };
  const res = runCompositeBacktest(root, data as unknown as Parameters<typeof runCompositeBacktest>[1], cfg, 0, risk);
  const want = derivePosition(res.trades);
  const cur = bot.position_state as PaperPosition | null;
  const curQty = cur && cur.status === "open" ? cur.qty : 0;
  // 멱등키는 봉 오픈시각(datetime, 전체 ISO) 기준 — date(YYYY-MM-DD)면 인트라데이 봇이 하루 1회 매매만 기록되어
  // 같은 날 재진입이 영구 차단됨(backtest≠live). 스캐너 경로와 동일 granularity.
  const idem = (sfx: string) => `${botId}:${data[data.length - 1].datetime}:${sfx}`;

  // ── 수량 델타(qty-delta) 정합 ──
  // 엔진의 넷 포지션(want.qty)을 라이브 보유수량(curQty)에 봉마다 추종 → tpLadder(부분익절)·scaleIn(물타기)·
  // pyramid(추가매수)의 단계적 수량 변화가 라이브에도 부분 체결로 반영됨(이전엔 flat↔holding 이진 전이라
  // 라더/스케일인/피라미딩이 발산했음). 단순 진입/청산은 dq=전량이라 기존 동작과 동일 → backtest≡live.
  const plan = planPositionDelta(curQty, want, price, bot.capital);

  if (plan.side === "buy") {
    // 신규 진입 또는 추가매수(스케일인/피라미딩). entryAvg는 엔진 가중평단(want.entryAvg)으로 갱신.
    const fill = await fillOrder(bot, "buy", plan.qty, price);
    const reason = plan.partial ? "추가매수(스케일인/피라미딩)" : "전략 진입";
    const t = store.insertTrade({ bot_id: botId, side: "buy", price: fill.price, qty: plan.qty, pnl: 0, is_paper: fill.live ? 0 : 1, reason, idempotency_key: idem("buy") });
    if (t) {
      const entryAvg = want.entryAvg > 0 ? want.entryAvg : fill.price;
      store.setBotPositionState(botId, { status: "open", entryAvg, qty: plan.wantQty, openedAt: cur?.openedAt ?? new Date().toISOString() } satisfies PaperPosition, true, true);
      store.insertLog(botId, "buy", `[${fill.live ? "실거래" : "페이퍼"}] ${reason} +${plan.qty} → 보유 ${plan.wantQty} @ ${fill.price}(평단 ${entryAvg.toFixed(2)})`);
      return { action: "buy", detail: `${reason} +${plan.qty} (보유 ${plan.wantQty}, ${fill.note})` };
    }
    return { action: "hold", detail: "매수 중복 스킵" };
  }

  if (plan.side === "sell") {
    // 부분 익절(라더) 또는 전량 청산. 실현손익은 매도분 × (체결가 − 진입평단). 평단은 부분매도 시 불변.
    const fill = await fillOrder(bot, "sell", plan.qty, price);
    const refAvg = cur?.entryAvg ?? fill.price;
    const realPnl = (fill.price - refAvg) * plan.qty;
    const reason = plan.partial ? "부분 익절(라더)" : "전략 청산";
    const t = store.insertTrade({ bot_id: botId, side: "sell", price: fill.price, qty: plan.qty, pnl: realPnl, is_paper: fill.live ? 0 : 1, reason, idempotency_key: idem("sell") });
    if (t) {
      const next: PaperPosition | null = plan.partial ? { status: "open", entryAvg: refAvg, qty: plan.wantQty, openedAt: cur?.openedAt ?? new Date().toISOString() } : null;
      store.setBotPositionState(botId, next, true, true);
      store.insertLog(botId, "sell", `[${fill.live ? "실거래" : "페이퍼"}] ${reason} -${plan.qty} → 보유 ${plan.wantQty} @ ${fill.price} pnl=${realPnl.toFixed(2)}`);
      return { action: "sell", detail: `${reason} -${plan.qty} (보유 ${plan.wantQty}, pnl=${realPnl.toFixed(2)}, ${fill.note})` };
    }
    return { action: "hold", detail: "매도 중복 스킵" };
  }

  store.setBotPositionState(botId, cur);
  return { action: "hold", detail: curQty > 1e-9 ? `보유중 ${curQty} @ ${price}` : `관망 @ ${price}` };
}

type ScannerPositions = Record<string, PaperPosition>;

/** 최신 봉 시각이 스케줄 hour에 드는지(tz 적용). schedule 없거나 hour 비면 항상 활성. */
function inSchedule(iso: string, schedule?: { hour: number[]; tz?: string }): boolean {
  if (!schedule || !Array.isArray(schedule.hour) || schedule.hour.length === 0) return true;
  const d = new Date(iso);
  const h = schedule.tz
    ? Number(new Intl.DateTimeFormat("en-GB", { timeZone: schedule.tz, hour: "2-digit", hour12: false }).formatToParts(d).find((x) => x.type === "hour")?.value ?? "0") % 24
    : d.getUTCHours();
  return schedule.hour.includes(h);
}

/**
 * 스캐너 봇 1틱: 유니버스 멀티심볼 페치 → 랭킹 → 상위 N → then 전략 평가 → 종목별 페이퍼 진입/청산.
 * 스캐너는 페이퍼 전용(v1) — 멀티심볼 실거래 리스크 회피(정직: 라이브는 단일심볼 봇만). position_state=심볼→포지션 맵.
 */
async function tickScanner(bot: store.BotRow, node: ScannerNode): Promise<{ action: "buy" | "sell" | "hold"; detail: string }> {
  const interval = secsToInterval(bot.interval_seconds);
  const fetched = await Promise.all(node.universe.map(async (sym) => {
    try { const bars = await fetchKlines(sym, interval, 300); return { symbol: sym, bars }; }
    catch { return null; }
  }));
  const entries = fetched.filter((x): x is { symbol: string; bars: Bar[] } => !!x && x.bars.length >= 30);
  const positions: ScannerPositions = (bot.position_state as ScannerPositions | null) || {};
  const held = Object.keys(positions);
  if (entries.length < 2) { store.setBotPositionState(bot.id, positions); return { action: "hold", detail: `유니버스 데이터 부족(${entries.length})` }; }

  const barsOf: Record<string, Bar[]> = {};
  for (const e of entries) barsOf[e.symbol] = e.bars;
  const nowIso = entries[0].bars[entries[0].bars.length - 1].datetime;
  const active = inSchedule(nowIso, node.schedule);

  const ranked = rankUniverse(entries.map((e) => ({ symbol: e.symbol, bars: e.bars as unknown as RankBar[] })), node.rank.metric, node.rank.top, node.rank.order, node.rank.period);
  const topSymbols = ranked.map((r) => r.symbol);
  // 자본 분할: 실제 보유 가능 슬롯 수(top과 유니버스 크기 중 작은 값)로 나눔 — top>유니버스면 과소배분 방지.
  const slots = Math.max(1, Math.min(node.rank.top, node.universe.length));
  const perSymCapital = bot.capital / slots;

  // 보유 + 상위N 종목의 then 전략 평가 → 보유 희망 여부
  const evalSet = new Set<string>([...held, ...topSymbols]);
  const wantHold: Record<string, boolean> = {};
  const priceOf: Record<string, number> = {};
  for (const sym of evalSet) {
    const bars = barsOf[sym];
    if (!bars) { wantHold[sym] = false; continue; } // 데이터 없음 → 청산쪽
    priceOf[sym] = bars[bars.length - 1].close;
    const cfg: BacktestConfig = { strategyId: "scanner", symbol: sym, startDate: bars[0].date, endDate: bars[bars.length - 1].date, initialCapital: perSymCapital, commission: 0.1, timeframe: interval };
    const res = runCompositeBacktest(node.then, bars as unknown as Parameters<typeof runCompositeBacktest>[1], cfg);
    wantHold[sym] = derivePosition(res.trades).holding;
  }

  // 스케줄 비활성: 신규 진입 0 + 보유는 then 청산 신호로만 정리(강제 플랫 아님 — 라이드스루).
  const { toOpen, toClose } = decideScannerActions(topSymbols, held, wantHold, { allowOpen: active, rankExit: active });
  // 멱등키는 각 심볼 자기 봉의 datetime 기준(entries[0] 공유 시각은 선두 심볼 페치 실패 시 비결정적).
  const barIso = (sym: string) => (barsOf[sym]?.[barsOf[sym].length - 1]?.datetime ?? nowIso);
  let opens = 0, closes = 0;
  // 청산 먼저(자본 회수)
  for (const sym of toClose) {
    const pos = positions[sym]; const price = priceOf[sym];
    if (!pos) { delete positions[sym]; continue; }
    if (price === undefined) { store.insertLog(bot.id, "gate", `${sym} 청산 보류(가격 없음, 다음 틱 재시도)`); continue; } // 데이터 부재 → 다음 틱
    const realPnl = (price - pos.entryAvg) * pos.qty;
    const t = store.insertTrade({ bot_id: bot.id, side: "sell", price, qty: pos.qty, pnl: realPnl, is_paper: 1, reason: `스캐너 청산(${sym})`, idempotency_key: `${bot.id}:${sym}:${barIso(sym)}:sell` });
    if (t) { delete positions[sym]; closes++; store.insertLog(bot.id, "sell", `[페이퍼] ${sym} 청산 qty=${pos.qty} @ ${price} pnl=${realPnl.toFixed(2)}`); }
  }
  // 신규 진입
  for (const sym of toOpen) {
    const price = priceOf[sym];
    if (price === undefined || price <= 0) continue;
    const qty = Math.floor(perSymCapital / price);
    if (qty <= 0) continue;
    const t = store.insertTrade({ bot_id: bot.id, side: "buy", price, qty, pnl: 0, is_paper: 1, reason: `스캐너 진입(${sym}, ${node.rank.metric} 상위)`, idempotency_key: `${bot.id}:${sym}:${barIso(sym)}:buy` });
    if (t) { positions[sym] = { status: "open", entryAvg: price, qty, openedAt: new Date().toISOString() }; opens++; store.insertLog(bot.id, "buy", `[페이퍼] ${sym} 진입 qty=${qty} @ ${price}`); }
  }

  store.setBotPositionState(bot.id, positions, true, opens + closes > 0);
  const detail = `랭킹 상위[${topSymbols.join(",") || "-"}] 진입${opens}/청산${closes} 보유[${Object.keys(positions).join(",") || "-"}]${active ? "" : " (스케줄 비활성)"}`;
  return { action: opens > 0 ? "buy" : closes > 0 ? "sell" : "hold", detail };
}

/** 러너 데몬: 가동 봇을 interval마다 tick. graceful shutdown 지원. */
export class Runner {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private alive = true;

  start(botId: string): void {
    const bot = store.getBot(botId);
    if (!bot) return;
    store.setBotStatus(botId, "running");
    if (this.timers.has(botId)) return;
    const run = () => { if (this.alive) tickBot(botId).catch((e) => store.insertLog(botId, "error", String(e instanceof Error ? e.message : e))); };
    run();
    this.timers.set(botId, setInterval(run, Math.max(15, bot.interval_seconds) * 1000));
  }
  stop(botId: string): void {
    const t = this.timers.get(botId); if (t) { clearInterval(t); this.timers.delete(botId); }
    store.setBotStatus(botId, "stopped");
  }
  resumeAll(): void { for (const b of store.listRunningBots()) this.start(b.id); }
  shutdown(): void { this.alive = false; for (const t of this.timers.values()) clearInterval(t); this.timers.clear(); }
}

let _runner: Runner | null = null;
export function runner(): Runner { if (!_runner) _runner = new Runner(); return _runner; }
