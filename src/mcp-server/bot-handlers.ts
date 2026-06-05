/**
 * bot-handlers.ts — v2 봇/전략 MCP 툴 핸들러(로컬 스토어 + 페이퍼 러너).
 * 에이전트가 전략 조립 → 로컬 봇 생성 → 페이퍼 실행 → 대시보드. 라이브 실행은 v2.5(키+게이트).
 */
import { validateRootNode } from "../core/validation/composite-node.js";
import * as store from "../store/db.js";
import { runner } from "../runner/runner.js";
import { startDashboard } from "../dashboard/server.js";

export function saveComposite(a: {
  name: string; tree: unknown; symbol?: string; market?: "spot" | "futures"; leverage?: number;
  stopLossPercent?: number; takeProfitPercent?: number; tpLadder?: unknown; scaleIn?: unknown; pyramid?: unknown; trailingStopPercent?: number;
}) {
  const err = validateRootNode(a.tree);
  if (err) return { ok: false, error: `검증 실패: ${err}` };
  const row = store.insertComposite({
    name: a.name, root_node: a.tree, symbol: a.symbol || "BTCUSDT",
    market: a.market || "spot", leverage: a.leverage ?? 1,
    stop_loss_percent: a.stopLossPercent ?? null, take_profit_percent: a.takeProfitPercent ?? null,
    tp_ladder: a.tpLadder ?? null, scale_in: a.scaleIn ?? null, pyramid: a.pyramid ?? null,
    trailing_stop_percent: a.trailingStopPercent ?? null,
  });
  return { ok: true, compositeStrategyId: row.id, name: row.name, symbol: row.symbol };
}

export function createBot(a: { name: string; compositeStrategyId: string; symbol?: string; capital?: number; mode?: "paper" | "live"; broker?: string; intervalSeconds?: number }) {
  const comp = store.getComposite(a.compositeStrategyId);
  if (!comp) return { ok: false, error: `복합전략 없음: ${a.compositeStrategyId}` };
  if (a.mode === "live") return { ok: false, error: "라이브 실행은 아직 비활성(v2.5: 브로커 키 + 2단계 확인토큰 + 하드게이트 필요). 현재는 mode=paper만 가능." };
  const bot = store.insertBot({
    name: a.name, symbol: a.symbol || comp.symbol, composite_strategy_id: a.compositeStrategyId,
    mode: "paper", capital: a.capital ?? 1_000_000, broker: a.broker || "binance", interval_seconds: a.intervalSeconds ?? 60,
  });
  store.insertLog(bot.id, "create", `[페이퍼] 봇 생성 — ${bot.name} (${bot.symbol})`);
  return { ok: true, botId: bot.id, name: bot.name, symbol: bot.symbol, mode: bot.mode, status: bot.status, note: "mode=paper. start_bot으로 가동." };
}

export function listBots() {
  return { ok: true, bots: store.listBots().map((b) => ({ id: b.id, name: b.name, symbol: b.symbol, status: b.status, mode: b.mode, capital: b.capital, hasPosition: !!b.position_state, lastEvaluatedAt: b.last_evaluated_at })) };
}

export function getBotStatus(a: { botId: string }) {
  const b = store.getBot(a.botId);
  if (!b) return { ok: false, error: `봇 없음: ${a.botId}` };
  return {
    ok: true, id: b.id, name: b.name, symbol: b.symbol, status: b.status, mode: b.mode, capital: b.capital,
    positionState: b.position_state, lastEvaluatedAt: b.last_evaluated_at, lastExecutedAt: b.last_executed_at,
    recentTrades: store.recentTrades(b.id, 10), recentLogs: store.recentLogs(b.id, 10),
  };
}

export function startBot(a: { botId: string }) {
  const b = store.getBot(a.botId);
  if (!b) return { ok: false, error: `봇 없음: ${a.botId}` };
  runner().start(a.botId);
  store.insertLog(a.botId, "start", "[페이퍼] 봇 가동");
  return { ok: true, botId: a.botId, status: "running", note: `${Math.max(15, b.interval_seconds)}초마다 평가(페이퍼). open_dashboard로 실시간 확인.` };
}

export function stopBot(a: { botId: string }) {
  if (!store.getBot(a.botId)) return { ok: false, error: `봇 없음: ${a.botId}` };
  runner().stop(a.botId);
  store.insertLog(a.botId, "stop", "[페이퍼] 봇 중지");
  return { ok: true, botId: a.botId, status: "stopped" };
}

export async function openDashboard(a: { port?: number }) {
  const { url, port } = await startDashboard(a.port);
  return { ok: true, url, port, note: "브라우저에서 열면 봇 포지션 + 실시간 미실현손익(Binance WS). 127.0.0.1 전용, 런치별 토큰." };
}
