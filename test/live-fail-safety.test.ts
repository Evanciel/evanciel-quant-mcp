/**
 * live-fail-safety.test.ts — 코덱스 P0 3건 회귀 방지(실거래 켜는 순간 터지는 구멍들).
 *  P0-1 채널 고정: 라이브 주문 실패가 조용히 페이퍼로 기록되어 실/로컬 포지션이 발산하던 구멍.
 *   - 라이브 채널 포지션의 매도 실패 → 동결(기록·상태 무변경, 다음 틱 재시도)
 *   - 페이퍼 채널 포지션 → 실주문 자체를 안 냄(실계좌 오버셀 방지)
 *   - 거부(rejected)는 체결이 아님 / 모호 실패(결과불명)는 페이퍼 기록 금지(동결)
 *  P0-2 보호주문 에스컬레이션: 배치 실패 swallow → 손절 없는 나체 포지션 방치 금지(연속 실패 → 비상 청산).
 *  P0-3 키움: return_code 없는 응답=성공 처리 / ord_no 없는 유령 pending / 분봉 KST를 Z(UTC)로 라벨.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-failsafe-${process.pid}`);
// 라이브 게이트 통과용(testnet 가짜 키 — 실거래소 호출 없음, 어댑터는 모킹).
process.env.BINANCE_ENV = "testnet";
process.env.BINANCE_API_KEY = "x".repeat(64);
process.env.BINANCE_API_SECRET = "y".repeat(64);

const calls = vi.hoisted(() => ({
  placed: [] as Array<Record<string, unknown>>,
  // ok=전부 체결 / throwAll=전 주문 throw / rejectAll=시장가 rejected 반환 / throwProtective=보호주문만 throw / throwTpOnly=TP leg만 throw(SL 성공)
  mode: "ok" as "ok" | "throwAll" | "rejectAll" | "throwProtective" | "throwTpOnly",
  getOrderThrows: false,            // true → getOrderByClientId throw → verdict unknown(모호)
  getOrderResult: null as unknown,  // null=not_placed(주문 안 나감 확정)
  fillCids: null as Set<string> | null, // 설정 시 getOrderByClientId가 이 cid에만 체결 응답(직전봉 입양 #5 테스트용)
  positions: null as unknown[] | null,  // 설정 시 getPositions가 이 계좌 보유 반환(강제 reconcile #4 테스트용)
}));
const klinesMock = vi.hoisted(() => vi.fn());

vi.mock("../src/data/binance-public.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, fetchKlines: klinesMock };
});
vi.mock("../src/brokers/index.js", () => ({
  getAdapter: () => ({
    adapter: {
      async placeOrder(o: Record<string, unknown>) {
        calls.placed.push(o);
        const prot = o.type === "stop_market" || o.type === "take_profit_market";
        if (calls.mode === "throwAll") throw new Error("network boom(mock)");
        if (calls.mode === "throwProtective" && prot) throw new Error("prot-fail(mock)");
        if (calls.mode === "throwTpOnly" && o.type === "take_profit_market") throw new Error("tp-fail(mock)"); // SL(stop_market)은 성공, TP만 실패

        if (calls.mode === "rejectAll" && !prot) {
          return { orderId: "", symbol: o.symbol, side: o.side, quantity: o.quantity, price: 0, status: "rejected" as const, timestamp: new Date() };
        }
        return { orderId: "oid-" + calls.placed.length, symbol: o.symbol, side: o.side, quantity: o.quantity, price: 100, status: "filled" as const, timestamp: new Date() };
      },
      async getOrderByClientId(_sym: string, cid: string) {
        if (calls.getOrderThrows) throw new Error("inquiry unsupported(mock)");
        if (calls.fillCids && !calls.fillCids.has(cid)) return null; // cid-aware: 지정 cid만 체결로 응답
        return calls.getOrderResult;
      },
      async cancelOrderByClientId() { return true; },
      async cancelOrder() { return true; },
      async getBalance() { return { totalAsset: 100000, cashBalance: 100000, currency: "USDT" }; },
      async getPositions() { return calls.positions ?? []; },
    },
  }),
}));

import * as store from "../src/store/db.js";
import { tickBot, nextProtFails, type PaperPosition } from "../src/runner/runner.js";
import { cancelOrderById } from "../src/mcp-server/live-handlers.js";
import type { StrategyNode } from "../src/core/types/strategy.js";

const bar = (i: number, c: number) => { const iso = new Date(Date.UTC(2025, 0, 1) + i * 3600000).toISOString(); return { date: iso.slice(0, 10), datetime: iso, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000 }; };
const barsAt = (n: number, prices: (i: number) => number) => Array.from({ length: n }, (_, i) => bar(i, prices(i)));

// buy: sma(1)<95(=가격<95) / sell: sma(1)>105 — 깔끔한 진입/청산.
const buyLowSellHigh: StrategyNode = { id: "l", type: "leaf", name: "bls", strategy: { id: "s", userId: "u", name: "s", description: "", symbol: "BTCUSDT",
  rules: [
    { id: "b", action: "buy", conditions: [{ id: "c", indicator: "sma", params: { period: 1 }, operator: "lt", value: 95 }], quantityPercent: 100 },
    { id: "se", action: "sell", conditions: [{ id: "c2", indicator: "sma", params: { period: 1 }, operator: "gt", value: 105 }], quantityPercent: 100 },
  ], isActive: true, createdAt: new Date(), updatedAt: new Date() } };

function mkLiveBot(name: string, stopLossPercent: number | null = 5, takeProfitPercent: number | null = null) {
  const comp = store.insertComposite({ name, root_node: buyLowSellHigh, symbol: "BTCUSDT", market: "spot", leverage: 1, stop_loss_percent: stopLossPercent, take_profit_percent: takeProfitPercent, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
  return store.insertBot({ name, symbol: "BTCUSDT", composite_strategy_id: comp.id, mode: "live", capital: 1000, broker: "binance", interval_seconds: 3600 }).id;
}
const reset = () => { calls.placed.length = 0; calls.mode = "ok"; calls.getOrderThrows = false; calls.getOrderResult = null; calls.fillCids = null; calls.positions = null; };

describe("P0-1 채널 고정: 라이브 실패의 조용한 페이퍼 기록 금지", () => {
  it("라이브 채널 포지션 매도 실패(not_placed 확정) → 동결: 기록 0 + 포지션 유지", async () => {
    reset(); calls.mode = "throwAll"; // 주문 throw + 조회 null(not_placed)
    const id = mkLiveBot("p01-freeze");
    // 라이브 채널 포지션 주입(엔진이 진입→청산 신호를 내도록 가격 90→110 시나리오).
    store.setBotPositionState(id, { status: "open", entryAvg: 90, qty: 5, openedAt: new Date().toISOString(), live: true } satisfies PaperPosition);
    klinesMock.mockResolvedValue(barsAt(50, (i) => (i < 30 ? 90 : 110))); // 엔진 want=flat → 매도 시도
    const r = await tickBot(id);
    expect(r.action).toBe("hold");
    expect(r.detail).toContain("동결");
    expect(store.recentTrades(id, 10).filter((t) => t.side === "sell")).toHaveLength(0); // 페이퍼 위장 기록 없음
    const st = store.getBot(id)?.position_state as PaperPosition | null;
    expect(st?.qty).toBe(5); // 포지션 그대로(다음 틱 재시도)
  });

  it("페이퍼 채널 포지션 청산 → 실주문 0건, 페이퍼로만 기록", async () => {
    reset();
    const id = mkLiveBot("p01-paperchan");
    store.setBotPositionState(id, { status: "open", entryAvg: 90, qty: 5, openedAt: new Date().toISOString(), live: false } satisfies PaperPosition);
    klinesMock.mockResolvedValue(barsAt(50, (i) => (i < 30 ? 90 : 110)));
    const r = await tickBot(id);
    expect(r.action).toBe("sell");
    expect(calls.placed).toHaveLength(0); // 실계좌에 주문 안 나감(오버셀 방지)
    const sells = store.recentTrades(id, 10).filter((t) => t.side === "sell");
    expect(sells).toHaveLength(1);
    expect(sells[0].is_paper).toBe(1); // 페이퍼로 정직 기록
    expect(store.getBot(id)?.position_state).toBeNull();
  });

  it("주문 거부(rejected 반환) → 신규 진입은 페이퍼 폴백(유령 live 기록 없음)", async () => {
    reset(); calls.mode = "rejectAll";
    const id = mkLiveBot("p01-rejected", null); // 보호주문 없이(시장가 거부 검증에 집중)
    klinesMock.mockResolvedValue(barsAt(50, () => 90)); // 진입 신호
    const r = await tickBot(id);
    expect(r.action).toBe("buy");
    const buys = store.recentTrades(id, 10).filter((t) => t.side === "buy");
    expect(buys).toHaveLength(1);
    expect(buys[0].is_paper).toBe(1); // 거부=체결 아님 → live 기록 금지
    expect((store.getBot(id)?.position_state as PaperPosition).live).toBe(false); // 채널=페이퍼로 시작
  });

  it("모호 실패(주문 throw + 조회 불가) 신규 진입 → 유령 기록 0 + 재진입 억제 마커(#5, 이중매수 방지)", async () => {
    reset(); calls.mode = "throwAll"; calls.getOrderThrows = true; // verdict unknown
    const id = mkLiveBot("p01-unknown", null);
    klinesMock.mockResolvedValue(barsAt(50, () => 90));
    const r = await tickBot(id);
    expect(r.action).toBe("hold");
    // #5: 옛 '동결(null)'은 다음 봉 재매수를 허용했다 → 재진입 억제 마커로 강화(거래소 reconcile 회수 대기).
    expect(r.detail).toContain("결과불명");
    expect(store.recentTrades(id, 10)).toHaveLength(0); // 핵심: 주문이 나갔을 수도 → 유령 페이퍼/라이브 기록 금지
    const ps = store.getBot(id)?.position_state as PaperPosition & { pendingUnknownEntry?: { intendedQty: number } };
    expect(ps?.pendingUnknownEntry?.intendedQty).toBeGreaterThan(0); // 의도수량 기록(다음 틱 회수 근거)
    expect(ps?.qty).toBe(0); // 포지션 수량 0(유령 보유 없음)
  });
});

describe("P0-2 보호주문 연속 실패 → 비상 청산(fail-closed)", () => {
  // 2026-06 audit P1-4 의도적 동작 변경: 손절(SL) leg 배치 실패 + 손절 설정 포지션이면 protFails가
  // 한도(기본 3)로 '즉시 점프' — TP만 걸린 편다리/나체 포지션을 3틱(180초) 들고 있지 않고 다음 틱에 비상 청산.
  it("SL 배치 실패 시 protFails 즉시 한도 점프 → 다음 틱 비상 청산(3틱 대기 금지)", async () => {
    reset(); calls.mode = "throwProtective"; // 시장가는 체결, 보호주문만 실패
    const id = mkLiveBot("p02-escalate", 5); // 손절 5% 설정(보호를 원한 포지션)
    klinesMock.mockResolvedValue(barsAt(50, () => 90)); // 진입 후 계속 보유
    const r1 = await tickBot(id); // 진입 + SL 배치 실패 → 한도 즉시 점프
    expect(r1.action).toBe("buy");
    expect((store.getBot(id)?.position_state as PaperPosition).protFails).toBe(3); // 1→2→3 점증 아님(즉시)
    const r2 = await tickBot(id); // 비상 청산 발동(나체 노출 최대 1틱)
    expect(r2.action).toBe("sell");
    expect(r2.detail).toContain("비상 청산");
    expect(store.getBot(id)?.position_state).toBeNull(); // 나체 포지션 해소
    const sells = store.recentTrades(id, 10).filter((t) => t.side === "sell");
    expect(sells).toHaveLength(1);
    expect(sells[0].reason).toContain("비상 청산");
    expect(sells[0].is_paper).toBe(0); // 라이브 채널이므로 실청산
    // SL 배치가 실제로 시도됐는지(swallow 아님)
    expect(calls.placed.filter((o) => o.type === "stop_market").length).toBeGreaterThanOrEqual(1);
  });
});

describe("P0-3 키움: 응답 신뢰성 + KST 타임스탬프", () => {
  // 전역 fetch 스텁(토큰 + API). 이 describe 안에서만.
  const fetchMock = vi.fn();
  let apiBody: Record<string, unknown> = {};
  const jsonRes = (body: unknown) => ({ ok: true, status: 200, json: async () => body, headers: new Headers() });
  beforeAll(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("/oauth2/token") ? jsonRes({ token: "tkn", expires_in: 3600 }) : jsonRes(apiBody));
  });
  afterAll(() => { vi.unstubAllGlobals(); });

  async function adapter() {
    const { KiwoomBrokerAdapter } = await import("../src/brokers/kiwoom.js");
    return new KiwoomBrokerAdapter({ appkey: "ak", secretkey: "sk", env: "mock" });
  }

  it("return_code 없는 빈 응답 → getBalance가 성공(잔고 0)으로 둔갑하지 않고 throw", async () => {
    apiBody = {}; // 만료토큰/게이트웨이 비정형 응답 시뮬레이션
    await expect((await adapter()).getBalance()).rejects.toThrow(/missing return_code/);
  });

  it("placeOrder: return_code도 ord_no도 없는 응답 → 유령 pending 금지(throw)", async () => {
    apiBody = {};
    await expect((await adapter()).placeOrder({ symbol: "005930", side: "buy", type: "market", quantity: 1 })).rejects.toThrow(/no return_code\/ord_no/);
  });

  it("placeOrder: 접수 성공 주장인데 ord_no 없음 → throw", async () => {
    apiBody = { return_code: 0 };
    await expect((await adapter()).placeOrder({ symbol: "005930", side: "buy", type: "market", quantity: 1 })).rejects.toThrow(/ord_no missing/);
  });

  it("placeOrder: 정상 접수(return_code 0 + ord_no) → pending + 주문번호", async () => {
    apiBody = { return_code: 0, ord_no: "12345" };
    const r = await (await adapter()).placeOrder({ symbol: "005930", side: "buy", type: "market", quantity: 1 });
    expect(r.status).toBe("pending");
    expect(r.orderId).toBe("12345");
    expect(r.price).toBe(0); // 체결가 미확인 — 러너가 명시 기록/감사
  });

  it("분봉 cntr_tm은 KST → '+09:00' 라벨(이전 'Z' 라벨=9시간 어긋남 버그)", async () => {
    apiBody = { return_code: 0, stk_min_pole_chart_qry: [{ cntr_tm: "20260610103000", open_pric: "100", high_pric: "110", low_pric: "90", cur_prc: "105", trde_qty: "1000" }] };
    const bars = await (await adapter()).getCandles("005930", "5m", 10);
    expect(bars).toHaveLength(1);
    expect(bars[0].datetime).toBe("2026-06-10T10:30:00+09:00");
    // epoch 검증: KST 10:30 == UTC 01:30 (Z로 라벨했다면 9시간 어긋났을 것)
    expect(Date.parse(bars[0].datetime)).toBe(Date.UTC(2026, 5, 10, 1, 30, 0));
  });

  it("일봉 dt도 KST 자정 기준 '+09:00'", async () => {
    apiBody = { return_code: 0, stk_dt_pole_chart_qry: [{ dt: "20260610", open_pric: "100", high_pric: "110", low_pric: "90", cur_prc: "105", trde_qty: "1000" }] };
    const bars = await (await adapter()).getCandles("005930", "1d", 10);
    expect(bars).toHaveLength(1);
    expect(bars[0].datetime).toBe("2026-06-10T00:00:00+09:00");
    expect(Date.parse(bars[0].datetime)).toBe(Date.UTC(2026, 5, 9, 15, 0, 0)); // KST 자정 = 전일 15:00 UTC
  });
});

// ── 적대검증 #1: 비상 청산 카운터는 '손절(SL) 부재(나체)'만 추적 — 현물 SL+TP 동시 설정에서 TP leg가 base 잔량
//    부족(-2010)으로 매 틱 실패해도 SL이 정상이면 건강한 포지션을 비상 시장가 청산하지 않는다(치명 버그 수정). ──
describe("nextProtFails — SL(나체)만 비상 추적(현물 SL+TP 오청산 차단)", () => {
  it("실패 0 → 카운터 0 리셋", () => {
    expect(nextProtFails(2, { failed: 0, slFailed: false }, true)).toBe(0);
  });
  it("SL leg 실패 + 손절 설정 → 즉시 한도(다음 틱 비상, 나체 방지) — 원동작 유지", () => {
    expect(nextProtFails(0, { failed: 1, slFailed: true }, true)).toBe(3); // PROTECTIVE_MAX_FAILS 기본 3
  });
  it("SL 정상 + TP만 실패(현물 SL+TP -2010) + 손절 설정 → 카운터 0(비상 금지) — 버그 수정", () => {
    // 종전: prev+1 누적 → 3틱 뒤 SL 정상인 건강 포지션을 비상청산. 수정 후: 0 유지(나체 아님).
    expect(nextProtFails(2, { failed: 1, slFailed: false }, true)).toBe(0);
    expect(nextProtFails(0, { failed: 1, slFailed: false }, true)).toBe(0);
  });
  it("손절 미설정(hasStop=false)에서 보호 leg 실패는 누적(비상 게이트가 hasStop 요구라 미발동)", () => {
    expect(nextProtFails(1, { failed: 1, slFailed: false }, false)).toBe(2);
  });
});

// ── P0-5 엔진 포지션 시드(근본해결): 진입봉이 윈도우 밖으로 스크롤아웃돼도 단순 SL/TP 경로면 라이브 포지션으로 엔진을
//    시드 재실행 → 청산 신호가 있으면 정확히 청산, 없으면 보유 유지(오청산/오매수 0). backtest≡live(seed-parity.test.ts 증명).
//    interim 보수 가드(무조건 보유)는 라더/스케일인/피라미딩·in-window 무신호에만 잔존. ──
describe("(B) P0-5 윈도우 스크롤아웃 시드 재평가", () => {
  it("스크롤아웃 + 윈도우 청산 신호 → 시드 재평가로 정확히 청산(보유 5 전량, P0-5)", async () => {
    reset(); // mode ok(체결 성공)
    const id = mkLiveBot("p05-scrolled-exit", 5);
    // 진입봉이 윈도우(2025)보다 한참 전(2024) → 스크롤아웃. 시드(5@90) 보유 시작 → 바25 가격110에서 청산 신호.
    store.setBotPositionState(id, { status: "open", entryAvg: 90, qty: 5, openedAt: "2024-06-01T00:00:00.000Z", live: true } satisfies PaperPosition);
    klinesMock.mockResolvedValue(barsAt(50, (i) => (i < 25 ? 90 : 110)));
    const r = await tickBot(id);
    expect(r.action).toBe("sell"); // 시드 엔진이 보유→청산 신호 인식 → 정확히 청산(이전 interim은 보수적으로 보유만 했음)
    const sells = store.recentTrades(id, 10).filter((t) => t.side === "sell");
    expect(sells).toHaveLength(1);
    expect(sells[0].qty).toBe(5); // 보유 전량(초과/과소 아님)
    expect(store.getBot(id)?.position_state).toBeNull();
  });
  it("스크롤아웃 + 청산 신호 없음(보유 신호만) → 시드 재평가로 보유 유지(오청산 0)", async () => {
    reset();
    const id = mkLiveBot("p05-scrolled-hold", 5);
    store.setBotPositionState(id, { status: "open", entryAvg: 90, qty: 5, openedAt: "2024-06-01T00:00:00.000Z", live: true } satisfies PaperPosition);
    klinesMock.mockResolvedValue(barsAt(50, () => 90)); // 전부 저가(매수 신호) — 시드 보유 중이라 재매수 차단, 청산 신호 없음
    const r = await tickBot(id);
    expect(r.action).toBe("hold"); // 보유 유지(오청산 없음)
    expect(store.recentTrades(id, 10).filter((t) => t.side === "sell")).toHaveLength(0);
    expect((store.getBot(id)?.position_state as PaperPosition).qty).toBe(5); // 5 유지(엔진 사이징 ~11로 재매수하지 않음)
  });
  it("openedAt가 윈도우 안이면 정상 청산(엔진 넷 신뢰 — backtest≡live)", async () => {
    reset();
    const id = mkLiveBot("p05-inwindow", 5);
    store.setBotPositionState(id, { status: "open", entryAvg: 90, qty: 5, openedAt: "2025-01-01T10:00:00.000Z", live: true } satisfies PaperPosition);
    klinesMock.mockResolvedValue(barsAt(50, (i) => (i < 25 ? 90 : 110)));
    const r = await tickBot(id);
    expect(r.action).toBe("sell"); // 진입봉 윈도우 내 → 엔진 청산 신호 반영
  });

  it("off-by-one 경계(#9): 진입봉이 윈도우 첫 봉 '직전'이면 스크롤아웃 즉시 발동 → 시드 재평가(보유 신호만이면 보유 유지, 오매수 0)", async () => {
    reset();
    const id = mkLiveBot("p09-boundary", 5); // interval 3600s
    // 진입 봉 = data[0] 직전 봉. openedAt = data[0] open(2025-01-01T00:00). intervalMs 보정으로 스크롤아웃 발동 → 시드.
    //   off-by-one 버그(미발동)면 시드 미적용 → 비시드 윈도우가 자본 사이징(~11)으로 want 산출 → 5→11 오매수. 발동 시 시드로 보유 5 유지.
    store.setBotPositionState(id, { status: "open", entryAvg: 90, qty: 5, openedAt: "2025-01-01T00:00:00.000Z", live: true } satisfies PaperPosition);
    klinesMock.mockResolvedValue(barsAt(50, () => 90)); // 매수 신호만(청산 없음) — 시드면 보유 5, 비시드면 11로 오매수
    const r = await tickBot(id);
    expect(r.action).toBe("hold"); // 스크롤아웃 발동 → 시드 → 보유 유지
    expect(store.recentTrades(id, 10).filter((t) => t.side === "buy")).toHaveLength(0); // 오매수 0
    expect((store.getBot(id)?.position_state as PaperPosition).qty).toBe(5);
  });
});

// ── 적대검증 #1 통합: 현물 SL+TP에서 TP leg만 실패해도 건강한(SL 정상) 포지션을 비상청산하지 않는다(엔드투엔드) ──
describe("#1 통합: TP-only 실패는 비상청산 안 함", () => {
  it("SL 성공·TP 실패 반복 → protFails 0 유지·비상 시장가 청산 없음·포지션 유지", async () => {
    reset(); calls.mode = "throwTpOnly"; // SL(stop_market) 성공, TP(take_profit_market)만 throw
    const id = mkLiveBot("p01-tponly", 5, 10); // SL 5% + TP 10%
    klinesMock.mockResolvedValue(barsAt(50, () => 90)); // 진입 후 보유(SL 85.5·TP 99 미발동)
    const r1 = await tickBot(id);
    expect(r1.action).toBe("buy");
    expect((store.getBot(id)?.position_state as PaperPosition).protFails ?? 0).toBe(0); // TP-only 실패는 비상 카운터 미증가
    for (let i = 0; i < 4; i++) { const r = await tickBot(id); expect(r.action).not.toBe("sell"); } // 여러 틱 — 비상청산 없음(종전 버그면 누적→청산)
    expect(store.getBot(id)?.position_state).not.toBeNull(); // 포지션 유지
    expect(store.recentTrades(id, 20).filter((t) => String(t.reason).includes("비상"))).toHaveLength(0);
  });
});

// ── 적대검증 #17: cancelOrderById도 liveGate 경유 — 취소는 상주 보호주문(SL/TP)을 벗겨 리스크를 '증가'시킬 수
//    있으므로 글로벌 킬스위치(LIVE_TRADING_HALT)·마스터 OFF에서 메인넷 취소가 나가면 안 된다. ──
describe("cancelOrderById liveGate(HALT·master OFF 취소 차단)", () => {
  it("LIVE_TRADING_HALT=true면 취소 차단(상주 보호주문 박탈 방지)", async () => {
    process.env.LIVE_TRADING_HALT = "true";
    const r = await cancelOrderById({ broker: "binance", symbol: "BTCUSDT", orderId: "x" });
    delete process.env.LIVE_TRADING_HALT;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("HALT");
  });
  it("게이트 통과(testnet 키)면 정상 취소", async () => {
    reset();
    const r = await cancelOrderById({ broker: "binance", symbol: "BTCUSDT", orderId: "x" });
    expect(r.ok).toBe(true);
    expect(r.cancelled).toBe(true);
  });
  it("메인넷 키 + master OFF → 취소 차단(#17 헤드라인: 상주 보호주문 박탈 방지)", async () => {
    reset();
    const savedEnv = process.env.BINANCE_ENV;
    process.env.BINANCE_ENV = "live"; delete process.env.LIVE_TRADING_ENABLED; // 메인넷 키, 마스터 OFF
    const r = await cancelOrderById({ broker: "binance", symbol: "BTCUSDT", orderId: "x" });
    process.env.BINANCE_ENV = savedEnv; // 복구(다른 테스트 격리)
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("마스터"); // 마스터 OFF 차단 사유
  });
});

// ── 적대검증 #4/#5: 라이브 reconcile/유령 방어(fail-closed 디펜시브) ──
describe("#4 binance 강제 reconcile 근거 캡 / #5 직전봉 오입양 회귀가드", () => {
  it("#5 후속(라운드트립 회귀): 직전 봉 cid가 거래소에 체결돼 있어도 현재 봉 fresh 매수는 신규 주문(직전봉 오입양 금지)", async () => {
    // prevBar 입양은 정상 라운드트립(매수→청산→재매수)을 유령으로 오입양하는 회귀를 만들어 되돌렸다(같은 봉 cid만 입양).
    //   이 테스트는 'prevBar 입양'이 재도입되면 실패한다(현재 동작=신규 주문). reset();
    reset();
    const id = mkLiveBot("p05-roundtrip", null);
    const bars = barsAt(50, () => 90);
    klinesMock.mockResolvedValue(bars);
    const data = bars.slice(0, -1);
    const prevIso = data[data.length - 2].datetime;
    const prevCid = `o${id.slice(0, 8)}b${"BTCUSDT".slice(0, 12)}${Math.floor(Date.parse(prevIso) / 1000).toString(36)}`;
    calls.fillCids = new Set([prevCid]); // 직전 봉 cid만 거래소 체결로 존재(=이미 청산된 정상 라운드트립 진입)
    calls.getOrderResult = { orderId: "prev-roundtrip", price: 90, quantity: 5, status: "filled" };
    const r = await tickBot(id);
    expect(r.action).toBe("buy"); // 합법 재진입
    expect(calls.placed.filter((o) => o.type === "market")).toHaveLength(1); // 직전봉 입양이 아니라 '신규 시장가 매수'(prevBar 오입양 금지 회귀가드)
  });

  it("#4 binance forceReconcile adopt를 근거(curQty/ledger)로 캡 — 수동보유 오입양 차단", async () => {
    reset();
    const id = mkLiveBot("p04-cap", null);
    // 봇 라이브 보유 0.01, unknownCount≥MAX → 첫 틱 forceReconcileOnUnknown. trades 0 → ledger 0.
    store.setBotPositionState(id, { status: "open", entryAvg: 100, qty: 0.01, openedAt: new Date().toISOString(), live: true, unknownCount: 99 } satisfies PaperPosition);
    calls.positions = [{ symbol: "BTC", quantity: 1.01, avgPrice: 100 }]; // 계좌: 사용자 수동 1 + 봇 0.01
    klinesMock.mockResolvedValue(barsAt(50, () => 100)); // 무신호 → 보유 유지
    await tickBot(id);
    const st = store.getBot(id)?.position_state as PaperPosition;
    expect(st.qty).toBeCloseTo(0.01, 8); // 거래소 1.01이나 근거(0.01)로 캡
    expect(st.qty).toBeLessThan(1);       // 수동보유 1 미채택(오입양 차단)
  });

  it("#4 reject 분기: 봇 라이브 체결 근거 0(curQty 0 + ledger 0) + 거래소 보유>0 → 수동보유 미채택", async () => {
    reset();
    const id = mkLiveBot("p04-reject", null);
    // 근거 0: 로컬 보유 0 + 거래내역 0(ledger 0). unknownCount≥MAX로 forceReconcile 진입.
    store.setBotPositionState(id, { status: "open", entryAvg: 0, qty: 0, openedAt: new Date().toISOString(), live: true, unknownCount: 99 } satisfies PaperPosition);
    calls.positions = [{ symbol: "BTC", quantity: 1.01, avgPrice: 100 }]; // 거래소엔 사용자 수동보유만
    klinesMock.mockResolvedValue(barsAt(50, () => 100)); // 무신호
    await tickBot(id);
    const st = store.getBot(id)?.position_state as PaperPosition | null;
    expect(st == null || !(st.qty > 1e-9)).toBe(true); // 거래소 1.01 미채택(근거 0 → 수동보유로 간주)
  });
});
