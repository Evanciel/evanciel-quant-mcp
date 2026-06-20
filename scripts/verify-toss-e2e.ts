/**
 * verify-toss-e2e.ts — 토스증권 Open API **읽기 전용** 라이브 E2E(주문 POST 절대 호출 안 함).
 *
 * 토스는 모의 호스트가 없어 주문 쓰기 검증은 불가 → 이 스크립트는 시세·계좌·보유·미체결 '조회'만 라이브로 검증한다.
 * 실행: TOSS_CLIENT_ID/TOSS_CLIENT_SECRET 설정 후 `npx tsx scripts/verify-toss-e2e.ts`
 *   (계좌·보유·미체결은 TOSS_ACCOUNT_SEQ도 필요 — 이 스크립트가 /accounts로 후보를 출력해 준다.)
 * 안전: 어떤 경로도 placeOrder/cancelOrder를 호출하지 않는다. 시크릿은 출력하지 않는다.
 */
import { readFileSync, existsSync } from "node:fs";
import { loadCredentialsFile } from "../src/setup/credentials.js";
import { getAdapter } from "../src/brokers/index.js";

const BASE = "https://openapi.tossinvest.com";
const KR = "005930"; // 삼성전자
const US = "AAPL";

function ok(label: string, detail: string) { console.log(`  ✅ ${label}: ${detail}`); }
function fail(label: string, e: unknown) { console.log(`  ❌ ${label}: ${e instanceof Error ? e.message : String(e)}`); }

async function main() {
  // 키 소스 2곳 로드: ① .env.local(프로젝트, go-daemon.ts와 동일 규약 — 브로커 키를 여기 두는 관행) ② credentials.env(홈).
  if (existsSync(".env.local")) {
    for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  loadCredentialsFile(); // ~/.quant-mcp/credentials.env → process.env
  // 표준명 + 별칭(TOSS_API_KEY/TOSS_SECRET_KEY) 둘 다 허용(loadCredentials와 동일).
  const clientId = (process.env.TOSS_CLIENT_ID || process.env.TOSS_API_KEY || "").trim();
  const clientSecret = (process.env.TOSS_CLIENT_SECRET || process.env.TOSS_SECRET_KEY || "").trim();
  if (!clientId || !clientSecret) {
    console.error("TOSS 키 미설정 — .env.local 또는 credentials.env에 TOSS_CLIENT_ID(=TOSS_API_KEY)/TOSS_CLIENT_SECRET(=TOSS_SECRET_KEY) 설정. 토스증권 WTS > 설정 > Open API 발급.");
    process.exit(1);
  }

  let pass = 0, total = 0;
  const step = async (label: string, fn: () => Promise<string>) => { total++; try { ok(label, await fn()); pass++; } catch (e) { fail(label, e); } };

  // ── Phase 0: 토큰 발급(직접) ──
  console.log("\n[Phase 0] 인증");
  let token = "";
  await step("OAuth2 토큰 발급", async () => {
    const r = await fetch(`${BASE}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = (await r.json()) as { access_token?: string; expires_in?: number };
    if (!d.access_token) throw new Error("access_token 부재");
    token = d.access_token;
    return `Bearer 발급(만료 ${d.expires_in ?? "?"}s)`;
  });
  if (!token) { console.error("\n토큰 발급 실패 — 이후 검증 중단."); process.exit(1); }

  // ── Phase 1: 계좌 목록(accountSeq 후보 출력) ──
  console.log("\n[Phase 1] 계좌");
  await step("GET /accounts (accountSeq 확인)", async () => {
    const r = await fetch(`${BASE}/api/v1/accounts`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = (await r.json()) as { result?: { accountNo?: string; accountSeq?: number; accountType?: string }[] };
    const accts = d.result ?? [];
    if (!accts.length) return "계좌 없음";
    return accts.map((a) => `accountSeq=${a.accountSeq}(${a.accountType})`).join(", ") + "  → 이 중 하나를 TOSS_ACCOUNT_SEQ 로 설정";
  });

  // ── Phase 2: 시세·캔들(토큰만 — 어댑터 경유) ──
  console.log("\n[Phase 2] 시세·캔들(어댑터, 토큰만)");
  const got = getAdapter("toss");
  if (!got) { console.error("getAdapter('toss') null — 자격증명 확인."); process.exit(1); }
  const ad = got.adapter;
  await step(`getPrice(${KR})`, async () => { const p = await ad.getPrice(KR); return `${p.price} KRW`; });
  await step(`getPrice(${US})`, async () => { const p = await ad.getPrice(US); return `${p.price} USD`; });
  await step(`getCandles(${KR}, 1d, 5)`, async () => {
    const c = await (ad as { getCandles: (s: string, i: string, n: number) => Promise<{ date: string; close: number }[]> }).getCandles(KR, "1d", 5);
    if (!c.length) throw new Error("빈 캔들");
    return `${c.length}봉, 최신 ${c[c.length - 1].date} 종가 ${c[c.length - 1].close}`;
  });

  // ── Phase 3: 계좌·보유·미체결(계좌헤더 필요) ──
  console.log("\n[Phase 3] 계좌·보유·미체결(TOSS_ACCOUNT_SEQ 필요)");
  if (!(process.env.TOSS_ACCOUNT_SEQ ?? "").trim()) {
    console.log("  ⏭️  TOSS_ACCOUNT_SEQ 미설정 — Phase 1의 accountSeq를 설정 후 재실행하면 계좌/보유/미체결도 검증됩니다.");
  } else {
    await step("getBalance()", async () => { const b = await ad.getBalance(); return `총평가 ${b.totalAsset} / 현금 ${b.cashBalance} ${b.currency}`; });
    await step("getPositions()", async () => { const p = await ad.getPositions(); return `${p.length}종목` + (p[0] ? ` (예: ${p[0].symbol} ${p[0].quantity}주)` : ""); });
    await step("getOpenOrders(all)", async () => { const o = await (ad as { getOpenOrders: (s: string) => Promise<unknown[]> }).getOpenOrders(""); return `미체결 ${o.length}건`; });
  }

  console.log(`\n${pass === total ? "🟢" : "🟡"} 토스 읽기 E2E: ${pass}/${total} 통과`);
  console.log("ℹ️  주문 생성/취소는 이 스크립트에서 검증하지 않음(라이브 실주문 — env=live + LIVE_TRADING_ENABLED + 소액 수동검증으로만).");
  process.exit(pass === total ? 0 : 1);
}

main().catch((e) => { console.error("E2E 예외:", e instanceof Error ? e.message : e); process.exit(1); });
