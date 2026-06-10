/**
 * bot-handlers.ts — v2 봇/전략 MCP 툴 핸들러(로컬 스토어 + 페이퍼 러너).
 * 에이전트가 전략 조립 → 로컬 봇 생성 → 페이퍼 실행 → 대시보드. 라이브 실행은 v2.5(키+게이트).
 */
import { validateBotRoot } from "../core/validation/composite-node.js";
import * as store from "../store/db.js";
import { runner } from "../runner/runner.js";
import { startDashboard } from "../dashboard/server.js";
import { liveGate, type Broker } from "../brokers/safety.js";
import type { RiskSizingConfig } from "../core/risk/order-sizing.js";

export function saveComposite(a: {
  name: string; tree: unknown; symbol?: string; market?: "spot" | "futures"; leverage?: number;
  stopLossPercent?: number; takeProfitPercent?: number; tpLadder?: unknown; scaleIn?: unknown; pyramid?: unknown; trailingStopPercent?: number;
  // 사이징 모드(opt-in). 리스크 통제(vol_target/atr/kelly) — 알파 아님. 미설정 시 기존 quantityPercent. 엔진·러너 공용(backtest≡live).
  riskSizing?: RiskSizingConfig;
}) {
  const err = validateBotRoot(a.tree); // scanner 노드도 허용(validateScannerNode 분기)
  if (err) return { ok: false, error: `검증 실패: ${err}` };
  const row = store.insertComposite({
    name: a.name, root_node: a.tree, symbol: a.symbol || "BTCUSDT",
    market: a.market || "spot", leverage: a.leverage ?? 1,
    stop_loss_percent: a.stopLossPercent ?? null, take_profit_percent: a.takeProfitPercent ?? null,
    tp_ladder: a.tpLadder ?? null, scale_in: a.scaleIn ?? null, pyramid: a.pyramid ?? null,
    trailing_stop_percent: a.trailingStopPercent ?? null,
    risk_sizing: a.riskSizing ?? null,
  });
  return { ok: true, compositeStrategyId: row.id, name: row.name, symbol: row.symbol };
}

export function createBot(a: { name: string; compositeStrategyId: string; symbol?: string; capital?: number; mode?: "paper" | "live"; broker?: string; intervalSeconds?: number }) {
  const comp = store.getComposite(a.compositeStrategyId);
  if (!comp) return { ok: false, error: `복합전략 없음: ${a.compositeStrategyId}` };
  const mode = a.mode === "live" ? "live" : "paper";
  const broker = a.broker || "binance";
  const bot = store.insertBot({
    name: a.name, symbol: a.symbol || comp.symbol, composite_strategy_id: a.compositeStrategyId,
    mode, capital: a.capital ?? 1_000_000, broker, interval_seconds: a.intervalSeconds ?? 60,
  });
  // 라이브 모드면 현재 게이트 상태를 알려줌(실행은 가동 시 게이트가 통제 — 키없으면 페이퍼 폴백).
  let note = "mode=paper. start_bot으로 가동.";
  if (mode === "live") {
    const g = liveGate(broker as Broker, "spot");
    note = g.allowed ? `mode=live — ${g.reason} start_bot 시 실주문(하드리밋 적용).` : `mode=live지만 ${g.reason} start_bot해도 게이트 통과 전엔 페이퍼 폴백. SETUP-LIVE.md로 키/스위치 설정.`;
  }
  store.insertLog(bot.id, "create", `[${mode}] 봇 생성 — ${bot.name} (${bot.symbol})`);
  return { ok: true, botId: bot.id, name: bot.name, symbol: bot.symbol, mode: bot.mode, status: bot.status, note };
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
