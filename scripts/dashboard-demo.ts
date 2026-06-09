/**
 * dashboard-demo.ts — 대시보드 시각확인용 데모 시드 + 서버 기동. 임시 스토어에 봇 3종(일반/스캐너/실거래) 주입.
 * 실행: npx tsx scripts/dashboard-demo.ts → 출력된 URL을 브라우저/Playwright로 확인. Ctrl+C 종료.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
// 키움 getCandles(주식 차트 실데이터)용 자격증명 로드(.env.local, 읽기전용·있을 때만).
// 서버는 봇 tick을 하지 않으므로(스냅샷+차트 데이터 fetch만) 주문/실거래 위험 없음.
try { for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch { /* .env.local 없으면 crypto 차트만 */ }
process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), "quant-mcp-dashboard-demo");
import * as store from "../src/store/db.js";
import { startDashboard } from "../src/dashboard/server.js";
import { fetchKlines } from "../src/data/binance-public.js";
import { getAdapter } from "../src/brokers/index.js";

const now = new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 데모 진입가/시각을 실제 과거 봉에서 도출 → 차트 마커(핀)·진입선·가격이 그 봉에 정확히 일치(불일치 버그 방지).
async function histBar(symbol: string, broker: "binance" | "kiwoom" | "kis", barsBack: number, interval = "1d"): Promise<{ price: number; datetime: string } | null> {
  try {
    let bars: { close: number; date: string; datetime?: string }[] = [];
    if (broker === "binance") bars = await fetchKlines(symbol, interval, barsBack + 8);
    else { const ad = getAdapter(broker, "spot")?.adapter as { getCandles?: (s: string, i: string, n: number) => Promise<{ close: number; date: string; datetime?: string }[]> } | undefined; bars = ad?.getCandles ? await ad.getCandles(symbol, interval, barsBack + 8) : []; }
    if (!bars.length) return null;
    const b = bars[Math.max(0, bars.length - 1 - barsBack)];
    return { price: Math.round(b.close), datetime: b.datetime ?? (b.date + "T00:00:00Z") };
  } catch { return null; }
}
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
// SL/TP봇 → 현재가 근처 진입(현재가가 손절·익절 사이 = 정상 보유 상태). 모순되는 가짜 청산거래는 두지 않음.
const e1 = await histBar("ETHUSDT", "binance", 3, "1h");
store.setBotPositionState(b1.id, { status: "open", entryAvg: e1?.price ?? 1610, qty: 3, openedAt: e1?.datetime ?? "2026-06-03T00:00:00Z" });
store.insertLog(b1.id, "buy", "[페이퍼] ETHUSDT 진입 qty=3 @" + (e1?.price ?? 1610).toLocaleString());
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
const eB = await histBar("BTCUSDT", "binance", 60, "5m");
const eS = await histBar("SOLUSDT", "binance", 60, "5m");
store.setBotPositionState(b2.id, { BTCUSDT: { status: "open", entryAvg: eB?.price ?? 61000, qty: 0.5, openedAt: eB?.datetime ?? "2026-06-04T00:00:00Z" }, SOLUSDT: { status: "open", entryAvg: eS?.price ?? 140, qty: 30, openedAt: eS?.datetime ?? "2026-06-04T00:00:00Z" } });
store.insertLog(b2.id, "buy", "[페이퍼] BTCUSDT 진입 qty=0.5 (roc 상위)");
store.insertLog(b2.id, "buy", "[페이퍼] SOLUSDT 진입 qty=30 (roc 상위)");

