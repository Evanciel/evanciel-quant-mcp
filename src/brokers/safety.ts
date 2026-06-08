/**
 * brokers/safety.ts — 라이브 머니패스 안전 코어 (defense-in-depth, 비협상).
 * 리서치 종합: MCP annotation은 힌트일 뿐 → 서버측 강제. fail-OPEN 금지.
 * BYOK는 env 런타임만(툴인자/로그 금지). 키 넣으면 testnet 즉시거래, 메인넷=마스터스위치+2단계토큰+하드리밋.
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, db } from "../store/db.js";
import type { BrokerCredentials } from "./types.js";

export type Broker = "binance" | "kis" | "kiwoom";
export type Env = "testnet" | "mock" | "live";

const trim = (v?: string) => (v ?? "").trim();
export const mask = (s?: string) => { const t = trim(s); return t ? `${t.slice(0, 2)}…${t.slice(-4)}` : "(none)"; };

/** 브로커별 자격증명을 env에서 읽음(절대 로그 금지). 키 없으면 null. env 기본=안전(testnet/mock). */
export function loadCredentials(broker: Broker, market: "spot" | "futures" = "spot"): (BrokerCredentials & { env: Env; market?: string }) | null {
  if (broker === "binance") {
    const env = (trim(process.env.BINANCE_ENV) || "testnet") as Env; // 기본 testnet
    // 선물 testnet 키는 현물과 별개
    const apiKey = market === "futures" ? (trim(process.env.BINANCE_FUTURES_API_KEY) || trim(process.env.BINANCE_API_KEY)) : trim(process.env.BINANCE_API_KEY);
    const apiSecret = market === "futures" ? (trim(process.env.BINANCE_FUTURES_API_SECRET) || trim(process.env.BINANCE_API_SECRET)) : trim(process.env.BINANCE_API_SECRET);
    if (!apiKey || !apiSecret) return null;
    return { env, market, apiKey, apiSecret };
  }
  if (broker === "kis") {
    const env = (trim(process.env.KIS_ENV) || "mock") as Env;
    const appkey = trim(process.env.KIS_APPKEY), appsecret = trim(process.env.KIS_APPSECRET), account = trim(process.env.KIS_ACCOUNT);
    if (!appkey || !appsecret || !account) return null;
    return { env, appkey, appsecret, account };
  }
  if (broker === "kiwoom") {
    const env = (trim(process.env.KIWOOM_ENV) || "mock") as Env;
    const appkey = trim(process.env.KIWOOM_APPKEY), secretkey = trim(process.env.KIWOOM_SECRETKEY);
    if (!appkey || !secretkey) return null;
    return { env, appkey, secretkey };
  }
  return null;
}

/** 라이브 게이트: 주문이 실제로 나갈 수 있는가? testnet/mock=키만 있으면 OK, live=마스터스위치 필수. */
export function liveGate(broker: Broker, market: "spot" | "futures" = "spot"): { allowed: boolean; env: Env | null; reason: string } {
  const c = loadCredentials(broker, market);
  if (!c) return { allowed: false, env: null, reason: `${broker} 키 미설정(env). 페이퍼로 유지.` };
  const masterOn = trim(process.env.LIVE_TRADING_ENABLED) === "true";
  if (c.env === "live") {
    if (!masterOn) return { allowed: false, env: "live", reason: "메인넷 키지만 LIVE_TRADING_ENABLED!=true → 차단(마스터 OFF). 페이퍼로 유지." };
    return { allowed: true, env: "live", reason: "메인넷 실거래 ON(마스터 스위치 + 메인넷 키)." };
  }
  // testnet/mock: 키만 있으면 즉시 거래(가짜돈, 안전)
  return { allowed: true, env: c.env, reason: `${c.env} 거래 활성(키 present, 가짜돈).` };
}

/**
 * 통화별 라이브 안전 기본값. 마스터 ON인데 LIVE_MAX_NOTIONAL/LIVE_DAILY_LOSS_LIMIT을 안 정했어도
 * 무제한이 아니라 이 값으로 보호. **통화 인식 필수**: Binance=USDT(달러), 한투/키움=KRW(원).
 * 이전 버그: KRW 봇에 USDT 기준 캡(50)을 적용 → 1주(수만 원)도 거부 → KR 거래 불가. 통화별 분기로 해결.
 */
