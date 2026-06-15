/**
 * bot-handlers.ts — v2 봇/전략 MCP 툴 핸들러(로컬 스토어 + 페이퍼 러너).
 * 에이전트가 전략 조립 → 로컬 봇 생성 → 페이퍼/라이브 실행 → 대시보드. mode=live는 브로커 키 + 마스터스위치 게이트 통과 시 실주문(미통과 시 페이퍼 폴백). 봇 라이브=생성 시 사전승인(주문별 토큰 없음), 라이브 주문 통제는 러너의 게이트/하드리밋/멱등.
 */
import { validateBotRoot } from "../core/validation/composite-node.js";
import * as store from "../store/db.js";
import { runner } from "../runner/runner.js";
import { startDashboard } from "../dashboard/server.js";
import { liveGate, type Broker } from "../brokers/safety.js";
import type { RiskSizingConfig } from "../core/risk/order-sizing.js";
import type { EntryExecution } from "../core/types/strategy.js";

export function saveComposite(a: {
  name: string; tree: unknown; symbol?: string; market?: "spot" | "futures"; leverage?: number;
  stopLossPercent?: number; takeProfitPercent?: number; tpLadder?: unknown; scaleIn?: unknown; pyramid?: unknown; trailingStopPercent?: number;
  // 사이징 모드(opt-in). 리스크 통제(vol_target/atr/kelly) — 알파 아님. 미설정 시 기존 quantityPercent. 엔진·러너 공용(backtest≡live).
  riskSizing?: RiskSizingConfig;
  // 진입 체결(opt-in, audit P1-5). limit=지정가+타임아웃→시장가 폴백. 미설정=시장가. PR-3에서 라이브 배선 + KR/start_bot fail-closed.
  entryExecution?: EntryExecution;
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
    entry_execution: a.entryExecution ?? null,
  });
  return { ok: true, compositeStrategyId: row.id, name: row.name, symbol: row.symbol };
}

export function createBot(a: { name: string; compositeStrategyId: string; symbol?: string; capital?: number; mode?: "paper" | "live"; broker?: Broker; intervalSeconds?: number }) {
  const comp = store.getComposite(a.compositeStrategyId);
  if (!comp) return { ok: false, error: `복합전략 없음: ${a.compositeStrategyId}` };
  const mode = a.mode === "live" ? "live" : "paper";
  const broker: Broker = a.broker || "binance";
  const bot = store.insertBot({
    name: a.name, symbol: a.symbol || comp.symbol, composite_strategy_id: a.compositeStrategyId,
    mode, capital: a.capital ?? 1_000_000, broker, interval_seconds: a.intervalSeconds ?? 60,
  });
  // 라이브 모드면 현재 게이트 상태를 알려줌(실행은 가동 시 게이트가 통제 — 키없으면 페이퍼 폴백).
  let note = "mode=paper. start_bot으로 가동.";
  if (mode === "live") {
    const g = liveGate(broker, "spot");
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
  // 동일 종목+브로커 라이브 봇 중복 가동 차단(audit P1-8): 계좌 보유 귀속이 모호해져 reconcile이 발산한다.
  //   사전 차단(여기) + 런타임 감지 시 자동 정지(runner ambiguous_halt) 이중 방어. 페이퍼는 중복 허용(실계좌 무관).
  if (b.mode === "live") {
    const dup = store.listRunningBots().find((o) => o.id !== b.id && o.mode === "live" && o.broker === b.broker && o.symbol === b.symbol);
    if (dup) return { ok: false, error: `동일 종목(${b.symbol})·브로커(${b.broker}) 라이브 봇이 이미 가동 중(${dup.name}, ${dup.id}) — 계좌 보유 귀속 모호로 발산 위험. 기존 봇을 정지한 뒤 시작하세요.` };
    // weighted 노드 라이브 거절(audit P1-13): 백테는 자식별 자본 분할 시뮬, 라이브 러너는 단일 병합 포지션 실행 —
    //   자본분할 실행 구현 전까지 backtest≡live 위반이므로 silent 실행 금지(fail-closed). 페이퍼는 허용(시뮬 일관).
    const comp = store.getComposite(b.composite_strategy_id);
    const hasWeighted = (node: unknown): boolean => {
      if (!node || typeof node !== "object") return false;
      const n = node as { mode?: string; children?: unknown[] };
      if (n.mode === "weighted") return true;
      return Array.isArray(n.children) ? n.children.some(hasWeighted) : false;
    };
    if (comp && hasWeighted(comp.root_node)) {
      return { ok: false, error: "weighted(자본분할) 모드는 라이브 미지원 — 백테스트는 자식별 자본을 분할하지만 라이브는 단일 포지션으로 실행되어 backtest≡live가 깨집니다(audit P1-13). priority 모드로 바꾸거나 페이퍼로 운용하세요." };
    }
    // 스캐너 봇 라이브 거절(audit P1-23): 멀티심볼 심볼맵에 체결 reconcile이 미구현 → 부분체결/지연체결 시
    //   가짜보유가 거래소와 발산. 조용한 페이퍼 폴백(fail-closed 위반) 대신 명시 거절. 페이퍼는 허용.
    if (comp && (comp.root_node as { type?: string })?.type === "scanner") {
      return { ok: false, error: "스캐너(자동선별) 봇은 라이브 미지원 — 멀티심볼 체결 reconcile 미구현으로 부분체결 시 장부-거래소 발산 위험(audit P1-23). 페이퍼로 운용하거나 단일 종목 봇으로 전환하세요." };
    }
  }
  runner().start(a.botId);
  // 표시 라벨은 봇 mode를 그대로 반영(라이브 봇을 '페이퍼'로 거짓 표기하지 않음). 실제 실주문 여부는 러너의 게이트가 통제.
  const modeLabel = b.mode === "live" ? "라이브(게이트 통과 시 실주문·미통과 시 페이퍼 폴백)" : "페이퍼";
  store.insertLog(a.botId, "start", `[${b.mode}] 봇 가동`);
  return { ok: true, botId: a.botId, status: "running", note: `${Math.max(15, b.interval_seconds)}초마다 평가(${modeLabel}). open_dashboard로 실시간 확인.` };
}

export function stopBot(a: { botId: string }) {
  const b = store.getBot(a.botId);
  if (!b) return { ok: false, error: `봇 없음: ${a.botId}` };
  runner().stop(a.botId);
  store.insertLog(a.botId, "stop", `[${b.mode}] 봇 중지`);
  return { ok: true, botId: a.botId, status: "stopped" };
}

export async function openDashboard(a: { port?: number }) {
  const { url, port } = await startDashboard(a.port);
  return { ok: true, url, port, note: "브라우저에서 열면 봇 포지션 + 실시간 미실현손익(Binance WS). 127.0.0.1 전용, 런치별 토큰." };
}
