/**
 * core/alerts/telegram.ts — 텔레그램 양방향 원격 제어(audit P1-14). 데몬 모드 전용.
 *
 * 보안 설계:
 *  - 호스트 고정(api.telegram.org, https) — URL을 외부에서 받지 않으므로 SSRF 면 0.
 *  - chat id 화이트리스트(TELEGRAM_CHAT_IDS, 쉼표구분) **필수** — 미설정이면 루프 자체를 안 띄움(fail-closed).
 *    화이트리스트 밖 발신자의 메시지는 응답 없이 무시(봇 존재 노출 최소화).
 *  - 파괴적 명령(/halt /forceexit /resume)은 2단계 확인 — 6자리 일회용 코드(5분 TTL) 회신 후
 *    /confirm <code> 로만 실행(머니패스 two-step-token과 동일 사상, 오터치·하이재킹 방어).
 *  - 주문 경로 신설 0: 실행부는 runner.emergencyStopAll(내부적으로 fillOrder 안전경로) 주입(핸들러 DI).
 *  - 토큰(TELEGRAM_BOT_TOKEN)은 로그·응답에 절대 미노출.
 */
import { randomInt } from "node:crypto";

const API_HOST = "https://api.telegram.org";
const POLL_TIMEOUT_S = 50;          // getUpdates long-poll
const CONFIRM_TTL_MS = 5 * 60_000;  // 확인 코드 유효시간

export interface TelegramConfig { token: string; chatIds: Set<string> }

/** env에서 설정 로드. 토큰+화이트리스트 둘 다 있어야 활성(없으면 null — 데몬이 루프를 안 띄움). */
export function loadTelegramConfig(): TelegramConfig | null {
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const ids = (process.env.TELEGRAM_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!token || ids.length === 0) return null;
  return { token, chatIds: new Set(ids) };
}

export type TgCommand =
  | { kind: "status" } | { kind: "help" }
  | { kind: "halt" } | { kind: "forceexit" } | { kind: "resume" }
  | { kind: "confirm"; code: string }
  | { kind: "unknown"; raw: string };

/** 명령 파싱(순수). 봇 멘션 접미(@botname) 허용. */
export function parseTelegramCommand(text: string): TgCommand {
  const t = (text || "").trim();
  const m = t.match(/^\/([a-z_]+)(?:@\S+)?(?:\s+(\S+))?/i);
  if (!m) return { kind: "unknown", raw: t };
  const cmd = m[1].toLowerCase();
  if (cmd === "status") return { kind: "status" };
  if (cmd === "help" || cmd === "start") return { kind: "help" };
  if (cmd === "halt" || cmd === "stop_all") return { kind: "halt" };
  if (cmd === "forceexit") return { kind: "forceexit" };
  if (cmd === "resume") return { kind: "resume" };
  if (cmd === "confirm" && m[2]) return { kind: "confirm", code: m[2] };
  return { kind: "unknown", raw: t };
}

/** 파괴적 명령 2단계 확인 게이트(순수 상태기계). 코드=6자리, 단일사용, TTL. */
export class ConfirmGate {
  private pending: { code: string; action: "halt" | "forceexit" | "resume"; at: number } | null = null;
  /** 확인 코드 발급(기존 보류 건은 대체 — 동시 1건만). */
  mint(action: "halt" | "forceexit" | "resume", now = Date.now()): string {
    const code = String(randomInt(100000, 999999));
    this.pending = { code, action, at: now };
    return code;
  }
  /** 코드 소비. 일치+TTL 내면 액션 반환(단일사용 — 즉시 소거), 아니면 null. */
  consume(code: string, now = Date.now()): "halt" | "forceexit" | "resume" | null {
    const p = this.pending;
    this.pending = null; // 성공/실패 무관 소거(브루트포스 방지 — 틀리면 재발급부터)
    if (!p) return null;
    if (now - p.at > CONFIRM_TTL_MS) return null;
    return p.code === code ? p.action : null;
  }
}

/** 메시지 발송(베스트에포트 — 실패는 호출측에 boolean으로만). */
export async function sendTelegram(cfg: TelegramConfig, chatId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_HOST}/bot${cfg.token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch { return false; }
}

