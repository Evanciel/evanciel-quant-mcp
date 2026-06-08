/**
 * setup/credentials.ts — 자격증명(API 키) 저장/로드 단일 출처. CLI 마법사 + 대시보드 폼이 공유.
 *
 * 보안 설계:
 *  - 키는 `~/.quant-mcp/credentials.env`(또는 QUANT_MCP_DATA_DIR/credentials.env)에만 저장. chmod 600(소유자만).
 *  - 서버 기동 시 loadCredentialsFile()로 process.env에 주입(이미 설정된 값은 안 덮음 → MCP 설정 env가 우선).
 *  - upsert는 파일 갱신 + 실행 중 process.env 즉시 반영(같은 프로세스가 러너/대시보드 호스팅 → 재시작 없이 적용).
 *  - 절대 로깅/표시 안 함(마스킹만). 평문 노출 경로(채팅/대시보드 readback) 차단.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type BrokerKey = "binance" | "kis" | "kiwoom";

/** 브로커별 자격증명 환경변수 필드(폼/마법사가 물어볼 항목). secret=마스킹 대상. */
export const BROKER_FIELDS: Record<BrokerKey, { key: string; label: string; secret: boolean; optional?: boolean }[]> = {
  binance: [
    { key: "BINANCE_ENV", label: "환경(testnet/mock/live)", secret: false },
    { key: "BINANCE_API_KEY", label: "현물 API Key", secret: true },
    { key: "BINANCE_API_SECRET", label: "현물 API Secret", secret: true },
    { key: "BINANCE_FUTURES_API_KEY", label: "선물 API Key(선택)", secret: true, optional: true },
    { key: "BINANCE_FUTURES_API_SECRET", label: "선물 API Secret(선택)", secret: true, optional: true },
  ],
  kis: [
    { key: "KIS_ENV", label: "환경(mock/live)", secret: false },
    { key: "KIS_APPKEY", label: "App Key", secret: true },
    { key: "KIS_APPSECRET", label: "App Secret", secret: true },
    { key: "KIS_ACCOUNT", label: "계좌번호(12345678-01)", secret: false },
  ],
  kiwoom: [
    { key: "KIWOOM_ENV", label: "환경(mock/live)", secret: false },
    { key: "KIWOOM_APPKEY", label: "App Key", secret: true },
    { key: "KIWOOM_SECRETKEY", label: "Secret Key", secret: true },
  ],
};

const ALL_KEYS = new Set(Object.values(BROKER_FIELDS).flat().map((f) => f.key));

export function dataDir(): string {
  return process.env.QUANT_MCP_DATA_DIR || join(homedir(), ".quant-mcp");
}
export function credentialsPath(): string {
  return join(dataDir(), "credentials.env");
}

/** .env 형식 파일 파싱(KEY=VALUE, # 주석 무시). 없으면 {}. */
export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/** 키 마스킹: 앞2···뒤4. 빈 값은 (none). */
export const mask = (s?: string): string => { const t = (s ?? "").trim(); return t ? `${t.slice(0, 2)}…${t.slice(-4)}` : "(none)"; };

/**
 * 자격증명 갱신: credentials.env에 upsert(chmod 600) + 실행 중 process.env 즉시 반영.
 * 빈 문자열/undefined 값은 무시(기존 값 유지). 알 수 없는 키는 거부(화이트리스트). 반환=갱신된 키 목록.
 */
export function upsertCredentials(updates: Record<string, string | undefined>): { written: string[]; path: string } {
  const path = credentialsPath();
  mkdirSync(dataDir(), { recursive: true });
  const cur = parseEnvFile(path);
  const written: string[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (!ALL_KEYS.has(k)) continue; // 화이트리스트 외 거부
    if (v === undefined || v === "") continue; // 빈 값=유지
    cur[k] = String(v).trim();
    process.env[k] = cur[k]; // 같은 프로세스 즉시 반영(재시작 불필요)
    written.push(k);
  }
  const body = "# quant-mcp 자격증명 (chmod 600, gitignore). 직접 편집 가능. 키는 마스킹되어 표시됨.\n"
    + Object.entries(cur).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  writeFileSync(path, body, { encoding: "utf8" });
  try { chmodSync(path, 0o600); } catch { /* Windows ACL 등 — best-effort */ }
  return { written, path };
}

/** 기동 시 credentials.env → process.env 로드(이미 설정된 키는 안 덮음 = MCP 설정 env 우선). */
export function loadCredentialsFile(): number {
  const env = parseEnvFile(credentialsPath());
  let n = 0;
  for (const [k, v] of Object.entries(env)) {
    if (ALL_KEYS.has(k) && process.env[k] === undefined) { process.env[k] = v; n++; }
  }
  return n;
}

/** 현재 설정 상태(마스킹). 키 값은 절대 반환 안 함. */
export function credentialStatus(): Record<BrokerKey, { configured: boolean; fields: Record<string, string> }> {
  const out = {} as Record<BrokerKey, { configured: boolean; fields: Record<string, string> }>;
  for (const broker of Object.keys(BROKER_FIELDS) as BrokerKey[]) {
    const fields: Record<string, string> = {};
    let hasSecret = false;
    for (const f of BROKER_FIELDS[broker]) {
      const v = (process.env[f.key] ?? "").trim();
      fields[f.key] = f.secret ? mask(v) : (v || "(none)");
      if (f.secret && v && !f.optional) hasSecret = true;
    }
    out[broker] = { configured: hasSecret, fields };
  }
  return out;
}
