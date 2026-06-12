/**
 * daemon.ts — MCP stdio와 분리된 24/7 헤드리스 데몬(audit P0-2).
 *
 * 종전: 봇 생존이 MCP stdio 프로세스(=Claude/Cursor 클라이언트 세션)에 종속 — 클라이언트를 닫으면 봇도 죽음.
 * 이 엔트리는 러너 + 대시보드 + (옵션) 텔레그램 원격제어만 띄운다. MCP 클라이언트 불필요.
 *
 * 실행: npm run daemon  (Docker: Dockerfile 참조 — restart:always + /healthz HEALTHCHECK)
 * 관측성(audit P1-15):
 *  - uncaughtException/unhandledRejection → 웹훅+텔레그램 critical 경보 발사 후 exit(1)
 *    (이어붙이기 금지 — 상태 불명 프로세스로 거래 계속하면 더 위험. Docker restart가 재기동,
 *     기동 시드(P0-1)가 포지션 복원).
 *  - ALERT_HEARTBEAT_MINUTES 설정 시 주기 하트비트 발신(채널 침묵 = 데몬 사망 신호).
 *  - 대시보드 /healthz(무인증·민감정보 0) → Docker HEALTHCHECK.
 */
import { loadCredentialsFile } from "./setup/credentials.js";
import { runner, emergencyStopAll } from "./runner/runner.js";
import { startDashboard } from "./dashboard/server.js";
import { sendWebhook } from "./core/alerts/webhook.js";
import { loadTelegramConfig, startTelegramLoop, broadcastTelegram, type TelegramHandlers } from "./core/alerts/telegram.js";
import * as store from "./store/db.js";
import { audit } from "./brokers/safety.js";

const log = (m: string) => console.log(`[daemon] ${new Date().toISOString()} ${m}`);

/** critical 경보 — 웹훅(설정 시) + 텔레그램(설정 시) 양쪽 베스트에포트. */
async function alertCritical(message: string): Promise<void> {
  const ev = { id: `daemon-${Date.now()}`, ts: new Date().toISOString(), level: "critical" as const, kind: "daemon", message };
  const url = (process.env.ALERT_WEBHOOK_URL ?? "").trim();
  if (url) await sendWebhook(url, [ev]).catch(() => {});
  const tg = loadTelegramConfig();
  if (tg) await broadcastTelegram(tg, `🚨 ${message}`).catch(() => {});
}

function statusText(): string {
  const bots = store.listBots();
  const running = bots.filter((b) => b.status === "running");
  const lines = running.map((b) => {
    const ps = b.position_state as { status?: string; qty?: number; entryAvg?: number; live?: boolean } | null;
    const pos = ps?.status === "open" ? `보유 ${ps.qty} @ ${ps.entryAvg}${ps.live ? " [라이브]" : " [페이퍼]"}` : "무포지션";
    return `· ${b.name} (${b.symbol}, ${b.mode}) — ${pos}`;
  });
  const halt = (process.env.LIVE_TRADING_HALT || "").trim() === "true";
  return [`가동 ${running.length}/${bots.length}봇${halt ? " · 🚫 HALT(주문 차단 중)" : ""}`, ...lines].join("\n") || "봇 없음";
}

async function main(): Promise<void> {
  const n = loadCredentialsFile();
  if (n > 0) log(`credentials.env에서 ${n}개 자격증명 로드`);

  // 러너(봇 재개 + 24h 백업 타이머) + 대시보드(/healthz 포함)
  runner().resumeAll();
  const port = parseInt((process.env.QUANT_MCP_DASHBOARD_PORT || "7788").trim(), 10) || 7788;
  const dash = await startDashboard(port);
  log(`대시보드: ${dash.url}`);
  log(`헬스체크: http://127.0.0.1:${dash.port}/healthz`);
  log(`가동 봇: ${store.listRunningBots().length}개 (MCP 클라이언트 불필요 — 24/7 헤드리스)`);

  // 텔레그램 원격 제어(옵션 — TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_IDS 둘 다 있어야 활성)
  const tg = loadTelegramConfig();
  let tgLoop: { stop: () => void } | null = null;
  if (tg) {
    const handlers: TelegramHandlers = {
      async status() { return statusText(); },
      async haltAll() {
        const r = await emergencyStopAll(); // 정지만(포지션 유지)
        process.env.LIVE_TRADING_HALT = "true"; // 청산 없으니 즉시 차단 가능
        audit({ event: "remote_halt", via: "telegram", stopped: r.stopped });
        return `🚫 전 봇 정지(${r.stopped}개) + 주문 차단(HALT). 포지션은 유지 — 상주 손절(Binance)만 동작.`;
      },
      async forceExitAll() {
        const r = await emergencyStopAll({ closePositions: true }); // 청산 먼저(HALT 전 — 게이트에 안 막히게)
        process.env.LIVE_TRADING_HALT = "true";
        audit({ event: "remote_forceexit", via: "telegram", ...r });
        return `🚨 전 봇 정지(${r.stopped}) · 청산 ${r.closed}건${r.failed ? ` · ⚠️ 실패 ${r.failed}건(거래소 수동 확인 필요)` : ""} · 주문 차단(HALT).`;
      },
      async resume() {
        delete process.env.LIVE_TRADING_HALT;
        audit({ event: "remote_resume", via: "telegram" });
        return "✅ 주문 차단 해제. 봇 재시작은 대시보드/MCP(start_bot)에서.";
      },
    };
    tgLoop = startTelegramLoop(tg, handlers, log);
    await broadcastTelegram(tg, `🟢 quant-mcp 데몬 기동 — ${statusText()}`);
  } else {
    log("telegram: 미설정(TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_IDS) — 원격 제어 비활성");
  }

  // 하트비트(옵션): 채널 침묵 = 데몬 사망 신호(데드맨 스위치의 정직한 최소 구현 — 외부 워치독은 Docker HEALTHCHECK).
  const hbMin = parseInt((process.env.ALERT_HEARTBEAT_MINUTES || "").trim(), 10);
  if (Number.isFinite(hbMin) && hbMin >= 5) {
    const t = setInterval(() => {
      const msg = `💓 quant-mcp 하트비트 — ${statusText()}`;
      if (tg) void broadcastTelegram(tg, msg);
      log("heartbeat 발신");
    }, hbMin * 60_000);
    t.unref?.();
  }

  // 미처리 예외/거부(audit P1-15): 침묵 사망 금지 — 경보 후 exit(1) → Docker restart가 재기동.
  const fatal = (kind: string) => async (e: unknown) => {
    const msg = `quant-mcp 데몬 ${kind}: ${e instanceof Error ? e.message : String(e)} — 프로세스 재시작(포지션은 기동 시드가 복원)`;
    log(`FATAL ${msg}`);
    try { audit({ event: "daemon_fatal", kind, error: e instanceof Error ? e.message : String(e) }); } catch { /* 감사 실패가 경보를 막지 않게 */ }
    await alertCritical(msg).catch(() => {});
    process.exit(1);
  };
  process.on("uncaughtException", (e) => { void fatal("uncaughtException")(e); });
  process.on("unhandledRejection", (e) => { void fatal("unhandledRejection")(e); });

  const shutdown = () => {
    log("graceful shutdown");
    tgLoop?.stop();
    runner().shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error(`[daemon] 기동 실패: ${e instanceof Error ? e.message : e}`); process.exit(1); });
