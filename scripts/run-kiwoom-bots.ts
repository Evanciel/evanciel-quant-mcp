/**
 * run-kiwoom-bots.ts — 키움 모의로 KR 주식 전략봇 3개 생성 + tick(실 KR 일봉 데이터 평가 + mock 주문).
 *   데이터=키움 ka10081 일봉(getCandles), 실행=키움 어댑터 mock 주문(mode=live, 게이트 mock 통과).
 * 실행: npx tsx scripts/run-kiwoom-bots.ts (.env.local KIWOOM_ENV=mock + 키 필요). 가짜돈, 실거래(메인넷) OFF.
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
if ((process.env.KIWOOM_ENV || "mock") !== "mock") { console.error("❌ KIWOOM_ENV=mock 아님 — 안전중단"); process.exit(1); }
// 데모 전용 store(격리) + KR 1주 살 수 있는 캡 + KR 종목 allowlist.
process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-kiwoom-bots`);
// ⚠️ KR 데모용 강제 오버라이드: .env.local은 크립토용(LIVE_MAX_NOTIONAL=50 USDT / allowlist=BTC,ETH)이라
//   그대로면 KR 주문이 캡·allowlist에서 차단됨. KR 종목·KRW 캡으로 덮어씀(모의=가짜돈).
process.env.LIVE_MAX_NOTIONAL = "2000000"; // KRW 2백만(모의)
process.env.LIVE_SYMBOL_ALLOWLIST = "005930,035720,035420";

const store = await import("../src/store/db.js");
const { tickBot } = await import("../src/runner/runner.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = new Date();

const leaf = (sym: string, buyOp: string, buyV: number, sellOp: string, sellV: number): any => ({
  id: "l", type: "leaf", name: sym, strategy: {
    id: "s", userId: "u", name: sym, description: "", symbol: sym,
    rules: [
      { id: "b", action: "buy", conditions: [{ id: "cb", indicator: "rsi", params: { period: 14 }, operator: buyOp, value: buyV }], quantityPercent: 100 },
      { id: "se", action: "sell", conditions: [{ id: "cs", indicator: "rsi", params: { period: 14 }, operator: sellOp, value: sellV }], quantityPercent: 100 },
    ], isActive: true, createdAt: now, updatedAt: now,
  },
});

// KR 전략봇 3개 (일봉 RSI). 진입데모(rsi<100=항상 진입)로 실제 mock 주문 시연. 자본 소액→정수주×현재가<캡.
// (SK하이닉스는 모의 1주가 ~207만 >캡이라 제외. 저가 종목으로 1주 이상 매수 가능하게.)
const defs = [
  { name: "삼성전자 진입데모", symbol: "005930", tree: leaf("005930", "lt", 100, "gt", 99) },
  { name: "카카오 진입데모", symbol: "035720", tree: leaf("035720", "lt", 100, "gt", 99) },
  { name: "NAVER RSI역추세(40/70)", symbol: "035420", tree: leaf("035420", "lt", 40, "gt", 70) },
];

async function main() {
  console.log("═══ 키움 모의 KR 주식 전략봇 3개 ═══ (데이터=ka10081 일봉, 실행=mock 주문, 가짜돈)\n");
  const bots: { name: string; id: string }[] = [];
  for (const d of defs) {
    const comp = store.insertComposite({ name: d.name, root_node: d.tree, symbol: d.symbol, market: "spot", leverage: 1, stop_loss_percent: null, take_profit_percent: null, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
    const bot = store.insertBot({ name: d.name, symbol: d.symbol, composite_strategy_id: comp.id, status: "running", mode: "live", capital: 300_000, broker: "kiwoom", interval_seconds: 86400 });
    bots.push({ name: d.name, id: bot.id });
    console.log(`✅ 봇 생성: ${d.name} (${d.symbol}, kiwoom mock, 일봉, 자본 30만)`);
  }
  console.log("\n── tick (KR 일봉 평가 + 신호 시 mock 주문) ──");
  for (const b of bots) {
    try {
      const r = await tickBot(b.id);
      console.log(`  • ${b.name}: action=${r.action} — ${r.detail}`);
    } catch (e) { console.log(`  • ${b.name}: 예외 ${e instanceof Error ? e.message : e}`); }
    await sleep(3500); // 키움 레이트리밋 회피
  }

  console.log("\n── 결과: 봇 상태 + 포지션 + 최근 로그 ──");
  for (const b of bots) {
    const bot = store.getBot(b.id);
    const ps = bot?.position_state as { status?: string; qty?: number; entryAvg?: number } | null;
    const logs = store.getLogs ? store.getLogs(b.id, 3) : [];
    console.log(`\n[${b.name}] status=${bot?.status} 포지션=${ps?.status === "open" ? `보유 ${ps.qty}주 @${ps.entryAvg}` : "없음"}`);
    for (const l of (logs as { level: string; message: string }[])) console.log(`   · [${l.level}] ${l.message}`);
  }
  console.log("\n실거래(메인넷) OFF. 모의=가짜돈.");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
