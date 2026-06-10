/**
 * verify-dashboard-credentials.ts — 대시보드 자격증명 엔드포인트 라이브 E2E(임시 데이터디렉터리).
 * 검증: 토큰 없으면 401 / 잘못된 Host 403 / 부트스트랩 302+HttpOnly 세션쿠키 / `/` 무인증 401(토큰 비공개) /
 *       벤더링(/vendor, unpkg 제거) / GET=마스킹 상태 / POST=upsert + 원문 미반환 / 파일 저장 /
 *       /api/live 켜기=2단계 confirmToken(enable 명시 필수, 프리뷰 무부작용) · 끄기=1샷.
 * 주: API 호출은 쿼리토큰 경로 — 스크립트 호환 듀얼 억셉트의 살아있는 검증.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";

/** fetch는 Host 헤더 오버라이드를 금지(forbidden header)하므로 raw http로 Host 위조 시도. */
function rawStatus(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { host } }, (res) => {
      res.resume(); resolve(res.statusCode || 0);
    });
    req.on("error", reject); req.end();
  });
}

const dir = join(tmpdir(), `qmc-dash-cred-${process.pid}`);
process.env.QUANT_MCP_DATA_DIR = dir;

const { startDashboard } = await import("../src/dashboard/server.js");
const C = await import("../src/setup/credentials.js");

function ok(cond: boolean, msg: string) { console.log(`${cond ? "✅" : "❌"} ${msg}`); if (!cond) process.exitCode = 1; }

