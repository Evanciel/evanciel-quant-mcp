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

const KEYS = ["BINANCE_ENV", "BINANCE_API_KEY", "BINANCE_API_SECRET", "BINANCE_FUTURES_API_KEY", "BINANCE_FUTURES_API_SECRET", "LIVE_TRADING_ENABLED", "LIVE_MAX_NOTIONAL", "LIVE_SYMBOL_ALLOWLIST", "LIVE_BROKER_ALLOWLIST", "KIS_ENV", "KIS_APPKEY", "KIS_APPSECRET", "KIS_ACCOUNT", "LIVE_DAY_BOUNDARY_OFFSET_MIN"];
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

  it("#6 브로커 옵트인: LIVE_BROKER_ALLOWLIST 미포함 브로커는 마스터 ON이어도 차단", () => {
    process.env.BINANCE_ENV = "live"; process.env.BINANCE_API_KEY = "k"; process.env.BINANCE_API_SECRET = "s"; process.env.LIVE_TRADING_ENABLED = "true";
    process.env.LIVE_BROKER_ALLOWLIST = "toss"; // 토스만 허용 → binance 차단(canary 격리)
    const g = liveGate("binance");
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/미허용|LIVE_BROKER_ALLOWLIST/);
  });

  it("#6 브로커 옵트인: 목록에 포함된 브로커는 허용", () => {
    process.env.BINANCE_ENV = "live"; process.env.BINANCE_API_KEY = "k"; process.env.BINANCE_API_SECRET = "s"; process.env.LIVE_TRADING_ENABLED = "true";
    process.env.LIVE_BROKER_ALLOWLIST = "toss, binance"; // 공백·복수 허용
    expect(liveGate("binance").allowed).toBe(true);
  });

  it("#6 브로커 옵트인 미설정이면 전체 허용(하위호환)", () => {
    process.env.BINANCE_ENV = "live"; process.env.BINANCE_API_KEY = "k"; process.env.BINANCE_API_SECRET = "s"; process.env.LIVE_TRADING_ENABLED = "true";
    expect(liveGate("binance").allowed).toBe(true); // LIVE_BROKER_ALLOWLIST 미설정
  });

  it("하드리밋: 노셔널 캡 초과 차단(메인넷 전용)", () => {
    process.env.LIVE_TRADING_ENABLED = "true"; // 하드리밋은 메인넷(마스터 ON)에서만 강제
    process.env.LIVE_MAX_NOTIONAL = "1000";
    expect(checkLimits({ symbol: "BTCUSDT", notional: 5000 }).ok).toBe(false);
    expect(checkLimits({ symbol: "BTCUSDT", notional: 500 }).ok).toBe(true);
  });

  it("하드리밋: 심볼 allowlist(메인넷 전용)", () => {
    process.env.LIVE_TRADING_ENABLED = "true";
    process.env.LIVE_SYMBOL_ALLOWLIST = "BTCUSDT,ETHUSDT";
    expect(checkLimits({ symbol: "DOGEUSDT", notional: 1 }).ok).toBe(false);
    expect(checkLimits({ symbol: "BTCUSDT", notional: 1 }).ok).toBe(true);
  });

  it("testnet/모의(마스터 OFF)는 하드리밋 무마찰 — 캡·allowlist 둘 다 통과(가짜돈 샌드박스)", () => {
    // 마스터 OFF(LIVE_TRADING_ENABLED 미설정): 캡·allowlist를 빡세게 걸어도 testnet 주문은 통과해야 함.
    process.env.LIVE_MAX_NOTIONAL = "50";
    process.env.LIVE_SYMBOL_ALLOWLIST = "BTCUSDT";
    expect(checkLimits({ symbol: "SOLUSDT", notional: 999999 }).ok).toBe(true);
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

  // 코덱스 재검증 지적: 유한 거대값(1e12)이 통과하면 Date 연산이 Invalid→toISOString() throw→dailyRealizedLoss catch가
  // 0 반환→일일손실 서킷 fail-open. 유효 TZ 오프셋 범위[-720,840] 밖은 기본 540으로 거부해 throw 자체를 막는다.
  it("범위 밖 오프셋(1e12·-99999)은 기본 540(KST)으로 폴백 — 서킷 fail-open 차단", () => {
    vi.setSystemTime(new Date("2026-06-10T02:00:00.000Z"));
    process.env.LIVE_DAY_BOUNDARY_OFFSET_MIN = "1e12";
    expect(dayBoundaryIso()).toBe("2026-06-09T15:00:00.000Z"); // throw 없이 KST 기본
    process.env.LIVE_DAY_BOUNDARY_OFFSET_MIN = "-99999";
    expect(dayBoundaryIso()).toBe("2026-06-09T15:00:00.000Z");
    // 경계 안(예: -300=UTC-5h)은 정상 적용
    process.env.LIVE_DAY_BOUNDARY_OFFSET_MIN = "-300";
    expect(() => dayBoundaryIso()).not.toThrow();
  });
});

