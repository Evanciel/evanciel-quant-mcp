/**
 * verify-testnet-regime-bot-e2e.ts — 옵션 B "하락장 대응(레짐필터)" testnet 실체결 시연(정직).
 *
 * ⚠️ 정직 라벨: 이 데모는 "알파"를 주장하지 않는다. 백테스트(scripts/test-bear-strategies.ts)에서
 *    하락장 방향성 알파는 ≈0 으로 기각됐다. 여기서 보이는 것은 **리스크 통제 머니패스**가 실제
 *    거래소(testnet)에서 작동한다는 것 — ① 레짐필터가 하락추세에서 진입을 차단(자본보존),
 *    ② 진입 시 거래소에 상주 SL/TP(보호주문)가 실제로 걸린다(봇 다운/봉 사이에도 손절 유지).
 *
 * 같은 레짐필터 봇을 두 타임프레임으로 돌려 B의 두 올바른 행동을 모두 보인다:
 *   Leg 1) interval=1d  → 현재 BTC 일봉 레짐=trend_down → 게이트 차단 → 진입 0(회피 작동).
 *   Leg 2) interval=1h  → 현재 BTC 시간봉 레짐=trend_up  → 게이트 통과 → 실 testnet 매수 +
 *                          거래소 상주 보호주문 배치 → 거래소 조회로 확인 → 정리(취소+청산).
 *
 * 실행: npx tsx scripts/verify-testnet-regime-bot-e2e.ts  (.env.local 자동 로드, 가짜돈)
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { console.error(".env.local 없음"); process.exit(1); }
process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-regime-e2e-${process.pid}`);
process.env.LIVE_MAX_NOTIONAL = process.env.LIVE_MAX_NOTIONAL || "50";
process.env.LIVE_SYMBOL_ALLOWLIST = process.env.LIVE_SYMBOL_ALLOWLIST || "BTCUSDT,ETHUSDT";

const store = await import("../src/store/db.js");
const { tickBot } = await import("../src/runner/runner.js");
const { getAdapter } = await import("../src/brokers/index.js");
const SYMBOL = "BTCUSDT";
const log = (s: string) => console.log(s);

// 레짐필터로 감싼 항상매수 leaf. trend_down 이면 thenNode 비활성 → 진입 차단(B 회피).
// 게이트 통과 시 leaf 의 rsi<200(항상참)으로 진입 → 레짐만이 유일 게이트가 되어 B 동작이 깨끗이 드러남.
function regimeAvoidRoot() {
  const strat = {
    id: "s", userId: "u", name: "regime-avoid", description: "", symbol: SYMBOL,
    rules: [{ id: "b", action: "buy", conditions: [{ id: "c", indicator: "rsi", params: { period: 2 }, operator: "lt", value: 200 }], quantityPercent: 100 }],
    isActive: true, createdAt: new Date(), updatedAt: new Date(),
  };
  return {
    id: "root", type: "condition", name: "하락추세 회피",
    condition: { type: "regime", in: ["trend_up", "range", "high_vol"] },
    thenNode: { id: "l", type: "leaf", name: "buy", strategy: strat },
  };
}

type BotPos = { qty?: number; protectiveIds?: string[]; entryAvg?: number } | null;

async function cleanup(botPos: BotPos) {
  if (!botPos?.qty && !(botPos?.protectiveIds?.length)) return;
  log("   정리(보호주문 취소 + 청산)...");
  const got = getAdapter("binance", "spot");
  const a = got!.adapter as {
    cancelOrderByClientId?: (s: string, c: string) => Promise<boolean>;
    placeOrder: (o: unknown) => Promise<{ status: string }>;
    normalizeQuantity?: (s: string, q: number, p: number) => Promise<number>;
    getPrice: (s: string) => Promise<{ price: number }>;
  };
  for (const cid of botPos?.protectiveIds ?? []) {
    try { const ok = a.cancelOrderByClientId ? await a.cancelOrderByClientId(SYMBOL, cid) : false; log(`     보호주문 취소 ${cid}: ${ok}`); }
    catch (e) { log(`     취소 실패 ${cid}: ${e instanceof Error ? e.message : e}`); }
  }
  if (botPos?.qty) {
    try {
      const px = (await a.getPrice(SYMBOL)).price;
      const nq = a.normalizeQuantity ? await a.normalizeQuantity(SYMBOL, botPos.qty, px) : botPos.qty;
      const r = await a.placeOrder({ symbol: SYMBOL, side: "sell", type: "market", quantity: nq, clientOrderId: `c${Date.now().toString(36)}` });
      log(`     청산 매도: ${r.status} qty=${nq}`);
    } catch (e) { log(`     청산 실패(수동 정리 필요): ${e instanceof Error ? e.message : e}`); }
  }
}

// 한 레그 실행: 봇 생성 → tickBot → 결과/포지션/로그 출력 → (필요시) 거래소 보호주문 확인 → 정리.
async function runLeg(label: string, intervalSeconds: number, expectEntry: boolean) {
  log(`\n══════ ${label} (interval=${intervalSeconds}s) ══════`);
  const comp = store.insertComposite({
    name: "regime-e2e", root_node: regimeAvoidRoot() as never, symbol: SYMBOL, market: "spot", leverage: 1,
    stop_loss_percent: 5, take_profit_percent: 10, tp_ladder: null, scale_in: null, pyramid: null, trailing_stop_percent: 3,
  });
  const bot = store.insertBot({ name: `regime-${label}`, symbol: SYMBOL, composite_strategy_id: comp.id, mode: "live", capital: 30, broker: "binance", interval_seconds: intervalSeconds });
  log(`봇 생성: ${bot.id} (live, capital $30, SL5/TP10/trail3)`);

  let botPos: BotPos = null;
  try {
    const r = await tickBot(bot.id);
    log(`tickBot: ${r.action} — ${r.detail}`);
    botPos = store.getBot(bot.id)?.position_state as BotPos;
    log("--- 봇 로그 ---");
    for (const l of store.recentLogs(bot.id, 8).reverse()) log(`   [${l.action}] ${l.detail}`);

    const entered = r.action === "buy" && !!botPos?.qty;
    if (expectEntry) {
      if (!entered) { log("❌ 기대=진입인데 미진입 — 레짐/데이터/게이트 확인"); return false; }
      log(`position_state: qty=${botPos?.qty} protectiveIds=${JSON.stringify(botPos?.protectiveIds)}`);
      // 거래소에 상주 보호주문이 실제로 걸렸는지 확인
      const got = getAdapter("binance", "spot");
      const a = got!.adapter as { getOrderByClientId?: (s: string, c: string) => Promise<unknown> };
      log("거래소 상주 보호주문 확인:");
      let okCount = 0;
      for (const cid of botPos?.protectiveIds ?? []) {
        const o = a.getOrderByClientId ? await a.getOrderByClientId(SYMBOL, cid) : null;
        if (o) okCount++;
        log(`   ${cid}: ${o ? `✅ ${JSON.stringify(o)}` : "조회불가/없음"}`);
      }
      log(okCount > 0 ? `✅ 거래소 상주 보호주문 ${okCount}건 확인(봇 다운에도 손절 유지)` : "⚠️ 보호주문 조회 0 — 확인 필요");
      return okCount > 0;
    } else {
      // 회피 기대: 진입 없어야 함
      if (entered) { log("❌ 기대=회피인데 진입함 — 레짐 게이트 미작동"); return false; }
      log("✅ 회피 작동: 하락추세 레짐 → 진입 차단(자본보존). 실주문 0건.");
      return true;
    }
  } finally {
    await cleanup(botPos);
  }
}

async function main() {
  log("═══ 옵션 B 레짐필터 봇 — testnet 실체결 시연(정직, 알파 주장 없음) ═══");
  log("리스크 통제 머니패스 검증: ① 하락추세 회피  ② 진입 시 거래소 상주 SL/TP\n");
  // Leg 1: 일봉(trend_down) → 회피. Leg 2: 시간봉(trend_up) → 진입+상주스톱.
  const leg1 = await runLeg("Leg1-일봉회피", 86400, false);
  const leg2 = await runLeg("Leg2-시간봉진입", 3600, true);

  log("\n" + "═".repeat(56));
  log(`Leg1 (일봉 trend_down → 회피):      ${leg1 ? "✅ PASS" : "❌ FAIL"}`);
  log(`Leg2 (시간봉 trend_up → 진입+상주스톱): ${leg2 ? "✅ PASS" : "❌ FAIL"}`);
  log(leg1 && leg2
    ? "\n🎉 2/2 PASS — B 리스크 통제 머니패스 testnet 실증. (수익 알파 아님 / 안전장치 작동)"
    : "\n⚠️ 일부 FAIL — 위 로그 확인.");
  process.exit(leg1 && leg2 ? 0 : 1);
}
main().catch((e) => { console.error("E2E 오류:", e); process.exit(1); });
