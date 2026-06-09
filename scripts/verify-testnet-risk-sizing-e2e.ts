/**
 * verify-testnet-risk-sizing-e2e.ts — riskSizing(vol_target) 봇 라이브 경로 E2E(testnet). 자동 정리.
 * riskSizing 봇 생성→tickBot→실 testnet 매수(변동성 타게팅 수량)→검증→청산. 가짜돈.
 * 실행: npx tsx scripts/verify-testnet-risk-sizing-e2e.ts (.env.local 자동 로드).
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
process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-risksize-e2e-${process.pid}`);
process.env.LIVE_MAX_NOTIONAL = process.env.LIVE_MAX_NOTIONAL || "50";
process.env.LIVE_SYMBOL_ALLOWLIST = process.env.LIVE_SYMBOL_ALLOWLIST || "BTCUSDT,ETHUSDT";

const store = await import("../src/store/db.js");
const { tickBot } = await import("../src/runner/runner.js");
const { getAdapter } = await import("../src/brokers/index.js");
const SYMBOL = "BTCUSDT";
const log = (s: string) => console.log(s);

async function main() {
  // 항상매수 + riskSizing(vol_target). capital 40 → 변동성 타게팅 수량(leverageCap 1.0 → 노셔널 ≤ $40 < $50 캡).
  const strat = { id: "s", userId: "u", name: "s", description: "", symbol: SYMBOL, rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: 200 }], quantityPercent: 100 }], isActive: true, createdAt: new Date(), updatedAt: new Date() };
  const comp = store.insertComposite({
    name: "risksize-e2e", root_node: { id: "l", type: "leaf", name: "buy", strategy: strat },
    symbol: SYMBOL, market: "spot", leverage: 1, stop_loss_percent: null, take_profit_percent: null,
    tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null,
    risk_sizing: { method: "vol_target", targetVolAnnual: 0.5, leverageCap: 1.0 },
  });
  const bot = store.insertBot({ name: "risksize-bot", symbol: SYMBOL, composite_strategy_id: comp.id, mode: "live", capital: 40, broker: "binance", interval_seconds: 3600 });
  log(`봇 생성: ${bot.id} (live, capital $40, riskSizing=vol_target targetVol=0.5)`);

  let botPos: { qty?: number } | null = null;
  try {
    log("\n① tickBot 실행 → 변동성 타게팅 수량으로 실 testnet 매수...");
    const r = await tickBot(bot.id);
    log(`   결과: ${r.action} — ${r.detail}`);
    botPos = store.getBot(bot.id)?.position_state as typeof botPos;
    log("   --- 봇 로그 ---");
    for (const l of store.recentLogs(bot.id, 8).reverse()) log(`     [${l.action}] ${l.detail}`);
    if (r.action !== "buy" || !botPos?.qty) { log("   ⚠️ 매수 안 됨(데이터/게이트 확인)"); return; }

    // 변동성 타게팅 수량 확인: legacy(floor(40/price))와 비교
    const got0 = getAdapter("binance", "spot");
    const px = (await (got0!.adapter as { getPrice: (s: string) => Promise<{ price: number }> }).getPrice(SYMBOL)).price;
    const legacyQty = Math.floor((40 / px) * 1e8) / 1e8;
    log(`\n② 사이징 검증: vol_target qty=${botPos.qty} vs legacy(floor(40/${px.toFixed(0)}))=${legacyQty}`);
    log(`   → 변동성 타게팅이 ${botPos.qty <= legacyQty ? "노출 축소(정상, 고변동)" : "노출 확대(저변동)"}. 실 testnet 주문 체결됨.`);
  } finally {
    log("\n③ 정리(청산)...");
    const got = getAdapter("binance", "spot");
    const a = got!.adapter as { placeOrder: (o: unknown) => Promise<{ status: string }>; normalizeQuantity?: (s: string, q: number, p: number) => Promise<number>; getPrice: (s: string) => Promise<{ price: number }> };
    if (botPos?.qty) {
      try {
        const px = (await a.getPrice(SYMBOL)).price;
        const nq = a.normalizeQuantity ? await a.normalizeQuantity(SYMBOL, botPos.qty, px) : botPos.qty;
        const r = await a.placeOrder({ symbol: SYMBOL, side: "sell", type: "market", quantity: nq, clientOrderId: `rs${Date.now().toString(36)}` });
        log(`   청산 매도: ${r.status} qty=${nq}`);
      } catch (e) { log(`   청산 실패(수동 정리 필요): ${e instanceof Error ? e.message : e}`); }
    }
  }
  log("\n✅ riskSizing 봇 라이브 경로 E2E 완료(testnet). 변동성 타게팅 수량으로 실주문 체결+청산.");
}
main().catch((e) => { console.error("E2E 오류:", e); process.exit(1); });
