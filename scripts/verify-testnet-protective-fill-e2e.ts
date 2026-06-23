/**
 * verify-testnet-protective-fill-e2e.ts — #6 상주 SL/TP 체결 reconcile 실거래소 계약 검증(binance testnet).
 *
 * #6 로직(거래소 상주 스톱 체결 → 장부 SELL 기록)의 book/clear/멱등은 단위테스트(protective-fill-reconcile.test.ts)가
 * 결정적으로 증명한다. 이 스크립트는 단위테스트로 못 잡는 **실거래소 거동 가정**을 검증한다(#2 오탐 교훈):
 *   Part A) 상주 SL/TP가 거래소에 NEW(미체결)로 떠 있는 동안 reconcileProtectiveFills가 **아무것도 기록 안 함**
 *           (= 체결 안 된 상주 주문을 체결로 오기록하지 않음, 핵심 안전속성) + 포지션 유지.
 *   Part B) `pS`형 cid의 실 체결 주문을 getOrderByClientId로 조회 시 status='filled' + executedQty>0 + price>0
 *           (= reconcile가 기록에 쓰는 바로 그 응답 필드가 실거래소에서 정확히 온다).
 * 자동 정리(보호주문 취소 + 청산 + temp 삭제). 가짜돈.
 *
 * 실행: npx tsx scripts/verify-testnet-protective-fill-e2e.ts
 */
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { console.error(".env.local 없음"); process.exit(1); }
const DATA_DIR = join(tmpdir(), `quant-mcp-protfill-e2e-${process.pid}`);
process.env.QUANT_MCP_DATA_DIR = DATA_DIR;
process.env.LIVE_MAX_NOTIONAL = process.env.LIVE_MAX_NOTIONAL || "50";
process.env.LIVE_SYMBOL_ALLOWLIST = process.env.LIVE_SYMBOL_ALLOWLIST || "BTCUSDT,ETHUSDT";

const store = await import("../src/store/db.js");
const { tickBot } = await import("../src/runner/runner.js");
const { getAdapter } = await import("../src/brokers/index.js");
const SYMBOL = "BTCUSDT";
const log = (s: string) => console.log(s);
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; log(`   ✅ ${name}${extra ? " — " + extra : ""}`); } else { fail++; log(`   ❌ ${name}${extra ? " — " + extra : ""}`); } };