export const LIVE_DEFAULTS_BY_CCY: Record<string, { cap: number; dailyLoss: number }> = {
  USDT: { cap: 100, dailyLoss: 50 },
  USD: { cap: 100, dailyLoss: 50 },
  KRW: { cap: 150_000, dailyLoss: 75_000 }, // 소액이되 KRW 주식 1주는 살 수 있게(원 단위)
};
const DEFAULT_CCY = "USDT";
function ccyDefaults(quoteCurrency?: string) { return LIVE_DEFAULTS_BY_CCY[(quoteCurrency || DEFAULT_CCY).toUpperCase()] ?? LIVE_DEFAULTS_BY_CCY[DEFAULT_CCY]; }
/** @deprecated 통화 인식 LIVE_DEFAULTS_BY_CCY 사용. 하위호환용 USDT 기본 캡. */
export const DEFAULT_LIVE_MAX_NOTIONAL = LIVE_DEFAULTS_BY_CCY.USDT.cap;

/**
 * 서버측 하드리밋(LLM 우회 불가 pre-trade). 노셔널캡 + 심볼 allowlist + 일일손실 서킷.
 * quoteCurrency: 주문 통화(USDT/KRW). 명시 캡/서킷 미설정 시 통화별 안전 기본값 적용(KRW 버그 방지).
 */
export function checkLimits(order: { symbol: string; notional: number; quoteCurrency?: string }): { ok: boolean; reason: string } {
  const liveActive = trim(process.env.LIVE_TRADING_ENABLED) === "true";
  const def = ccyDefaults(order.quoteCurrency);
  // 명시 캡 우선. 라이브 마스터 ON인데 미설정이면 통화별 안전 기본 캡(무제한 금지). 페이퍼/testnet 마스터 OFF면 0(캡 없음).
  const explicitCap = Number(trim(process.env.LIVE_MAX_NOTIONAL) || "0");
  const cap = explicitCap || (liveActive ? def.cap : 0);
  if (cap > 0 && order.notional > cap) return { ok: false, reason: `노셔널 ${order.notional} > 캡 ${cap}(LIVE_MAX_NOTIONAL${explicitCap ? "" : ` ${order.quoteCurrency || DEFAULT_CCY} 기본값`})` };
  const allow = trim(process.env.LIVE_SYMBOL_ALLOWLIST);
  if (allow && !allow.split(",").map((s) => s.trim().toUpperCase()).includes(order.symbol.toUpperCase()))
    return { ok: false, reason: `${order.symbol} 미허용(LIVE_SYMBOL_ALLOWLIST)` };
  const dl = dailyRealizedLoss();
  const explicitCircuit = Number(trim(process.env.LIVE_DAILY_LOSS_LIMIT) || "0");
  const circuit = explicitCircuit || (liveActive ? def.dailyLoss : 0);
  if (circuit > 0 && dl <= -Math.abs(circuit)) return { ok: false, reason: `일일 손실 ${dl} ≤ 서킷 -${circuit}(LIVE_DAILY_LOSS_LIMIT${explicitCircuit ? "" : " 기본값"}) → 거래중단` };
  return { ok: true, reason: "ok" };
}

// ── 2단계 확인 토큰(fail-CLOSED): place_order 수동툴용. 토큰=주문해시 바인딩, 단일사용, TTL. ──
const TOKENS = new Map<string, { hash: string; exp: number }>();
const TTL_MS = 300_000;
export function orderHash(o: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);
}
export function mintToken(hash: string): string {
  const tok = randomBytes(12).toString("hex");
  TOKENS.set(tok, { hash, exp: Date.now() + TTL_MS });
  return tok;
}
export function consumeToken(tok: string, hash: string): boolean {
  const e = TOKENS.get(tok);
  if (!e) return false;
  TOKENS.delete(tok); // 단일사용
  return e.hash === hash && e.exp > Date.now();
}

// ── 감사로그(append-only JSONL) + 일일 실현손익(서킷용) ──
const auditPath = () => join(dataDir(), "audit.jsonl");
export function audit(entry: Record<string, unknown>): void {
  try { appendFileSync(auditPath(), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"); } catch { /* noop */ }
}
function dailyRealizedLoss(): number {
  // 스토어의 오늘 실거래(is_paper=0) pnl 합. 음수=손실.
  try {
    const today = new Date().toISOString().slice(0, 10);
    const r = db().prepare(`SELECT COALESCE(SUM(pnl),0) s FROM trades WHERE is_paper=0 AND ts >= ?`).get(today + "T00:00:00.000Z") as { s: number } | undefined;
    return r?.s ?? 0;
  } catch { return 0; }
}
