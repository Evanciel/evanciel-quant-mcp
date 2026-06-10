/**
 * honesty-doc.test.ts — 정직성 회귀 가드(코드 로직 0, 문서/설명 ↔ 코드 동작 정합).
 *
 * 목적: 코덱스 냉정 평가가 지적한 "문서가 코드보다 더 강하게/덜 정확하게 말하는" 드리프트를
 * 빌드에서 잡는다. 진실의 원천 = 실제 코드 동작:
 *   - OOS 분할은 단일 70/30 홀드아웃(handlers.ts: Math.floor(len*0.7))이지 rolling walk-forward 아님.
 *   - 자율 봇 라이브 주문에는 per-order 2단계 토큰이 없다(runner는 게이트/하드리밋/멱등으로만 통제).
 *   - 라이브 안전 기본 캡 = USDT 100 (safety.ts LIVE_DEFAULTS_BY_CCY.USDT.cap).
 *   - create_bot은 mode:live도 받는다(스키마 enum) → "paper만 가능"은 거짓.
 * 텍스트만 검사(정규식). 코드 로직/머니패스/게이트/토큰/audit 불변.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("honesty — docs/tool descriptions ↔ actual code behavior", () => {
  it("no user-facing 'walk-forward' / '워크포워드' (OOS is a single 70/30 hold-out, not rolling walk-forward)", () => {
    // 코드 사실 재확인: 단일 홀드아웃 분할(앵커).
    const handlers = read("src/mcp-server/handlers.ts");
    expect(handlers, "handlers.ts must compute a single 70/30 split").toContain("Math.floor(data.length * 0.7)");

    for (const f of ["README.md", "README.ko.md", "CHANGELOG.md", "examples/usage.md", "src/mcp-server/index.ts"]) {
      const txt = read(f);
      expect(txt.toLowerCase(), `${f}: 'walk-forward' is misleading — OOS is a single 70/30 hold-out`).not.toContain("walk-forward");
      expect(txt, `${f}: '워크포워드' is misleading — use '홀드아웃'`).not.toContain("워크포워드");
    }
  });

  it("bots are honestly described as having NO per-order confirm token (token is manual-only)", () => {
    // 코드 사실: runner는 토큰 소비/발행 없음(consumeToken/mintToken은 live-handlers 전용).
    const runner = read("src/runner/runner.ts");
    expect(runner, "runner.ts must not mint/consume a per-order token for bots").not.toMatch(/consumeToken|mintToken/);

    // SECURITY/README는 '모든 주문에 2단계 토큰' 식 전칭(false)을 쓰지 말고, 봇은 토큰 없음을 명시해야 한다.
    const security = read("SECURITY.md");
    expect(security).not.toMatch(/every\s+real\/protective\s+order[^.]*two-step\s+confirm\s+token/i);
    expect(security.toLowerCase()).toContain("no per-order token");

    const readme = read("README.md");
    expect(readme.toLowerCase(), "README must state bots have no per-order token").toContain("no per-order token");

    // CONTRIBUTING(개발자 대면)도 같은 거짓을 쓰면 안 된다: (a) 'live-handlers.ts only'가 유일 경로라는 주장,
    // (b) 모든 실/보호 주문에 2단계 토큰이라는 전칭. 봇 머니패스는 runner.ts(두 번째 진입점)이고 봇엔 토큰이 없다.
    const contributing = read("CONTRIBUTING.md");
    expect(contributing, "CONTRIBUTING must not claim live-handlers.ts is the ONLY order path (runner.ts is a 2nd entry point)")
      .not.toMatch(/live-handlers\.ts['`]?\s+only/i);
    expect(contributing, "CONTRIBUTING must not present a universal 'all/every real & protective order ... two-step confirm token'")
      .not.toMatch(/(all|every)\s+real[\s\S]{0,400}?two-step\s+[`'"]?confirm\s*-?\s*token/i);
    expect(contributing.toLowerCase(), "CONTRIBUTING must state bots have no per-order token").toContain("no per-order token");
  });

  it("create_bot is described as live-capable (paper-fallback), not 'paper only' (schema enum accepts live)", () => {
    const schemas = read("src/mcp-server/schemas.ts");
    // mode enum이 실제로 live를 허용.
    expect(schemas).toMatch(/mode:\s*z\.enum\(\["paper",\s*"live"\]\)/);
    // 그런데 설명이 'paper만 가능'이라고 거짓말하면 안 됨.
    expect(schemas, "schemas.ts mode .describe must not claim 'paper만 가능'").not.toContain("paper만 가능");

    const index = read("src/mcp-server/index.ts");
    // create_bot 설명에서 미래형 거짓('라이브 실행은 v2.5')이 사라지고 게이트/폴백을 말해야 한다.
    expect(index, "create_bot description must not defer live to a future version").not.toContain("라이브 실행은 v2.5");
    expect(index, "create_bot description must mention paper-fallback gating").toContain("페이퍼 폴백");
  });

  it("live default cap text matches the code authority (USDT 100), not a stale 50", () => {
    // 코드 권위값: USDT cap=100.
    const safety = read("src/brokers/safety.ts");
    expect(safety, "safety.ts USDT default cap must be 100").toMatch(/USDT:\s*\{\s*cap:\s*100/);

    // 사용자 대면 문구에 '기본 (안전 )?캡 ... 50 USDT' 류의 거짓 기본 캡이 없어야 한다.
    const setup = read("SETUP-LIVE.md");
    const runbook = read("docs/mainnet-pilot-runbook.md");
    for (const [name, txt] of [["SETUP-LIVE.md", setup], ["mainnet-pilot-runbook.md", runbook]] as const) {
      expect(txt, `${name}: per-order default cap must read 100 USDT, not 50`).not.toMatch(/주문당\s*50\s*USDT/);
      expect(txt, `${name}: '기본 안전 캡(50 USDT)' is stale (code=100)`).not.toMatch(/기본 안전 캡\(50/);
    }
    // 대시보드 입력칸 placeholder/기본 안내가 100이어야 한다(코드 적용 캡과 일치).
    const server = read("src/dashboard/server.ts");
    expect(server, "dashboard livecap placeholder must be 100").toContain('id="livecap"');
    expect(server, "dashboard must not say '비우면 기본 50 USDT'").not.toContain("비우면 기본 50 USDT");
    expect(server, "dashboard cap default text must read 100 USDT").toContain("비우면 기본 100 USDT");
  });

  it("usage.md no longer contradicts itself ('does not place trades / v1 only' vs live BYOK tools)", () => {
    const usage = read("examples/usage.md");
    expect(usage, "usage.md must not claim it never places trades").not.toMatch(/does \*\*not\*\* place trades/i);
    expect(usage, "usage.md must not claim 'v1 is analysis ... only'").not.toMatch(/v1 is analysis/i);
    // 옵트인 라이브 거래 경로를 정직하게 언급(LIVE_TRADING_ENABLED 게이트).
    expect(usage).toContain("LIVE_TRADING_ENABLED");
  });
});
