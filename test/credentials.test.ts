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
  "LIVE_TRADING_ENABLED", "LIVE_MAX_NOTIONAL", "LIVE_SYMBOL_ALLOWLIST", "LIVE_DAILY_LOSS_LIMIT"];

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
  it("enableLive: 마스터 ON + 안전 기본값(캡50/서킷50) 자동 채움, process.env 즉시 반영", async () => {
    const C = await load();
    const { written } = C.enableLive();
    expect(written).toContain("LIVE_TRADING_ENABLED");
    expect(process.env.LIVE_TRADING_ENABLED).toBe("true");
    expect(process.env.LIVE_MAX_NOTIONAL).toBe(C.LIVE_DEFAULTS.LIVE_MAX_NOTIONAL);
    expect(process.env.LIVE_DAILY_LOSS_LIMIT).toBe(C.LIVE_DEFAULTS.LIVE_DAILY_LOSS_LIMIT);
  });
  it("enableLive(opts): 지정 캡/allowlist 적용", async () => {
    const C = await load();
    C.enableLive({ maxNotional: "30", allowlist: "BTCUSDT" });
    expect(process.env.LIVE_MAX_NOTIONAL).toBe("30");
    expect(process.env.LIVE_SYMBOL_ALLOWLIST).toBe("BTCUSDT");
  });
  it("기존 캡이 있으면 enableLive가 덮어쓰지 않음(유지)", async () => {
    const C = await load();
    C.upsertCredentials({ LIVE_MAX_NOTIONAL: "20" });
    C.enableLive();
    expect(process.env.LIVE_MAX_NOTIONAL).toBe("20");
  });
  it("disableLive: 마스터 OFF(긴급 정지), 캡 등은 유지", async () => {
    const C = await load();
    C.enableLive({ maxNotional: "30" });
    C.disableLive();
    expect(process.env.LIVE_TRADING_ENABLED).toBe("false");
    expect(process.env.LIVE_MAX_NOTIONAL).toBe("30");
  });
});

describe("checkLimits 안전 기본 캡(친화+안전)", () => {
  it("마스터 ON + 캡 미설정 → DEFAULT_LIVE_MAX_NOTIONAL로 자동 캡(무제한 금지)", async () => {
    const S = await import("../src/brokers/safety.js");
    process.env.LIVE_TRADING_ENABLED = "true";
    delete process.env.LIVE_MAX_NOTIONAL;
    const over = S.checkLimits({ symbol: "BTCUSDT", notional: S.DEFAULT_LIVE_MAX_NOTIONAL + 1 });
    expect(over.ok).toBe(false);
    expect(over.reason).toContain("기본값");
    const under = S.checkLimits({ symbol: "BTCUSDT", notional: S.DEFAULT_LIVE_MAX_NOTIONAL - 1 });
    expect(under.ok).toBe(true);
  });
  it("마스터 OFF(페이퍼/testnet) + 캡 미설정 → 캡 없음(가짜돈이라 제한 불필요)", async () => {
    const S = await import("../src/brokers/safety.js");
    delete process.env.LIVE_TRADING_ENABLED;
    delete process.env.LIVE_MAX_NOTIONAL;
    expect(S.checkLimits({ symbol: "BTCUSDT", notional: 1e9 }).ok).toBe(true);
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
