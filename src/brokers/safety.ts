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
import { evaluatePortfolioRisk, type PortfolioPosition, type CircuitState } from "../core/risk/portfolio.js";

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
  // 글로벌 킬스위치(audit P1-17): HALT면 환경 불문 전 주문 차단. 매 호출 env 재평가라 런타임 토글 즉시 반영
  //   (텔레그램 /halt 등). 기존 포지션 청산은 emergencyStopAll(closePositions)이 HALT 설정 '전에' 수행.
  if (trim(process.env.LIVE_TRADING_HALT) === "true") {
    return { allowed: false, env: c.env, reason: "LIVE_TRADING_HALT=true — 글로벌 킬스위치 작동(모든 주문 차단). 해제: 환경변수 제거." };
  }
  // 감사로그 누적 실패 차단(audit P1-24, opt-in). 기본 OFF(가용성 보호) — 감사 무결성이 절대적인 운영에서만 켠다.
  //   임계 초과 시 주문 차단(fail-closed). 임계 기본 10회, AUDIT_FAILURE_HALT_MAX로 조정(1..1000).
  if (trim(process.env.AUDIT_FAILURE_HALT) === "true") {
    const maxRaw = parseInt(trim(process.env.AUDIT_FAILURE_HALT_MAX) || "10", 10);
    const max = Number.isFinite(maxRaw) && maxRaw >= 1 && maxRaw <= 1000 ? maxRaw : 10;
    if (auditFailureCount() > max) {
      return { allowed: false, env: c.env, reason: `감사로그 누적 기록 실패 ${auditFailureCount()}회 > ${max} → 주문 차단(AUDIT_FAILURE_HALT). 디스크/권한 점검 후 재시작.` };
    }
  }
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
  // env 숫자 파서: 유한 양수만 채택. 음수/garbage는 0 → 아래 `||` 체인이 통화별 안전 기본값으로 폴백.
  //   (audit P1-24 후속: 음수 typo[예: -50]가 truthy라 circuit/cap으로 채택되고 `>0` 가드에 걸러져 서킷/캡이
  //    조용히 무력화 + 일일손실 조회실패 -Infinity 폴백까지 가려지던 구멍 차단. 정상 양수 경로는 불변.)
  const posNum = (v?: string) => { const n = Number(trim(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
  // 명시 캡 우선. 라이브 마스터 ON인데 미설정이면 통화별 안전 기본 캡(무제한 금지). 페이퍼/testnet 마스터 OFF면 0(캡 없음).
  const explicitCap = posNum(process.env.LIVE_MAX_NOTIONAL);
  const cap = explicitCap || (liveActive ? def.cap : 0);
  if (cap > 0 && order.notional > cap) return { ok: false, reason: `노셔널 ${order.notional} > 캡 ${cap}(LIVE_MAX_NOTIONAL${explicitCap ? "" : ` ${order.quoteCurrency || DEFAULT_CCY} 기본값`})` };
  const allow = trim(process.env.LIVE_SYMBOL_ALLOWLIST);
  if (allow && !allow.split(",").map((s) => s.trim().toUpperCase()).includes(order.symbol.toUpperCase()))
    return { ok: false, reason: `${order.symbol} 미허용(LIVE_SYMBOL_ALLOWLIST)` };
  // 일일손실 서킷 — 통화 분리(audit P1-6). dl은 주문 통화의 실거래 손익만 집계(KRW+USDT 합산 비교 버그 제거).
  //   서킷 우선순위: ① 통화별 분리 env(LIVE_DAILY_LOSS_LIMIT_USDT/_KRW) → ② 하위호환 단일 env(LIVE_DAILY_LOSS_LIMIT)
  //   → ③ 통화별 안전 기본값. dl=-Infinity(조회 실패 fail-closed)면 어떤 양수 서킷에도 걸려 차단.
  const ccyU = (order.quoteCurrency || DEFAULT_CCY).toUpperCase();
  const dl = dailyRealizedLoss(order.quoteCurrency);
  const sepEnv = ccyU === "KRW" ? process.env.LIVE_DAILY_LOSS_LIMIT_KRW : process.env.LIVE_DAILY_LOSS_LIMIT_USDT;
  const explicitSep = posNum(sepEnv);
  const explicitSingle = posNum(process.env.LIVE_DAILY_LOSS_LIMIT);
  const circuit = explicitSep || explicitSingle || (liveActive ? def.dailyLoss : 0);
  const circuitSrc = explicitSep ? `LIVE_DAILY_LOSS_LIMIT_${ccyU}` : explicitSingle ? "LIVE_DAILY_LOSS_LIMIT" : `${ccyU} 기본값`;
  if (circuit > 0 && dl <= -Math.abs(circuit)) return { ok: false, reason: `${ccyU} 일일 손실 ${dl} ≤ 서킷 -${circuit}(${circuitSrc}) → 거래중단` };
  return { ok: true, reason: "ok" };
}

// ── 포트폴리오 레벨 캡(opt-in, 신규진입 게이트). 과노출/MDD 차단 — 봇별 사이징과 별개의 '교차봇 throttle'. ──
//
// 왜 게이트인가(불변식 보존): backtest≡live는 "엔진이 단일 사이징 소스 → 러너가 want.qty 상속"으로 보장된다.
// 포트폴리오 캡은 본질적으로 **다른 봇들의 오픈 포지션 + 계좌 자기자본**에 의존하므로 봇별 백테스트 엔진이 알 수 없다
// (엔진에 넣으면 오히려 backtest≡live를 깬다). 따라서 엔진이 want.qty를 정한 **뒤** 라이브 주문에만 적용되는
// 신규진입 throttle로 배선한다: ① allowNewEntry=false면 진입 스킵 ② MDD 디리스킹이면 qty를 sizeMultiplier로 **축소만**
// (정규화-후-캡, 절대 증액 안 함). 백테스트는 포트폴리오 컨텍스트가 없어 영향 0 → 미설정 시 legacy 바이트 동일(회귀 0).
//
// 정직: 알파가 아니라 '파산위험/과노출 통제'(리서치 결론). 미설정(env 없음)=완전 OFF.

/** 포트폴리오 캡 설정(env opt-in). 하나라도 설정되면 enabled. 전부 미설정이면 enabled=false(no-op). */
export interface PortfolioGateConfig {
  enabled: boolean;
  maxHeat?: number;     // 총노출(heat) 상한(자기자본 대비 비율). QUANT_MCP_PORTFOLIO_MAX_HEAT
  riskBudget?: number;  // 상관보정 실효리스크 상한. QUANT_MCP_PORTFOLIO_RISK_BUDGET
  avgCorr: number;      // 가정 평균상관(기본 0.7). QUANT_MCP_PORTFOLIO_AVG_CORR
  mdd: boolean;         // MDD 단계적 디리스킹 활성. QUANT_MCP_PORTFOLIO_MDD=true
}

/** env에서 포트폴리오 캡 설정 로드(순수). 캡/리스크버짓/MDD 중 하나라도 있으면 enabled. */
export function loadPortfolioGateConfig(): PortfolioGateConfig {
  const num = (v?: string) => { const n = Number(trim(v)); return Number.isFinite(n) && n > 0 ? n : undefined; };
  const maxHeat = num(process.env.QUANT_MCP_PORTFOLIO_MAX_HEAT);
  const riskBudget = num(process.env.QUANT_MCP_PORTFOLIO_RISK_BUDGET);
  const mdd = trim(process.env.QUANT_MCP_PORTFOLIO_MDD) === "true";
  // avgCorr 기본 0.7. 빈문자열(미설정)은 Number("")=0이라 명시 0과 구분 — 미설정이면 기본값, 명시 [0,1]만 채택.
  const avgCorrStr = trim(process.env.QUANT_MCP_PORTFOLIO_AVG_CORR);
  const avgCorrRaw = Number(avgCorrStr);
  const avgCorr = avgCorrStr !== "" && Number.isFinite(avgCorrRaw) && avgCorrRaw >= 0 && avgCorrRaw <= 1 ? avgCorrRaw : 0.7;
  const enabled = maxHeat !== undefined || riskBudget !== undefined || mdd;
  return { enabled, maxHeat, riskBudget, avgCorr, mdd };
}

export interface PortfolioGateResult {
  enabled: boolean;          // 게이트 활성 여부(미설정이면 false=완전 통과)
  allow: boolean;            // 신규진입 허용(false면 진입 스킵)
  sizeMultiplier: number;    // 진입 수량 배수(MDD 디리스킹 시 <1, 그 외 1). 절대 >1 아님(축소만).
  heat: number; effectiveRisk: number; ddPct: number; state: CircuitState;
  reasons: string[];
}

/**
 * 포트폴리오 레벨 신규진입 게이트(순수, 부수효과 0). config.enabled=false면 즉시 통과(allow=true, mult=1).
 * positions=현재 오픈 포지션의 자기자본 대비 리스크(노출/equity 등), equity/peakEquity=계좌 곡선.
 * evaluatePortfolioRisk로 heat>maxHeat / effectiveRisk>riskBudget / MDD halt 시 allow=false,
 * MDD reduced 시 sizeMultiplier<1(축소). 설정 안 한 항목(maxHeat/riskBudget undefined)은 검사 제외(무한대 취급).
 */
export function portfolioGate(config: PortfolioGateConfig, snapshot: { positions: PortfolioPosition[]; equity: number; peakEquity: number }): PortfolioGateResult {
  if (!config.enabled) {
    return { enabled: false, allow: true, sizeMultiplier: 1, heat: 0, effectiveRisk: 0, ddPct: 0, state: "normal", reasons: [] };
  }
  const r = evaluatePortfolioRisk({
    positions: snapshot.positions, equity: snapshot.equity, peakEquity: snapshot.peakEquity,
    avgCorr: config.avgCorr,
    // 미설정 항목은 사실상 무한대(검사 제외) — 명시한 캡만 적용. MDD 미설정이면 단계 없음(항상 normal).
    maxHeat: config.maxHeat ?? Number.POSITIVE_INFINITY,
    riskBudget: config.riskBudget ?? Number.POSITIVE_INFINITY,
    tiers: config.mdd ? undefined : [], // tiers=[] → MDD 단계 없음(sizeMultiplier 1, allowNewEntry true)
  });
  // MDD halt(mult<=0)는 evaluatePortfolioRisk가 이미 allowNewEntry=false로 처리. reduced는 mult<1로 축소(진입 허용).
  const sizeMultiplier = r.allowNewEntry ? Math.max(0, Math.min(1, r.sizeMultiplier)) : 0;
  return {
    enabled: true, allow: r.allowNewEntry, sizeMultiplier,
    heat: r.heat, effectiveRisk: r.effectiveRisk, ddPct: r.ddPct, state: r.state, reasons: r.reasons,
  };
}

// ── 2단계 확인 토큰(fail-CLOSED): place_order 수동툴용. 토큰=주문해시 바인딩, 단일사용, TTL. ──
const TOKENS = new Map<string, { hash: string; exp: number }>();
const TTL_MS = 300_000;
export function orderHash(o: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);
}
export function mintToken(hash: string): string {
  const now = Date.now();
  for (const [k, v] of TOKENS) if (v.exp <= now) TOKENS.delete(k); // 만료 토큰 스윕(미사용 프리뷰 토큰 메모리 누적 방지)
  const tok = randomBytes(12).toString("hex");
  TOKENS.set(tok, { hash, exp: now + TTL_MS });
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
// 감사 무결성 가시화: 쓰기 실패를 침묵시키지 않고 카운터+마지막 에러를 인메모리로 노출(프로세스 재시작 시 0 리셋).
let _auditFailures = 0;
let _lastAuditError = "";
/**
 * 머니패스 감사로그(주문 시도/결과/에러, OCO, 봇 주문)를 append-only로 기록.
 * 트레이드오프(명시 결정): 쓰기 실패(디스크 풀/권한/경로부재) 시 **throw로 거래를 끊지 않는다**(가용성 우선 —
 * 단일 로그쓰기 실패가 전체 머니패스를 마비시키면 안 됨). 대신 **침묵(noop)은 금지** — stderr 경고 + 실패 카운터로
 * 크게 알린다(감사 무결성). 따라서 '감사로그 100% 보장'은 아니며, 규제·사후추적이 절대적이면 호출부에서 차단을
 * 검토해야 한다(본 스코프 밖). stdout 금지: MCP는 StdioServerTransport(stdout=JSON-RPC 전용)라 stderr만 사용.
 */
export function audit(entry: Record<string, unknown>): void {
  try {
    appendFileSync(auditPath(), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch (e) {
    _auditFailures++;
    _lastAuditError = e instanceof Error ? e.message : String(e);
    try {
      process.stderr.write(`[quant-mcp][AUDIT-FAIL] 머니패스 감사로그 기록 실패(#${_auditFailures}): ${_lastAuditError} — 거래는 계속되나 감사 무결성 손상. 즉시 디스크/권한 점검 요망.\n`);
    } catch { /* stderr 마저 실패해도 거래는 끊지 않음(가용성) */ }
  }
}
/** 누적 감사로그 기록 실패 횟수(인메모리, 운영 가시성·테스트용). 프로세스 재시작 시 0. */
export function auditFailureCount(): number { return _auditFailures; }
/** 마지막 감사로그 기록 실패 메시지(없으면 ""). */
export function lastAuditError(): string { return _lastAuditError; }

/**
 * 일일손실 서킷용 '오늘'의 시작 인스턴트(UTC ISO-Z 문자열). KST(+09:00) 자정 기준이 기본(한국 브로커 KRW 정합).
 * env LIVE_DAY_BOUNDARY_OFFSET_MIN(분 단위)로 override 가능(기본 540=+09:00). 0이면 UTC 자정, 음수=서쪽 TZ.
 * 한계: 단일 글로벌 서킷이라 Binance(UTC 운영)엔 9h 의미차 존재(다중통화 통합 서킷의 구조적 한계). 오프셋-시프트
 * 방식이라 DST 있는 TZ로 override하면 부정확 — 현재 타깃 KRW(KST, DST 없음)엔 정확. trades.ts ts는 UTC-Z 저장이라
 * 사전식 비교를 위해 경계도 UTC-Z로 환산(KST면 전날 15:00:00.000Z).
 */
export function dayBoundaryIso(nowMs: number = Date.now()): string {
  const ms = 60_000;
  const raw = trim(process.env.LIVE_DAY_BOUNDARY_OFFSET_MIN);
  const parsed = Number(raw);
  // 유효 TZ 오프셋 범위 [-720(-12h), +840(+14h)]로 클램프-거부. 범위 밖(예: 1e12)을 허용하면
  // Date 연산이 Invalid Date→toISOString() throw→dailyRealizedLoss catch가 0 반환→일일손실 서킷 fail-open(위험).
  const offsetMin = raw !== "" && Number.isFinite(parsed) && parsed >= -720 && parsed <= 840 ? parsed : 540; // 그 외 전부 기본 540(KST)
  const shifted = new Date(nowMs + offsetMin * ms); // now를 '로컬 시계'로 시프트
  const localMidUTC = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(localMidUTC - offsetMin * ms).toISOString(); // 로컬 자정을 실제 UTC 인스턴트로 되빼기
}
/**
 * 스토어의 '오늘'(일경계=KST 기본, dayBoundaryIso) 실거래(is_paper=0) pnl 합. 음수=손실.
 * quoteCurrency(audit P1-6): 'USDT'/'USD'=binance 봇만, 'KRW'=kis/키움 봇만, 미지정=전체(하위호환).
 *   trades→bots 조인으로 broker→통화 추론(통화별 서킷 독립 — KRW 손실이 USDT 서킷을 끄지 않게).
 * 조회 실패(audit P1-24, fail-closed 교정): 종전 `return 0`은 손실을 0으로 숨겨 서킷을 무력화(fail-open)했다.
 *   이제 NEGATIVE_INFINITY 반환 → 양수 서킷이면 무조건 발화(주문 차단) + stderr 경고. ⚠️ POSITIVE_INFINITY가
 *   아님: checkLimits 비교가 `dl <= -circuit`이라 양의 무한대는 차단 안 됨(계획 부호 오류 교정).
 */
export function dailyRealizedLoss(quoteCurrency?: string): number {
  try {
    const since = dayBoundaryIso();
    const ccy = quoteCurrency ? quoteCurrency.toUpperCase() : null;
    let r: { s: number } | undefined;
    if (ccy === "USDT" || ccy === "USD") {
      r = db().prepare(`SELECT COALESCE(SUM(t.pnl),0) s FROM trades t JOIN bots b ON b.id=t.bot_id WHERE t.is_paper=0 AND t.ts >= ? AND b.broker='binance'`).get(since) as { s: number } | undefined;
    } else if (ccy === "KRW") {
      r = db().prepare(`SELECT COALESCE(SUM(t.pnl),0) s FROM trades t JOIN bots b ON b.id=t.bot_id WHERE t.is_paper=0 AND t.ts >= ? AND b.broker IN ('kis','kiwoom')`).get(since) as { s: number } | undefined;
    } else {
      r = db().prepare(`SELECT COALESCE(SUM(pnl),0) s FROM trades WHERE is_paper=0 AND ts >= ?`).get(since) as { s: number } | undefined;
    }
    return r?.s ?? 0;
  } catch (e) {
    try { process.stderr.write(`[quant-mcp] dailyRealizedLoss 조회 실패 → 서킷 안전 발화(fail-closed): ${e instanceof Error ? e.message : e}\n`); } catch { /* stderr 실패 무시 */ }
    return Number.NEGATIVE_INFINITY; // fail-closed: 손실 불명 → 무한 손실로 간주해 서킷 차단
  }
}