// 3) 실거래(라이브) 배지 확인 — 관망
const c3 = store.insertComposite({ name: "BTC 레짐", root_node: { id: "cn", type: "condition", name: "추세장", condition: { type: "regime", in: ["trend_up"] }, thenNode: { id: "l", type: "leaf", name: "r", strategy: strat("BTCUSDT", "rsi", 14, "lt", 30) } }, symbol: "BTCUSDT", market: "spot", leverage: 1, stop_loss_percent: null, take_profit_percent: null, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
const b3 = store.insertBot({ name: "BTC 레짐봇(실거래대기)", symbol: "BTCUSDT", composite_strategy_id: c3.id, mode: "live", capital: 500_000, broker: "binance", interval_seconds: 3600 });
store.setBotStatus(b3.id, "running");

// 4) 키움 KR 주식 봇 — crypto와 같은 대시보드에 함께 표시.
//    KR은 이 대시보드에 실시간 시세피드(Binance WS)가 없어 정적(보유수량@평단만, P&L 0). broker 미노출이라 이름에 "(키움 모의)" 표기.
const krLeaf = (sym: string, buyV: number, sellV: number) => ({
  id: "l", type: "leaf", name: sym, strategy: {
    id: "s", userId: "u", name: sym, description: "", symbol: sym,
    rules: [
      { id: "b", action: "buy", conditions: [{ id: "cb", indicator: "rsi", params: { period: 14 }, operator: "lt", value: buyV }], quantityPercent: 100 },
      { id: "se", action: "sell", conditions: [{ id: "cs", indicator: "rsi", params: { period: 14 }, operator: "gt", value: sellV }], quantityPercent: 100 },
    ], isActive: true, createdAt: now, updatedAt: now,
  },
});
// 삼성전자: SL/TP 봇 → 현재가 근처(최근 봉) 진입 → 현재가가 손절·익절 사이 = 정상 보유 상태(모순 방지).
const k1c = store.insertComposite({ name: "삼성전자 RSI", root_node: krLeaf("005930", 40, 70), symbol: "005930", market: "spot", leverage: 1, stop_loss_percent: 5, take_profit_percent: 10, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
const k1 = store.insertBot({ name: "삼성전자(키움 모의)", symbol: "005930", composite_strategy_id: k1c.id, mode: "live", capital: 300_000, broker: "kiwoom", interval_seconds: 86400 });
store.setBotStatus(k1.id, "running");
const eK1 = await histBar("005930", "kiwoom", 0, "1d");
store.setBotPositionState(k1.id, { status: "open", entryAvg: eK1?.price ?? 280000, qty: 1, openedAt: eK1?.datetime ?? "2026-04-10T00:00:00Z" });
store.insertLog(k1.id, "buy", "[키움 모의] 005930 진입 1주 @" + (eK1?.price ?? 280000).toLocaleString());
store.insertLog(k1.id, "hold", "RSI 중립 — 손절·익절 사이 보유 유지");
// 카카오: 보유. 평단 41,850(틱50 정렬).
const k2c = store.insertComposite({ name: "카카오 RSI", root_node: krLeaf("035720", 40, 70), symbol: "035720", market: "spot", leverage: 1, stop_loss_percent: 5, take_profit_percent: 10, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
const k2 = store.insertBot({ name: "카카오(키움 모의)", symbol: "035720", composite_strategy_id: k2c.id, mode: "live", capital: 300_000, broker: "kiwoom", interval_seconds: 86400 });
store.setBotStatus(k2.id, "running");
store.insertLog(k2.id, "hold", "[키움 모의] 035720 일봉 데이터 없음 — 진입 대기(관망)");
// NAVER: 관망(RSI 중립, 포지션 없음).
const k3c = store.insertComposite({ name: "NAVER RSI역추세", root_node: krLeaf("035420", 40, 70), symbol: "035420", market: "spot", leverage: 1, stop_loss_percent: null, take_profit_percent: null, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
const k3 = store.insertBot({ name: "NAVER(키움 모의)", symbol: "035420", composite_strategy_id: k3c.id, mode: "live", capital: 300_000, broker: "kiwoom", interval_seconds: 86400 });
store.setBotStatus(k3.id, "running");
await sleep(1500); // 키움 레이트리밋 회피(005930 직후)
const eK3 = await histBar("035420", "kiwoom", 55, "1d");
store.setBotPositionState(k3.id, { status: "open", entryAvg: eK3?.price ?? 265000, qty: 1, openedAt: eK3?.datetime ?? "2026-03-20T00:00:00Z" });
store.insertLog(k3.id, "buy", "[키움 모의] 035420 진입 1주 @265,000");

const { url } = await startDashboard(7788);
console.log("DASHBOARD_URL " + url);
