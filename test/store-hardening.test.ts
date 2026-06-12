/**
 * store-hardening.test.ts — SQLite 내구성 강화(audit P1-21) 회귀.
 * WAL 모드 / tx 원자성(커밋·롤백) / liveOpenLedger(P0-1 시드 근거) / backupDb 스냅샷.
 */
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-store-hard-${process.pid}`);

import * as store from "../src/store/db.js";

function mkBot(name: string) {
  const comp = store.insertComposite({ name, root_node: { type: "leaf" }, symbol: "TESTUSDT", market: "spot", leverage: 1, stop_loss_percent: null, take_profit_percent: null, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
  return store.insertBot({ name, symbol: "TESTUSDT", composite_strategy_id: comp.id, mode: "live", capital: 1000, broker: "binance", interval_seconds: 60 });
}

describe("P1-21: SQLite 내구성", () => {
  it("journal_mode=WAL 적용", () => {
    const r = store.db().prepare(`PRAGMA journal_mode`).get() as { journal_mode: string };
    expect(r.journal_mode.toLowerCase()).toBe("wal");
  });

  it("tx 커밋: trade+position_state가 함께 반영", () => {
    const bot = mkBot("tx-commit");
    store.tx(() => {
      store.insertTrade({ bot_id: bot.id, side: "buy", price: 100, qty: 1, pnl: 0, is_paper: 0, reason: "t", idempotency_key: `${bot.id}:k1` });
      store.setBotPositionState(bot.id, { status: "open", entryAvg: 100, qty: 1 }, true, true);
    });
    expect(store.recentTrades(bot.id, 10)).toHaveLength(1);
    expect((store.getBot(bot.id)?.position_state as { qty: number }).qty).toBe(1);
  });

  it("tx 롤백: 중간 throw 시 trade도 state도 남지 않음(원자성)", () => {
    const bot = mkBot("tx-rollback");
    expect(() =>
      store.tx(() => {
        store.insertTrade({ bot_id: bot.id, side: "buy", price: 100, qty: 1, pnl: 0, is_paper: 0, reason: "t", idempotency_key: `${bot.id}:k2` });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.recentTrades(bot.id, 10)).toHaveLength(0); // 함께 죽음
    expect(store.getBot(bot.id)?.position_state).toBeNull();
  });
});

describe("P0-1: liveOpenLedger(라이브 체결 장부상 미청산)", () => {
  it("buy 2회 + 부분 sell → 잔여 수량과 가중평단", () => {
    const bot = mkBot("ledger-1");
    store.insertTrade({ bot_id: bot.id, side: "buy", price: 100, qty: 2, pnl: 0, is_paper: 0, reason: "", idempotency_key: `${bot.id}:b1` });
    store.insertTrade({ bot_id: bot.id, side: "buy", price: 200, qty: 2, pnl: 0, is_paper: 0, reason: "", idempotency_key: `${bot.id}:b2` });
    store.insertTrade({ bot_id: bot.id, side: "sell", price: 250, qty: 1, pnl: 100, is_paper: 0, reason: "", idempotency_key: `${bot.id}:s1` });
    const l = store.liveOpenLedger(bot.id);
    expect(l.qty).toBeCloseTo(3);
    expect(l.avgPrice).toBeCloseTo(150); // 평단은 매도에 불변(평단 기준 차감)
  });

  it("페이퍼 거래(is_paper=1)는 제외 — 라이브 근거만", () => {
    const bot = mkBot("ledger-2");
    store.insertTrade({ bot_id: bot.id, side: "buy", price: 100, qty: 5, pnl: 0, is_paper: 1, reason: "", idempotency_key: `${bot.id}:p1` });
    expect(store.liveOpenLedger(bot.id).qty).toBe(0);
  });

  it("전량 청산(과매도 포함) → qty 0 (음수 금지)", () => {
    const bot = mkBot("ledger-3");
    store.insertTrade({ bot_id: bot.id, side: "buy", price: 100, qty: 1, pnl: 0, is_paper: 0, reason: "", idempotency_key: `${bot.id}:b1` });
    store.insertTrade({ bot_id: bot.id, side: "sell", price: 110, qty: 2, pnl: 10, is_paper: 0, reason: "", idempotency_key: `${bot.id}:s1` });
    expect(store.liveOpenLedger(bot.id).qty).toBe(0);
  });
});

describe("P1-21: backupDb", () => {
  it("VACUUM INTO 스냅샷 생성 + 경로 반환", () => {
    const dest = store.backupDb();
    expect(dest).toBeTruthy();
    expect(existsSync(dest as string)).toBe(true);
  });
});
