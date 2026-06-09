/**
 * core/alerts/webhook.ts — Slack/Discord 웹훅 배달(SSRF 하드닝).
 *
 * 보안(BLOCKING): 웹훅 URL은 외부로 HTTP 요청을 발사하는 머니패스급 SSRF 벡터다. 방어:
 *  1) https 강제(평문 금지)  2) 호스트 화이트리스트(Slack/Discord만)  3) IP 리터럴·userinfo·비443포트 거부
 *  4) 경로 형태 검증(slack=/services/, discord=/api/webhooks/)  5) fetch redirect:'error'(내부망 리다이렉트 차단)
 *  6) 전송 직전 재검증(TOCTOU)  7) 타임아웃(AbortController)  8) URL 자체를 시크릿 취급(로깅·에코 0).
 * 화이트리스트 밖 호스트(사내 IP/메타데이터 169.254.169.254 등)는 구조적으로 도달 불가.
 */
import type { AlertEvent } from "./alerts.js";

/** 허용 웹훅 호스트(정확 일치, 소문자). 와일드카드·서브도메인 매칭 없음. */
const ALLOWED_HOSTS = new Set<string>([
  "hooks.slack.com",
  "discord.com",
  "discordapp.com",
  "canary.discord.com",
  "ptb.discord.com",
]);

export type WebhookKind = "slack" | "discord";
export interface WebhookValidation {
  ok: boolean;
  url?: string;
  host?: string;
  kind?: WebhookKind;
  error?: string;
}

/** 웹훅 URL 검증(SSRF 게이트). 통과 시 정규화된 url + 종류 반환. 실패 시 사유(값 미포함). */
export function validateWebhookUrl(raw: string): WebhookValidation {
  const s = (raw || "").trim();
  if (!s) return { ok: false, error: "빈 URL" };
  let u: URL;
  try { u = new URL(s); } catch { return { ok: false, error: "URL 파싱 실패" }; }
  if (u.protocol !== "https:") return { ok: false, error: "https만 허용(평문 거부)" };
  if (u.username || u.password) return { ok: false, error: "URL userinfo 금지" };
  if (u.port && u.port !== "443") return { ok: false, error: "443 외 포트 금지" };
  const host = u.hostname.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host === "localhost") {
    return { ok: false, error: "IP 리터럴/로컬호스트 금지" };
  }
  if (!ALLOWED_HOSTS.has(host)) return { ok: false, error: `허용되지 않은 호스트(${host}) — Slack/Discord만 가능` };
  const kind: WebhookKind = host === "hooks.slack.com" ? "slack" : "discord";
  // 경로 형태 방어(웹훅 엔드포인트만)
  if (kind === "slack" && !u.pathname.startsWith("/services/")) return { ok: false, error: "Slack 웹훅 경로 아님(/services/)" };
  if (kind === "discord" && !/\/api\/webhooks\//.test(u.pathname)) return { ok: false, error: "Discord 웹훅 경로 아님(/api/webhooks/)" };
  return { ok: true, url: u.toString(), host, kind };
}

/** 알림 배열 → Slack/Discord 페이로드. 길이 캡(디스코드 2000자). */
export function formatPayload(events: AlertEvent[], kind: WebhookKind): Record<string, unknown> {
  const icon = (l: string) => (l === "critical" ? "🔴" : l === "warn" ? "🟡" : "🟢");
  const text = events.map((e) => `${icon(e.level)} [${e.kind}] ${e.message}`).join("\n").slice(0, 1900) || "(빈 알림)";
  return kind === "slack" ? { text } : { content: text };
}

export interface SendOptions {
  timeoutMs?: number;
  fetch?: typeof fetch; // 테스트 주입
}

/** 웹훅 발사(SSRF 게이트 + redirect 차단 + 타임아웃). URL/본문은 로깅하지 않는다. */
export async function sendWebhook(rawUrl: string, events: AlertEvent[], opts?: SendOptions): Promise<{ ok: boolean; status?: number; error?: string }> {
  const v = validateWebhookUrl(rawUrl); // 전송 직전 재검증(TOCTOU)
  if (!v.ok || !v.url || !v.kind) return { ok: false, error: v.error || "검증 실패" };
  if (events.length === 0) return { ok: false, error: "보낼 알림 없음" };
  const body = JSON.stringify(formatPayload(events, v.kind));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 5000);
  try {
    const fetchImpl = opts?.fetch ?? fetch;
    const res = await fetchImpl(v.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      redirect: "error", // SSRF: 내부망으로의 리다이렉트 차단
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "전송 실패" };
  } finally {
    clearTimeout(t);
  }
}
