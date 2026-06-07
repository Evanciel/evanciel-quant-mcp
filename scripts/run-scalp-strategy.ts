/**
 * run-scalp-strategy.ts — 초단타(스캘핑) 복합전략 1개 실행. 5분봉 평균회귀 스캘프.
 * 구조: 활성시간대(UTC 8~22) → VWAP 아래 → 스토캐스틱RSI 과매도 진입 / 타이트 TP라더(0.4/0.8/1.2%)+손절0.6%+트레일0.3%.
 * ① 실 Binance 5m 백테스트 ② testnet 라이브(interval 5m) 1틱 ③ 자동정리. 정직: 스캘핑일수록 수수료·슬리피지로 알파↓.
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
try { for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch { /* */ }
process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-scalp-${process.pid}`);
process.env.LIVE_MAX_NOTIONAL = process.env.LIVE_MAX_NOTIONAL || "50";
process.env.LIVE_SYMBOL_ALLOWLIST = process.env.LIVE_SYMBOL_ALLOWLIST || "BTCUSDT,ETHUSDT";

const H = await import("../src/mcp-server/handlers.js");
const store = await import("../src/store/db.js");
const { tickBot } = await import("../src/runner/runner.js");
const { getAdapter } = await import("../src/brokers/index.js");
const now = new Date();
const SYMBOL = "BTCUSDT";

// 스캘핑 트리: 시간대 → VWAP 아래 → 스토캐스틱RSI 과매도 진입(빠른 period 7), 반대=과매수 청산.
const scalpLeaf = {
  id: "sl", type: "leaf", name: "stochrsi-scalp",
  strategy: { id: "s", userId: "u", name: "s", description: "", symbol: SYMBOL,
    rules: [
      { id: "b", action: "buy", conditions: [{ id: "c", indicator: "stochastic_rsi", params: { period: 7 }, operator: "lt", value: 20 }], quantityPercent: 100 },
      { id: "se", action: "sell", conditions: [{ id: "c2", indicator: "stochastic_rsi", params: { period: 7 }, operator: "gt", value: 80 }], quantityPercent: 100 },
    ], isActive: true, createdAt: now, updatedAt: now },
};
const flat = { id: "f", type: "leaf", name: "flat", strategy: { id: "f", userId: "u", name: "f", description: "", symbol: SYMBOL, rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 7 }, operator: "lt", value: -999 }], quantityPercent: 100 }], isActive: true, createdAt: now, updatedAt: now } };
const tree = {
  id: "t", type: "condition", name: "활성시간대(UTC 8~22)",
  condition: { type: "time", field: "hour", operator: "between", values: [8, 22] },
  thenNode: {
    id: "v", type: "condition", name: "VWAP 아래",
    condition: { type: "anchor", anchor: "vwapFromOpen", operator: "lt", multiplier: 1 },
    thenNode: scalpLeaf, elseNode: flat,
  },
  elseNode: flat,
};
const tpLadder = [{ pct: 0.4, sellPct: 50 }, { pct: 0.8, sellPct: 50 }, { pct: 1.2, sellPct: 100 }];

async function main() {
  console.log("═══ 초단타 스캘핑 복합전략 ═══");
  console.log("5m | 활성시간대(UTC8~22) → VWAP아래 → 스토캐스틱RSI(7) 과매도 진입 / TP라더 0.4·0.8·1.2% + 손절0.6% + 트레일0.3%\n");

  console.log("① 백테스트(실 Binance 5m, ~7일):");
  try {
    const r: any = await H.backtest({ tree, symbol: SYMBOL, interval: "5m", days: 2000 });
    if (r.ok) { const st = r.stats; console.log(`   ${r.bars}봉 | 수익 ${st.totalReturnPercent}% | MDD ${st.maxDrawdownPercent}% | 거래 ${st.totalTrades} | 승률 ${st.winRate}% | Sharpe ${st.sharpeRatio} | OOS robust=${r.verdict?.oosRobust}`); }
    else console.log("   ❌", r.error);
  } catch (e) { console.log("   ❌", e instanceof Error ? e.message : e); }
  console.log("   (정직: 스캘핑은 수수료·슬리피지로 알파 더 어려움. 표현/실행 검증이 목적)\n");

  if (!process.env.BINANCE_API_KEY) { console.log("② BINANCE_API_KEY 없음 → 라이브 스킵."); return; }

  console.log("② testnet 라이브(5m 봇) 1틱:");
  const comp = store.insertComposite({ name: "스캘핑", root_node: tree, symbol: SYMBOL, market: "spot", leverage: 1, stop_loss_percent: 0.6, take_profit_percent: null, tp_ladder: tpLadder, scale_in: null, pyramid: null, trailing_stop_percent: 0.3 });
  const bot = store.insertBot({ name: "스캘핑봇", symbol: SYMBOL, composite_strategy_id: comp.id, mode: "live", capital: 30, broker: "binance", interval_seconds: 300 }); // 5m
  const r = await tickBot(bot.id);
  const ps = store.getBot(bot.id)?.position_state as { qty?: number; protectiveIds?: string[] } | null;
  console.log(`   tick: ${r.action} — ${r.detail}`);
  console.log(`   보유=${ps?.qty ?? 0} 상주주문=${(ps?.protectiveIds ?? []).length}건`);
  for (const l of store.recentLogs(bot.id, 6).reverse()) console.log(`     [${l.action}] ${l.detail}`);

  // ③ 정리
  console.log("\n③ 정리:");
  const a = getAdapter("binance", "spot")!.adapter as any;
  for (const cid of ps?.protectiveIds ?? []) { try { await a.cancelOrderByClientId(SYMBOL, cid); } catch { /* */ } }
  if (ps?.qty) { try { const px = (await a.getPrice(SYMBOL)).price; const nq = await a.normalizeQuantity(SYMBOL, ps.qty, px); await a.placeOrder({ symbol: SYMBOL, side: "sell", type: "market", quantity: nq, clientOrderId: `cx${Date.now().toString(36)}` }); console.log(`   청산 ${nq}`); } catch (e) { console.log("   청산 실패:", e instanceof Error ? e.message : e); } }
  console.log("\n✅ 초단타 스캘핑 전략 실행 완료.");
}
main().catch((e) => { console.error("오류:", e); process.exit(1); });
