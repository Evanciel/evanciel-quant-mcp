/**
 * run-complex-strategies.ts — 복잡한 복합전략 쇼케이스. 표현력 총동원(레짐·MTF·이벤트·스프레드·앵커·라더·복합).
 * ① 실 Binance 데이터로 백테스트(OOS) → 조건 로직 검증 ② 일부를 testnet 라이브 봇으로 실행(실주문+상주스톱) → 자동 정리.
 * 실행: npx tsx scripts/run-complex-strategies.ts (.env.local 자동 로드). 정직: 백테스트 음수=정상(알파 아님).
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
try { for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch { /* 키 없으면 백테만 */ }
process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-complex-${process.pid}`);
process.env.LIVE_MAX_NOTIONAL = process.env.LIVE_MAX_NOTIONAL || "50";
process.env.LIVE_SYMBOL_ALLOWLIST = process.env.LIVE_SYMBOL_ALLOWLIST || "BTCUSDT,ETHUSDT";

const H = await import("../src/mcp-server/handlers.js");
const store = await import("../src/store/db.js");
const { tickBot } = await import("../src/runner/runner.js");
const { getAdapter } = await import("../src/brokers/index.js");

const now = new Date();
const leaf = (sym: string, ind: string, p: number, op: string, v: number, sellOp = "gt", sellV = 70): any => ({ id: "l-" + Math.random().toString(36).slice(2, 6), type: "leaf", name: ind, strategy: { id: "s", userId: "u", name: "s", description: "", symbol: sym, rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: ind, params: { period: p }, operator: op, value: v }], quantityPercent: 100 }, { id: "se", action: "sell", conditions: [{ id: "c2", indicator: ind, params: { period: p }, operator: sellOp, value: sellV }], quantityPercent: 100 }], isActive: true, createdAt: now, updatedAt: now } });

// ── 복잡 전략 정의 ──
const strategies: { name: string; symbol: string; interval: string; days: number; tree: any; live?: boolean; sl?: number; tp?: number; trail?: number; ladder?: boolean }[] = [
  {
    name: "A. FOMC회피 + 상승레짐 + 1h추세확인 + RSI눌림(ETH)", symbol: "ETHUSDT", interval: "1h", days: 600, live: true, sl: 5, tp: 10, trail: 3,
    tree: { id: "fomc", type: "condition", name: "FOMC회피", condition: { type: "event", calendar: "FOMC", hoursBefore: 6, hoursAfter: 6 },
      thenNode: leaf("ETHUSDT", "rsi", 14, "lt", -999), // 윈도우엔 매매 안 함
      elseNode: { id: "rg", type: "condition", name: "상승레짐", condition: { type: "regime", in: ["trend_up"] },
        thenNode: { id: "mtf", type: "condition", name: "4h추세", condition: { type: "indicator", indicator: "sma", params: { period: 50 }, operator: "gt", value: 0, timeframe: "4h" },
          thenNode: leaf("ETHUSDT", "rsi", 14, "lt", 40, "gt", 70) }, elseNode: leaf("ETHUSDT", "rsi", 14, "lt", -999) } },
  },
  {
    name: "B. ETH/BTC 스프레드 z-score 평균회귀(ETH)", symbol: "ETHUSDT", interval: "4h", days: 500, live: true, sl: 6, tp: 12,
    tree: { id: "sp", type: "condition", name: "ETH/BTC저평가", condition: { type: "spread", symbolB: "BTCUSDT", expr: "zscore", lookback: 20, operator: "lt", value: -1 },
      thenNode: leaf("ETHUSDT", "rsi", 14, "lt", 100, "gt", 70), elseNode: leaf("ETHUSDT", "rsi", 14, "lt", -999) },
  },
  {
    name: "C. 세션 갭앤고: 당일시가 +2% 돌파(BTC 1h)", symbol: "BTCUSDT", interval: "1h", days: 400,
    tree: { id: "an", type: "condition", name: "갭2%", condition: { type: "anchor", anchor: "dayOpen", operator: "gt", multiplier: 1.02 },
      thenNode: leaf("BTCUSDT", "rsi", 14, "lt", 100, "gt", 75), elseNode: leaf("BTCUSDT", "rsi", 14, "lt", -999) },
  },
  {
    name: "D. 가중복합: 레짐추세 + RSI역추세 (BTC 1d)", symbol: "BTCUSDT", interval: "1d", days: 700,
    tree: { id: "cmp", type: "composite", name: "가중", mode: "weighted", weights: [0.6, 0.4], children: [
      { id: "t1", type: "condition", name: "추세", condition: { type: "regime", in: ["trend_up"] }, thenNode: leaf("BTCUSDT", "sma", 20, "gt", 0), elseNode: leaf("BTCUSDT", "rsi", 14, "lt", -999) },
      leaf("BTCUSDT", "rsi", 14, "lt", 35, "gt", 65),
    ] },
  },
  {
    name: "E. FOMC회피 + 진입 + TP라더(50/25/25)+물타기+트레일링 (BTC)", symbol: "BTCUSDT", interval: "1h", days: 300, live: true, sl: 8, trail: 4,
    ladder: true,
    tree: { id: "f2", type: "condition", name: "FOMC회피", condition: { type: "event", calendar: "FOMC", hoursBefore: 6, hoursAfter: 6 },
      thenNode: leaf("BTCUSDT", "rsi", 14, "lt", -999), elseNode: leaf("BTCUSDT", "rsi", 14, "lt", 200, "gt", 200) }, // 평시 진입(rsi<200 항상)
  },
];

async function main() {
  console.log("═══ ① 백테스트(실 Binance, OOS) — 복잡 전략이 끝까지 평가되는지 ═══");
  console.log("(정직: 음수/저조한 수익은 정상 — 알파 아니라 표현력·리스크 검증)\n");
  for (const s of strategies) {
    try {
      const r: any = await H.backtest({ tree: s.tree, symbol: s.symbol, interval: s.interval, days: s.days });
      if (!r.ok) { console.log(`▸ ${s.name}\n   ❌ ${r.error}\n`); continue; }
      const st = r.stats;
      console.log(`▸ ${s.name}`);
      console.log(`   ${r.bars}봉 | 수익 ${st.totalReturnPercent}% | MDD ${st.maxDrawdownPercent}% | 거래 ${st.totalTrades} | 승률 ${st.winRate}% | Sharpe ${st.sharpeRatio} | OOS robust=${r.verdict?.oosRobust}\n`);
    } catch (e) { console.log(`▸ ${s.name}\n   ❌ ${e instanceof Error ? e.message : e}\n`); }
  }

  const liveOk = !!process.env.BINANCE_API_KEY;
  console.log(`═══ ② testnet 라이브 봇 실행 ${liveOk ? "(실주문+상주스톱)" : "(키 없음 → 스킵)"} ═══\n`);
  if (!liveOk) { console.log("BINANCE_API_KEY 없음 → 라이브 스킵."); return; }

  const liveStrats = strategies.filter((s) => s.live);
  const botIds: { id: string; symbol: string }[] = [];
  for (const s of liveStrats) {
    const tpLadder = s.ladder ? [{ pct: 3, sellPct: 50 }, { pct: 6, sellPct: 50 }, { pct: 10, sellPct: 100 }] : null;
    const scaleIn = s.ladder ? { ladder: [{ dropPct: 3, addPct: 50 }], maxMultiple: 2 } : null;
    const comp = store.insertComposite({ name: s.name, root_node: s.tree, symbol: s.symbol, market: "spot", leverage: 1, stop_loss_percent: s.sl ?? null, take_profit_percent: s.tp ?? null, tp_ladder: tpLadder, scale_in: scaleIn, pyramid: null, trailing_stop_percent: s.trail ?? null });
    const bot = store.insertBot({ name: s.name, symbol: s.symbol, composite_strategy_id: comp.id, mode: "live", capital: 30, broker: "binance", interval_seconds: 3600 });
    botIds.push({ id: bot.id, symbol: s.symbol });
    const r = await tickBot(bot.id);
    const ps = store.getBot(bot.id)?.position_state as { qty?: number; protectiveIds?: string[] } | null;
    console.log(`▸ ${s.name}\n   tick: ${r.action} — ${r.detail}\n   보유=${ps?.qty ?? 0} 상주주문=${(ps?.protectiveIds ?? []).length}건\n`);
  }

  // ③ 정리: 보호주문 취소 + 청산
  console.log("═══ ③ 정리(보호주문 취소 + 청산) ═══");
  const a = getAdapter("binance", "spot")!.adapter as any;
  for (const { id, symbol } of botIds) {
    const ps = store.getBot(id)?.position_state as { qty?: number; protectiveIds?: string[] } | null;
    for (const cid of ps?.protectiveIds ?? []) { try { await a.cancelOrderByClientId(symbol, cid); } catch { /*무시*/ } }
    if (ps?.qty) { try { const px = (await a.getPrice(symbol)).price; const nq = await a.normalizeQuantity(symbol, ps.qty, px); await a.placeOrder({ symbol, side: "sell", type: "market", quantity: nq, clientOrderId: `cx${Date.now().toString(36)}` }); console.log(`   ${symbol} 청산 ${nq}`); } catch (e) { console.log(`   ${symbol} 청산 실패: ${e instanceof Error ? e.message : e}`); } }
  }
  console.log("\n✅ 복잡 전략 쇼케이스 완료(백테스트 + testnet 라이브 + 정리).");
}
main().catch((e) => { console.error("오류:", e); process.exit(1); });
