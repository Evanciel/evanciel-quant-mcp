/**
 * kill-switch-telegram.test.ts — 글로벌 킬스위치(audit P1-17) + 텔레그램 원격제어 순수부(P1-14) 회귀.
 */
import { describe, it, expect, afterEach } from "vitest";
import { liveGate } from "../src/brokers/safety.js";
import { parseTelegramCommand, ConfirmGate, loadTelegramConfig } from "../src/core/alerts/telegram.js";

const ENV_KEYS = ["LIVE_TRADING_HALT", "BINANCE_ENV", "BINANCE_API_KEY", "BINANCE_API_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_IDS"];
const saved = new Map<string, string | undefined>();
for (const k of ENV_KEYS) saved.set(k, process.env[k]);
afterEach(() => { for (const k of ENV_KEYS) { const v = saved.get(k); if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

describe("P1-17: LIVE_TRADING_HALT 글로벌 킬스위치", () => {
  it("HALT=true → 키가 있어도(testnet 포함) 게이트 차단", () => {
    process.env.BINANCE_ENV = "testnet";
    process.env.BINANCE_API_KEY = "k".repeat(64);
    process.env.BINANCE_API_SECRET = "s".repeat(64);
    expect(liveGate("binance").allowed).toBe(true); // HALT 없으면 testnet 통과(기존 동작)
    process.env.LIVE_TRADING_HALT = "true";
    const g = liveGate("binance");
    expect(g.allowed).toBe(false);
    expect(g.reason).toContain("킬스위치");
  });

  it("HALT 해제 → 즉시 복귀(매 호출 env 재평가)", () => {
    process.env.BINANCE_ENV = "testnet";
    process.env.BINANCE_API_KEY = "k".repeat(64);
    process.env.BINANCE_API_SECRET = "s".repeat(64);
    process.env.LIVE_TRADING_HALT = "true";
    expect(liveGate("binance").allowed).toBe(false);
    delete process.env.LIVE_TRADING_HALT;
    expect(liveGate("binance").allowed).toBe(true);
  });
});

describe("P1-14: 텔레그램 명령 파싱", () => {
  it("기본 명령 + 봇멘션 접미 허용", () => {
    expect(parseTelegramCommand("/status").kind).toBe("status");
    expect(parseTelegramCommand("/halt@my_bot").kind).toBe("halt");
    expect(parseTelegramCommand("/stop_all").kind).toBe("halt");
    expect(parseTelegramCommand("/forceexit").kind).toBe("forceexit");
    expect(parseTelegramCommand("/confirm 123456")).toEqual({ kind: "confirm", code: "123456" });
  });
  it("미지 입력 → unknown(임의 실행 금지)", () => {
    expect(parseTelegramCommand("sell everything now").kind).toBe("unknown");
    expect(parseTelegramCommand("/confirm").kind).toBe("unknown"); // 코드 없는 confirm
  });
});

describe("P1-14: ConfirmGate 2단계 확인", () => {
  it("발급 코드 일치 + TTL 내 → 액션 반환, 단일사용", () => {
    const g = new ConfirmGate();
    const code = g.mint("forceexit", 1000);
    expect(g.consume(code, 2000)).toBe("forceexit");
    expect(g.consume(code, 2000)).toBeNull(); // 재사용 불가
  });
  it("코드 불일치 → null + 보류 건 소거(브루트포스 방지)", () => {
    const g = new ConfirmGate();
    const code = g.mint("halt", 1000);
    expect(g.consume("000000", 2000)).toBeNull();
    expect(g.consume(code, 2000)).toBeNull(); // 틀린 시도 후엔 재발급부터
  });
  it("TTL(5분) 경과 → null", () => {
    const g = new ConfirmGate();
    const code = g.mint("halt", 0);
    expect(g.consume(code, 5 * 60_000 + 1)).toBeNull();
  });
  it("새 발급이 기존 보류 건 대체(동시 1건)", () => {
    const g = new ConfirmGate();
    const c1 = g.mint("halt", 1000);
    g.mint("forceexit", 2000);
    expect(g.consume(c1, 3000)).toBeNull();
  });
});

describe("P1-14: 설정 fail-closed", () => {
  it("토큰 또는 화이트리스트 없으면 null(루프 비활성)", () => {
    delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_IDS;
    expect(loadTelegramConfig()).toBeNull();
    process.env.TELEGRAM_BOT_TOKEN = "t";
    expect(loadTelegramConfig()).toBeNull(); // 화이트리스트 없음 → 비활성
    process.env.TELEGRAM_CHAT_IDS = "123, 456";
    const cfg = loadTelegramConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.chatIds.has("123")).toBe(true);
    expect(cfg!.chatIds.has("456")).toBe(true);
    expect(cfg!.chatIds.has("789")).toBe(false);
  });
});
