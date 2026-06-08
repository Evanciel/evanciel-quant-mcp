/**
 * verify-mainnet-readiness.ts — 메인넷(실돈) 파일럿 사전점검. **주문 0건**(읽기전용 GO/NO-GO).
 *
 * 검사: BINANCE_ENV=live + 마스터스위치 + 키유효(잔고조회) + **출금권한 OFF**(최우선) + IP제한
 *       + 하드리밋(노셔널캡 소액/심볼allowlist/일일손실서킷) 설정 여부.
 * 실패(NO-GO) 시 exit 1. 실제 거래는 이 점검 GO 후 사장님이 소액 1건 파일럿으로 직접 결정.
 * 실행: npx tsx scripts/verify-mainnet-readiness.ts (quant-mcp/.env.local 자동 로드)
 *
 * ⚠️ 이 스크립트는 키를 화면/로그에 노출하지 않음(마스킹만). 주문/출금/취소 안 함.
 */
import { readFileSync } from "node:fs";

try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { console.error(".env.local 없음 — 메인넷 키/설정을 .env.local에 넣고 다시 실행하세요."); process.exit(1); }

const { getAdapter } = await import("../src/brokers/index.js");
const { liveGate, loadCredentials, checkLimits, mask } = await import("../src/brokers/safety.js");

const T = (v?: string) => (v ?? "").trim();
let nogo = 0; const warns: string[] = [];
const PASS = (m: string) => console.log(`  ✅ ${m}`);
const FAIL = (m: string) => { console.log(`  ❌ ${m}`); nogo++; };
const WARN = (m: string) => { console.log(`  ⚠️  ${m}`); warns.push(m); };

