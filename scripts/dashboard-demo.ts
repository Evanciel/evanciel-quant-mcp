/**
 * dashboard-demo.ts — 대시보드 시각확인용 데모 시드 + 서버 기동. 임시 스토어에 봇 3종(일반/스캐너/실거래) 주입.
 * 실행: npx tsx scripts/dashboard-demo.ts → 출력된 URL을 브라우저/Playwright로 확인. Ctrl+C 종료.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), "quant-mcp-dashboard-demo");
import * as store from "../src/store/db.js";
import { startDashboard } from "../src/dashboard/server.js";

const now = new Date().toISOString();
const strat = (sym: string, ind: string, p: number, op: string, v: number) => ({
  id: "s", userId: "u", name: "s", description: "", symbol: sym,
  rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: ind, params: { period: p }, operator: op, value: v }], quantityPercent: 100 }],
  isActive: true, createdAt: now, updatedAt: now,
});

// 1) 일반 봇: MTF + 이벤트 조건 트리(요약 표시 확인) + 오픈 포지션 + 실현손익(과거 거래)
const tree1 = {
  id: "cn", type: "condition", name: "FOMC 회피",
  condition: { type: "event", calendar: "FOMC", hoursBefore: 6, hoursAfter: 6 },
  thenNode: { id: "l0", type: "leaf", name: "noop", strategy: strat("ETHUSDT", "rsi", 14, "lt", -999) },
  elseNode: {
    id: "cn2", type: "condition", name: "1h 추세",
    condition: { type: "indicator", indicator: "sma", params: { period: 50 }, operator: "gt", value: 0, timeframe: "1h" },
    thenNode: { id: "l", type: "leaf", name: "rsi", strategy: strat("ETHUSDT", "rsi", 14, "lt", 35) },
  },
};
const c1 = store.insertComposite({ name: "ETH 스윙(MTF+FOMC회피)", root_node: tree1, symbol: "ETHUSDT", market: "spot", leverage: 1, stop_loss_percent: 5, take_profit_percent: 10, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
const b1 = store.insertBot({ name: "ETH 스윙봇", symbol: "ETHUSDT", composite_strategy_id: c1.id, mode: "paper", capital: 1_000_000, broker: "binance", interval_seconds: 3600 });
store.setBotStatus(b1.id, "running");
store.setBotPositionState(b1.id, { status: "open", entryAvg: 3200, qty: 3, openedAt: now });
// 과거 청산 거래(실현손익): +120, -40, +80 → 누적 +160, 3회, 2승
for (const [pnl, key] of [[120, "t1"], [-40, "t2"], [80, "t3"]] as [number, string][]) {
  store.insertTrade({ bot_id: b1.id, side: "sell", price: 3300, qty: 1, pnl, is_paper: 1, reason: "전략 청산", idempotency_key: `${b1.id}:${key}` });
}
store.insertLog(b1.id, "buy", "[페이퍼] 진입 qty=3 @ 3200");
store.insertLog(b1.id, "hold", "1h 추세 게이트 통과, 보유 유지");

// 2) 스캐너 봇: 멀티심볼 포지션(맵) — 이전엔 안 보이던 버그 수정 확인
const scannerNode = {
  id: "sc", type: "scanner", name: "급등주", universe: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"],
  rank: { metric: "roc", top: 2 }, schedule: { hour: [9, 10], tz: "Asia/Seoul" },
  then: { id: "l", type: "leaf", name: "mom", strategy: strat("X", "rsi", 14, "lt", 60) },
};
const c2 = store.insertComposite({ name: "9시 급등주 스캐너", root_node: scannerNode, symbol: "BTCUSDT", market: "spot", leverage: 1, stop_loss_percent: null, take_profit_percent: null, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
const b2 = store.insertBot({ name: "급등주 단타 스캐너", symbol: "BTCUSDT", composite_strategy_id: c2.id, mode: "paper", capital: 1_000_000, broker: "binance", interval_seconds: 300 });
store.setBotStatus(b2.id, "running");
store.setBotPositionState(b2.id, { BTCUSDT: { status: "open", entryAvg: 63000, qty: 0.5, openedAt: now }, SOLUSDT: { status: "open", entryAvg: 140, qty: 30, openedAt: now } });
store.insertTrade({ bot_id: b2.id, side: "sell", price: 145, qty: 10, pnl: 55, is_paper: 1, reason: "스캐너 청산(SOLUSDT)", idempotency_key: `${b2.id}:sc1` });
store.insertLog(b2.id, "buy", "[페이퍼] BTCUSDT 진입 qty=0.5 (roc 상위)");
store.insertLog(b2.id, "buy", "[페이퍼] SOLUSDT 진입 qty=30 (roc 상위)");

// 3) 실거래(라이브) 배지 확인 — 관망
const c3 = store.insertComposite({ name: "BTC 레짐", root_node: { id: "cn", type: "condition", name: "추세장", condition: { type: "regime", in: ["trend_up"] }, thenNode: { id: "l", type: "leaf", name: "r", strategy: strat("BTCUSDT", "rsi", 14, "lt", 30) } }, symbol: "BTCUSDT", market: "spot", leverage: 1, stop_loss_percent: null, take_profit_percent: null, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
const b3 = store.insertBot({ name: "BTC 레짐봇(실거래대기)", symbol: "BTCUSDT", composite_strategy_id: c3.id, mode: "live", capital: 500_000, broker: "binance", interval_seconds: 3600 });
store.setBotStatus(b3.id, "running");

const { url } = await startDashboard(7788);
console.log("DASHBOARD_URL " + url);
