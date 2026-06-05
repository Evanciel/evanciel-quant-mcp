/**
 * safety.test.ts — 라이브 머니패스 안전 게이트 검증(네트워크 0, 키 0). 회귀 방지의 핵심.
 * 키 없으면 페이퍼 / 2단계 토큰 fail-closed / 메인넷 마스터스위치 / 하드리밋.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { loadCredentials, liveGate, checkLimits, orderHash, mintToken, consumeToken } from "../src/brokers/safety.js";
import { liveStatus } from "../src/mcp-server/live-handlers.js";

const KEYS = ["BINANCE_ENV", "BINANCE_API_KEY", "BINANCE_API_SECRET", "BINANCE_FUTURES_API_KEY", "BINANCE_FUTURES_API_SECRET", "LIVE_TRADING_ENABLED", "LIVE_MAX_NOTIONAL", "LIVE_SYMBOL_ALLOWLIST", "KIS_ENV", "KIS_APPKEY", "KIS_APPSECRET", "KIS_ACCOUNT"];
beforeEach(() => { for (const k of KEYS) delete process.env[k]; });

describe("safety gate", () => {
  it("키 없으면 자격증명 null + 게이트 차단(페이퍼)", () => {
    expect(loadCredentials("binance")).toBeNull();
    const g = liveGate("binance");
    expect(g.allowed).toBe(false);
    expect(g.env).toBeNull();
  });

  it("live_status: 키 없으면 마스터 OFF + 설정 없음", () => {
    const s = liveStatus();
    expect(s.masterSwitch).toContain("OFF");
    expect(s.configured).toBe("없음(키 미설정 → 전부 페이퍼)");
  });

  it("testnet 키 있으면 즉시 거래 허용(가짜돈)", () => {
    process.env.BINANCE_API_KEY = "k"; process.env.BINANCE_API_SECRET = "s"; // BINANCE_ENV 미설정→testnet 기본
    const g = liveGate("binance");
    expect(g.allowed).toBe(true);
    expect(g.env).toBe("testnet");
  });

  it("메인넷 키지만 마스터 OFF면 차단(fail-safe)", () => {
    process.env.BINANCE_ENV = "live"; process.env.BINANCE_API_KEY = "k"; process.env.BINANCE_API_SECRET = "s";
    const g = liveGate("binance");
    expect(g.allowed).toBe(false); // LIVE_TRADING_ENABLED 미설정
    expect(g.env).toBe("live");
  });

  it("메인넷 키 + 마스터 ON이면 허용", () => {
    process.env.BINANCE_ENV = "live"; process.env.BINANCE_API_KEY = "k"; process.env.BINANCE_API_SECRET = "s"; process.env.LIVE_TRADING_ENABLED = "true";
    expect(liveGate("binance").allowed).toBe(true);
  });

  it("하드리밋: 노셔널 캡 초과 차단", () => {
    process.env.LIVE_MAX_NOTIONAL = "1000";
    expect(checkLimits({ symbol: "BTCUSDT", notional: 5000 }).ok).toBe(false);
    expect(checkLimits({ symbol: "BTCUSDT", notional: 500 }).ok).toBe(true);
  });

  it("하드리밋: 심볼 allowlist", () => {
    process.env.LIVE_SYMBOL_ALLOWLIST = "BTCUSDT,ETHUSDT";
    expect(checkLimits({ symbol: "DOGEUSDT", notional: 1 }).ok).toBe(false);
    expect(checkLimits({ symbol: "BTCUSDT", notional: 1 }).ok).toBe(true);
  });

  it("2단계 토큰: fail-CLOSED (단일사용 + 해시바인딩)", () => {
    const h1 = orderHash({ symbol: "BTCUSDT", side: "buy", qty: 1 });
    const h2 = orderHash({ symbol: "ETHUSDT", side: "buy", qty: 1 });
    const tok = mintToken(h1);
    expect(consumeToken(tok, h2)).toBe(false); // 다른 주문 해시 → 거절
    const tok2 = mintToken(h1);
    expect(consumeToken(tok2, h1)).toBe(true);  // 일치 → 1회 통과
    expect(consumeToken(tok2, h1)).toBe(false); // 재사용 → 거절(단일사용)
    expect(consumeToken("bogus", h1)).toBe(false); // 위조 → 거절
  });

  it("KIS는 mock 기본 + 키 없으면 null", () => {
    expect(loadCredentials("kis")).toBeNull();
    process.env.KIS_APPKEY = "a"; process.env.KIS_APPSECRET = "b"; process.env.KIS_ACCOUNT = "12345678-01";
    const c = loadCredentials("kis");
    expect(c?.env).toBe("mock");
  });
});
