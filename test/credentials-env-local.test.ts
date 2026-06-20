/**
 * credentials-env-local.test.ts — loadEnvLocalFile(.env.local 로드) 검증.
 * MCP 서버가 .env.local을 읽어 자비스(MCP) 경유에도 브로커 키(별칭 포함)가 보이게 하는 핵심 헬퍼.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvLocalFile } from "../src/setup/credentials.js";

const KEYS = ["TOSS_API_KEY", "TOSS_SECRET_KEY", "BINANCE_API_KEY"];

describe("loadEnvLocalFile — .env.local 로드(non-override, 별칭 허용)", () => {
  beforeEach(() => { for (const k of KEYS) delete process.env[k]; });
  afterEach(() => { for (const k of KEYS) delete process.env[k]; });

  it("별칭 키(TOSS_API_KEY/SECRET_KEY) 포함 로드 + 따옴표 제거 + 기존값 비덮어쓰기", () => {
    const dir = mkdtempSync(join(tmpdir(), "qm-envlocal-"));
    writeFileSync(join(dir, ".env.local"), 'TOSS_API_KEY=cid\nTOSS_SECRET_KEY="sec"\nBINANCE_API_KEY=fromfile\n');
    process.env.BINANCE_API_KEY = "preexisting"; // 기존값(=MCP env/credentials.env 우선 모사)
    const n = loadEnvLocalFile(dir);
    expect(process.env.TOSS_API_KEY).toBe("cid");           // 별칭도 로드(화이트리스트 없음 — go-daemon 동일)
    expect(process.env.TOSS_SECRET_KEY).toBe("sec");         // 따옴표 제거
    expect(process.env.BINANCE_API_KEY).toBe("preexisting"); // non-override(기존 우선)
    expect(n).toBe(2);                                       // 신규 2개(BINANCE는 기존이라 스킵)
    rmSync(dir, { recursive: true, force: true });
  });

  it(".env.local 없으면 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "qm-envlocal2-"));
    expect(loadEnvLocalFile(dir)).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
