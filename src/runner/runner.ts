/**
 * runner/runner.ts — 로컬 페이퍼 봇 러너. bot-runner route.ts 평가루프를 standalone으로 이식.
 * core 엔진(runCompositeBacktest) 재사용 → backtest≡live. 페이퍼 가상체결을 스토어에 기록.
 * 라이브 실행은 v2.5(브로커 어댑터 + 2단계 토큰 + 하드게이트)에서. 현재는 paper만.
 */
import type { StrategyNode, BacktestConfig } from "../core/types/strategy.js";
import { runCompositeBacktest } from "../core/backtest/engine.js";
import { fetchKlines, type Bar } from "../data/binance-public.js";
import * as store from "../store/db.js";

export interface PaperPosition { status: "open"; entryAvg: number; qty: number; openedAt: string; }

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

  const interval = "1d"; // v1 분석과 동일 기본; 멀티 타임프레임은 후속
  const data = await fetchKlines(bot.symbol, interval, 300);
  if (data.length < 30) { store.setBotPositionState(botId, bot.position_state); return { action: "hold", detail: `데이터 부족(${data.length})` }; }
  const price = data[data.length - 1].close;

  const cfg: BacktestConfig = { strategyId: "runner", symbol: bot.symbol, startDate: data[0].date, endDate: data[data.length - 1].date, initialCapital: bot.capital, commission: 0.1, timeframe: interval };
  const risk = {
    stopLossPercent: comp.stop_loss_percent, takeProfitPercent: comp.take_profit_percent,
    tpLadder: comp.tp_ladder as never, scaleIn: comp.scale_in as never, pyramid: comp.pyramid as never,
    trailingStopPercent: comp.trailing_stop_percent,
  };
  const res = runCompositeBacktest(comp.root_node as StrategyNode, data as unknown as Parameters<typeof runCompositeBacktest>[1], cfg, 0, risk);
  const want = derivePosition(res.trades);

  const cur = bot.position_state as PaperPosition | null;
  const holding = !!cur && cur.status === "open";
  const idem = (sfx: string) => `${botId}:${data[data.length - 1].date}:${sfx}`;

  // 전이: flat→holding = 페이퍼 진입 / holding→flat = 페이퍼 청산
  if (!holding && want.holding) {
    const qty = want.qty > 0 ? want.qty : Math.max(1, Math.floor(bot.capital / price));
    const t = store.insertTrade({ bot_id: botId, side: "buy", price, qty, pnl: 0, is_paper: 1, reason: "전략 진입", idempotency_key: idem("buy") });
    if (t) { store.setBotPositionState(botId, { status: "open", entryAvg: price, qty, openedAt: new Date().toISOString() } satisfies PaperPosition, true, true); store.insertLog(botId, "buy", `[페이퍼] 진입 qty=${qty} @ ${price}`); return { action: "buy", detail: `진입 ${qty} @ ${price}` }; }
    return { action: "hold", detail: "진입 중복 스킵" };
  }
  if (holding && !want.holding) {
    const pnl = (price - cur!.entryAvg) * cur!.qty;
    const t = store.insertTrade({ bot_id: botId, side: "sell", price, qty: cur!.qty, pnl, is_paper: 1, reason: "전략 청산", idempotency_key: idem("sell") });
    if (t) { store.setBotPositionState(botId, null, true, true); store.insertLog(botId, "sell", `[페이퍼] 청산 qty=${cur!.qty} @ ${price} pnl=${pnl.toFixed(2)}`); return { action: "sell", detail: `청산 pnl=${pnl.toFixed(2)}` }; }
    return { action: "hold", detail: "청산 중복 스킵" };
  }
  store.setBotPositionState(botId, cur);
  return { action: "hold", detail: holding ? `보유중 @ ${price}` : `관망 @ ${price}` };
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