/** 전 화이트리스트 채널로 브로드캐스트(경보용 — 데몬 크래시/하트비트). */
export async function broadcastTelegram(cfg: TelegramConfig, text: string): Promise<void> {
  for (const id of cfg.chatIds) await sendTelegram(cfg, id, text);
}

export interface TelegramHandlers {
  status(): Promise<string>;                                  // 봇 현황 요약 텍스트
  haltAll(): Promise<string>;                                 // 전 봇 정지 + HALT (포지션 유지)
  forceExitAll(): Promise<string>;                            // 전 봇 정지 + 라이브 포지션 시장가 청산 + HALT
  resume(): Promise<string>;                                  // HALT 해제(봇 재시작은 수동)
}

/**
 * getUpdates 장기폴링 루프. 반환된 stop()으로 종료. 네트워크 오류는 백오프 후 재시도(루프 비종료).
 * 화이트리스트 밖 메시지는 무응답 무시.
 */
export function startTelegramLoop(cfg: TelegramConfig, handlers: TelegramHandlers, log: (m: string) => void): { stop: () => void } {
  let alive = true;
  let offset = 0;
  const gate = new ConfirmGate();

  const HELP = [
    "quant-mcp 원격 제어:",
    "/status — 봇·포지션 현황",
    "/halt — 전 봇 정지 + 신규 주문 차단(포지션 유지) ⚠️확인 필요",
    "/forceexit — 전 봇 정지 + 라이브 포지션 전량 시장가 청산 ⚠️확인 필요",
    "/resume — 주문 차단 해제(봇 재시작은 대시보드/MCP에서) ⚠️확인 필요",
    "/confirm <코드> — 위 명령 확인 실행(5분 유효)",
  ].join("\n");

  async function handle(chatId: string, text: string): Promise<void> {
    const cmd = parseTelegramCommand(text);
    const reply = (t: string) => sendTelegram(cfg, chatId, t);
    switch (cmd.kind) {
      case "status": await reply(await handlers.status()); return;
      case "help": await reply(HELP); return;
      case "halt": await reply(`⚠️ 전 봇 정지 + 주문 차단. 확인: /confirm ${gate.mint("halt")} (5분 유효)`); return;
      case "forceexit": await reply(`🚨 전 봇 정지 + 라이브 포지션 전량 시장가 청산. 확인: /confirm ${gate.mint("forceexit")} (5분 유효)`); return;
      case "resume": await reply(`주문 차단 해제(HALT 제거). 확인: /confirm ${gate.mint("resume")} (5분 유효)`); return;
      case "confirm": {
        const action = gate.consume(cmd.code);
        if (!action) { await reply("코드 무효/만료 — 명령부터 다시 보내세요(fail-closed)."); return; }
        const out = action === "halt" ? await handlers.haltAll() : action === "forceexit" ? await handlers.forceExitAll() : await handlers.resume();
        await reply(out); return;
      }
      default: await reply(HELP); return;
    }
  }

  (async () => {
    log("telegram: 원격 제어 루프 시작(화이트리스트 " + cfg.chatIds.size + "채널)");
    while (alive) {
      try {
        const res = await fetch(`${API_HOST}/bot${cfg.token}/getUpdates?timeout=${POLL_TIMEOUT_S}&offset=${offset}`, {
          signal: AbortSignal.timeout((POLL_TIMEOUT_S + 10) * 1000),
        });
        if (!res.ok) { await new Promise((r) => setTimeout(r, 5000)); continue; }
        const data = (await res.json()) as { ok?: boolean; result?: Array<{ update_id: number; message?: { chat?: { id?: number | string }; text?: string } }> };
        for (const up of data.result ?? []) {
          offset = Math.max(offset, up.update_id + 1);
          const chatId = String(up.message?.chat?.id ?? "");
          const text = up.message?.text ?? "";
          if (!chatId || !text) continue;
          if (!cfg.chatIds.has(chatId)) continue; // 화이트리스트 밖 — 무응답 무시
          try { await handle(chatId, text); } catch (e) { log(`telegram 명령 처리 오류: ${e instanceof Error ? e.message : e}`); }
        }
      } catch {
        if (alive) await new Promise((r) => setTimeout(r, 5000)); // 네트워크 단절 — 백오프 후 재시도
      }
    }
  })();

  return { stop: () => { alive = false; } };
}
