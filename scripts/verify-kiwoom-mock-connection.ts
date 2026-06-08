/**
 * verify-kiwoom-mock-connection.ts — 키움 모의투자 키로 읽기전용 연결 검증(주문 없음).
 *   OAuth2 토큰 발급(au10001) → 잔고(kt00018) → 현재가(005930 삼성전자) 조회.
 * 실행: npx tsx scripts/verify-kiwoom-mock-connection.ts (.env.local 자동 로드)
 * 안전: KIWOOM_ENV=mock이면 mockapi.kiwoom.com(가짜돈). live면 게이트가 마스터스위치 확인.
 */
import { readFileSync } from "node:fs";
try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { console.error(".env.local 없음"); process.exit(1); }

const { getAdapter } = await import("../src/brokers/index.js");
const { liveGate, loadCredentials, mask } = await import("../src/brokers/safety.js");

console.log("=== 키움(Kiwoom) 모의 연결 검증 (읽기전용) ===");
const c = loadCredentials("kiwoom");
console.log("env:", c?.env, "| appkey:", mask(c?.appkey), "| secretkey:", mask(c?.secretkey));
if (!c) { console.log("❌ 키 미설정 — .env.local의 KIWOOM_APPKEY/KIWOOM_SECRETKEY 확인"); process.exit(1); }
const gate = liveGate("kiwoom");
console.log("게이트:", gate.allowed, `(${gate.env})`, "—", gate.reason);

const got = getAdapter("kiwoom");
if (!got) { console.log("❌ 어댑터 생성 실패"); process.exit(1); }

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

try {
  const bal = await got.adapter.getBalance(); // 내부에서 토큰 발급 → 인증 검증
  ok(bal != null, `잔고 조회(=토큰 발급 OK): ${JSON.stringify(bal)}`);
} catch (e) { ok(false, `잔고/인증 실패: ${e instanceof Error ? e.message : String(e)}`); }

try {
  const px = await got.adapter.getPrice("005930"); // 삼성전자
  ok(px?.price > 0, `현재가 005930(삼성전자): ${px?.price}`);
} catch (e) { ok(false, `현재가 조회 실패: ${e instanceof Error ? e.message : String(e)}`); }

try {
  const pos = await got.adapter.getPositions();
  ok(Array.isArray(pos), `보유종목: ${pos.length}개`);
} catch (e) { ok(false, `보유종목 조회 실패: ${e instanceof Error ? e.message : String(e)}`); }

console.log(fail === 0 ? "\n🟢 PASS — 키움 모의 연결·인증 OK. 주문 E2E 진행 가능." : "\n🔴 FAIL — 위 오류 확인(앱키/시크릿/모의가입 여부).");
process.exit(fail === 0 ? 0 : 1);
