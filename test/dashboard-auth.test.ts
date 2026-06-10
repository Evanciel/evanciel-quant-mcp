/**
 * dashboard-auth.test.ts — 대시보드 인증 경계(P1-B) 회귀.
 * 검증: 부트스트랩 302+HttpOnly 세션쿠키(qm_sid_<port>, 값≠토큰) / `/` 무인증 401(과거 토큰-임베드 HTML 무단공개 버그 재발 방지) /
 * 쿠키+쿼리토큰 듀얼 억셉트 / Host 위조 403 / POST Origin 정밀검사(포트 포함) /
 * /api/live 2단계 confirmToken(프리뷰 무부작용·해시 바인딩·단일사용·끄기 1샷·audit) / /vendor 셀프호스팅 / SSE 쿠키 인증.
 * 위생: QUANT_MCP_DATA_DIR=tmp를 import 전에 설정(실홈 ~/.quant-mcp 오염 금지), 에페메랄 포트(0), afterAll에서 정리.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, readFileSync } from "node:fs";
import { request } from "node:http";

const dir = join(tmpdir(), `qm-dash-auth-${process.pid}`);
process.env.QUANT_MCP_DATA_DIR = dir; // 모든 import 전 — store/credentials/audit이 임시 디렉터리만 쓰게

const S = await import("../src/dashboard/server.js");
const C = await import("../src/setup/credentials.js");

let base = "", token = "", port = 0, cookie = "";

/** fetch는 Host/Origin 등 일부 헤더 제어가 불안정하므로 raw http로 상태코드만 확인. */
function raw(path: string, headers: Record<string, string>, method = "GET"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => { res.resume(); resolve(res.statusCode || 0); });
    req.on("error", reject); req.end();
  });
}

beforeAll(async () => {
  const r = await S.startDashboard(0); // 에페메랄 포트 — 다른 테스트/스크립트(7788/7797/7799)와 충돌 없음
  port = r.port; base = `http://127.0.0.1:${port}`;
  token = new URL(r.url).searchParams.get("token")!;
});

