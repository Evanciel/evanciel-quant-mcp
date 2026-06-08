/**
 * verify-dashboard-credentials.ts — 대시보드 자격증명 엔드포인트 라이브 E2E(임시 데이터디렉터리).
 * 검증: 토큰 없으면 401 / 잘못된 Host 403 / GET=마스킹 상태 / POST=upsert + 원문 미반환 / 파일 저장.
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

  console.log(`\n${process.exitCode ? "🔴 일부 실패" : "🟢 대시보드 자격증명 E2E ALL PASS"}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
main().catch((e) => { console.error("오류:", e); rmSync(dir, { recursive: true, force: true }); process.exit(1); });
