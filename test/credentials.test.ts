/**
 * credentials.test.ts — 자격증명 저장/로드 단일 출처(CLI 마법사 + 대시보드 폼 공유)의 순수/파일 동작.
 * 임시 디렉터리(QUANT_MCP_DATA_DIR)로 격리 → 화이트리스트·마스킹·no-override·즉시반영 검증.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEYS = ["BINANCE_ENV", "BINANCE_API_KEY", "BINANCE_API_SECRET", "BINANCE_FUTURES_API_KEY", "BINANCE_FUTURES_API_SECRET",
  "KIS_ENV", "KIS_APPKEY", "KIS_APPSECRET", "KIS_ACCOUNT", "KIWOOM_ENV", "KIWOOM_APPKEY", "KIWOOM_SECRETKEY", "QUANT_MCP_DATA_DIR",
  "TOSS_ENV", "TOSS_CLIENT_ID", "TOSS_CLIENT_SECRET", "TOSS_ACCOUNT_SEQ",
  "LIVE_TRADING_ENABLED", "LIVE_MAX_NOTIONAL", "LIVE_SYMBOL_ALLOWLIST", "LIVE_DAILY_LOSS_LIMIT",
  "LIVE_BROKER_ALLOWLIST", "QUANT_TICKBOT_MARKET_GATE"];

let dir: string;
function clearEnv() { for (const k of KEYS) delete process.env[k]; }

async function load() {
  // 모듈은 dataDir()를 호출 시점에 평가하므로 재import 불필요.
  return import("../src/setup/credentials.js");
}

beforeEach(() => { clearEnv(); dir = mkdtempSync(join(tmpdir(), "qmc-cred-")); process.env.QUANT_MCP_DATA_DIR = dir; });
afterEach(() => { clearEnv(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

describe("upsertCredentials", () => {
  it("화이트리스트 키만 저장 + 파일 생성 + process.env 즉시 반영", async () => {
    const C = await load();
    const { written, path } = C.upsertCredentials({ BINANCE_API_KEY: "abcd1234", BINANCE_API_SECRET: "secretXYZ9", NOT_A_KEY: "x", EVIL: "y" });
    expect(written.sort()).toEqual(["BINANCE_API_KEY", "BINANCE_API_SECRET"]);
    expect(existsSync(path)).toBe(true);
    expect(process.env.BINANCE_API_KEY).toBe("abcd1234"); // 같은 프로세스 즉시 반영(재시작 불필요)
    expect(process.env.NOT_A_KEY).toBeUndefined(); // 화이트리스트 외 거부
  });

  it("빈 값/undefined는 기존 값 유지(덮어쓰기 안 함)", async () => {
    const C = await load();
    C.upsertCredentials({ BINANCE_API_KEY: "keep-me" });
    const { written } = C.upsertCredentials({ BINANCE_API_KEY: "", BINANCE_API_SECRET: undefined });
    expect(written).toEqual([]);
    expect(process.env.BINANCE_API_KEY).toBe("keep-me");
  });

  it("저장 파일은 평문이지만 chmod 600 의도(POSIX). 값 보존", async () => {
    const C = await load();
    const { path } = C.upsertCredentials({ KIS_APPKEY: "appkey-123", KIS_ACCOUNT: "12345678-01" });
    const body = readFileSync(path, "utf8");
    expect(body).toContain("KIS_APPKEY=appkey-123");
    expect(body).toContain("KIS_ACCOUNT=12345678-01");
  });

  it("줄바꿈/제어문자 인젝션 거부 — 키값으로 라이브 마스터스위치 무단 ON 차단(fail-closed)", async () => {
    const C = await load();
    // 공격: 화이트리스트 통과 키(BINANCE_API_KEY) 값에 개행을 실어 LIVE_TRADING_ENABLED=true를 별도 줄로 주입 시도.
    expect(() => C.upsertCredentials({ BINANCE_API_KEY: "realkey\nLIVE_TRADING_ENABLED=true\nLIVE_MAX_NOTIONAL=999999" })).toThrow();
    expect(() => C.upsertCredentials({ BINANCE_API_SECRET: "x\r\nLIVE_TRADING_ENABLED=true" })).toThrow();
    expect(() => C.upsertCredentials({ KIS_APPKEY: "tab\there" })).toThrow(); // 제어문자(탭)도 거부
    // 거부 후 파일에 주입 줄이 없어야 하고(또는 파일 미생성) 마스터스위치 미오염
    expect(process.env.LIVE_TRADING_ENABLED).toBeUndefined();
    expect(process.env.LIVE_MAX_NOTIONAL).toBeUndefined();
    // 정상값(개행 없음)은 통과
    const { written } = C.upsertCredentials({ BINANCE_API_KEY: "clean-key-1234" });
    expect(written).toEqual(["BINANCE_API_KEY"]);
  });
});

describe("sanitizeCredentialPost (대시보드 /api/credentials 라이브키 차단)", () => {
  it("라이브 무장 키(LIVE_TRADING_ENABLED/캡/allowlist/일일손실)는 드롭 — 브로커 키/ENV만 통과", async () => {
    const C = await load();
    const out = C.sanitizeCredentialPost({
      BINANCE_API_KEY: "k", BINANCE_ENV: "live",
      LIVE_TRADING_ENABLED: "true", LIVE_MAX_NOTIONAL: "9999999", LIVE_SYMBOL_ALLOWLIST: "", LIVE_DAILY_LOSS_LIMIT: "999999",
      num: 1, // 비문자열은 무시
    });
    expect(out).toEqual({ BINANCE_API_KEY: "k", BINANCE_ENV: "live" });
    expect(out.LIVE_TRADING_ENABLED).toBeUndefined();
    expect(out.LIVE_MAX_NOTIONAL).toBeUndefined();
  });
  it("upsert와 결합: 라이브키를 실은 POST는 라이브 마스터스위치를 켜지 못함(권한상승 차단)", async () => {
    const C = await load();
    C.upsertCredentials(C.sanitizeCredentialPost({ BINANCE_API_KEY: "k2", LIVE_TRADING_ENABLED: "true", LIVE_MAX_NOTIONAL: "9999999" }));
    expect(process.env.BINANCE_API_KEY).toBe("k2");
    expect(process.env.LIVE_TRADING_ENABLED).toBeUndefined(); // /api/credentials 경유로는 무장 불가(/api/live 전용)
    expect(process.env.LIVE_MAX_NOTIONAL).toBeUndefined();
  });
});

describe("parseEnvFile", () => {
  it("KEY=VALUE 파싱 + 주석 무시 + 따옴표 제거", async () => {
    const C = await load();
    const p = join(dir, "x.env");
    writeFileSync(p, '# comment\nBINANCE_API_KEY="quoted"\nKIS_ENV=mock\n# KIS_APPKEY=ignored\n');
    const out = C.parseEnvFile(p);
    expect(out.BINANCE_API_KEY).toBe("quoted");
    expect(out.KIS_ENV).toBe("mock");
    expect(out.KIS_APPKEY).toBeUndefined();
  });
  it("없는 파일 → 빈 객체", async () => {
    const C = await load();
    expect(C.parseEnvFile(join(dir, "nope.env"))).toEqual({});
  });
});

describe("loadCredentialsFile (no-override)", () => {
  it("파일값을 주입하되 이미 설정된 env는 안 덮음(MCP 설정 env 우선)", async () => {
    const C = await load();
    C.upsertCredentials({ BINANCE_API_KEY: "from-file", BINANCE_ENV: "testnet" });
    clearEnv(); process.env.QUANT_MCP_DATA_DIR = dir; // 파일은 남고 env만 비움
    process.env.BINANCE_ENV = "live"; // MCP 설정이 이미 줌 → 우선
    const n = C.loadCredentialsFile();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(process.env.BINANCE_API_KEY).toBe("from-file"); // 비어있던 키는 주입
    expect(process.env.BINANCE_ENV).toBe("live"); // 이미 있던 키는 유지
  });
});

describe("enableLive / disableLive (라이브 친화 원스톱)", () => {
  it("enableLive: 마스터 ON만(캡/서킷 미지정 시 미저장 → safety가 통화별 기본 적용)", async () => {
    const C = await load();
    const { written } = C.enableLive();
    expect(written).toContain("LIVE_TRADING_ENABLED");
    expect(process.env.LIVE_TRADING_ENABLED).toBe("true");
    expect(process.env.LIVE_MAX_NOTIONAL).toBeUndefined();   // 통화별 기본은 safety.ts에서(여기 저장 안 함=KRW버그 방지)
    expect(process.env.LIVE_DAILY_LOSS_LIMIT).toBeUndefined();
  });
  it("enableLive(opts): 지정 캡/allowlist만 적용", async () => {
    const C = await load();
    C.enableLive({ maxNotional: "30", allowlist: "BTCUSDT" });
    expect(process.env.LIVE_MAX_NOTIONAL).toBe("30");
    expect(process.env.LIVE_SYMBOL_ALLOWLIST).toBe("BTCUSDT");
  });
  it("disableLive: 마스터 OFF(긴급 정지), 명시 캡은 유지", async () => {
    const C = await load();
    C.enableLive({ maxNotional: "30" });
    C.disableLive();
    expect(process.env.LIVE_TRADING_ENABLED).toBe("false");
    expect(process.env.LIVE_MAX_NOTIONAL).toBe("30");
  });
  it("#6 enableLive: 라이브 전환 시 장운영 게이트(QUANT_TICKBOT_MARKET_GATE) 자동 ON", async () => {
    const C = await load();
    C.enableLive();
    expect(process.env.QUANT_TICKBOT_MARKET_GATE).toBe("1"); // 미설정 시 자동 1
  });
  it("#6 enableLive: 이미 설정된 QUANT_TICKBOT_MARKET_GATE은 보존(덮어쓰지 않음)", async () => {
    const C = await load();
    process.env.QUANT_TICKBOT_MARKET_GATE = "0"; // 명시적으로 꺼둠
    C.enableLive();
    expect(process.env.QUANT_TICKBOT_MARKET_GATE).toBe("0"); // 보존
  });
  it("#6 enableLive(brokerAllowlist): 브로커 옵트인 저장 + 상태표기", async () => {
    const C = await load();
    C.enableLive({ brokerAllowlist: "toss" });
    expect(process.env.LIVE_BROKER_ALLOWLIST).toBe("toss");
    expect(C.liveSettingsStatus().brokerAllowlist).toBe("toss");
    expect(C.liveSettingsStatus().marketGate).toBe(true);
  });
});

describe("checkLimits 통화 인식 안전 기본 캡(KRW 버그 수정)", () => {
  it("USDT 마스터 ON + 캡 미설정 → USDT 기본 캡(100)으로 자동", async () => {
    const S = await import("../src/brokers/safety.js");
    process.env.LIVE_TRADING_ENABLED = "true";
    delete process.env.LIVE_MAX_NOTIONAL;
    expect(S.checkLimits({ symbol: "BTCUSDT", notional: 101, quoteCurrency: "USDT" }).ok).toBe(false);
    expect(S.checkLimits({ symbol: "BTCUSDT", notional: 99, quoteCurrency: "USDT" }).ok).toBe(true);
  });
  it("🐛수정: KRW 봇은 USDT 캡(100) 아닌 KRW 기본 캡(150,000) 적용 → 7만원 주식 1주 통과", async () => {
    const S = await import("../src/brokers/safety.js");
    process.env.LIVE_TRADING_ENABLED = "true";
    delete process.env.LIVE_MAX_NOTIONAL;
    // 삼성전자 1주 ~70,000원: 이전(USDT 50/100 캡)이면 거부됐음 → 이제 KRW 기본 150,000으로 통과
    expect(S.checkLimits({ symbol: "005930", notional: 70000, quoteCurrency: "KRW" }).ok).toBe(true);
    expect(S.checkLimits({ symbol: "005930", notional: 150001, quoteCurrency: "KRW" }).ok).toBe(false);
  });
  it("명시 LIVE_MAX_NOTIONAL은 통화 불문 그대로 적용(사용자 의도 우선)", async () => {
    const S = await import("../src/brokers/safety.js");
    process.env.LIVE_TRADING_ENABLED = "true";
    process.env.LIVE_MAX_NOTIONAL = "200000";
    expect(S.checkLimits({ symbol: "005930", notional: 150000, quoteCurrency: "KRW" }).ok).toBe(true);
  });
  it("마스터 OFF(페이퍼/testnet) + 캡 미설정 → 캡 없음(가짜돈이라 제한 불필요)", async () => {
    const S = await import("../src/brokers/safety.js");
    delete process.env.LIVE_TRADING_ENABLED;
    delete process.env.LIVE_MAX_NOTIONAL;
    expect(S.checkLimits({ symbol: "BTCUSDT", notional: 1e9 }).ok).toBe(true);
  });
});

describe("liveSettingsStatus broker-aware env(#18 — KR-only 메인넷 testnet 오표시 방지)", () => {
  it("설정된 브로커들의 env를 합쳐 표기 — 토스만 live여도 'toss:live'(BINANCE_ENV 단독 오표시 아님)", async () => {
    const C = await load();
    C.upsertCredentials({ TOSS_CLIENT_ID: "tid12345", TOSS_CLIENT_SECRET: "tsec6789", TOSS_ENV: "live" });
    const s = C.liveSettingsStatus();
    expect(s.env).toContain("toss:live");
    expect(s.env).not.toBe("testnet"); // 종전 BINANCE_ENV 단독 폴백 오표시 방지
  });
  it("아무 브로커도 미설정이면 binance 기본(testnet) 폴백", async () => {
    const C = await load();
    expect(C.liveSettingsStatus().env).toBe("testnet");
  });
});

describe("mask / credentialStatus", () => {
  it("mask: 앞2…뒤4, 빈 값은 (none)", async () => {
    const C = await load();
    expect(C.mask("abcdefghij")).toBe("ab…ghij");
    expect(C.mask("")).toBe("(none)");
    expect(C.mask(undefined)).toBe("(none)");
  });
  it("credentialStatus: 시크릿은 마스킹, 키 원문 절대 미반환, 필수 시크릿 있으면 configured", async () => {
    const C = await load();
    C.upsertCredentials({ BINANCE_API_KEY: "supersecretkey123", BINANCE_API_SECRET: "supersecret999", BINANCE_ENV: "testnet" });
    const st = C.credentialStatus();
    expect(st.binance.configured).toBe(true);
    expect(st.binance.fields.BINANCE_API_KEY).toBe("su…y123"); // 마스킹
    expect(st.binance.fields.BINANCE_ENV).toBe("testnet"); // 비시크릿은 원문
    expect(JSON.stringify(st)).not.toContain("supersecretkey123"); // 원문 절대 노출 안 됨
    expect(st.kis.configured).toBe(false);
  });
});