afterAll(async () => {
  C.disableLive(); // 테스트가 켠 마스터 스위치 복원(임시 dir 파일 + process.env 동시)
  delete process.env.LIVE_TRADING_ENABLED; delete process.env.LIVE_MAX_NOTIONAL; delete process.env.LIVE_SYMBOL_ALLOWLIST;
  await S.stopDashboard();
  // best-effort: Windows에선 node:sqlite가 store.db 핸들을 유지해 EBUSY 가능(닫기 API 없음) — 임시 dir 잔존 허용(기존 테스트 관례와 동일)
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("대시보드 인증 경계(P1-B)", () => {
  it("① 부트스트랩: 유효 토큰 → 302+HttpOnly/Lax 포트별 세션쿠키(값≠토큰), 위조 토큰 → 401+쿠키 미발급", async () => {
    const boot = await fetch(`${base}/?token=${token}`, { redirect: "manual" });
    expect(boot.status).toBe(302);
    expect(boot.headers.get("location")).toBe("/");
    const setc = boot.headers.get("set-cookie") || "";
    expect(setc).toContain(`qm_sid_${port}=`);
    expect(setc).toMatch(/HttpOnly/i);
    expect(setc).toMatch(/SameSite=Lax/i);
    expect(setc).toMatch(/Path=\//);
    cookie = setc.split(";")[0];
    expect(cookie.split("=")[1]).not.toBe(token); // 세션값은 부트스트랩 토큰과 별개(세션 분리)
    const forged = await fetch(`${base}/?token=${"0".repeat(32)}`, { redirect: "manual" });
    expect(forged.status).toBe(401);
    expect(forged.headers.get("set-cookie")).toBeNull();
  });

  it("② 쿠키로 GET / → 200 HTML(토큰 미포함·unpkg 제거·vendor 참조), 무쿠키 GET / → 401(토큰 무단공개 구멍 폐쇄)", async () => {
    const page = await fetch(`${base}/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain("자동매매");
    expect(body.includes(token)).toBe(false); // INV-D5: HTML에 토큰 비에코
    expect(body).not.toContain("const TOKEN");
    expect(body).not.toContain("unpkg.com");
    expect(body).toContain("/vendor/lightweight-charts.standalone.js");
    const noauth = await fetch(`${base}/`);
    expect(noauth.status).toBe(401);
    expect((await noauth.text()).includes(token)).toBe(false);
  });

  it("③ 인증 fail-closed 전수: 무인증 401(GET/POST 전 라우트), 변조·길이불일치 쿠키 401, favicon 204, 듀얼 억셉트 유지", async () => {
    for (const p of ["/api/state", "/api/candles", "/api/credentials", "/api/alerts", "/api/balances", "/api/prices", "/api/account", "/events"]) {
      expect((await fetch(`${base}${p}`)).status, `GET ${p}`).toBe(401);
    }
    for (const p of ["/api/order", "/api/protect", "/api/protect/cancel", "/api/live", "/api/credentials", "/api/alerts"]) {
      const r = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(r.status, `POST ${p}`).toBe(401); // 본문 파싱 전 차단 = 머니패스 도달 0
    }
    expect((await fetch(`${base}/favicon.ico`)).status).toBe(204);
    expect((await fetch(`${base}/api/state`, { headers: { cookie: `qm_sid_${port}=` + "f".repeat(32) } })).status).toBe(401); // 변조(같은 길이)
    expect((await fetch(`${base}/api/state`, { headers: { cookie: `qm_sid_${port}=abc` } })).status).toBe(401); // 길이 불일치 — safeEq가 throw하지 않음
    expect((await fetch(`${base}/api/state?token=${token}`)).status).toBe(200); // 쿼리토큰 폴백(v2-smoke/verify 스크립트 계약 보존)
    const okC = await fetch(`${base}/api/state`, { headers: { cookie } });
    expect(okC.status).toBe(200);
    expect(Array.isArray((await okC.json() as { bots?: unknown[] }).bots)).toBe(true);
  });

  it("④ Host 위조 → 403 (DNS rebinding 차단, 유효 쿠키 동봉이어도)", async () => {
    expect(await raw("/api/state", { host: "evil.com", cookie })).toBe(403);
  });

  it("⑤ Origin 정밀검사(POST 한정): 교차출처/타포트/타스킴 403, 자기 오리진·Origin 부재 통과, GET 미적용", async () => {
    const h = (origin?: string) => ({ host: `127.0.0.1:${port}`, cookie, "content-type": "application/json", ...(origin ? { origin } : {}) });
    expect(await raw("/api/live", h("http://evil.com"), "POST")).toBe(403);
    expect(await raw("/api/live", h(`http://127.0.0.1:${port + 1}`), "POST")).toBe(403); // 포트 불일치 — SameSite 포트 무시 보완
    expect(await raw("/api/live", h(`https://127.0.0.1:${port}`), "POST")).toBe(403); // 스킴 불일치
    expect(await raw("/api/live", h(`http://127.0.0.1:${port}`), "POST")).toBe(400); // 게이트 통과 → 빈 바디 enable 미명시 400
    expect(await raw("/api/live", h(undefined), "POST")).toBe(400); // Origin 부재(curl) 통과 → 400
    expect(await raw("/api/state", { host: `127.0.0.1:${port}`, cookie, origin: "http://evil.com" })).toBe(200); // GET은 미적용(읽기전용·교차출처 응답 비가독)
  });

  it("⑥ /api/live 2단계: enable 미명시 400 / preview 무부작용 / bogus·인자변조·재사용 거절 / 동일인자 확정 / 끄기 1샷 / audit", async () => {
    type LiveResp = { ok?: boolean; phase?: string; confirmToken?: string; live?: { masterOn?: boolean; maxNotional?: string } };
    const post = (body: unknown) => fetch(`${base}/api/live`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
    const postJ = async (body: unknown) => (await (await post(body)).json()) as LiveResp;
    expect((await post({})).status).toBe(400); // 과거 fail-open(빈 바디=켜짐) 제거 회귀 가드
    expect((await post({ maxNotional: "30" })).status).toBe(400);
    const pv = await postJ({ enable: true, maxNotional: "30", allowlist: "BTCUSDT" });
    expect(pv.ok).toBe(true); expect(pv.phase).toBe("preview"); expect(typeof pv.confirmToken).toBe("string");
    expect(C.liveSettingsStatus().masterOn).toBe(false); // 프리뷰는 무부작용
    const bad = await postJ({ enable: true, maxNotional: "30", allowlist: "BTCUSDT", confirmToken: "f".repeat(24) });
    expect(bad.ok).toBe(false);
    expect(C.liveSettingsStatus().masterOn).toBe(false);
    const pv2 = await postJ({ enable: true, maxNotional: "30", allowlist: "BTCUSDT" });
    const tampered = await postJ({ enable: true, maxNotional: "30", allowlist: "ETHUSDT", confirmToken: pv2.confirmToken });
    expect(tampered.ok).toBe(false); // 해시 바인딩 — 프리뷰와 다른 인자로 확정 불가
    expect(C.liveSettingsStatus().masterOn).toBe(false);
    const pv3 = await postJ({ enable: true, maxNotional: "30", allowlist: "BTCUSDT" });
    const en = await postJ({ enable: true, maxNotional: "30", allowlist: "BTCUSDT", confirmToken: pv3.confirmToken });
    expect(en.ok).toBe(true); expect(en.phase).toBe("executed"); expect(en.live?.masterOn).toBe(true); expect(en.live?.maxNotional).toBe("30");
    const reuse = await postJ({ enable: true, maxNotional: "30", allowlist: "BTCUSDT", confirmToken: pv3.confirmToken });
    expect(reuse.ok).toBe(false); // 단일사용
    const dis = await postJ({ enable: false });
    expect(dis.ok).toBe(true); expect(dis.live?.masterOn).toBe(false); // 긴급 OFF는 1샷(킬스위치 무마찰)
    const auditLog = readFileSync(join(dir, "audit.jsonl"), "utf8");
    expect(auditLog).toContain('"event":"live_toggle"');
    expect(auditLog).toContain('"action":"enable"');
    expect(auditLog).toContain('"action":"disable"');
  });

  it("⑦ /vendor 셀프호스팅: 무인증 200 JS(공개 정적), 실제 번들(>100KB)", async () => {
    const r = await fetch(`${base}/vendor/lightweight-charts.standalone.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") || "").toContain("javascript");
    expect((await r.text()).length).toBeGreaterThan(100_000);
  });

  it("⑧ SSE /events: 쿠키 인증 → 200 text/event-stream + 첫 프레임 JSON(bots[])", async () => {
    const ac = new AbortController();
    const r = await fetch(`${base}/events`, { headers: { cookie }, signal: ac.signal });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") || "").toContain("text/event-stream");
    const reader = r.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text.startsWith("data: ")).toBe(true);
    const j = JSON.parse(text.slice(6).split("\n")[0]);
    expect(Array.isArray(j.bots)).toBe(true);
    ac.abort(); // 연결 정리(서버 close 리스너가 인터벌 해제)
  }, 10_000);
});
