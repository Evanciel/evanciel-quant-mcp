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
  // ok=전부 체결 / throwAll=전 주문 throw / rejectAll=시장가 rejected 반환 / throwProtective=보호주문만 throw
  mode: "ok" as "ok" | "throwAll" | "rejectAll" | "throwProtective",
  getOrderThrows: false,            // true → getOrderByClientId throw → verdict unknown(모호)
  getOrderResult: null as unknown,  // null=not_placed(주문 안 나감 확정)
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
        if (calls.mode === "rejectAll" && !prot) {
          return { orderId: "", symbol: o.symbol, side: o.side, quantity: o.quantity, price: 0, status: "rejected" as const, timestamp: new Date() };
        }
        return { orderId: "oid-" + calls.placed.length, symbol: o.symbol, side: o.side, quantity: o.quantity, price: 100, status: "filled" as const, timestamp: new Date() };
      },
      async getOrderByClientId() {
        if (calls.getOrderThrows) throw new Error("inquiry unsupported(mock)");
        return calls.getOrderResult;
      },
      async cancelOrderByClientId() { return true; },
      async cancelOrder() { return true; },
      async getBalance() { return { totalAsset: 100000, cashBalance: 100000, currency: "USDT" }; },
      async getPositions() { return []; },
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

function mkLiveBot(name: string, stopLossPercent: number | null = 5) {
  const comp = store.insertComposite({ name, root_node: buyLowSellHigh, symbol: "BTCUSDT", market: "spot", leverage: 1, stop_loss_percent: stopLossPercent, take_profit_percent: null, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
  return store.insertBot({ name, symbol: "BTCUSDT", composite_strategy_id: comp.id, mode: "live", capital: 1000, broker: "binance", interval_seconds: 3600 }).id;
}
const reset = () => { calls.placed.length = 0; calls.mode = "ok"; calls.getOrderThrows = false; calls.getOrderResult = null; };

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

  it("모호 실패(주문 throw + 조회 불가) 신규 진입 → 기록 없이 동결(이중 장부 방지)", async () => {
    reset(); calls.mode = "throwAll"; calls.getOrderThrows = true; // verdict unknown
    const id = mkLiveBot("p01-unknown", null);
    klinesMock.mockResolvedValue(barsAt(50, () => 90));
    const r = await tickBot(id);
    expect(r.action).toBe("hold");
    expect(r.detail).toContain("동결");
    expect(store.recentTrades(id, 10)).toHaveLength(0); // 주문이 나갔을 수도 → 페이퍼 기록 금지
    expect(store.getBot(id)?.position_state).toBeNull();
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

// ── 적대검증 #9: (B) 윈도우스크롤 가드 — 진입봉이 300봉 윈도우 밖으로 밀린 장기보유는 엔진 넷(윈도우만 본)을
//    신뢰하지 않고 보유 유지(전량 덤핑/초과 재매수 차단). SL/TP는 거래소 상주 스톱이 계속 보호. ──
describe("(B) 윈도우스크롤 가드(P0-5 interim)", () => {
  it("openedAt < 윈도우 oldest 봉 + 엔진 buy→sell 사이클(넷0) → 청산 안 함(보유 유지)", async () => {
    reset(); // mode ok(체결 성공) — 가드 없으면 청산됨
    const id = mkLiveBot("p05-scrolled", 5);
    // 진입봉이 윈도우(2025 봉들)보다 한참 전(2024) → 스크롤아웃. 엔진은 윈도우 안 buy+sell만 봐 넷=0.
    store.setBotPositionState(id, { status: "open", entryAvg: 90, qty: 5, openedAt: "2024-06-01T00:00:00.000Z", live: true } satisfies PaperPosition);
    klinesMock.mockResolvedValue(barsAt(50, (i) => (i < 25 ? 90 : 110))); // 저가 진입→고가 청산 1사이클(엔진 넷 0)
    const r = await tickBot(id);
    expect(r.action).toBe("hold");
    expect(r.detail).toContain("스크롤아웃");
    expect(store.recentTrades(id, 10).filter((t) => t.side === "sell")).toHaveLength(0); // 전량 덤핑 안 함
    expect((store.getBot(id)?.position_state as PaperPosition).qty).toBe(5); // 보유 유지
  });
  it("openedAt가 윈도우 안이면 정상 청산(엔진 넷 신뢰 — backtest≡live)", async () => {
    reset();
    const id = mkLiveBot("p05-inwindow", 5);
    store.setBotPositionState(id, { status: "open", entryAvg: 90, qty: 5, openedAt: "2025-01-01T10:00:00.000Z", live: true } satisfies PaperPosition);
    klinesMock.mockResolvedValue(barsAt(50, (i) => (i < 25 ? 90 : 110)));
    const r = await tickBot(id);
    expect(r.action).toBe("sell"); // 진입봉 윈도우 내 → 엔진 청산 신호 반영
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
});