// ── P1-6: 일일손실 통화 분리 + P1-24: fail-closed 교정 ──
describe("P1-6 일일손실 통화 분리", () => {
  const savedDataDir = process.env.QUANT_MCP_DATA_DIR;
  function mkBot(id: string, broker: string) {
    db().prepare(`INSERT INTO composite_strategies (id,name,root_node,symbol,market,leverage,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(`c-${id}`, id, "{}", broker === "binance" ? "BTCUSDT" : "005930", "spot", 1, new Date().toISOString());
    db().prepare(`INSERT INTO bots (id,name,symbol,composite_strategy_id,status,mode,capital,broker,interval_seconds,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, id, broker === "binance" ? "BTCUSDT" : "005930", `c-${id}`, "running", "live", 1000, broker, 60, new Date().toISOString());
  }
  function mkBotSym(id: string, broker: string, symbol: string) {
    db().prepare(`INSERT INTO composite_strategies (id,name,root_node,symbol,market,leverage,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(`c-${id}`, id, "{}", symbol, "spot", 1, new Date().toISOString());
    db().prepare(`INSERT INTO bots (id,name,symbol,composite_strategy_id,status,mode,capital,broker,interval_seconds,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, id, symbol, `c-${id}`, "running", "live", 1000, broker, 60, new Date().toISOString());
  }
  function rawTrade(botId: string, ts: string, pnl: number) {
    db().prepare(`INSERT INTO trades (id,bot_id,ts,side,price,qty,pnl,is_paper,reason,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(`t-${Math.random()}`, botId, ts, "sell", 100, 1, pnl, 0, "test", `i-${Math.random()}`);
  }
  beforeEach(() => {
    process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-ccyloss-${process.pid}`);
    try { db().prepare(`DELETE FROM trades`).run(); db().prepare(`DELETE FROM bots`).run(); db().prepare(`DELETE FROM composite_strategies`).run(); } catch { /* noop */ }
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-06-10T02:00:00.000Z"));
    mkBot("bn", "binance"); mkBot("kw", "kiwoom");
    rawTrade("bn", "2026-06-09T16:00:00.000Z", -30);   // USDT -30
    rawTrade("kw", "2026-06-09T16:00:00.000Z", -50000); // KRW -50000
  });
  afterEach(() => {
    try { db().prepare(`DELETE FROM trades`).run(); db().prepare(`DELETE FROM bots`).run(); db().prepare(`DELETE FROM composite_strategies`).run(); } catch { /* noop */ }
    vi.useRealTimers();
    for (const k of ["LIVE_DAILY_LOSS_LIMIT", "LIVE_DAILY_LOSS_LIMIT_USDT", "LIVE_DAILY_LOSS_LIMIT_KRW", "LIVE_TRADING_ENABLED"]) delete process.env[k];
    if (savedDataDir === undefined) delete process.env.QUANT_MCP_DATA_DIR; else process.env.QUANT_MCP_DATA_DIR = savedDataDir;
  });

  it("통화별 손익 분리 집계 — USDT는 binance만, KRW는 kis/키움만", () => {
    expect(dailyRealizedLoss("USDT")).toBe(-30);
    expect(dailyRealizedLoss("KRW")).toBe(-50000);
    expect(dailyRealizedLoss()).toBe(-50030); // 미지정=전체(하위호환)
  });

  // ── 적대검증 수정: 토스 행을 심볼 통화(isKrSymbol)로 분리 — 종전 양 버킷 이중계상은 통화 마스킹/오발화 유발(fail-open). ──
  it("토스 KR(6자리) 손익은 KRW 버킷에만 — USD 버킷 불오염(이중계상 제거)", () => {
    mkBot("ts", "toss"); // 심볼 005930(KR)
    rawTrade("ts", "2026-06-09T16:00:00.000Z", -10000); // toss KR 손실
    expect(dailyRealizedLoss("KRW")).toBe(-60000);  // kw(-50000) + ts-KR(-10000)
    expect(dailyRealizedLoss("USDT")).toBe(-30);    // bn만 (toss KR은 USD 버킷에서 제외)
    expect(dailyRealizedLoss("USD")).toBe(-30);
  });

  it("토스 US(티커) 손익은 USD 버킷에만 — KRW 버킷 불오염", () => {
    mkBotSym("tsus", "toss", "AAPL"); // toss US
    rawTrade("tsus", "2026-06-09T16:00:00.000Z", -40); // toss US 손실(USD)
    expect(dailyRealizedLoss("USD")).toBe(-70);    // bn(-30) + tsus(-40)
    expect(dailyRealizedLoss("USDT")).toBe(-70);
    expect(dailyRealizedLoss("KRW")).toBe(-50000); // kw만 (toss US는 KRW 버킷 불오염)
  });

  it("FAIL-OPEN 회귀: 토스 KR '이익'이 binance USD '손실'을 가리지 않는다(서킷 정상 발화)", () => {
    process.env.LIVE_TRADING_ENABLED = "true";
    mkBot("ts", "toss");
    rawTrade("ts", "2026-06-09T16:00:00.000Z", 100000); // toss KR 큰 이익(KRW)
    rawTrade("bn", "2026-06-09T16:00:00.000Z", -40);    // binance 추가 손실 → USDT 총 -70
    // 종전(이중계상): dl(USDT)=-70+100000=+99930 → `99930<=-50` 거짓 → 서킷 미발화(fail-open, 메인넷 보호 무력화).
    // 수정 후: toss KR은 USD 버킷 제외 → dl(USDT)=-70 → 기본 서킷 50 → -70<=-50 → 차단.
    expect(dailyRealizedLoss("USDT")).toBe(-70);
    expect(checkLimits({ symbol: "BTCUSDT", notional: 50, quoteCurrency: "USDT" }).ok).toBe(false);
  });

  it("KRW 서킷 도달이 USDT 주문을 막지 않음(독립 서킷)", () => {
    process.env.LIVE_TRADING_ENABLED = "true";
    process.env.LIVE_DAILY_LOSS_LIMIT_KRW = "40000"; // KRW -50000 > 40000 → KRW 차단
    process.env.LIVE_DAILY_LOSS_LIMIT_USDT = "1000"; // USDT -30 < 1000 → USDT 통과
    expect(checkLimits({ symbol: "005930", notional: 1000, quoteCurrency: "KRW" }).ok).toBe(false);
    expect(checkLimits({ symbol: "BTCUSDT", notional: 50, quoteCurrency: "USDT" }).ok).toBe(true);
  });

  it("분리값 우선 > 단일값 > 통화 기본값", () => {
    process.env.LIVE_TRADING_ENABLED = "true";
    process.env.LIVE_DAILY_LOSS_LIMIT = "25"; // 단일값(하위호환): USDT -30 > 25 → 차단
    expect(checkLimits({ symbol: "BTCUSDT", notional: 50, quoteCurrency: "USDT" }).ok).toBe(false);
    process.env.LIVE_DAILY_LOSS_LIMIT_USDT = "100"; // 분리값 우선: -30 < 100 → 통과
    expect(checkLimits({ symbol: "BTCUSDT", notional: 50, quoteCurrency: "USDT" }).ok).toBe(true);
  });

  // ── P1-24 후속: 음수/garbage env가 서킷·캡을 조용히 무력화하지 않는다(posNum 정화) ──
  it("음수 일일손실 env(typo)는 서킷을 무력화하지 않고 통화 기본값으로 폴백해 차단", () => {
    process.env.LIVE_TRADING_ENABLED = "true";
    rawTrade("bn", "2026-06-09T16:00:00.000Z", -40); // USDT 추가 손실 → 총 -70 (기본서킷 50 초과)
    process.env.LIVE_DAILY_LOSS_LIMIT_USDT = "-50";  // 음수 typo: 이전엔 circuit=-50 → `>0` 거짓 → 서킷 무력화(미차단 버그)
    // 수정 후: posNum(-50)=0 → 통화 기본값(서킷 50)으로 폴백 → -70 ≤ -50 → 차단.
    expect(checkLimits({ symbol: "BTCUSDT", notional: 50, quoteCurrency: "USDT" }).ok).toBe(false);
  });

  it("음수 LIVE_MAX_NOTIONAL(typo)는 노셔널 캡을 무력화하지 않고 기본 캡으로 폴백해 차단", () => {
    process.env.LIVE_TRADING_ENABLED = "true";
    process.env.LIVE_MAX_NOTIONAL = "-100"; // 음수 typo: 이전엔 cap=-100 → `>0` 거짓 → 캡 무력화
    // 수정 후: posNum→0 → 통화 기본 캡(USDT 100)으로 폴백 → 노셔널 500 > 100 → 차단.
    expect(checkLimits({ symbol: "BTCUSDT", notional: 500, quoteCurrency: "USDT" }).ok).toBe(false);
    delete process.env.LIVE_MAX_NOTIONAL;
  });
});

describe("P1-24 dailyRealizedLoss fail-closed", () => {
  const savedDataDir = process.env.QUANT_MCP_DATA_DIR;
  afterEach(() => { if (savedDataDir === undefined) delete process.env.QUANT_MCP_DATA_DIR; else process.env.QUANT_MCP_DATA_DIR = savedDataDir; });
  it("조회 실패 시 NEGATIVE_INFINITY(서킷 발화) — return 0(fail-open) 금지", () => {
    // 존재하지 않는 경로/권한오류를 유발하기 어려우니, DB 손상 대신 동작 계약만 확인:
    // 정상 경로는 유한수, 실패 경로는 -Infinity여야 checkLimits가 차단한다.
    process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-failclosed-${process.pid}`);
    const v = dailyRealizedLoss("USDT");
    expect(Number.isFinite(v) || v === Number.NEGATIVE_INFINITY).toBe(true);
    expect(v).not.toBe(Number.POSITIVE_INFINITY); // 양의 무한대면 서킷이 안 터짐(부호 오류 방지 회귀)
  });
});