async function main() {
  console.log("═══ 메인넷(실돈) 파일럿 사전점검 — 읽기전용, 주문 0건 ═══\n");

  // 1) 환경: 반드시 live (이 스크립트는 메인넷 전용)
  console.log("[1] 환경 / 마스터 스위치");
  const env = T(process.env.BINANCE_ENV);
  if (env !== "live") { FAIL(`BINANCE_ENV='${env || "(미설정)"}' — 메인넷 점검은 BINANCE_ENV=live 필요(현재 testnet/페이퍼). 메인넷 파일럿이 아니면 이 스크립트 대신 verify-testnet-*를 쓰세요.`); }
  else PASS("BINANCE_ENV=live");
  const master = T(process.env.LIVE_TRADING_ENABLED) === "true";
  if (!master) FAIL("LIVE_TRADING_ENABLED!=true — 마스터 스위치 OFF면 메인넷 주문 차단(페이퍼 폴백).");
  else PASS("LIVE_TRADING_ENABLED=true (마스터 ON)");

  const c = loadCredentials("binance", "spot");
  if (!c) { FAIL("현물 키 미설정(BINANCE_API_KEY/SECRET)."); return finish(); }
  PASS(`현물 키 present: ${mask(c.apiKey)}`);
  const gate = liveGate("binance", "spot");
  console.log(`  · liveGate: allowed=${gate.allowed} (${gate.env}) — ${gate.reason}`);

  // 2) 키 유효성(읽기전용 잔고)
  console.log("\n[2] 키 유효성(읽기전용 잔고 조회)");
  const got = getAdapter("binance", "spot");
  type ReadAdapter = {
    getBalance: () => Promise<{ totalAsset: number; cashBalance: number }>;
    apiRestrictions?: () => Promise<{ enableWithdrawals: boolean; ipRestrict: boolean; enableSpotTrading: boolean; enableFutures: boolean } | null>;
  };
  const adapter = got?.adapter as ReadAdapter | undefined;
  if (!adapter) { FAIL("어댑터 생성 실패."); return finish(); }
  let cash = 0;
  try { const bal = await adapter.getBalance(); cash = bal.cashBalance; PASS(`잔고 조회 OK — 가용현금 ${bal.cashBalance} USDT / 총자산 ${bal.totalAsset.toFixed(2)}`); }
  catch (e) { FAIL(`잔고 조회 실패(키 무효/IP차단/시간오차?): ${e instanceof Error ? e.message : String(e)}`); return finish(); }

  // 3) 키 권한 — 출금권한 OFF가 실돈 최대 안전장치
  console.log("\n[3] API 키 권한(출금 OFF / IP 제한)");
  const restr = adapter.apiRestrictions ? await adapter.apiRestrictions() : null;
  if (!restr) WARN("apiRestrictions 점검 불가(엔드포인트 미지원/권한). 거래소 웹에서 [출금권한 OFF + IP 화이트리스트]를 직접 확인하세요.");
  else {
    if (restr.enableWithdrawals) FAIL("🚨 출금 권한이 켜져 있음! 거래소에서 즉시 OFF(키 유출 시 자금 인출 위험). 거래 권한만 남기세요.");
    else PASS("출금 권한 OFF (안전).");
    if (!restr.ipRestrict) WARN("IP 화이트리스트 미설정 — 봇 돌리는 PC IP로 제한 권장.");
    else PASS("IP 화이트리스트 설정됨.");
    if (!restr.enableSpotTrading) WARN("현물 거래 권한이 꺼져 있음 — 봇이 주문 못 함(거래 권한 ON 필요).");
  }

  // 4) 하드리밋(서버측 강제) 설정 여부
  console.log("\n[4] 하드리밋(사고 방지 — 서버측 강제)");
  const cap = Number(T(process.env.LIVE_MAX_NOTIONAL) || "0");
  if (cap <= 0) FAIL("LIVE_MAX_NOTIONAL 미설정 — 주문당 최대금액 캡 필수(파일럿은 소액, 예: 20).");
  else { PASS(`LIVE_MAX_NOTIONAL=${cap} USDT`); if (cap > 100) WARN(`노셔널 캡 ${cap}이 큼 — 첫 파일럿은 20~50 권장.`); }
  const allow = T(process.env.LIVE_SYMBOL_ALLOWLIST);
  if (!allow) FAIL("LIVE_SYMBOL_ALLOWLIST 미설정 — 허용 종목 화이트리스트 필수.");
  else PASS(`LIVE_SYMBOL_ALLOWLIST=${allow}`);
  const circuit = Number(T(process.env.LIVE_DAILY_LOSS_LIMIT) || "0");
  if (circuit <= 0) WARN("LIVE_DAILY_LOSS_LIMIT 미설정 — 일일손실 서킷브레이커 권장(예: 50).");
  else PASS(`LIVE_DAILY_LOSS_LIMIT=${circuit} USDT`);

  // 하드리밋 동작 자체점검: allowlist 첫 종목 + 캡 초과 주문이 막히는지(메모리 계산, 주문 안 함)
  if (allow && cap > 0) {
    const sym = allow.split(",")[0].trim();
    const blocked = checkLimits({ symbol: sym, notional: cap + 1 });
    if (!blocked.ok) PASS(`하드리밋 동작 확인: ${sym} 캡+1 주문 거부됨 — "${blocked.reason}"`);
    else FAIL("하드리밋이 캡 초과 주문을 막지 못함(설정 점검).");
    const wrong = checkLimits({ symbol: "ZZZNOTALLOWED", notional: 1 });
    if (!wrong.ok) PASS("하드리밋 동작 확인: 미허용 종목 거부됨.");
    else FAIL("allowlist가 미허용 종목을 막지 못함.");
  }

  return finish(cash);
}

function finish(cash = 0) {
  console.log("\n" + "─".repeat(52));
  if (nogo > 0) {
    console.log(`🔴 NO-GO — 차단 ${nogo}건. 위 ❌를 모두 해결 후 재실행하세요. (실거래 시작 금지)`);
    process.exit(1);
  }
  console.log("🟢 GO — 사전점검 통과(주문은 아직 0건).");
  if (warns.length) console.log(`   (경고 ${warns.length}건 — 검토 권장)`);
  console.log("\n다음 단계(사장님 직접, 소액):");
  console.log("  1) 봇 1개 · 소액 · stop_loss_percent 설정 · allowlist 종목으로 create_bot(mode=live)");
  console.log("  2) open_dashboard로 모니터 + 거래소 앱에서 상주 SL/TP 주문 안착 확인");
  console.log("  3) 며칠 관찰 → audit.jsonl + testnet-cleanup-orders(심볼만 메인넷으로) 고아주문 0 확인 → 점진 확대");
  console.log(`\n  현재 가용현금: ${cash} USDT. 첫 주문은 LIVE_MAX_NOTIONAL 이하 1건만.`);
  process.exit(0);
}

main().catch((e) => { console.error("점검 오류:", e); process.exit(1); });
