/**
 * toss-wiring.test.ts — 배선 불변식 가드(설계 §8 L1 #10 no-coerce-to-binance).
 *
 * 러너의 broker cast는 인라인 리터럴 `["binance","kis","kiwoom","toss"].includes(bot.broker) ? bot.broker : "binance"`라
 * 한 곳이라도 'toss'를 누락하면 toss 봇이 조용히 'binance'로 강등돼 **다른 거래소에 실주문**이 나간다(적대검증 M1 계열).
 * tsc/일반 테스트로는 못 잡으므로, 소스의 모든 cast 가드가 'toss'를 포함하는지 직접 단언한다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("toss 배선 불변식 — no-coerce-to-binance (design §8 L1 #10)", () => {
  it("runner.ts의 모든 broker cast 가드가 'toss'를 포함(누락 시 silent binance 강등)", () => {
    const src = readFileSync(join(root, "src/runner/runner.ts"), "utf8");
    const casts = [...src.matchAll(/\[([^\]]*)\]\.includes\(bot\.broker\)\s*\?\s*bot\.broker\s*:\s*"binance"/g)];
    expect(casts.length).toBeGreaterThanOrEqual(5); // 98/224/457/729/1143 — 최소 5곳
    for (const m of casts) expect(m[1]).toContain('"toss"');
  });

  it("coercion 로직: 등록 브로커는 보존, 미등록은 binance 폴백", () => {
    const coerce = (b: string) => (["binance", "kis", "kiwoom", "toss"].includes(b) ? b : "binance");
    expect(coerce("toss")).toBe("toss");
    expect(coerce("kiwoom")).toBe("kiwoom");
    expect(coerce("kis")).toBe("kis");
    expect(coerce("bogus")).toBe("binance");
  });

  it("schemas.ts broker enum이 'toss'를 허용", () => {
    const src = readFileSync(join(root, "src/mcp-server/schemas.ts"), "utf8");
    const enums = [...src.matchAll(/z\.enum\(\[([^\]]*)\]\)\.default\("binance"\)/g)];
    expect(enums.length).toBeGreaterThanOrEqual(2); // createBotShape.broker + brokerEnum
    for (const m of enums) expect(m[1]).toContain('"toss"');
  });
});
