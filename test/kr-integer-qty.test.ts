/**
 * kr-integer-qty.test.ts — KR(한국주식) 정수주 수량 + 체결 미확인(pending) fail-closed 회귀.
 *
 * 실측 발견(2026-06, 키움 모의서버): 매수 신호 → 봇 로컬 장부엔 "삼성전자 5.63주 매수 보유"로 기록됐으나
 *  실제 키움 모의계좌는 변화 0(5주 그대로). 즉 로컬 장부 ≠ 거래소 실계좌(발산). 두 원인:
 *   [Bug#1 소수 수량] KR 주식은 정수주만 거래 가능한데 엔진/러너가 포지션 수량을 소수(5.63)로 계산·store 기록.
 *     → quantizeQty(symbol)로 KR이면 엔진(백테)·러너(라이브) 양쪽 정수 → store(장부)==거래소(발산 방지). 크립토는 분수 유지.
 *   [Bug#2 pending=보유] 키움 시장가=pending(price 0) + 지정가=pending(price>0)인데 러너가 보유로 기록.
 *     → fillConfirmed=(status==='filled' && price>0)만 보유 인정. pending이면 fail-closed(동결, 다음 틱 재시도).
 *
 * 불변식: 크립토(Binance) 경로 무영향(분수 수량·시장가 filled). 실 키움 호출 0(getAdapter 모킹).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-kr-int-${process.pid}`);
// 키움 라이브 게이트 통과용(env 기본=mock → 마스터스위치 불필요, 가짜돈). 어댑터 모킹이라 실호출 0.
process.env.KIWOOM_APPKEY = "ka";
process.env.KIWOOM_SECRETKEY = "ks";

import { isKrStockSymbol, quantizeQty, floorQty } from "../src/core/position/qty.js";

describe("Bug#1 순수: isKrStockSymbol + quantizeQty", () => {
  it("KR 종목코드 판정(6자리 숫자, A접두/접미 흡수)", () => {
    expect(isKrStockSymbol("005930")).toBe(true);       // 삼성전자
    expect(isKrStockSymbol("A005930")).toBe(true);       // A접두
    expect(isKrStockSymbol("005930.KS")).toBe(true);     // 접미 시장코드
    expect(isKrStockSymbol("005930_AL")).toBe(true);
    expect(isKrStockSymbol("035720")).toBe(true);        // 카카오
  });
  it("크립토/미국주식/빈값은 비KR(분수 경로 유지)", () => {
    expect(isKrStockSymbol("BTCUSDT")).toBe(false);
    expect(isKrStockSymbol("ETHUSDT")).toBe(false);
    expect(isKrStockSymbol("AAPL")).toBe(false);
    expect(isKrStockSymbol("12345")).toBe(false);        // 5자리(6자리 아님)
    expect(isKrStockSymbol("00593")).toBe(false);        // 5자리(경계: 6자리 미만)
    expect(isKrStockSymbol("1234567")).toBe(false);      // 7자리
    expect(isKrStockSymbol("")).toBe(false);
    expect(isKrStockSymbol(undefined)).toBe(false);
    expect(isKrStockSymbol(null)).toBe(false);
  });
  it("경계: 6자리 숫자 뒤 영문 연속은 비KR(\\b 워드경계 — 오탐 차단)", () => {
    // "123456ABC"/"005930KQ"는 숫자6→영문이 워드경계 없이 이어짐 → 6자리코드가 아님(크립토/타거래소 티커 흡수 금지).
    //   이 경계가 무너지면 'BTC123456' 류가 KR로 오판→정수강제→크립토 발산. 가장 까다로운 regex 분기 고정.
    expect(isKrStockSymbol("123456ABC")).toBe(false);
    expect(isKrStockSymbol("005930KQ")).toBe(false);
    expect(isKrStockSymbol("A0059301")).toBe(false);     // A접두 후 7자리(접두 규약은 정확히 6자리만)
  });
  it("quantizeQty: KR=정수 내림, 크립토=floorQty(8자리 분수)와 바이트 동일", () => {
    expect(quantizeQty(5.63, "005930")).toBe(5);         // KR 정수(발산원이던 5.63 → 5)
    expect(quantizeQty(5.99, "005930")).toBe(5);
    expect(quantizeQty(0.9, "005930")).toBe(0);          // 1주 미만 → 0(무거래)
    // 크립토: floorQty와 완전 동일(회귀 0)
    expect(quantizeQty(0.015873256, "BTCUSDT")).toBe(floorQty(0.015873256));
    expect(quantizeQty(16.11211475, "ETHUSDT")).toBe(floorQty(16.11211475));
    // 심볼 미지정 → floorQty 동치
    expect(quantizeQty(0.0166)).toBe(floorQty(0.0166));
  });
  it("0/음수/비유한 → 0(KR·크립토 공통)", () => {
    expect(quantizeQty(0, "005930")).toBe(0);
    expect(quantizeQty(-1, "005930")).toBe(0);
    expect(quantizeQty(NaN, "005930")).toBe(0);
    expect(quantizeQty(Infinity, "BTCUSDT")).toBe(0);
  });
});

// ── 사이징 레이어(order-sizing): 엔진·러너가 공유하는 단일 진입수량 산출이 symbol을 전파하는지 직접 고정 ──
//   엔진 테스트(아래)는 computeOrderQty를 간접 호출하지만, finalizeQty의 symbol 전파가 빠지면 엔진/스캐너 양쪽이
//   동시 회귀한다. 이 직접 단위테스트로 회귀 지점을 order-sizing.ts로 국소화(legacy 경로의 quantizeQty 분기 고정).
import { computeOrderQty } from "../src/core/risk/order-sizing.js";

describe("Bug#1 사이징: computeOrderQty가 KR symbol이면 정수 수량(크립토/미지정은 분수)", () => {
  const base = { equity: 400_000, price: 71_000, commissionPct: 0.1, closes: [71000], timeframe: "1d", legacyQuantityPercent: 100 };
  it("KR(005930): qty 정수(5), 크립토(BTCUSDT): 분수, 동일 입력", () => {
    const kr = computeOrderQty({ ...base, symbol: "005930" });
    expect(Number.isInteger(kr.qty)).toBe(true);
    expect(kr.qty).toBe(5);                              // floor(400000/71071) = 5주
    const btc = computeOrderQty({ equity: 1000, price: 60_000, commissionPct: 0.1, closes: [60000], timeframe: "1d", legacyQuantityPercent: 100, symbol: "BTCUSDT" });
    expect(btc.qty).toBeGreaterThan(0);
    expect(btc.qty).toBeLessThan(1);
    expect(Number.isInteger(btc.qty)).toBe(false);       // 분수 유지(정수 강제됐으면 0=무거래였을 것)
  });
  it("회귀: symbol 미지정은 floorQty 경로와 바이트 동일(크립토 회귀 0)", () => {
    const withBtc = computeOrderQty({ equity: 1000, price: 60_000, commissionPct: 0.1, closes: [60000], timeframe: "1d", legacyQuantityPercent: 100, symbol: "BTCUSDT" });
    const noSym = computeOrderQty({ equity: 1000, price: 60_000, commissionPct: 0.1, closes: [60000], timeframe: "1d", legacyQuantityPercent: 100 });
    expect(noSym.qty).toBe(withBtc.qty);                 // symbol 분기는 KR에서만 갈라짐 → 비KR/미지정 동치
  });
});

// ── 엔진(백테) 정수 수량: backtest≡live 일관(러너가 derivePosition으로 이 trade 수량을 그대로 라이브 반영) ──
import { runCompositeBacktest } from "../src/core/backtest/engine.js";
import type { StrategyNode, Strategy, BacktestConfig } from "../src/core/types/strategy.js";

function buyLeaf(symbol: string): StrategyNode {
  const strat: Strategy = { id: "s", userId: "u", name: "s", description: "", symbol,
    rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: 200 }], quantityPercent: 100 }],
    isActive: true, createdAt: new Date(), updatedAt: new Date() };
  return { id: "l", type: "leaf", name: "buy", strategy: strat };
}
// 삼성전자류 가격대(7만원대) — 자본 400,000 → 정수 floor면 5주, 소수면 5.6x주.
function krBars() {
  return Array.from({ length: 40 }, (_, i) => ({ date: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10), open: 71000, high: 71500, low: 70500, close: 71000, volume: 100000 }));
}

describe("Bug#1 엔진: KR 백테 진입 수량은 정수(소수주 금지)", () => {
  it("KR(005930) 자본 400,000 / 71,000원 → 정수주(5), 소수 아님", () => {
    const bars = krBars();
    const cfg: BacktestConfig = { strategyId: "t", symbol: "005930", startDate: bars[0].date, endDate: bars[39].date, initialCapital: 400_000, commission: 0.1, timeframe: "1d" };
    const res = runCompositeBacktest(buyLeaf("005930"), bars as unknown as Parameters<typeof runCompositeBacktest>[1], cfg);
    const buy = res.trades.find((t) => t.action === "buy")!;
    expect(buy).toBeTruthy();
    expect(Number.isInteger(buy.quantity)).toBe(true);   // 정수주(발산원이던 5.6x → 5)
    expect(buy.quantity).toBe(5);
  });
  it("회귀-크립토: 같은 형태라도 BTCUSDT는 분수 수량 유지(정수 강제 안 함)", () => {
    const bars = Array.from({ length: 40 }, (_, i) => ({ date: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10), open: 60000, high: 60100, low: 59900, close: 60000, volume: 1000 }));
    const cfg: BacktestConfig = { strategyId: "t", symbol: "BTCUSDT", startDate: bars[0].date, endDate: bars[39].date, initialCapital: 1000, commission: 0.1, timeframe: "1d" };
    const res = runCompositeBacktest(buyLeaf("BTCUSDT"), bars as unknown as Parameters<typeof runCompositeBacktest>[1], cfg);
    const buy = res.trades.find((t) => t.action === "buy")!;
    expect(buy.quantity).toBeGreaterThan(0);
    expect(buy.quantity).toBeLessThan(1);                 // 분수(< 1 BTC) — 정수 강제됐으면 0이라 무거래였을 것
    expect(Number.isInteger(buy.quantity)).toBe(false);
  });
  it("KR 라더(tp_ladder) 부분익절 수량도 정수(엔진=라이브 단일 경로)", () => {
    // +5%에서 남은수량 50% 익절. 5주의 50%=2.5 → KR이면 정수(2).
    const bars = [
      ...Array.from({ length: 10 }, (_, i) => ({ date: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10), open: 71000, high: 71000, low: 71000, close: 71000, volume: 100000 })),
      // +5% 도달 봉(74,550)
      ...Array.from({ length: 6 }, (_, i) => ({ date: new Date(Date.UTC(2025, 0, 11) + i * 86400000).toISOString().slice(0, 10), open: 75000, high: 75500, low: 74600, close: 75000, volume: 100000 })),
    ];
    const cfg: BacktestConfig = { strategyId: "t", symbol: "005930", startDate: bars[0].date, endDate: bars[bars.length - 1].date, initialCapital: 400_000, commission: 0.1, timeframe: "1d" };
    const res = runCompositeBacktest(buyLeaf("005930"), bars as unknown as Parameters<typeof runCompositeBacktest>[1], cfg, 0, { tpLadder: [{ pct: 5, sellPct: 50 }, { pct: 100, sellPct: 100 }] });
    for (const t of res.trades) expect(Number.isInteger(t.quantity)).toBe(true); // 모든 체결(진입·부분익절) 정수
  });
});

// ── 러너(라이브) KR: 정수 포지션 + pending fail-closed ──
const state = vi.hoisted(() => ({
  placed: [] as Array<Record<string, unknown>>,
  kiwoomStatus: "filled" as "pending" | "filled" | "rejected",
  kiwoomPrice: 71000, // KR 어댑터가 체결가를 실어 줄 때(지정가/일부 응답). pending+price>0 = Bug#2 갭.
}));
const klinesMock = vi.hoisted(() => vi.fn());

vi.mock("../src/data/binance-public.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, fetchKlines: klinesMock };
});

vi.mock("../src/brokers/index.js", () => ({
  getAdapter: (broker: string) => {
    if (broker !== "kiwoom") return null;
    return {
      adapter: {
        // KR 주식: 정수 수량(소수주 미지원). 러너 nq 정규화 + Bug#1 엔진 정수와 일관.
        async normalizeQuantity(_s: string, q: number) { return Math.max(0, Math.floor(q)); },
        async placeOrder(o: Record<string, unknown>) {
          state.placed.push(o);
          if (state.kiwoomStatus === "rejected") return { orderId: "", symbol: o.symbol, side: o.side, quantity: o.quantity, price: 0, status: "rejected" as const, timestamp: new Date() };
          return { orderId: "kw-" + state.placed.length, symbol: o.symbol, side: o.side, quantity: o.quantity, price: state.kiwoomPrice, status: state.kiwoomStatus as "pending" | "filled", timestamp: new Date() };
        },
        async getBalance() { return { totalAsset: 10_000_000, cashBalance: 10_000_000, currency: "KRW" }; },
        async getPositions() { return []; },
        // ⚠️ getOrderByClientId 의도적 미정의(키움 실제 상태) → 체결 미확인 시 fail-closed.
        async getCandles() { return klinesMock(); },
      },
    };
  },
}));

import * as store from "../src/store/db.js";
import { tickBot, type PaperPosition } from "../src/runner/runner.js";

// buy: rsi(2)<200(=항상 매수) — 깔끔한 진입 신호.
function mkKrBot(name: string, mode: "live" | "paper", status: "pending" | "filled") {
  const comp = store.insertComposite({ name, root_node: buyLeaf("005930"), symbol: "005930", market: "spot", leverage: 1, stop_loss_percent: null, take_profit_percent: null, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
  state.kiwoomStatus = status;
  return store.insertBot({ name, symbol: "005930", composite_strategy_id: comp.id, mode, capital: 400_000, broker: "kiwoom", interval_seconds: 86400 }).id;
}

beforeEach(() => { state.placed.length = 0; state.kiwoomStatus = "filled"; state.kiwoomPrice = 71000; klinesMock.mockResolvedValue(krBars()); });

describe("Bug#1 러너: KR 라이브 봇의 store 포지션 수량은 정수", () => {
  it("키움 매수 filled → 보유 수량 정수(5), 소수 아님(장부==계좌)", async () => {
    const id = mkKrBot("kr-live", "live", "filled");
    const r = await tickBot(id);
    expect(r.action).toBe("buy");
    const pos = store.getBot(id)?.position_state as PaperPosition;
    expect(pos.status).toBe("open");
    expect(Number.isInteger(pos.qty)).toBe(true);        // 정수주(발산원이던 5.6x 차단)
    expect(pos.qty).toBe(5);
    const buy = store.recentTrades(id, 10).find((t) => t.side === "buy")!;
    expect(Number.isInteger(buy.qty)).toBe(true);
    expect(buy.is_paper).toBe(0);                          // 라이브 체결로 기록
  });
});

describe("Bug#2 러너: KR pending(체결 미확인)은 보유로 기록 금지(fail-closed)", () => {
  it("핵심: 키움 pending + price>0(지정가형) → 보유 기록 없음 + 동결(이전엔 보유로 둔갑)", async () => {
    const id = mkKrBot("kr-pending", "live", "pending"); // status=pending, price=71000(>0) = Bug#2 갭 재현
    const r = await tickBot(id);
    expect(r.action).toBe("hold");                        // 보유 기록 안 함 → hold
    expect(store.recentTrades(id, 10)).toHaveLength(0);   // 장부 드리프트 0
    expect(store.getBot(id)?.position_state).toBeNull();  // 거래소에 없는 포지션 안 만듦
    expect(state.placed.length).toBeGreaterThanOrEqual(1); // 주문 접수 시도는 함
    const logs = store.recentLogs(id, 30).map((l) => l.detail).join("\n");
    expect(logs).toMatch(/체결 미확인|동결/);              // 침묵 금지(로그)
  });
  it("회귀-페이퍼: mode=paper 키움 봇은 가상 체결 정상(정수 수량, pending 로직 미도달)", async () => {
    const id = mkKrBot("kr-paper", "paper", "pending");
    const r = await tickBot(id);
    expect(r.action).toBe("buy");
    const pos = store.getBot(id)?.position_state as PaperPosition;
    expect(Number.isInteger(pos.qty)).toBe(true);         // 페이퍼도 KR 정수
    expect(pos.qty).toBe(5);
    expect(store.recentTrades(id, 10).find((t) => t.side === "buy")?.is_paper).toBe(1);
    expect(state.placed).toHaveLength(0);                  // 실주문 0(조기 return)
  });
});
