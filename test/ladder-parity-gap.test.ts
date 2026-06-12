/**
 * ladder-parity-gap.test.ts — Sprint 6 회귀: 라더 평단 패리티(audit P1-11) + 손절 갭 처리(P1-12) + weighted 라이브 거절(P1-13).
 *
 * P1-11: 종전엔 스케일인/피라미딩 평단을 '원시 틱 가격'으로 갱신했는데 거래 기록은 '슬리피지 조정가'로 남아
 *   엔진 내부 평단 ≠ 기록 trade 가중평단 ≠ 라이브 derivePosition 평단으로 3자 발산. 이제 buySlipPct 주입 시
 *   evaluateLadderTick 평단 == 체결가 가중평균 == derivePosition(trades) 평단이어야 한다.
 * P1-12: gapHandling='worst'면 봉 저가가 손절선을 터치할 때 발동하고 체결가=min(시가, 손절선).
 *   기본('close')은 기존 결과 바이트 동일(종가 판정).
 * P1-13: weighted(자본분할) 트리는 라이브 봇 시작이 거절돼야 한다(silent 단일병합 실행 금지).
 */
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-ladder-parity-${process.pid}`);

import { evaluateLadderTick, openPosition } from "../src/core/position/ladder.js";
import { derivePosition } from "../src/runner/runner.js";
import { runCompositeBacktest } from "../src/core/backtest/engine.js";
import * as store from "../src/store/db.js";
import { startBot } from "../src/mcp-server/bot-handlers.js";
import type { StrategyNode } from "../src/core/types/strategy.js";

describe("P1-11: 라더 평단 — 체결가(슬리피지) 기준 3자 일치", () => {
  it("스케일인 평단 = 체결가 가중평균 (buySlipPct 주입)", () => {
    const slip = 0.05; // %
    const st = openPosition({ entryPrice: 100, qty: 10, stopLossPercent: null, openedAt: "2025-01-01" });
    // 가격 90 → -10% 스케일인 발동(원시가 기준 트리거). 평단은 체결가 90*(1+0.05%) 기준이어야.
    const r = evaluateLadderTick(st, 90, [], { scaleIn: { ladder: [{ dropPct: 10, addPct: 100 }], maxMultiple: 3 }, buySlipPct: slip });
    expect(r.adds).toHaveLength(1);
    const exec = 90 * (1 + slip / 100);
    const expected = (100 * 10 + exec * 10) / 20;
    expect(r.next.entryAvg).toBeCloseTo(expected, 8);
    // 기록될 trade(체결가 exec)로 derivePosition을 돌려도 동일 평단 → 라이브 want.entryAvg와 일치
    const want = derivePosition([
      { action: "buy", price: 100, quantity: 10 },
      { action: "buy", price: exec, quantity: r.adds[0].qty },
    ]);
    expect(want.entryAvg).toBeCloseTo(r.next.entryAvg, 8);
  });

  it("buySlipPct 미지정 → 기존 동작 바이트 동일(원시가 평균, 회귀 0)", () => {
    const st = openPosition({ entryPrice: 100, qty: 10, stopLossPercent: null, openedAt: "2025-01-01" });
    const r = evaluateLadderTick(st, 90, [], { scaleIn: { ladder: [{ dropPct: 10, addPct: 100 }], maxMultiple: 3 } });
    expect(r.next.entryAvg).toBeCloseTo((100 * 10 + 90 * 10) / 20, 8);
  });
});

// ── P1-12: gapHandling ──
const bar = (i: number, o: number, h: number, l: number, c: number) => {
  const iso = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString();
  return { date: iso.slice(0, 10), datetime: iso, open: o, high: h, low: l, close: c, volume: 1000 };
};
// sma(1)<95 매수 / 절대 매도 안 함(SL만 청산 경로)
const buyLowStrat: StrategyNode = { id: "l", type: "leaf", name: "bl", strategy: { id: "s", userId: "u", name: "s", description: "", symbol: "TESTUSDT",
  rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "sma", params: { period: 1 }, operator: "lt", value: 95 }], quantityPercent: 100 }],
  isActive: true, createdAt: new Date(), updatedAt: new Date() } };

describe("P1-12: gapHandling — 손절 갭 모델", () => {
  // 시나리오: 90에 진입 → 다음 봉이 저가 70(손절선 85.5=-5% 관통)인데 종가는 95로 회복.
  const data = [
    ...Array.from({ length: 30 }, (_, i) => bar(i, 90, 90.5, 89.5, 90)), // 진입 구간(90<95)
    bar(30, 88, 96, 70, 95), // 갭/플래시크래시 봉: low 70 < SL 85.5, close 95(회복)
    ...Array.from({ length: 5 }, (_, i) => bar(31 + i, 100, 100.5, 99.5, 100)), // 이후(재진입 없게 >95)
  ];
  const cfgBase = { strategyId: "t", symbol: "TESTUSDT", startDate: data[0].date, endDate: data[data.length - 1].date, initialCapital: 10000, commission: 0.1, timeframe: "1d" } as const;
  const risk = { stopLossPercent: 5, takeProfitPercent: null, tpLadder: null, scaleIn: null, pyramid: null, trailingStopPercent: null } as never;

  it("기본(close): 종가 95 회복 → 손절 미발동(기존 동작)", () => {
    const r = runCompositeBacktest(buyLowStrat, data as never, { ...cfgBase } as never, 0, risk);
    expect(r.trades.filter((t) => t.action === "sell")).toHaveLength(0); // 종가 기준 -5% 미달
  });

  it("worst: 저가 터치로 발동 + 체결가=min(시가, 손절선)", () => {
    const r = runCompositeBacktest(buyLowStrat, data as never, { ...cfgBase, gapHandling: "worst" } as never, 0, risk);
    const sells = r.trades.filter((t) => t.action === "sell");
    expect(sells).toHaveLength(1);
    const entry = r.trades.find((t) => t.action === "buy")!.price;
    const stopLevel = entry * 0.95;
    expect(sells[0].price).toBeCloseTo(Math.min(88, stopLevel), 6); // 시가 88 vs 손절선 — 작은 쪽
    expect(sells[0].pnl).toBeLessThan(0); // 손실로 정직 기록
  });
});

describe("P1-13: weighted 트리 라이브 시작 거절", () => {
  function mkBot(mode: "paper" | "live", rootMode: "priority" | "weighted") {
    const root = { id: "r", type: "composite", mode: rootMode, children: [{ ...buyLowStrat, id: "c1" }] };
    const comp = store.insertComposite({ name: `w-${mode}-${rootMode}`, root_node: root, symbol: "TESTUSDT", market: "spot", leverage: 1, stop_loss_percent: null, take_profit_percent: null, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
    return store.insertBot({ name: `w-${mode}-${rootMode}`, symbol: "TESTUSDT", composite_strategy_id: comp.id, mode, capital: 1000, broker: "binance", interval_seconds: 3600 });
  }
  it("live + weighted → 거절(fail-closed)", () => {
    const b = mkBot("live", "weighted");
    const r = startBot({ botId: b.id }) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("weighted");
  });
  it("paper + weighted → 허용(시뮬 일관) / live + priority → 허용", () => {
    const p = startBot({ botId: mkBot("paper", "weighted").id }) as { ok: boolean };
    expect(p.ok).toBe(true);
    const l = startBot({ botId: mkBot("live", "priority").id }) as { ok: boolean };
    expect(l.ok).toBe(true);
  });
});