async function main() {
  if (process.env.BINANCE_ENV !== "testnet") { log("⚠️ BINANCE_ENV != testnet — 안전 중단"); process.exit(1); }
  const got = getAdapter("binance", "spot");
  const a = got!.adapter as {
    getOrderByClientId?: (s: string, c: string) => Promise<{ status: string; executedQty: number; price: number } | null>;
    cancelOrderByClientId?: (s: string, c: string) => Promise<boolean>;
    placeOrder: (o: unknown) => Promise<{ status: string; executedQty?: number; price: number; orderId: string }>;
    normalizeQuantity?: (s: string, q: number, p: number) => Promise<number>;
    getPrice: (s: string) => Promise<{ price: number }>;
  };

  const strat = { id: "s", userId: "u", name: "s", description: "", symbol: SYMBOL, rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: 200 }], quantityPercent: 100 }], isActive: true, createdAt: new Date(), updatedAt: new Date() };
  const comp = store.insertComposite({ name: "protfill-e2e", root_node: { id: "l", type: "leaf", name: "buy", strategy: strat }, symbol: SYMBOL, market: "spot", leverage: 1, stop_loss_percent: 5, take_profit_percent: 10, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: null });
  const bot = store.insertBot({ name: "protfill-e2e-bot", symbol: SYMBOL, composite_strategy_id: comp.id, mode: "live", capital: 30, broker: "binance", interval_seconds: 3600 });
  log(`봇 생성: ${bot.id} (live, capital $30, SL 5% / TP 10%)`);

  let botPos: { qty?: number; protectiveIds?: string[] } | null = null;
  try {
    // ── 틱1: 실 testnet 매수 + 상주 SL/TP 배치
    log("\n① tickBot → 실 매수 + 상주 SL/TP 배치...");
    const r1 = await tickBot(bot.id);
    botPos = store.getBot(bot.id)?.position_state as typeof botPos;
    log(`   결과: ${r1.action} / qty=${botPos?.qty} protectiveIds=${JSON.stringify(botPos?.protectiveIds)}`);
    if (r1.action !== "buy" || !botPos?.qty) { log("   ⚠️ 매수 안 됨(데이터/게이트) — 검증 중단"); return; }
    check("진입 + 상주 보호주문 2다리(SL+TP) 배치", (botPos.protectiveIds ?? []).length === 2);

    // 상주 주문이 거래소에 NEW(미체결)로 떠 있는지 확인
    log("\n② 상주 보호주문 거래소 상태(미체결=NEW 기대):");
    let allResting = true;
    for (const cid of botPos.protectiveIds ?? []) {
      const o = a.getOrderByClientId ? await a.getOrderByClientId(SYMBOL, cid) : null;
      const st = o?.status ?? "(없음)";
      if (st !== "pending") allResting = false;
      log(`     ${cid}: status=${st}`);
    }
    check("상주 SL/TP 둘 다 거래소 미체결(pending/NEW)", allResting);

    // ── 틱2: reconcileProtectiveFills가 미체결 상주를 '체결'로 오기록하지 않아야 함(핵심 안전속성)
    log("\n③ 다음 틱 → reconcileProtectiveFills가 미체결 상주를 오기록하지 않는가...");
    await tickBot(bot.id);
    const after2 = store.getBot(bot.id)?.position_state as typeof botPos;
    const falseBooked = store.recentTrades(bot.id, 20).filter((t) => t.reason?.includes("상주 SL/TP 거래소 체결"));
    check("미체결 상주 → SELL 오기록 0건(false-book 없음)", falseBooked.length === 0, `booked=${falseBooked.length}`);
    check("포지션 유지(오청산 없음)", !!after2?.qty && after2.qty > 0, `qty=${after2?.qty}`);

    // ── Part B: 실 체결 주문의 getOrderByClientId 응답 계약(filled + executedQty + price)
    log("\n④ 체결감지 계약: pS형 cid 실 시장가 매수 → getOrderByClientId 응답 필드 검증...");
    const px = (await a.getPrice(SYMBOL)).price;
    const probeQty = a.normalizeQuantity ? await a.normalizeQuantity(SYMBOL, 12 / px, px) : 12 / px; // ~$12 < 캡
    const probeCid = `pStestfill${Date.now().toString(36)}`.slice(0, 30);
    const pr = await a.placeOrder({ symbol: SYMBOL, side: "buy", type: "market", quantity: probeQty, clientOrderId: probeCid });
    log(`   프로브 매수: status=${pr.status} qty=${probeQty}`);
    const q = a.getOrderByClientId ? await a.getOrderByClientId(SYMBOL, probeCid) : null;
    log(`   getOrderByClientId(${probeCid}): ${JSON.stringify(q)}`);
    check("체결 주문 status='filled'", q?.status === "filled");
    check("executedQty > 0", (q?.executedQty ?? 0) > 0, `executedQty=${q?.executedQty}`);
    check("price > 0", (q?.price ?? 0) > 0, `price=${q?.price}`);

    // 프로브 매수분 청산(누적 보유 정리)
    try { const nq = a.normalizeQuantity ? await a.normalizeQuantity(SYMBOL, probeQty, px) : probeQty; await a.placeOrder({ symbol: SYMBOL, side: "sell", type: "market", quantity: nq, clientOrderId: `c${Date.now().toString(36)}` }); } catch (e) { log(`   프로브 청산 실패(정리에서 재시도): ${e instanceof Error ? e.message : e}`); }
  } finally {
    // ── 정리: 보호주문 취소 + 봇 포지션 청산
    log("\n⑤ 정리(보호주문 취소 + 청산)...");
    for (const cid of botPos?.protectiveIds ?? []) {
      try { const ok = a.cancelOrderByClientId ? await a.cancelOrderByClientId(SYMBOL, cid) : false; log(`   보호주문 취소 ${cid}: ${ok}`); } catch (e) { log(`   취소 실패 ${cid}: ${e instanceof Error ? e.message : e}`); }
    }
    if (botPos?.qty) {
      try { const px = (await a.getPrice(SYMBOL)).price; const nq = a.normalizeQuantity ? await a.normalizeQuantity(SYMBOL, botPos.qty, px) : botPos.qty; const r = await a.placeOrder({ symbol: SYMBOL, side: "sell", type: "market", quantity: nq, clientOrderId: `c${Date.now().toString(36)}x` }); log(`   봇 포지션 청산: ${r.status} qty=${nq}`); } catch (e) { log(`   청산 실패(수동 정리 필요): ${e instanceof Error ? e.message : e}`); }
    }
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* noop */ }
  }
  log(`\n${fail === 0 ? "✅" : "❌"} #6 상주 보호주문 체결 reconcile 실거래소 계약 검증: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("E2E 오류:", e); try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* noop */ } process.exit(1); });
