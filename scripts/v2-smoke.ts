/**
 * v2-smoke.ts — v2 토대 E2E(키 불필요, 실 Binance 공개데이터).
 * save_composite → create_bot → tickBot(페이퍼) → get_bot_status → open_dashboard → /api/state 검증.
 * 임시 데이터 디렉토리 사용(스토어 오염 방지). 실행: npx tsx scripts/v2-smoke.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUANT_MCP_DATA_DIR = mkdtempSync(join(tmpdir(), "qmcp-smoke-"));

const B = await import("../src/mcp-server/bot-handlers.js");
const { tickBot } = await import("../src/runner/runner.js");

const log = (...a: unknown[]) => console.error(...a);
let fail = false;
const check = (cond: boolean, msg: string) => { log(cond ? "  ✅" : "  ❌", msg); if (!cond) fail = true; };

async function main() {
  log("=== quant-mcp v2 smoke (paper, real Binance) ===");

  // 1. 전략 저장(거의 항상 매수=보유 유도: rsi<90 buy / rsi>95 sell)
  const tree = {
    id: "leaf", type: "leaf", name: "always-ish",
    strategy: { id: "s", userId: "u", name: "s", description: "", symbol: "BTCUSDT",
      rules: [
        { id: "b", action: "buy", conditions: [{ id: "c1", indicator: "rsi", params: { period: 14 }, operator: "lt", value: 90 }], quantityPercent: 100 },
        { id: "s", action: "sell", conditions: [{ id: "c2", indicator: "rsi", params: { period: 14 }, operator: "gt", value: 95 }], quantityPercent: 100 },
      ], isActive: true, createdAt: "2025-01-01", updatedAt: "2025-01-01" },
  };
  const sv = B.saveComposite({ name: "스모크 전략", tree, symbol: "BTCUSDT" });
  check(sv.ok === true && !!sv.compositeStrategyId, "save_composite → id 반환");

  // 2. 봇 생성(페이퍼)
  const cb = B.createBot({ name: "스모크 봇", compositeStrategyId: sv.compositeStrategyId!, capital: 1_000_000 });
  check(cb.ok === true && !!cb.botId, "create_bot → paper 봇 생성");
  // live 봇 생성은 허용되지만(SETUP-LIVE 체계), 키/마스터스위치 게이트 통과 전엔 페이퍼 폴백이 안전 계약.
  const lv = B.createBot({ name: "x", compositeStrategyId: sv.compositeStrategyId!, mode: "live" });
  check(lv.ok === true && /페이퍼 폴백/.test(lv.note ?? ""), "create_bot mode=live → 게이트 전 페이퍼 폴백(안전)");

  // 3. 페이퍼 틱(실 Binance 데이터, core 엔진)
  const r1 = await tickBot(cb.botId!);
  log("  tick1:", JSON.stringify(r1));
  check(["buy", "hold"].includes(r1.action), "tickBot 1회 실행(실데이터)");

  // 4. 봇 상태 — 포지션 존재 확인
  const st = B.getBotStatus({ botId: cb.botId! });
  check(st.ok === true, "get_bot_status OK");
  const hasPos = !!(st as { positionState?: unknown }).positionState;
  log("  positionState:", JSON.stringify((st as { positionState?: unknown }).positionState));
  check(hasPos, "페이퍼 포지션 생성됨(진입)");

  // 5. 대시보드 + /api/state 검증
  const dash = await B.openDashboard({ port: 7799 });
  check(dash.ok === true && dash.url.includes("127.0.0.1:7799"), "open_dashboard → 127.0.0.1 URL+토큰");
  const token = new URL(dash.url).searchParams.get("token");
  const res = await fetch(`http://127.0.0.1:7799/api/state?token=${token}`);
  const state = await res.json() as { bots: { symbol: string; positions?: { symbol: string; entryAvg: number }[] }[] };
  check(res.status === 200 && Array.isArray(state.bots), "/api/state 200 + bots[]");
  check(state.bots.some((b) => (b.positions ?? []).some((p) => p.symbol === "BTCUSDT" && p.entryAvg > 0)), "대시보드 state에 봇 포지션 노출");
  check((await fetch(`http://127.0.0.1:7799/api/state`)).status === 401, "토큰 없으면 401(보안)");

  log(fail ? "\n❌ SMOKE FAIL" : "\n✅ V2 SMOKE PASS — 전략조립→로컬봇→페이퍼실행→HTML대시보드 전경로 동작(키 0)");
}
main().catch((e) => { log("fatal:", e); fail = true; }).finally(() => {
  try { rmSync(process.env.QUANT_MCP_DATA_DIR!, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(fail ? 1 : 0);
});
