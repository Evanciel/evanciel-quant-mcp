/**
 * safety.test.ts — 라이브 머니패스 안전 게이트 검증(네트워크 0, 키 0). 회귀 방지의 핵심.
 * 키 없으면 페이퍼 / 2단계 토큰 fail-closed / 메인넷 마스터스위치 / 하드리밋.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { loadCredentials, liveGate, checkLimits, orderHash, mintToken, consumeToken, audit, auditFailureCount, dayBoundaryIso, dailyRealizedLoss } from "../src/brokers/safety.js";
import { liveStatus } from "../src/mcp-server/live-handlers.js";
import { db } from "../src/store/db.js";

const KEYS = ["BINANCE_ENV", "BINANCE_API_KEY", "BINANCE_API_SECRET", "BINANCE_FUTURES_API_KEY", "BINANCE_FUTURES_API_SECRET", "LIVE_TRADING_ENABLED", "LIVE_MAX_NOTIONAL", "LIVE_SYMBOL_ALLOWLIST", "KIS_ENV", "KIS_APPKEY", "KIS_APPSECRET", "KIS_ACCOUNT", "LIVE_DAY_BOUNDARY_OFFSET_MIN"];
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

// ── B1: audit() fail-closed(비-silent) 회귀 ──
// 검증: 쓰기 실패가 noop이 아니라 카운터 증가 + stderr 경고로 '크게 알린다'. 단, throw로 거래를 끊지 않는다(가용성).
describe("audit fail-closed(비-silent, 비-throw)", () => {
  const savedDataDir = process.env.QUANT_MCP_DATA_DIR;
  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.QUANT_MCP_DATA_DIR;
    else process.env.QUANT_MCP_DATA_DIR = savedDataDir;
    vi.restoreAllMocks();
  });

  // dataDir()을 '정규 파일 하위 경로'로 지정 → appendFileSync(join(dir,'audit.jsonl'))가 ENOTDIR/ENOENT throw.
  // (node:fs mock 금지: db.ts의 mkdirSync까지 오염시키므로. 경로 트릭이 가장 격리적·OS 독립.)
  function pointAuditAtUnwritablePath() {
    const base = mkdtempSync(join(tmpdir(), "quant-mcp-auditfail-"));
    const fileNotDir = join(base, "iam-a-file");
    writeFileSync(fileNotDir, "x"); // 파일 생성 → 이걸 디렉토리처럼 join하면 쓰기 불가
    process.env.QUANT_MCP_DATA_DIR = fileNotDir; // audit은 join(fileNotDir,'audit.jsonl')에 쓰려다 실패
  }

  it("쓰기 실패 시 카운터 증가(noop 아님) + throw 안 함", () => {
    pointAuditAtUnwritablePath();
    const before = auditFailureCount();
    expect(() => audit({ event: "test_fail" })).not.toThrow(); // 가용성: 거래를 끊지 않음
    expect(auditFailureCount()).toBe(before + 1); // 침묵이 아님(카운터 증가로 증명)
  });

  it("쓰기 실패 시 stderr에 AUDIT-FAIL 경고 1회", () => {
    pointAuditAtUnwritablePath();
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    audit({ event: "test_warn" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain("AUDIT-FAIL");
  });

  it("쓰기 성공 시 카운터 불변(회귀 가드)", () => {
    // 정상 쓰기 가능한 임시 디렉토리(기본 동작). 카운터가 오르면 안 됨.
    process.env.QUANT_MCP_DATA_DIR = mkdtempSync(join(tmpdir(), "quant-mcp-auditok-"));
    const before = auditFailureCount();
    expect(() => audit({ event: "ok" })).not.toThrow();
    expect(auditFailureCount()).toBe(before); // 성공 경로는 카운터 불변
  });
});

// ── B2: dailyRealizedLoss() KST 일경계 회귀 ──
// 검증: '하루' 경계가 UTC 자정이 아니라 KST(+09:00) 자정(=전날 15:00:00.000Z) 기준. env로 override 가능.
describe("dailyRealizedLoss KST 일경계", () => {
  const savedDataDir = process.env.QUANT_MCP_DATA_DIR;
  // ts를 강제 제어해 raw 삽입(insertTrade는 ts=now()로 덮어쓰므로 테스트 전용 raw INSERT 사용).
  function insertRawTrade(ts: string, pnl: number, isPaper = 0) {
    db().prepare(`INSERT INTO trades (id,bot_id,ts,side,price,qty,pnl,is_paper,reason,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(`id-${ts}-${Math.random()}`, "b-kst", ts, "sell", 100, 1, pnl, isPaper, "test", `idem-${ts}-${Math.random()}`);
  }
  beforeEach(() => {
    // 격리 스토어(이 describe 전용). 첫 db() 호출 전에 설정해야 하나, 다른 describe가 이미 _db를 잡았을 수 있어
    // 새 프로세스가 아니면 같은 store.db를 공유 → 충돌 방지 위해 매 테스트 trades를 비움.
    process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-kst-${process.pid}`);
    try { db().prepare(`DELETE FROM trades`).run(); } catch { /* 테이블 없으면 무시 */ }
    vi.useFakeTimers();
  });
  afterEach(() => {
    try { db().prepare(`DELETE FROM trades`).run(); } catch { /* noop */ }
    vi.useRealTimers();
    if (savedDataDir === undefined) delete process.env.QUANT_MCP_DATA_DIR;
    else process.env.QUANT_MCP_DATA_DIR = savedDataDir;
  });

  it("기본 경계 = KST 자정(전날 15:00:00.000Z), UTC 자정과 다름", () => {
    // 2026-06-10T02:00:00Z = UTC 6/10 02:00 = KST 6/10 11:00 → KST '오늘'의 시작 = 6/9 15:00:00.000Z
    vi.setSystemTime(new Date("2026-06-10T02:00:00.000Z"));
    expect(dayBoundaryIso()).toBe("2026-06-09T15:00:00.000Z");
  });

  it("UTC였다면 제외됐을 거래(6/9 16:00Z)를 KST 경계는 포함 → 합산이 달라짐", () => {
    vi.setSystemTime(new Date("2026-06-10T02:00:00.000Z"));
    insertRawTrade("2026-06-09T14:00:00.000Z", -100); // KST 경계(6/9T15:00Z) '이전' → 제외
    insertRawTrade("2026-06-09T16:00:00.000Z", -50);  // KST 경계 '이후' → 포함(UTC자정이었다면 6/9라 제외됐을 것)
    expect(dailyRealizedLoss()).toBe(-50); // UTC 자정 기준이었다면 0
  });

  it("페이퍼 거래(is_paper=1)는 서킷 합산에서 제외", () => {
    vi.setSystemTime(new Date("2026-06-10T02:00:00.000Z"));
    insertRawTrade("2026-06-09T16:00:00.000Z", -50, 0); // 라이브
    insertRawTrade("2026-06-09T17:00:00.000Z", -999, 1); // 페이퍼 → 제외
    expect(dailyRealizedLoss()).toBe(-50);
  });

  it("env override=0(UTC 자정)이면 위 두 거래 모두 제외(=0)", () => {
    process.env.LIVE_DAY_BOUNDARY_OFFSET_MIN = "0"; // UTC 자정으로 회귀
    vi.setSystemTime(new Date("2026-06-10T02:00:00.000Z"));
    expect(dayBoundaryIso()).toBe("2026-06-10T00:00:00.000Z");
    insertRawTrade("2026-06-09T14:00:00.000Z", -100);
    insertRawTrade("2026-06-09T16:00:00.000Z", -50);
    expect(dailyRealizedLoss()).toBe(0); // 둘 다 UTC 6/9 → 6/10 경계 이전 → 제외
  });

  it("빈 문자열/비유한수 override는 기본 540(KST)으로 폴백", () => {
    vi.setSystemTime(new Date("2026-06-10T02:00:00.000Z"));
    process.env.LIVE_DAY_BOUNDARY_OFFSET_MIN = "";
    expect(dayBoundaryIso()).toBe("2026-06-09T15:00:00.000Z");
    process.env.LIVE_DAY_BOUNDARY_OFFSET_MIN = "abc";
    expect(dayBoundaryIso()).toBe("2026-06-09T15:00:00.000Z");
  });
});
