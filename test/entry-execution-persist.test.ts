/**
 * entry-execution-persist.test.ts — audit P1-5 PR-2: entry_execution 영속 + Zod 검증.
 *   ① insertComposite → getComposite 라운드트립(JSON 직렬화 보존), 미지정=null(시장가 기본)
 *   ② entryExecutionSchema clamp 범위 검증(저장 시 잘못된 값 거절; 엔진 resolveEntryFill은 런타임 재클램프=방어)
 */
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-entryexec-${process.pid}`);

import * as store from "../src/store/db.js";
import { entryExecutionSchema } from "../src/mcp-server/schemas.js";

const baseComposite = { name: "ee", root_node: {}, symbol: "BTCUSDT", market: "spot" as const, leverage: 1, stop_loss_percent: null, take_profit_percent: null, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null };

describe("P1-5 PR-2: entry_execution 영속", () => {
  it("insertComposite → getComposite 라운드트립(entry_execution 보존)", () => {
    const ee = { type: "limit", limitOffsetPct: -1, timeoutBars: 3, maxSlippagePct: 0.5 };
    const row = store.insertComposite({ ...baseComposite, entry_execution: ee });
    expect(store.getComposite(row.id)?.entry_execution).toEqual(ee);
  });
  it("미지정 → null(시장가 기본, 레거시)", () => {
    const row = store.insertComposite({ ...baseComposite, name: "m" });
    expect(store.getComposite(row.id)?.entry_execution).toBeNull();
  });
});

describe("P1-5 PR-2: entryExecutionSchema 범위 검증", () => {
  it("유효값 통과", () => {
    expect(entryExecutionSchema.safeParse({ type: "limit", limitOffsetPct: -2, timeoutBars: 5, maxSlippagePct: 1 }).success).toBe(true);
    expect(entryExecutionSchema.safeParse({ type: "market" }).success).toBe(true);
  });
  it("범위 초과/형식오류 거절", () => {
    expect(entryExecutionSchema.safeParse({ type: "limit", maxSlippagePct: 10 }).success).toBe(false); // >5
    expect(entryExecutionSchema.safeParse({ type: "limit", timeoutBars: 100 }).success).toBe(false);   // >50
    expect(entryExecutionSchema.safeParse({ type: "limit", limitOffsetPct: 5 }).success).toBe(false);  // >0(현재가 위 매수 금지)
    expect(entryExecutionSchema.safeParse({ type: "bogus" }).success).toBe(false);                     // enum
  });
});
