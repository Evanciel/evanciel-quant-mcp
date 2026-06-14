/**
 * kiwoom-fill-unconfirmed.test.ts — P0-5 회귀: 키움/한투 체결 미확인을 보유로 기록 금지(fail-closed).
 *
 * 실측 발견(2026-06, 키움 모의서버): 매수 신호 → 봇 로컬 장부엔 '보유'로 기록됐으나 실계좌는 변화 0.
 *  원인: 키움 시장가 placeOrder가 status:'pending' + price:0(체결가 미확인)을 반환하는데, runner.fillOrder가
 *  이를 live:true + filledQty로 둔갑시켜 store에 보유 기록 → 장부≠계좌 발산. 키움은 getOrderByClientId(주문조회)
 *  미구현이라 '주문조회로 실체결 확인'(우선안)이 배선 불가 → 정답=fail-closed(보유 기록 금지·동결, 다음 틱 재시도).
 *
 * 불변식: 가드 조건은 'priceConfirmed===false && getOrderByClientId 미지원'으로 좁힘 → 바이낸스(시장가
 *  priceConfirmed=true, 지정가는 getOrderByClientId 지원)는 미진입(회귀 0). 페이퍼 봇은 fillOrder 조기 return으로 무영향.
 * 실 키움 호출 0(getAdapter 모킹 — broker별 어댑터 분기).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-kiwoom-unconf-${process.pid}`);
// 바이낸스 라이브 게이트 통과용(testnet 가짜 키 — 실거래소 호출 없음, 어댑터 모킹).
process.env.BINANCE_ENV = "testnet";
process.env.BINANCE_API_KEY = "x".repeat(64);
process.env.BINANCE_API_SECRET = "y".repeat(64);
// 키움 라이브 게이트 통과용(env 기본=mock → 마스터스위치 불필요, 가짜돈). 어댑터는 모킹이라 실호출 없음.
process.env.KIWOOM_APPKEY = "ka";
process.env.KIWOOM_SECRETKEY = "ks";

const state = vi.hoisted(() => ({
  placed: [] as Array<Record<string, unknown>>,
  // 키움 mock placeOrder가 반환할 체결 상태(시장가 접수=pending·price 0이 실측 발산원).
  kiwoomStatus: "pending" as "pending" | "filled" | "rejected",
  kiwoomPrice: 0,
}));
const klinesMock = vi.hoisted(() => vi.fn());

// 키움 일봉(가격<95 = 매수 신호). datetime=KST 자정(어댑터 규약과 일치).
function kiwoomBars(n: number, priceAt: (i: number) => number) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    const c = priceAt(i);
    return { date: d, datetime: `${d}T00:00:00+09:00`, open: c, high: c + 1, low: c - 1, close: c, volume: 1000 };
  });
}

vi.mock("../src/data/binance-public.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, fetchKlines: klinesMock };
});

// broker별 어댑터 분기: kiwoom=주문조회 미지원 + 시장가 pending/price0(실측 형태), binance=즉시 체결가(priceConfirmed).
vi.mock("../src/brokers/index.js", () => ({
  getAdapter: (broker: string) => {
    if (broker === "kiwoom") {
      return {
        adapter: {
          // 키움 KR 주식: 정수 수량(소수주 미지원).
          async normalizeQuantity(_s: string, q: number) { return Math.max(0, Math.floor(q)); },
          async placeOrder(o: Record<string, unknown>) {
            state.placed.push(o);
            if (state.kiwoomStatus === "rejected") {
              return { orderId: "", symbol: o.symbol, side: o.side, quantity: o.quantity, price: 0, status: "rejected" as const, timestamp: new Date() };
            }
            // 시장가 접수: pending + price 0(체결가 미확인) — 발산을 일으키던 실제 키움 응답 형태.
            return { orderId: "kw-" + state.placed.length, symbol: o.symbol, side: o.side, quantity: o.quantity, price: state.kiwoomPrice, status: state.kiwoomStatus as "pending", timestamp: new Date() };
          },
          async getBalance() { return { totalAsset: 10_000_000, cashBalance: 10_000_000, currency: "KRW" }; },
          async getPositions() { return []; },
          // ⚠️ getOrderByClientId 의도적 미정의(키움 어댑터 실제 상태) → fail-closed 분기 발동.
          // ⚠️ getCandles는 tickBot이 KR 데이터 소스로 호출 → kiwoomBars 반환.
          async getCandles() { return klinesMock(); },
        },
      };
    }
    // binance(회귀): 시장가 즉시 체결가 → priceConfirmed=true → fail-closed 미진입.
    return {
      adapter: {
        async placeOrder(o: Record<string, unknown>) {
          state.placed.push(o);
          return { orderId: "bn-" + state.placed.length, symbol: o.symbol, side: o.side, quantity: o.quantity, price: 100, status: "filled" as const, timestamp: new Date() };
        },
        async getOrderByClientId() { return null; },
        async cancelOrderByClientId() { return true; },
        async cancelOrder() { return true; },
        async getBalance() { return { totalAsset: 100000, cashBalance: 100000, currency: "USDT" }; },
        async getPositions() { return []; },
      },
    };
  },
}));

import * as store from "../src/store/db.js";
import { tickBot, type PaperPosition } from "../src/runner/runner.js";
import type { StrategyNode } from "../src/core/types/strategy.js";

// buy: sma(1)<95(=가격<95) / sell: sma(1)>105 — 깔끔한 진입/청산 신호. symbol별 leaf 생성.
function mkLeaf(symbol: string): StrategyNode {
  return { id: "l", type: "leaf", name: "bl", strategy: { id: "s", userId: "u", name: "s", description: "", symbol,
    rules: [
      { id: "b", action: "buy", conditions: [{ id: "c", indicator: "sma", params: { period: 1 }, operator: "lt", value: 95 }], quantityPercent: 100 },
      { id: "se", action: "sell", conditions: [{ id: "c2", indicator: "sma", params: { period: 1 }, operator: "gt", value: 105 }], quantityPercent: 100 },
    ], isActive: true, createdAt: new Date(), updatedAt: new Date() } };
}

function mkBot(name: string, broker: "kiwoom" | "binance", symbol: string) {
  const comp = store.insertComposite({ name, root_node: mkLeaf(symbol), symbol, market: "spot", leverage: 1, stop_loss_percent: null, take_profit_percent: null, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
  return store.insertBot({ name, symbol, composite_strategy_id: comp.id, mode: "live", capital: 1_000_000, broker, interval_seconds: 86400 }).id;
}

beforeEach(() => { state.placed.length = 0; state.kiwoomStatus = "pending"; state.kiwoomPrice = 0; });

describe("P0-5 키움 체결 미확인 → 보유 기록 금지(fail-closed)", () => {
  it("(1) 핵심: 키움 시장가 pending(price 0) 진입 → 보유 기록 없음 + 동결", async () => {
    klinesMock.mockResolvedValue(kiwoomBars(50, () => 90)); // 매수 신호
    const id = mkBot("kw-unconf", "kiwoom", "005930");
    const r = await tickBot(id);
    // 거래소 미반영 가능 → 보유로 기록하지 않고 동결(hold).
    expect(r.action).toBe("hold");
    expect(store.recentTrades(id, 10)).toHaveLength(0);              // 보유 기록 0건(장부 드리프트 차단)
    expect(store.getBot(id)?.position_state).toBeNull();             // 거래소에 없는 포지션 안 만듦
    expect(state.placed.length).toBeGreaterThanOrEqual(1);           // 주문 시도는 했음(접수)
    // 동결 메시지가 로그에 남는지(침묵 금지).
    const logs = store.recentLogs(id, 30).map((l) => l.detail).join("\n");
    expect(logs).toMatch(/체결 미확인|동결/);
  });

  it("(2) 재시도: 같은 닫힌봉 두 번째 틱도 여전히 미기록(보유 0 유지)", async () => {
    klinesMock.mockResolvedValue(kiwoomBars(50, () => 90));
    const id = mkBot("kw-retry", "kiwoom", "005930");
    await tickBot(id);
    const r2 = await tickBot(id);
    expect(r2.action).toBe("hold");
    expect(store.recentTrades(id, 10)).toHaveLength(0);
    expect(store.getBot(id)?.position_state).toBeNull();
  });

  it("(3) 회귀-크립토: 바이낸스 시장가 filled(price>0) → 정상 보유 기록(priceConfirmed 경로 불변)", async () => {
    klinesMock.mockResolvedValue(
      // 봉 간격은 봇 interval(86400s=1d)과 일치해야 함(audit P1-22 캔들 무결성 게이트). 일봉 간격(86400000ms).
      Array.from({ length: 50 }, (_, i) => { const iso = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString(); return { date: iso.slice(0, 10), datetime: iso, open: 90, high: 90.5, low: 89.5, close: 90, volume: 1000 }; }),
    );
    const id = mkBot("bn-ok", "binance", "BTCUSDT");
    const r = await tickBot(id);
    expect(r.action).toBe("buy");
    const buys = store.recentTrades(id, 10).filter((t) => t.side === "buy");
    expect(buys).toHaveLength(1);
    expect(buys[0].is_paper).toBe(0);                                // 라이브 체결로 기록
    expect((store.getBot(id)?.position_state as PaperPosition).qty).toBeGreaterThan(0);
  });

  it("(4) 회귀-페이퍼: mode=paper 키움 봇 → 가상 체결 정상 기록(미확인 로직 미도달)", async () => {
    klinesMock.mockResolvedValue(kiwoomBars(50, () => 90));
    const comp = store.insertComposite({ name: "kw-paper", root_node: mkLeaf("005930"), symbol: "005930", market: "spot", leverage: 1, stop_loss_percent: null, take_profit_percent: null, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
    const id = store.insertBot({ name: "kw-paper", symbol: "005930", composite_strategy_id: comp.id, mode: "paper", capital: 1_000_000, broker: "kiwoom", interval_seconds: 86400 }).id;
    const r = await tickBot(id);
    expect(r.action).toBe("buy");
    const buys = store.recentTrades(id, 10).filter((t) => t.side === "buy");
    expect(buys).toHaveLength(1);
    expect(buys[0].is_paper).toBe(1);                                // 페이퍼로 정직 기록
    expect((store.getBot(id)?.position_state as PaperPosition).qty).toBeGreaterThan(0);
    expect(state.placed).toHaveLength(0);                            // 실주문 0(조기 return)
  });

  it("(5) 어댑터 단위: 키움 placeOrder(시장가) → pending + price 0(러너가 이 형태를 보유로 안 만듦)", async () => {
    // live-fail-safety.test.ts:189-195가 어댑터를 직접 검증 — 여기선 mock 어댑터가 그 계약(pending/price0)을 재현함을 확인.
    const got = (await import("../src/brokers/index.js")).getAdapter("kiwoom", "spot")!;
    const res = await got.adapter.placeOrder({ symbol: "005930", side: "buy", type: "market", quantity: 5 });
    expect(res.status).toBe("pending");
    expect(res.price).toBe(0);
    expect((got.adapter as unknown as Record<string, unknown>).getOrderByClientId).toBeUndefined(); // 주문조회 미지원 → fail-closed 발동 조건
  });
});