async function main() {
  const { url, port } = await startDashboard(7799);
  const token = new URL(url).searchParams.get("token")!;
  const base = `http://127.0.0.1:${port}`;

  // 0) 부트스트랩 → 302 + HttpOnly/Lax 포트별 세션쿠키(값≠토큰) / `/`는 쿠키 전용 / HTML 토큰 미포함 / 벤더링
  const boot = await fetch(`${base}/?token=${token}`, { redirect: "manual" });
  const setc = boot.headers.get("set-cookie") || "";
  ok(boot.status === 302 && (boot.headers.get("location") || "") === "/", `부트스트랩 → 302 Location:/ (got ${boot.status})`);
  ok(setc.includes(`qm_sid_${port}=`) && /HttpOnly/i.test(setc) && /SameSite=Lax/i.test(setc), "부트스트랩 → HttpOnly+Lax 포트별 세션쿠키 발급");
  ok(!setc.includes(token), "쿠키값 ≠ 부트스트랩 토큰(세션 분리)");
  const sid = setc.split(";")[0];
  ok((await fetch(`${base}/`)).status === 401, "무인증 GET / → 401(토큰 무단공개 구멍 폐쇄)");
  const page = await (await fetch(`${base}/`, { headers: { cookie: sid } })).text();
  ok(!page.includes(token), "HTML에 토큰 미포함(const TOKEN 전역 제거)");
  ok(!page.includes("unpkg.com") && page.includes("/vendor/lightweight-charts.standalone.js"), "외부 CDN 제거 + /vendor 셀프호스팅");
  const vend = await fetch(`${base}/vendor/lightweight-charts.standalone.js`);
  ok(vend.status === 200 && (vend.headers.get("content-type") || "").includes("javascript"), "GET /vendor → 200 JS(무인증 공개 정적)");

  // 1) 토큰 없이 GET → 401
  const r401 = await fetch(`${base}/api/credentials`);
  ok(r401.status === 401, `토큰 없는 GET → 401 (got ${r401.status})`);

  // 2) 잘못된 Host 헤더 → 403 (DNS-rebinding 차단). raw http로 Host 위조.
  const hostStatus = await rawStatus(port, `/api/credentials?token=${token}`, "evil.com");
  ok(hostStatus === 403, `잘못된 Host → 403 (got ${hostStatus})`);

  // 3) GET → 마스킹 상태(미설정)
  const g0 = await (await fetch(`${base}/api/credentials?token=${token}`)).json();
  ok(g0.ok && g0.status.binance.configured === false, "초기 GET: binance 미설정");
  ok(!!g0.fields.binance, "GET: 폼 필드 목록 제공");

  // 4) POST upsert(시크릿) → 원문 미반환 + 마스킹만
  const secret = "TESTSECRETKEY1234567890";
  const post = await fetch(`${base}/api/credentials?token=${token}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ BINANCE_API_KEY: secret, BINANCE_API_SECRET: "anotherSecret999", BINANCE_ENV: "testnet", NOT_A_KEY: "evil" }),
  });
  const pj = await post.json();
  ok(pj.ok && pj.written === 3, `POST: 화이트리스트 3개 저장(NOT_A_KEY 거부) (written=${pj.written})`);
  ok(!JSON.stringify(pj).includes(secret), "POST 응답에 시크릿 원문 미포함(마스킹만)");
  ok(pj.status.binance.configured === true, "POST 후 binance configured=true");

  // 5) 파일 저장 + chmod 의도
  const path = C.credentialsPath();
  ok(existsSync(path), `credentials.env 파일 생성: ${path}`);
  ok(readFileSync(path, "utf8").includes(`BINANCE_API_KEY=${secret}`), "파일에 키 저장됨(소유자 전용 파일)");

  // 6) 라이브 모드 토글: enable 미명시 400(과거 fail-open 제거) → 프리뷰(무부작용) → 가짜토큰 거절 → 확정 → 끄기 1샷
  const implicit = await fetch(`${base}/api/live?token=${token}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxNotional: "30" }),
  });
  ok(implicit.status === 400, `enable 미명시 POST /api/live → 400 (fail-open 제거) (got ${implicit.status})`);
  const pv = await (await fetch(`${base}/api/live?token=${token}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enable: true, maxNotional: "30", allowlist: "BTCUSDT" }),
  })).json();
  ok(pv.ok === true && pv.phase === "preview" && !!pv.confirmToken, "켜기 1단계 → preview + confirmToken");
  const st0 = await (await fetch(`${base}/api/credentials?token=${token}`)).json();
  ok(st0.live.masterOn === false, "프리뷰만으로는 마스터 OFF 유지(무부작용)");
  const badTok = await (await fetch(`${base}/api/live?token=${token}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enable: true, maxNotional: "30", allowlist: "BTCUSDT", confirmToken: "bogus" }),
  })).json();
  ok(badTok.ok === false, "가짜 confirmToken → 거절(fail-closed)");
  const en = await (await fetch(`${base}/api/live?token=${token}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enable: true, maxNotional: "30", allowlist: "BTCUSDT", confirmToken: pv.confirmToken }),
  })).json();
  ok(en.ok === true && en.phase === "executed" && en.live.masterOn === true, "확정(동일 인자+토큰) → masterOn=true");
  ok(en.live.maxNotional === "30" && en.live.allowlist === "BTCUSDT", `라이브 한도 적용(캡=${en.live.maxNotional}, 허용=${en.live.allowlist})`);
  const dis = await (await fetch(`${base}/api/live?token=${token}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enable: false }),
  })).json();
  ok(dis.ok && dis.live.masterOn === false, "POST /api/live 끄기 → masterOn=false(긴급 페이퍼)");
  const liveNoAuth = await fetch(`${base}/api/live`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  ok(liveNoAuth.status === 401, `토큰 없는 /api/live → 401 (got ${liveNoAuth.status})`);

  console.log(`\n${process.exitCode ? "🔴 일부 실패" : "🟢 대시보드 자격증명 E2E ALL PASS"}`);
  cleanup();
  process.exit(process.exitCode || 0);
}
// best-effort: Windows에선 node:sqlite가 store.db 핸들을 유지해 EBUSY 가능(닫기 API 없음) — 임시 dir 잔존 허용
function cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } }
main().catch((e) => { console.error("오류:", e); cleanup(); process.exit(1); });
