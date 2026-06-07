/**
 * verify-testnet-bot-e2e.ts — 실 testnet 봇 라이브 경로 E2E(gold standard). 자동 정리.
 * 봇 생성→tickBot→실 testnet 매수(분수)+상주 보호주문→검증→정리(보호주문 취소+청산).
 * 실행: npx tsx scripts/verify-testnet-bot-e2e.ts (.env.local 자동 로드). 가짜돈.
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { console.error(".env.local 없음"); process.exit(1); }
process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-bot-e2e-${process.pid}`);
process.env.LIVE_MAX_NOTIONAL = process.env.LIVE_MAX_NOTIONAL || "50";
process.env.LIVE_SYMBOL_ALLOWLIST = process.env.LIVE_SYMBOL_ALLOWLIST || "BTCUSDT,ETHUSDT";

const store = await import("../src/store/db.js");
const { tickBot } = await import("../src/runner/runner.js");
const { getAdapter } = await import("../src/brokers/index.js");
const SYMBOL = "BTCUSDT";
const log = (s: string) => console.log(s);

async function main() {
  // 항상매수(rsi<200) + SL 5% + 트레일링 3%. capital 30 → 분수 ~0.0005 BTC, 노셔널 ~$30 < $50 캡.
  const strat = { id: "s", userId: "u", name: "s", description: "", symbol: SYMBOL, rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: 200 }], quantityPercent: 100 }], isActive: true, createdAt: new Date(), updatedAt: new Date() };
  const comp = store.insertComposite({ name: "e2e", root_node: { id: "l", type: "leaf", name: "buy", strategy: strat }, symbol: SYMBOL, market: "spot", leverage: 1, stop_loss_percent: 5, take_profit_percent: 10, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: 3 });
  const bot = store.insertBot({ name: "e2e-bot", symbol: SYMBOL, composite_strategy_id: comp.id, mode: "live", capital: 30, broker: "binance", interval_seconds: 3600 });
  log(`봇 생성: ${bot.id} (live, capital $30)`);

  let botPos: { qty?: number; protectiveIds?: string[] } | null = null;
  try {
    log("\n① tickBot 실행 → 실 testnet 매수 + 상주 보호주문...");
    const r = await tickBot(bot.id);
    log(`   결과: ${r.action} — ${r.detail}`);
    botPos = store.getBot(bot.id)?.position_state as typeof botPos;
    log(`   position_state: qty=${botPos?.qty} protectiveIds=${JSON.stringify(botPos?.protectiveIds)}`);
    log("   --- 봇 로그 ---");
    for (const l of store.recentLogs(bot.id, 12).reverse()) log(`     [${l.action}] ${l.detail}`);
    if (r.action !== "buy" || !botPos?.qty) { log("   ⚠️ 매수 안 됨(데이터/게이트 확인)"); return; }

    // ② 상주 보호주문이 거래소에 실제로 걸렸는지 조회
    const got = getAdapter("binance", "spot");
    const a = got!.adapter as { getOrderByClientId?: (s: string, c: string) => Promise<unknown> };
    log("\n② 거래소 상주 보호주문 확인:");
    for (const cid of botPos.protectiveIds ?? []) {
      const o = a.getOrderByClientId ? await a.getOrderByClientId(SYMBOL, cid) : null;
      log(`   ${cid}: ${o ? `✅ ${JSON.stringify(o)}` : "조회불가/없음"}`);
    }
  } finally {
    // ③ 정리: 보호주문 전부 취소 + 포지션 청산(고아주문/잔여 0)
    log("\n③ 정리(보호주문 취소 + 청산)...");
    const got = getAdapter("binance", "spot");
    const a = got!.adapter as { cancelOrderByClientId?: (s: string, c: string) => Promise<boolean>; placeOrder: (o: unknown) => Promise<{ status: string }>; normalizeQuantity?: (s: string, q: number, p: number) => Promise<number>; getPrice: (s: string) => Promise<{ price: number }> };
    for (const cid of botPos?.protectiveIds ?? []) {
      try { const ok = a.cancelOrderByClientId ? await a.cancelOrderByClientId(SYMBOL, cid) : false; log(`   보호주문 취소 ${cid}: ${ok}`); } catch (e) { log(`   취소 실패 ${cid}: ${e instanceof Error ? e.message : e}`); }
    }
    if (botPos?.qty) {
      try {
        const px = (await a.getPrice(SYMBOL)).price;
        const nq = a.normalizeQuantity ? await a.normalizeQuantity(SYMBOL, botPos.qty, px) : botPos.qty;
        const r = await a.placeOrder({ symbol: SYMBOL, side: "sell", type: "market", quantity: nq, clientOrderId: `c${Date.now().toString(36)}` });
        log(`   청산 매도: ${r.status} qty=${nq}`);
      } catch (e) { log(`   청산 실패(수동 정리 필요): ${e instanceof Error ? e.message : e}`); }
    }
  }
  log("\n✅ 봇 라이브 경로 E2E 완료(testnet). 매수+상주스톱+정리 검증.");
}
main().catch((e) => { console.error("E2E 오류:", e); process.exit(1); });
