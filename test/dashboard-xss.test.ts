/**
 * dashboard-xss.test.ts — 저장형 XSS 회귀(출력 인코딩 + 입력 좁히기).
 * 배경: esc()가 &<>만 이스케이프하고 "·'를 통과시켜, 불신 입력(공격자 제어 broker)이
 *   data-broker="..." 속성 컨텍스트를 브레이크아웃 → innerHTML 파싱 시 on* 핸들러 활성 →
 *   동일오리진(127.0.0.1)에서 머니패스(/api/order·/api/live) 호출 가능했던 결함.
 * 검증:
 *   ① 실제 서빙된 HTML에서 esc() 정의를 추출·실행 → "·'가 엔티티로 이스케이프(속성 브레이크아웃 차단).
 *   ② create_bot 입력 스키마(createBotShape.broker)가 enum 고정 → 공격 페이로드 broker 거부(심층방어).
 *   ③ name/symbol 길이·charset 가드(DoS·주입 표면 축소).
 * 위생: QUANT_MCP_DATA_DIR=tmp를 import 전 설정(실홈 오염 금지), 에페메랄 포트(0), afterAll 정리.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { z } from "zod";

const dir = join(tmpdir(), `qm-dash-xss-${process.pid}`);
process.env.QUANT_MCP_DATA_DIR = dir; // 모든 import 전 — store/credentials/audit이 임시 디렉터리만 쓰게

const S = await import("../src/dashboard/server.js");
const { createBotShape } = await import("../src/mcp-server/schemas.js");

let base = "", token = "", port = 0, cookie = "";

beforeAll(async () => {
  const r = await S.startDashboard(0); // 에페메랄 포트
  port = r.port; base = `http://127.0.0.1:${port}`;
  token = new URL(r.url).searchParams.get("token")!;
  const boot = await fetch(`${base}/?token=${token}`, { redirect: "manual" });
  cookie = (boot.headers.get("set-cookie") || "").split(";")[0];
});

afterAll(async () => {
  await S.stopDashboard();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
});

/** 서빙된 HTML 본문에서 `function esc(s){...}` 정의를 균형 중괄호로 추출해 실행 가능한 함수로 복원(실제 출하 코드 검증). */
function extractEsc(html: string): (s: unknown) => string {
  const start = html.indexOf("function esc(s){");
  if (start < 0) throw new Error("esc() 정의를 서빙 HTML에서 찾지 못함");
  let depth = 0, end = -1;
  for (let i = html.indexOf("{", start); i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error("esc() 본문 닫는 중괄호를 찾지 못함");
  const src = html.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`${src}; return esc;`)() as (s: unknown) => string;
}

describe("대시보드 저장형 XSS 회귀", () => {
  it("① 서빙된 esc()가 따옴표(\"·')까지 이스케이프 — 속성 컨텍스트 브레이크아웃 차단", async () => {
    const html = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    const esc = extractEsc(html);

    // 핵심: 따옴표가 통과하면 data-broker="..." 를 깨고 on* 핸들러를 주입할 수 있음.
    expect(esc('"')).toBe("&quot;");
    expect(esc("'")).toBe("&#39;");
    expect(esc("&")).toBe("&amp;");
    expect(esc("<")).toBe("&lt;");
    expect(esc(">")).toBe("&gt;");

    // 실제 공격 페이로드: data-broker 속성 브레이크아웃 → onmouseover 핸들러 주입 시도.
    const payload = 'x" onmouseover=fetch(`/api/live`,{method:`POST`}) z="';
    const escaped = esc(payload);
    // 속성을 끝낼 수 있는 리터럴 따옴표가 출력에 남으면 안 됨(브레이크아웃 불가).
    expect(escaped).not.toContain('"');
    expect(escaped).toContain("&quot;");
    // data-broker="<escaped>" 로 감쌌을 때, 닫는 따옴표는 우리가 붙인 1쌍뿐이어야 함.
    const attr = `data-broker="${escaped}"`;
    expect(attr.match(/"/g)!.length).toBe(2);
  });

  it("② create_bot broker는 enum 고정 — 임의/공격 페이로드 문자열 거부(심층방어)", () => {
    const broker = createBotShape.broker;
    // 정상 브로커는 통과.
    expect(broker.parse("binance")).toBe("binance");
    expect(broker.parse("kis")).toBe("kis");
    expect(broker.parse("kiwoom")).toBe("kiwoom");
    // 공격 페이로드(속성 브레이크아웃) broker는 입구에서 거절.
    expect(broker.safeParse('x" onmouseover=fetch(`/api/live`) z="').success).toBe(false);
    expect(broker.safeParse("BINANCE").success).toBe(false); // 대소문자 임의값도 거부(화이트리스트)
    // 생략 시 기존 기본값(binance) 유지 — 페이퍼 기본 동작 불변.
    expect(z.object({ broker }).parse({}).broker).toBe("binance");
  });

  it("③ name/symbol 길이·charset 가드(DoS·주입 표면 축소, 기존 정상값은 통과)", () => {
    const name = createBotShape.name;
    const symbol = createBotShape.symbol;
    // 정상값 통과.
    expect(name.parse("내 RSI 봇")).toBe("내 RSI 봇");
    expect(symbol.parse("BTCUSDT")).toBe("BTCUSDT");
    expect(symbol.parse(undefined)).toBeUndefined(); // optional 유지
    // 빈 이름·과도 길이 거부.
    expect(name.safeParse("").success).toBe(false);
    expect(name.safeParse("a".repeat(121)).success).toBe(false);
    // 심볼 화이트리스트 외 문자(따옴표·꺾쇠 등) 거부.
    expect(symbol.safeParse('A"B').success).toBe(false);
    expect(symbol.safeParse("<script>").success).toBe(false);
  });
});
