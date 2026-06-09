/**
 * webhook.test.ts — 웹훅 SSRF 게이트 + 배달 검증.
 * 핵심: 화이트리스트 밖/평문/IP/리다이렉트는 구조적으로 차단(over-reject, never over-permit).
 */
import { describe, it, expect, vi } from "vitest";
import { validateWebhookUrl, formatPayload, sendWebhook } from "../src/core/alerts/webhook.js";
import type { AlertEvent } from "../src/core/alerts/alerts.js";

const ev = (over: Partial<AlertEvent> = {}): AlertEvent => ({ id: "1", ts: "2026-06-09T00:00:00Z", level: "info", kind: "trade_closed", message: "테스트", ...over });

describe("validateWebhookUrl (SSRF 게이트)", () => {
  it("정상 Slack 웹훅 통과", () => {
    const v = validateWebhookUrl("https://hooks.slack.com/services/T000/B000/XXXX");
    expect(v.ok).toBe(true);
    expect(v.kind).toBe("slack");
  });

  it("정상 Discord 웹훅 통과", () => {
    const v = validateWebhookUrl("https://discord.com/api/webhooks/123/abcdef");
    expect(v.ok).toBe(true);
    expect(v.kind).toBe("discord");
  });

  it("http(평문) 거부", () => {
    expect(validateWebhookUrl("http://hooks.slack.com/services/x").ok).toBe(false);
  });

  it("IP 리터럴 거부(SSRF 핵심)", () => {
    expect(validateWebhookUrl("https://169.254.169.254/latest/meta-data").ok).toBe(false);
    expect(validateWebhookUrl("https://127.0.0.1/services/x").ok).toBe(false);
  });

  it("localhost 거부", () => {
    expect(validateWebhookUrl("https://localhost/services/x").ok).toBe(false);
  });

  it("화이트리스트 밖 호스트 거부", () => {
    expect(validateWebhookUrl("https://evil.com/services/x").ok).toBe(false);
    expect(validateWebhookUrl("https://hooks.slack.com.evil.com/services/x").ok).toBe(false);
  });

  it("userinfo 포함 거부", () => {
    expect(validateWebhookUrl("https://user:pass@hooks.slack.com/services/x").ok).toBe(false);
  });

  it("비443 포트 거부", () => {
    expect(validateWebhookUrl("https://hooks.slack.com:8080/services/x").ok).toBe(false);
  });

  it("웹훅 경로 형태 강제(엉뚱한 경로 거부)", () => {
    expect(validateWebhookUrl("https://hooks.slack.com/wrong").ok).toBe(false);
    expect(validateWebhookUrl("https://discord.com/wrong").ok).toBe(false);
  });

  it("빈/깨진 URL 거부", () => {
    expect(validateWebhookUrl("").ok).toBe(false);
    expect(validateWebhookUrl("not a url").ok).toBe(false);
  });
});

describe("formatPayload", () => {
  it("slack=text, discord=content", () => {
    expect(formatPayload([ev()], "slack")).toHaveProperty("text");
    expect(formatPayload([ev()], "discord")).toHaveProperty("content");
  });
  it("길이 캡(1900자)", () => {
    const many = Array.from({ length: 200 }, () => ev({ message: "x".repeat(50) }));
    const p = formatPayload(many, "discord") as { content: string };
    expect(p.content.length).toBeLessThanOrEqual(1900);
  });
});

describe("sendWebhook", () => {
  it("검증 실패 URL은 fetch 호출 없이 거부", async () => {
    const spy = vi.fn();
    const r = await sendWebhook("https://evil.com/x", [ev()], { fetch: spy as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("빈 이벤트 거부", async () => {
    const spy = vi.fn();
    const r = await sendWebhook("https://hooks.slack.com/services/x", [], { fetch: spy as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("정상 전송 시 redirect:'error' + POST", async () => {
    const spy = vi.fn(async (_u: string, _init?: RequestInit) => ({ ok: true, status: 204 }) as Response);
    const r = await sendWebhook("https://hooks.slack.com/services/T/B/X", [ev()], { fetch: spy as unknown as typeof fetch });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(204);
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
  });

  it("fetch 예외는 ok:false로 흡수(크래시 없음)", async () => {
    const spy = vi.fn(async () => { throw new Error("network"); });
    const r = await sendWebhook("https://hooks.slack.com/services/T/B/X", [ev()], { fetch: spy as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("network");
  });
});
