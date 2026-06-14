/**
 * runner/runner.ts — 로컬 페이퍼/라이브 봇 러너. bot-runner route.ts 평가루프를 standalone으로 이식.
 * core 엔진(runCompositeBacktest) 재사용 → backtest≡live(신호·사이징). 페이퍼는 가상체결을 스토어에 기록.
 * mode=live는 fillOrder가 liveGate 통과 시 어댑터로 실주문(미통과 시 페이퍼 폴백). 봇 라이브는 주문별 2단계 토큰이 아니라
 * 게이트 + 하드리밋 + 멱등으로 통제(2단계 토큰은 수동 place_order/place_protective 전용). 메인넷은 마스터스위치 전까지 OFF.
 */
import type { StrategyNode, ScannerNode, BacktestConfig } from "../core/types/strategy.js";
import { runCompositeBacktest } from "../core/backtest/engine.js";
import { fetchKlines, buildAuxSeries, type Bar } from "../data/binance-public.js";
import { validateCandleContiguity } from "../util/candle.js";
import { collectSpreadSymbols } from "../core/strategy/spread-symbols.js";
import { collectMtfConditions, buildMtfSeries, collectMtfRegimeConditions, buildMtfRegimeSeries, type MtfBar } from "../core/strategy/mtf.js";
import { collectEventCalendars, buildEventCalendars } from "../core/calendar/calendars.js";
import { rankUniverse, decideScannerActions, type RankBar } from "../core/scanner/rank.js";
import { planProtectiveOrders, syncProtective } from "../core/execution/protective.js";
import { sizeFromBalance, classifyFillStatus, reconcilePositionFromExchange, type ExchangePos } from "../core/execution/reconcile.js";
import { computeOrderQty } from "../core/risk/order-sizing.js"; // 스캐너 진입 사이징(opt-in 변동성 타게팅)
// 체결 reconcile(P0-4): 키움/KIS는 getOrderByClientId 미지원 → 주문 시점 체결확인 불가(지연체결). tickBot 시작 시
//   거래소 실보유(getPositions)를 조회해 봇 장부를 거래소 진실로 동기화(reconcilePositionFromExchange). 크립토(Binance,
//   getOrderByClientId 지원=주문 시점 즉시 filled 확인)는 reconcile 불필요 → 술어 미충족으로 미진입(회귀 0).
import * as store from "../store/db.js";
import { getAdapter } from "../brokers/index.js";
import { liveGate, checkLimits, audit, loadPortfolioGateConfig, portfolioGate, type Broker } from "../brokers/safety.js";
import { floorQty, quantizeQty } from "../core/position/qty.js";
import type { PortfolioPosition } from "../core/risk/portfolio.js";

/** 보호주문 동기화 연속 실패 한도 — 도달 시 비상 청산(fail-closed). 손절 없는 나체 라이브 포지션 방치 금지(P0-2). */
// 보호주문 연속실패 한도(audit P1-9: env 조정 가능, 1..10 클램프, 기본 3). interval×한도 = 최대 나체 노출 시간.
const PROTECTIVE_MAX_FAILS = (() => {
  const n = parseInt((process.env.LIVE_PROTECTIVE_FAIL_LIMIT || "").trim(), 10);
  return Number.isFinite(n) && n >= 1 && n <= 10 ? n : 3;
})();

/** reconcile 가짜보유 정정 한도(연속 거래소 부재 틱). 키움 지연체결로 방금 산 정상 포지션이 거래소에 잠시
 *  안 떠 빈배열로 보일 수 있어(adopt의 대칭 위험), 빈배열 1회를 곧장 '가짜보유'로 단정해 오삭제하지 않는다.
 *  연속 N틱(거래소 진실=무보유 확정) 지속될 때만 장부 0으로 정정(fail-closed: 정상 포지션 보존 우선). */
const RECON_CLEAR_MISSES = 3;

// reconcile용 거래소 실보유 계좌 단위 캐시(broker+env). 같은 키움 계좌를 봇마다 매 틱 중복 조회하면
// 레이트리밋(429)으로 일부 throw → reconcile 비결정 실패. 한 사이클 내 1회 조회를 공유(TTL) + in-flight 코얼레싱.
const _reconPosCache = new Map<string, { at: number; positions: ExchangePos[] }>();
const _reconPosInflight = new Map<string, Promise<ExchangePos[]>>();
const RECON_POS_TTL_MS = 4000; // 키움 봇 평가 주기보다 짧고, 한 틱 사이클(봇 N개 순차) 공유엔 충분
async function getReconcilePositions(broker: string, env: string, fetcher: () => Promise<ExchangePos[]>): Promise<ExchangePos[]> {
  const key = `${broker}:${env}`;
  const cached = _reconPosCache.get(key);
  if (cached && Date.now() - cached.at < RECON_POS_TTL_MS) return cached.positions;
  let inflight = _reconPosInflight.get(key);
  if (!inflight) {
    inflight = fetcher().then((positions) => { _reconPosCache.set(key, { at: Date.now(), positions }); return positions; })
      .finally(() => { _reconPosInflight.delete(key); });
    _reconPosInflight.set(key, inflight);
  }
  return inflight;
}
/** 라이브 주문(매수/매도) 후 호출 — 거래소 보유가 바뀌었으니 계좌 캐시를 버려 다음 reconcile이 fresh 조회하게. */
function invalidateReconCache(broker: string, env: string): void { _reconPosCache.delete(`${broker}:${env}`); }
/** 테스트 전용: reconcile 계좌 캐시 초기화(모듈 스코프라 테스트 간 누수 방지). 프로덕션 경로 미사용. */
export function __clearReconCache(): void { _reconPosCache.clear(); _reconPosInflight.clear(); }

type FillResult = { live: boolean; price: number; orderId?: string; note: string; filledQty?: number; failed?: boolean };

/**
 * 봇 체결: mode=live + 게이트 통과면 실주문(어댑터), 아니면 페이퍼. 자율봇이라 2단계토큰 없음
 * (생성 시 mode=live=사전승인). 안전=마스터스위치+testnet기본+하드리밋+멱등.
 *
 * 채널 고정 원칙(P0-1 — 실패의 조용한 페이퍼 기록이 실/로컬 포지션을 발산시키던 구멍):
 *  - posLive=true(라이브로 연 포지션의 변경): 라이브 체결만 인정. 실패 시 failed:true → 호출측이 기록/상태를
 *    동결하고 다음 틱 재시도. 페이퍼로 조용히 기록하면 거래소엔 실포지션(손절 없는 고아), 장부엔 청산으로 남는다.
 *  - posLive=false(페이퍼로 연 포지션의 변경): 실주문을 내지 않음(실계좌 오버셀 방지). 페이퍼로만 닫는다.
 *  - posLive=undefined(신규 진입): 라이브 시도 → '명확한' 실패(게이트/리밋/거부/not_placed)만 페이퍼 폴백
 *    (포지션 채널=페이퍼로 시작). '모호한' 실패(주문이 나갔을 수도)는 페이퍼 기록 금지 → failed:true 동결.
 *    다음 틱 같은 봉이면 동일 clientOrderId pre-check가 기존 체결을 입양해 이중주문을 막는다(binance 한정).
 */
async function fillOrder(bot: store.BotRow, side: "buy" | "sell", qty: number, price: number, symbol: string = bot.symbol, opts?: { posLive?: boolean; barIso?: string }): Promise<FillResult> {
  if (bot.mode !== "live") return { live: false, price, note: "페이퍼" };
  if (opts?.posLive === false) return { live: false, price, note: "페이퍼 채널(실주문 없음)" }; // 페이퍼 포지션은 페이퍼로만 변경
  const mustLive = opts?.posLive === true;
  // 라이브 채널 포지션 관리 불가 시: 페이퍼로 위장 기록하지 않고 동결(failed) — 다음 틱 재시도.
  const blocked = (note: string): FillResult => {
    if (!mustLive) return { live: false, price, note: `${note}→페이퍼` };
    store.insertLog(bot.id, "error", `라이브 포지션 관리 불가(${note}) → 동결(기록 없음, 다음 틱 재시도)`);
    return { live: false, price, note, failed: true };
  };
  const broker = (["binance", "kis", "kiwoom"].includes(bot.broker) ? bot.broker : "binance") as Broker;
  const market = "spot" as "spot" | "futures"; // quant-mcp 러너는 현물만(선물 라이브는 stock-autotrade). 향후 선물 지원 시 심볼/설정 기반 분기.
  const gate = liveGate(broker, market);
  if (!gate.allowed) { store.insertLog(bot.id, "gate", `라이브 차단(${gate.reason})`); return blocked("게이트 차단"); }
  // 통화 인식: Binance=USDT, 한투/키움=KRW → 통화별 안전 기본 캡(KRW 봇에 달러캡 적용 버그 방지).
  const quoteCurrency = broker === "binance" ? "USDT" : "KRW";
  const got = getAdapter(broker, market);
  if (!got) { store.insertLog(bot.id, "gate", "어댑터 없음"); return blocked("어댑터없음"); }
  // 거래소 LOT_SIZE(stepSize)로 수량 정규화 — 안 하면 -1013(LOT_SIZE) 거부. minQty/minNotional 보정 포함.
  let nq = got.adapter.normalizeQuantity ? await got.adapter.normalizeQuantity(symbol, qty, price) : qty;
  // 실잔고 사이징(P0-2): 매수는 가용현금 초과 못 함(insufficient funds 거부 예방). 정적 capital이 실잔고보다 클 때.
  if (side === "buy" && got.adapter.getBalance) {
    try {
      const bal = await got.adapter.getBalance();
      const affordable = sizeFromBalance(bal.cashBalance, price, 99); // 수수료 여유 1%
      if (affordable > 0 && affordable < nq) {
        nq = got.adapter.normalizeQuantity ? await got.adapter.normalizeQuantity(symbol, affordable, price) : affordable;
        store.insertLog(bot.id, "gate", `실잔고 제한: 주문 ${qty}→${nq}(가용현금 ${bal.cashBalance})`);
      }
    } catch { /* 잔고조회 실패 시 정규화수량 그대로(하드리밋이 상한) */ }
  }
  if (!(nq > 0)) { store.insertLog(bot.id, "gate", `수량 정규화/잔고 0(${qty}→${nq})`); return blocked("수량0"); }
  // ① 하드리밋(노셔널캡 + allowlist + 일일손실 서킷)을 '최종 제출 수량(nq)'으로 검증 — minNotional 상향분이 캡 넘으면 차단(검증==제출).
  const lim = checkLimits({ symbol, notional: price * nq, quoteCurrency });
  if (!lim.ok) { store.insertLog(bot.id, "gate", `하드리밋(${symbol} ${lim.reason})`); return blocked("리밋"); }
  // clientOrderId ≤36자([a-zA-Z0-9-_]): botId 앞 8자 + side + symbol태그 + base36 봉시각. 봉 기준 '결정적' cid라
  // 같은 봉의 재시도가 같은 cid를 재사용 → 모호실패 후 재시도 시 거래소측 기존 주문을 조회/입양 가능(이중주문 방지).
  // ⚠️ symbol 태그 필수: 스캐너 봇은 한 봉에 여러 심볼을 같은 side로 진입 → symbol 없으면 cid 충돌 →
  //    거래소가 2번째 심볼 주문을 중복 cid로 거부 → 그 심볼이 페이퍼로 폴백(심볼축 live/paper 발산). symbol 태그로 차단.
  const barMs = opts?.barIso ? Date.parse(opts.barIso) : NaN;
  const symTag = symbol.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
  const cid = `o${bot.id.slice(0, 8)}${side[0]}${symTag}${(Number.isFinite(barMs) ? Math.floor(barMs / 1000) : Date.now()).toString(36)}`;
  // pre-check(입양): 이전 틱의 모호 실패 주문이 실제 나가 있으면 재주문 대신 그 체결을 채택.
  if (Number.isFinite(barMs) && got.adapter.getOrderByClientId) {
    try {
      const prev = await got.adapter.getOrderByClientId(symbol, cid);
      const pv = classifyFillStatus(prev);
      if (pv === "filled" || pv === "open") {
        store.insertLog(bot.id, "live", `[${gate.env}] 기존 주문 입양(${pv}, ${prev?.orderId}) — 같은 봉 재시도 이중주문 방지`);
        return { live: true, price: prev?.price || price, orderId: prev?.orderId, note: `${gate.env} 입양-${pv}`, filledQty: prev?.quantity || nq };
      }
    } catch { /* 조회 실패 → 신규 주문 경로 */ }
  }
  audit({ event: "bot_order_attempt", botId: bot.id, broker, env: gate.env, symbol, side, qty: nq, price });
  // 라이브 주문은 거래소 실보유를 바꾼다 → reconcile 계좌 캐시를 무효화(다음 reconcile은 fresh 조회).
  //   안 하면 주문 후 같은 사이클/TTL 내 reconcile이 옛 스냅샷으로 stale-adopt하거나, 빈 스냅샷을 clear 카운트에
  //   중복 반영(="N misses ≠ N 독립관측")할 수 있음(코덱스 지적). 무효화로 주문 직후 관측은 항상 신선.
  invalidateReconCache(broker, gate.env ?? "testnet"); // 키 = reconcile의 live.env(gate.env ?? "testnet")와 동일해야 무효화가 맞음
  try {
    const r = await got.adapter.placeOrder({ symbol, side, type: "market", quantity: nq, clientOrderId: cid });
    audit({ event: "bot_order_result", botId: bot.id, env: gate.env, orderId: r.orderId, status: r.status });
    // 거부는 체결이 아니다(P0-3: 키움 rejected가 정상 반환되어 live 기록되던 구멍). 진입=페이퍼 폴백 / 라이브채널=동결.
    if (r.status === "rejected") {
      store.insertLog(bot.id, "error", `[${gate.env}] 주문 거부 ${symbol} ${side} qty=${nq}`);
      return blocked("주문 거부");
    }
    // 체결 미확인 판정: 'filled' + 체결가(>0)만 확정 체결. 그 외(status=pending=접수형 미체결 / 체결가 0)는 미확인.
    //   ⚠️ priceConfirmed만으론 부족(P0-5 구멍): 키움 '지정가'는 pending인데도 참조가(>0)를 실어 보내 → priceConfirmed=true로
    //   '보유'로 둔갑하던 발산(키움 모의 실측: 장부 보유, 실계좌 0). status=pending 자체를 미확인으로 본다(시장가 price0 + 지정가 둘 다 포착).
    const priceConfirmed = typeof r.price === "number" && r.price > 0;
    const fillConfirmed = r.status === "filled" && priceConfirmed;
    if (!fillConfirmed) {
      store.insertLog(bot.id, "live", `[${gate.env}] ⚠️ 접수됨(${r.status}) — 체결 미확인(${priceConfirmed ? `참조가 ${price}` : "체결가 미확인"}, 체결조회 미배선)`);
      audit({ event: "fill_price_unconfirmed", botId: bot.id, env: gate.env, orderId: r.orderId, status: r.status, refPrice: price });
      // P0-5(fail-closed): 체결 미확인 + 체결조회 미지원 브로커(키움/한투 — getOrderByClientId 미구현)면
      //   접수=비동기 미체결이라 거래소엔 아직 포지션이 없는데 보유로 기록하면 장부≠계좌로 발산한다
      //   (키움 모의 실측: 봇 장부엔 '보유'인데 실계좌는 변화 0). 보유로 기록하지 말고 동결 → 다음 틱 재시도.
      //   진입/라이브채널 공히 동결(blocked의 진입 페이퍼폴백조차 '거래소에 없는 포지션을 만드는' 셈이라 금지).
      //   바이낸스는 getOrderByClientId 지원 → 이 분기 미진입(시장가는 status='filled'+price>0=fillConfirmed라 애초에 안 옴, 회귀 0).
      if (!got.adapter.getOrderByClientId) {
        store.insertLog(bot.id, "error", `[${gate.env}] 체결 미확인(${r.status}) + 주문조회 미지원(${broker}) → 보유 기록 금지·동결(거래소 미반영 가능, 다음 틱 재시도)`);
        audit({ event: "fill_unconfirmed_frozen", botId: bot.id, env: gate.env, orderId: r.orderId, status: r.status, broker, symbol });
        return { live: false, price, note: "체결 미확인 동결(조회 미지원)", failed: true };
      }
    }
    store.insertLog(bot.id, "live", `[${gate.env}] 실주문 ${symbol} ${side} qty=${nq} → ${r.status} (${r.orderId})`);
    return { live: true, price: fillConfirmed ? r.price : price, orderId: r.orderId, note: `${gate.env} 실주문${fillConfirmed ? "" : "(체결 미확인)"}`, filledQty: r.quantity || nq };
  } catch (e) {
    // P0-4 체결 reconcile: 모호한 실패(타임아웃/네트워크)여도 주문이 실제 나갔을 수 있음 → 같은 clientOrderId로 조회.
    let verdict: ReturnType<typeof classifyFillStatus> = "unknown";
    let recon: { orderId?: string; price?: number; quantity?: number } | null = null;
    if (got.adapter.getOrderByClientId) {
      try {
        const o = await got.adapter.getOrderByClientId(symbol, cid);
        verdict = classifyFillStatus(o);
        recon = o;
      } catch { verdict = "unknown"; }
    }
    if (verdict === "filled" || verdict === "open") {
      store.insertLog(bot.id, "live", `[${gate.env}] reconcile: 주문 실제 ${verdict}(${recon?.orderId}) → live 인정(중복방지)`);
      return { live: true, price: recon?.price || price, orderId: recon?.orderId, note: `${gate.env} reconcile-${verdict}`, filledQty: recon?.quantity || nq };
    }
    audit({ event: "bot_order_error", botId: bot.id, error: e instanceof Error ? e.message : String(e), verdict });
    if (verdict === "not_placed" || verdict === "rejected") {
      // 주문이 안 나갔음이 '확정' → 진입은 페이퍼 폴백 안전, 라이브 채널은 동결 후 재시도.
      store.insertLog(bot.id, "error", `실주문 실패(${e instanceof Error ? e.message : e}; ${verdict})`);
      return blocked(`실주문실패(${verdict})`);
    }
    // 결과 불명: 주문이 나갔을 수 있다 → 페이퍼 기록 금지(이중 장부 = 발산). 동결 후 다음 틱 재시도.
    //   binance는 다음 시도에서 같은 cid pre-check로 입양. cid 미지원 브로커(키움)는 수동 확인 경고.
    store.insertLog(bot.id, "error", `실주문 결과 불명(${e instanceof Error ? e.message : e}) → 동결(기록 없음). ${got.adapter.getOrderByClientId ? "다음 틱 동일 cid로 입양 시도" : "⚠️ 주문조회 미지원 브로커 — 거래소에서 수동 확인 필요"}`);
    return { live: false, price, note: "실주문 결과 불명", failed: true };
  }
}

type LiveAdapter = NonNullable<ReturnType<typeof getAdapter>>["adapter"];
/** 라이브 봇의 어댑터 해석(mode=live + 게이트 통과 + 어댑터 존재 시). 아니면 null(페이퍼=엔진이 스톱 시뮬레이트). */
function liveAdapterFor(bot: store.BotRow): { adapter: LiveAdapter; env: string } | null {
  if (bot.mode !== "live") return null;
  const broker = (["binance", "kis", "kiwoom"].includes(bot.broker) ? bot.broker : "binance") as Broker;
  const market = "spot" as "spot" | "futures"; // 현물(페이퍼봇과 일치). 선물 보호주문은 후속.
  const gate = liveGate(broker, market);
  if (!gate.allowed) return null; // 게이트가 메인넷(LIVE_TRADING_ENABLED) 등 통제. testnet/mock만 통과.
  const got = getAdapter(broker, market);
  if (!got) return null;
  return { adapter: got.adapter, env: gate.env ?? "testnet" };
}

interface RiskCfg { stopLossPercent?: number | null; takeProfitPercent?: number | null; trailingStopPercent?: number | null }

/** KR 상주 보호주문 미지원 경고를 봇당 1회만 남기기 위한 기록(프로세스 생애 — 재시작 시 1회 재고지는 의도). */
const krProtectiveWarned = new Set<string>();

/**
 * 라이브 봇의 거래소 상주 보호주문(SL/TP/트레일링)을 현 포지션에 맞게 동기화.
 * posLive=false(페이퍼 채널 포지션)면 no-op — 페이퍼 포지션에 실보호주문을 걸면 트리거 시 실계좌 매도가 나간다(금지).
 * posQty 0이면 desired=[] → 전부 취소(청산 정리). 트레일링은 peakPrice로 stopPrice 갱신 → 옛 주문 취소+새 주문.
 * 실패는 삼키지 않고 failed 수를 반환(P0-2) — 호출측이 연속 실패를 집계해 비상 청산으로 에스컬레이션.
 */
async function syncBotProtective(bot: store.BotRow, posLive: boolean, symbol: string, posQty: number, entryAvg: number, peakPrice: number, risk: RiskCfg, restingIds: string[]): Promise<{ ids: string[]; failed: number; slFailed: boolean }> {
  if (!posLive) return { ids: restingIds, failed: 0, slFailed: false }; // 페이퍼 채널 → 보호주문 없음(엔진이 시뮬레이트)
  // KR 브로커(KIS/키움)는 거래소 상주 SL/TP 미지원(audit P0-3). 어댑터가 protective 타입을 명시 거절하므로
  // 시도 자체를 스킵 — 시도하면 매 틱 실패 집계 → PROTECTIVE_MAX_FAILS 비상청산 오발동. 경고는 봇당 1회(스팸 금지).
  // KR 포지션의 SL/TP는 봇 폴링 평가(소프트스톱)가 수행한다(봇 다운 시 손절 공백 — 문서·로그로 정직 고지).
  if (bot.broker === "kis" || bot.broker === "kiwoom") {
    if (posQty > 1e-9 && !krProtectiveWarned.has(bot.id)) {
      krProtectiveWarned.add(bot.id);
      store.insertLog(bot.id, "gate", `KR 브로커(${bot.broker})는 거래소 상주 보호주문(SL/TP) 미지원 — 봇 폴링 평가로만 손절/익절 동작. 봇/프로세스 다운 시 손절 공백(audit P0-3).`);
    }
    return { ids: restingIds, failed: 0, slFailed: false };
  }
  const live = liveAdapterFor(bot);
  if (!live) {
    // 라이브 채널 포지션인데 게이트/어댑터 불가 = 보호 불능. 침묵하지 않고 실패로 집계(에스컬레이션 대상).
    if (posQty > 1e-9) store.insertLog(bot.id, "error", `상주 보호주문 불가(게이트/어댑터) — 라이브 포지션 ${symbol} 보호 없음`);
    return { ids: restingIds, failed: posQty > 1e-9 ? 1 : 0, slFailed: posQty > 1e-9 }; // 어댑터 불능 = SL도 못 건 상태
  }
  const adapter = live.adapter as { placeOrder: (o: unknown) => Promise<{ orderId: string }>; cancelOrderByClientId?: (s: string, c: string) => Promise<boolean>; normalizeQuantity?: (s: string, q: number, p: number) => Promise<number> };
  const desired = posQty > 1e-9 && entryAvg > 0
    ? planProtectiveOrders({ botId: bot.id, symbol, positionSide: "long", qty: posQty, entryAvg, extremeSinceEntry: peakPrice, stopLossPercent: risk.stopLossPercent, takeProfitPercent: risk.takeProfitPercent, trailingStopPercent: risk.trailingStopPercent })
    : [];
  let slFailed = false; // 손절(SL) leg 배치 실패 추적(audit P1-4) — TP만 걸리고 SL 없는 '편다리 보호'가 최악
  const res = await syncProtective(
    desired, restingIds,
    async (o) => { try { const nq = adapter.normalizeQuantity ? await adapter.normalizeQuantity(symbol, o.quantity, o.stopPrice) : o.quantity; await adapter.placeOrder({ symbol, side: o.side, type: o.type, quantity: nq, stopPrice: o.stopPrice, reduceOnly: o.reduceOnly, clientOrderId: o.clientOrderId }); return o.clientOrderId; } catch (e) { if (o.kind === "stop_loss") slFailed = true; store.insertLog(bot.id, "error", `보호주문 배치 실패(${o.kind} @${o.stopPrice}): ${e instanceof Error ? e.message : e}`); return null; } },
    async (cid) => { try { return adapter.cancelOrderByClientId ? await adapter.cancelOrderByClientId(symbol, cid) : false; } catch { return false; } },
  );
  if (res.placed || res.cancelled) store.insertLog(bot.id, "live", `[${live.env}] 상주 보호주문 ${symbol}: 배치 ${res.placed} / 취소 ${res.cancelled}${res.failed ? ` / 실패 ${res.failed}` : ""}`);
  return { ids: res.restingIds, failed: res.failed, slFailed };
}

export interface PaperPosition {
  status: "open"; entryAvg: number; qty: number; openedAt: string;
  // P0 실행 레이어(라이브) 준비 필드 — 게이트 ON 시 사용. 페이퍼/게이트OFF에선 미사용(하위호환).
  live?: boolean;            // 체결 채널: true=라이브 체결로 연 포지션(라이브로만 변경), false/없음=페이퍼(실주문 금지)
  protectiveIds?: string[];  // 거래소에 걸린 상주 보호주문(SL/TP) clientOrderId 목록(syncProtective 추적)
  peakPrice?: number;        // 진입 후 고점(롱)/저점(숏) — 트레일링 스탑 기준(planProtectiveOrders extremeSinceEntry)
  protFails?: number;        // 보호주문 동기화 연속 실패 수 — PROTECTIVE_MAX_FAILS 도달 시 비상 청산(P0-2)
  reconMisses?: number;      // reconcile 시 라이브 포지션이 거래소에 연속 부재한 틱 수 — RECON_CLEAR_MISSES 도달 시 가짜보유 정정(지연체결 오삭제 방지, 라이브 채널만)
}

/** 폴링 주기(초) → Binance kline 타임프레임. 인트라데이 봉이라야 시간대(hour) 조건이 의미. */
function secsToInterval(s: number): string {
  if (s <= 60) return "1m"; if (s <= 180) return "3m"; if (s <= 300) return "5m"; if (s <= 900) return "15m";
  if (s <= 1800) return "30m"; if (s <= 3600) return "1h"; if (s <= 14400) return "4h"; if (s <= 86400) return "1d"; return "1d";
}

/**
 * 수량 델타 정합 계획(순수). 엔진 넷 포지션(want)을 라이브 보유수량(curQty)에 추종.
 * dq>0=매수(진입/스케일인/피라미딩), dq<0=매도(부분익절/청산), 0=유지. 라더류 부분체결을 라이브에 반영.
 */
export function planPositionDelta(
  curQty: number, want: { holding: boolean; qty: number; entryAvg: number }, price: number, capital: number
): { side: "buy" | "sell" | "hold"; qty: number; partial: boolean; wantQty: number } {
  const wantQty = want.holding ? (want.qty > 0 ? want.qty : Math.max(1, Math.floor(capital / price))) : 0;
  const EPS = 1e-9;
  const dq = wantQty - curQty;
  if (dq > EPS) return { side: "buy", qty: dq, partial: curQty > EPS, wantQty };   // partial=추가매수
  if (dq < -EPS) return { side: "sell", qty: -dq, partial: wantQty > EPS, wantQty }; // partial=부분익절
  return { side: "hold", qty: 0, partial: false, wantQty };
}

/** 백테스트 결과의 trade 시퀀스에서 "현재 보유 여부 + 평단/수량"을 도출(net). (export: 라더 평단 패리티 테스트용 — audit P1-11) */
export function derivePosition(trades: { action: string; price: number; quantity: number }[]): { holding: boolean; entryAvg: number; qty: number } {
  let qty = 0, cost = 0;
  for (const t of trades) {
    if (t.action === "buy") { cost += t.price * t.quantity; qty += t.quantity; }
    else { const sell = Math.min(t.quantity, qty); if (qty > 0) cost -= (cost / qty) * sell; qty -= sell; if (qty <= 1e-9) { qty = 0; cost = 0; } }
  }
  return { holding: qty > 1e-9, entryAvg: qty > 0 ? cost / qty : 0, qty };
}

/**
 * 체결 reconcile(P0-4, 라이브 단일봇 전용). tickBot 신호평가 전에 봇 장부(position_state)를 거래소 실보유로 동기화.
 *
 * 적용 조건(셋 다 충족 시에만 getPositions 조회 — 그 외 즉시 cur 반환=거동/오버헤드 0):
 *   ① bot.mode==='live'  ② 라이브 어댑터 해석 가능(liveAdapterFor: 게이트 통과 + 어댑터 존재)
 *   ③ 어댑터가 getOrderByClientId 미지원(=키움/KIS; 바이낸스는 지원→주문 시점 즉시 체결확인되어 reconcile 불요).
 *
 * 동작:
 *   - adopt: 거래소 보유>0 && 로컬과 발산 → 장부를 거래소 진실(실수량/평단)로 재구성(지연체결/부분체결 반영). live:true.
 *            reconMisses=0 리셋. 보호주문(protectiveIds)은 후속 syncBotProtective가 재동기화하므로 여기선 비움.
 *   - no_exchange_pos + 라이브 보유 장부: 거래소에 그 종목 없음 → '가짜보유 후보'. 단정 clear 금지(지연체결로 방금
 *            산 정상 포지션이 거래소에 잠시 안 떴을 수 있음). reconMisses++ → RECON_CLEAR_MISSES 연속 도달 시에만 장부 0
 *            정정(fail-closed). 미만이면 보유 유지(카운터만 증가).
 *   - in_sync / 거래소 보유 정상: reconMisses=0 리셋, 무변경.
 *   - 페이퍼 채널 장부(live!=true): reconcile 비대상(실주문 안 나가 발산 없음) — 무변경.
 *   - getPositions 조회 실패(throw): 삼키되 침묵 금지(error 로그) + 장부 임의 변경 안 함(보수, 다음 틱 재시도).
 *
 * 멱등/재주문 폭주 방지: reconcile은 읽기(getPositions)만 — 주문 안 냄. adopt로 장부가 채워지면 다음 단계
 *   planPositionDelta의 want vs curQty 델타가 0이 되어 재진입 자체가 사라진다(2차 방어). 멱등키는 같은 봉 1차 방어.
 */
async function reconcileLivePosition(bot: store.BotRow, cur: PaperPosition | null, lastIso: string): Promise<PaperPosition | null> {
  if (bot.mode !== "live") return cur;
  const live = liveAdapterFor(bot);
  if (!live) return cur; // 게이트 미통과/어댑터 없음 → reconcile 불가(페이퍼처럼 동작, 회귀 0)
  const adapter = live.adapter as {
    getPositions?: () => Promise<ExchangePos[]>;
    getOrderByClientId?: unknown;
  };
  // 바이낸스(getOrderByClientId 지원)는 주문 시점 즉시 체결확인 → reconcile 불요. getPositions 없는 어댑터도 스킵.
  if (typeof adapter.getPositions !== "function" || adapter.getOrderByClientId !== undefined) return cur;

  const curQty = cur && cur.status === "open" ? cur.qty : 0;
  const curLive = curQty > 1e-9 ? (cur?.live ?? false) : false;

  let exPos: ExchangePos[];
  try {
    // 계좌 단위 캐시(broker+env) — 여러 봇이 같은 키움 계좌를 매 틱 중복 조회하면 레이트리밋(429)으로 일부 throw됨.
    // 한 틱 사이클 내 1회만 조회해 공유(TTL). 읽기전용·시크릿 없음이라 캐싱 안전(dashboard _acctCache와 동일 취지).
    exPos = await getReconcilePositions(bot.broker, live.env, () => (adapter.getPositions as () => Promise<ExchangePos[]>)());
  } catch (e) {
    // 거래소 조회 실패 → 장부 임의 변경 금지(보수). 침묵 금지(다음 틱 재시도).
    store.insertLog(bot.id, "error", `[${live.env}] reconcile 조회 실패(${e instanceof Error ? e.message : e}) → 기존 장부 유지(다음 틱 재시도)`);
    return cur;
  }

  const rec = reconcilePositionFromExchange(curQty > 1e-9 ? { qty: curQty } : null, exPos, bot.symbol);
  if (rec.ambiguous) {
    // 같은 종목을 여러 라이브 봇이 보유하면 계좌 단위 보유를 어느 봇에 귀속할지 모호(종목당 단일봇 가정 위반).
    //   경고만 남기고 계속 돌리면 다음 틱에 발산 상태로 추가 매수가 나갈 수 있다(audit P1-8) →
    //   봇을 자동 정지(status=error)하고 타이머 해제. 사용자가 중복 봇을 정리 후 재시작해야 한다(fail-closed).
    runner().stop(bot.id);
    store.setBotStatus(bot.id, "error"); // stop()의 'stopped'를 'error'로 승격(원인 구분 — 대시보드 표시)
    store.insertLog(bot.id, "error", `[${live.env}] reconcile 귀속 모호: ${bot.symbol} 거래소 보유 다중 매칭(종목당 단일봇 가정 위반) → 봇 자동 정지(audit P1-8). 중복 라이브 봇 정리 후 재시작 필요.`);
    audit({ event: "ambiguous_halt", botId: bot.id, env: live.env, symbol: bot.symbol });
    return cur;
  }

  if (rec.action === "adopt" && rec.next) {
    // 거래소 진실 채택: 지연체결/부분체결분을 장부에 확정. 평단=거래소값(없으면 기존/0 폴백).
    const entryAvg = rec.next.entryAvg > 0 ? rec.next.entryAvg : (cur?.entryAvg ?? 0);
    const adopted: PaperPosition = {
      status: "open",
      entryAvg,
      qty: rec.next.qty,
      openedAt: cur?.openedAt ?? new Date().toISOString(),
      live: true,                                   // 거래소 실보유 = 라이브 채널
      peakPrice: Math.max(cur?.peakPrice ?? entryAvg, entryAvg),
      protectiveIds: cur?.protectiveIds ?? [],      // 후속 syncBotProtective가 재동기화
      protFails: cur?.protFails ?? 0,
      reconMisses: 0,
    };
    store.setBotPositionState(bot.id, adopted, true, false);
    store.insertLog(bot.id, "live", `[${live.env}] reconcile 거래소 채택: ${bot.symbol} 장부 ${curQty}→${rec.next.qty}(평단 ${entryAvg})${rec.drift.severity === "major" ? " [major drift]" : ""} — 지연체결/부분체결 반영`);
    audit({ event: "reconcile_adopt", botId: bot.id, env: live.env, symbol: bot.symbol, localQty: curQty, exchangeQty: rec.next.qty, severity: rec.drift.severity });
    return adopted;
  }

  if (rec.action === "no_exchange_pos" && curLive && cur && curQty > 1e-9) {
    // 가짜보유 후보(라이브 장부 보유 ↔ 거래소 부재). 지연체결 오삭제 방지 → 연속 N틱 부재 시에만 clear.
    const misses = (cur.reconMisses ?? 0) + 1;
    if (misses >= RECON_CLEAR_MISSES) {
      store.setBotPositionState(bot.id, null, true, false);
      store.insertLog(bot.id, "live", `[${live.env}] reconcile 가짜보유 정정: ${bot.symbol} 거래소 ${RECON_CLEAR_MISSES}틱 연속 부재 → 장부 ${curQty}→0(거래소 진실 채택)`);
      audit({ event: "reconcile_clear", botId: bot.id, env: live.env, symbol: bot.symbol, localQty: curQty, misses });
      return null;
    }
    const next: PaperPosition = { ...cur, reconMisses: misses };
    store.setBotPositionState(bot.id, next, true, false);
    store.insertLog(bot.id, "gate", `[${live.env}] reconcile: ${bot.symbol} 거래소 부재(${misses}/${RECON_CLEAR_MISSES}틱) — 보유 유지(지연체결 가능성, 즉시 삭제 안 함)`);
    return next;
  }

  // in_sync / 거래소 보유 정상 / 페이퍼 채널 / 장부 0: reconMisses 리셋(연속성 깨짐) 후 무변경.
  if (cur && (cur.reconMisses ?? 0) > 0) {
    const next: PaperPosition = { ...cur, reconMisses: 0 };
    store.setBotPositionState(bot.id, next, true, false);
    return next;
  }
  return cur;
}

// ── P0-1 기동 포지션 시드(크래시/재시작 갭 복구) ──

/** 프로세스 기동 후 봇당 1회만 시드(재시도 폭주 방지). 재시작하면 다시 1회 수행(의도). */
const bootSeeded = new Set<string>();

/** Binance 현물 getPositions는 자산 단위(BTC) 반환 — bot.symbol(BTCUSDT)에서 base 자산 환원(매칭용). */
function baseAsset(symbol: string): string {
  const s = String(symbol).trim().toUpperCase();
  for (const q of ["USDT", "USDC", "FDUSD", "TUSD", "BUSD"]) {
    if (s.endsWith(q) && s.length > q.length) return s.slice(0, -q.length);
  }
  return s;
}

/**
 * 기동 포지션 시드(audit P0-1). fillOrder 성공 ↔ 장부 기록 사이 크래시 후 재기동하면 position_state=null인데
 * 거래소엔 실포지션이 남는다(손절 없는 발산). 주기 reconcile은 ① KR 전용(바이낸스 스킵) ② liveGate 통과 필요라
 * 이 시나리오(특히 gate-off 재기동)를 못 덮는다 → 첫 틱에서 1회, 게이트와 무관하게 read-only 조회로 복원한다.
 *
 * fail-closed 가드(수동 보유 오입양 금지):
 *   - 이 봇의 라이브 체결 장부(liveOpenLedger)상 미청산 수량>0 일 때만 채택 — 근거 없이 계좌 보유를
 *     봇에 귀속하면 사용자의 수동 보유를 봇이 관리(매도)하게 된다(금지).
 *   - 채택 수량은 min(거래소 보유, 장부 미청산) — 계좌에 섞인 수동 보유분은 채택 안 함.
 *   - 평단: 거래소 평단(>0) 우선, 현물 잔고(평단 미상=0)는 장부 가중평단 폴백.
 *   - 다중 매칭(ambiguous)/조회 실패/어댑터 없음 → 채택 보류(로그만, 장부 무변경).
 * 주문은 절대 안 냄(read-only) — 게이트 OFF 상태에서도 안전.
 */
async function bootSeedLivePosition(bot: store.BotRow, cur: PaperPosition | null): Promise<PaperPosition | null> {
  if (bot.mode !== "live" || bootSeeded.has(bot.id)) return cur;
  bootSeeded.add(bot.id);
  if (cur && cur.status === "open") return cur; // 장부 존재 → 주기 reconcile 책임(여긴 null 갭 전용)
  const ledger = store.liveOpenLedger(bot.id);
  if (!(ledger.qty > 1e-9)) return cur; // 라이브 체결 근거 0 → 거래소 보유는 수동 보유로 간주(채택 금지)
  const broker = (["binance", "kis", "kiwoom"].includes(bot.broker) ? bot.broker : "binance") as Broker;
  const got = getAdapter(broker, "spot"); // liveGate 비경유 — 게이트 OFF여도 read-only 조회는 수행(P0-1 핵심)
  const adapter = got?.adapter as { getPositions?: () => Promise<ExchangePos[]> } | undefined;
  if (!got || typeof adapter?.getPositions !== "function") {
    store.insertLog(bot.id, "error", `기동 시드 불가(어댑터/키 없음) — 장부상 라이브 미청산 ${ledger.qty} 존재, 거래소 수동 대조 필요(audit P0-1)`);
    return cur;
  }
  let exPos: ExchangePos[];
  try {
    exPos = await (adapter.getPositions as () => Promise<ExchangePos[]>)();
  } catch (e) {
    store.insertLog(bot.id, "error", `기동 시드 조회 실패(${e instanceof Error ? e.message : e}) — 장부 무변경(다음 재시작/주기 reconcile에 위임)`);
    return cur;
  }
  let rec = reconcilePositionFromExchange({ qty: 0 }, exPos, bot.symbol);
  if (rec.action === "no_exchange_pos" && broker === "binance") {
    rec = reconcilePositionFromExchange({ qty: 0 }, exPos, baseAsset(bot.symbol)); // 현물 잔고는 자산 단위(BTC)
  }
  if (rec.ambiguous) {
    store.insertLog(bot.id, "error", `기동 시드 귀속 모호(${bot.symbol} 거래소 다중 매칭) — 채택 보류(중복 봇/보유 정리 필요)`);
    return cur;
  }
  if (rec.action === "adopt" && rec.next) {
    const qty = Math.min(rec.next.qty, ledger.qty); // 수동 보유 혼입분 제외(장부 근거 상한)
    const entryAvg = rec.next.entryAvg > 0 ? rec.next.entryAvg : ledger.avgPrice;
    const adopted: PaperPosition = {
      status: "open", entryAvg, qty,
      openedAt: new Date().toISOString(), live: true,
      peakPrice: entryAvg, protectiveIds: [], protFails: 0, reconMisses: 0,
    };
    store.setBotPositionState(bot.id, adopted, true, false);
    store.insertLog(bot.id, "live", `기동 포지션 시드: 거래소 진실 복원 ${bot.symbol} qty=${qty}(평단 ${entryAvg}) — 크래시/재시작 갭 복구(audit P0-1)`);
    audit({ event: "boot_seed_adopt", botId: bot.id, symbol: bot.symbol, qty, entryAvg, ledgerQty: ledger.qty, exchangeQty: rec.next.qty });
    return adopted;
  }
  store.insertLog(bot.id, "gate", `기동 시드: 장부상 라이브 미청산 ${ledger.qty} 있으나 거래소 보유 없음 — 외부 청산 추정(장부 무변경)`);
  return cur;
}

// ── 포트폴리오 레벨 캡(opt-in) — 러너측 스냅샷 + 진입 게이트 적용 ──
// 러너가 position_state 모양(단일 PaperPosition / 스캐너 심볼맵)을 알므로 노출 추출은 여기서 한다.
// 게이트 자체는 safety.portfolioGate(순수). env 미설정이면 buildPortfolioSnapshot도 호출 안 됨 → 오버헤드/거동 변화 0.

/** 한 봇의 position_state에서 오픈 포지션 노출(=진입평단×수량)들을 추출. 단일/스캐너맵 양형 지원. 라이브 마크 불요(보수적 진입노셔널). */
function exposuresOf(positionState: unknown, symbol: string): { symbol: string; notional: number }[] {
  if (!positionState || typeof positionState !== "object") return [];
  const ps = positionState as Record<string, unknown>;
  // 단일 포지션: { status:"open", entryAvg, qty }
  if (ps.status === "open" && typeof ps.qty === "number" && typeof ps.entryAvg === "number") {
    const n = ps.entryAvg * ps.qty;
    return n > 0 ? [{ symbol, notional: n }] : [];
  }
  // 스캐너 심볼맵: { [sym]: { status:"open", entryAvg, qty } }
  const out: { symbol: string; notional: number }[] = [];
  for (const [sym, v] of Object.entries(ps)) {
    if (v && typeof v === "object") {
      const p = v as Record<string, unknown>;
      if (p.status === "open" && typeof p.qty === "number" && typeof p.entryAvg === "number") {
        const n = p.entryAvg * p.qty;
        if (n > 0) out.push({ symbol: sym, notional: n });
      }
    }
  }
  return out;
}

/**
 * 포트폴리오 스냅샷(읽기전용). 가동 봇 전체의 오픈 노출 + 실현손익 곡선으로 equity/peakEquity·positions 구성.
 *  - equity   = Σ(가동 봇 capital) + 실현손익(보수적: 미실현 제외)
 *  - peakEquity = Σ capital + 실현손익 곡선 고점(고수위)
 *  - positions = 각 오픈 포지션의 { symbol, riskFraction=노셔널/equity }
 * pendingNotional(이번에 낼 진입 노셔널)을 heat에 선반영 — 새 진입 후 총노출로 캡 판정(과노출 사전 차단).
 * 진입 봇의 기존 포지션은 가동봇 순회에 포함되고 pending이 그 위에 더해지므로, 합산이 곧 '진입 후' 상태.
 */
function buildPortfolioSnapshot(pendingSymbol: string, pendingNotional: number): { positions: PortfolioPosition[]; equity: number; peakEquity: number } {
  const running = store.listRunningBots();
  const baseCapital = running.reduce((a, b) => a + (Number.isFinite(b.capital) ? b.capital : 0), 0);
  const { realized, peakCum } = store.realizedEquityCurve();
  const equity = Math.max(1e-9, baseCapital + realized); // 0 division 가드
  const peakEquity = Math.max(equity, baseCapital + peakCum);
  const exps: { symbol: string; notional: number }[] = [];
  for (const b of running) for (const e of exposuresOf(b.position_state, b.symbol)) exps.push(e);
  if (pendingNotional > 0) exps.push({ symbol: pendingSymbol, notional: pendingNotional }); // 진입 예정분 선반영
  const positions: PortfolioPosition[] = exps.map((e) => ({ symbol: e.symbol, riskFraction: e.notional / equity }));
  return { positions, equity, peakEquity };
}

/**
 * 신규진입 게이트 적용(opt-in). config.enabled=false면 { qty 그대로, blocked:false } — 거동 변화 0(legacy 바이트 동일).
 * 활성 시: 진입 예정 노셔널을 포함한 스냅샷으로 portfolioGate 호출 →
 *   - allow=false: blocked=true(진입 스킵)
 *   - sizeMultiplier<1: qty를 배수로 **축소만**(floorQty). 0으로 떨어지면 blocked.
 * 절대 증액 안 함(정규화-후-캡). reasons는 로깅용.
 */
function applyPortfolioGate(symbol: string, qty: number, price: number): { qty: number; blocked: boolean; reasons: string[] } {
  const cfg = loadPortfolioGateConfig();
  if (!cfg.enabled || !(qty > 0) || !(price > 0)) return { qty, blocked: false, reasons: [] };
  const snap = buildPortfolioSnapshot(symbol, qty * price);
  const g = portfolioGate(cfg, snap);
  if (!g.allow) return { qty: 0, blocked: true, reasons: g.reasons };
  if (g.sizeMultiplier < 1) {
    const scaled = quantizeQty(qty * g.sizeMultiplier, symbol); // KR(6자리)=정수주, 크립토=8자리 소수(Bug#1 일관 — 포트폴리오 캡 축소분도 KR 정수)
    if (!(scaled > 0)) return { qty: 0, blocked: true, reasons: [...g.reasons, `MDD 디리스킹 ×${g.sizeMultiplier} → 수량 0`] };
    return { qty: scaled, blocked: false, reasons: g.reasons };
  }
  return { qty, blocked: false, reasons: g.reasons };
}

/** 봇 1회 평가(틱). 신호 전이 시 페이퍼 체결 기록 + position_state 갱신. */
export async function tickBot(botId: string): Promise<{ action: "buy" | "sell" | "hold"; detail: string }> {
  const bot = store.getBot(botId);
  if (!bot) return { action: "hold", detail: "no bot" };
  const comp = store.getComposite(bot.composite_strategy_id);
  if (!comp) { store.insertLog(botId, "error", "복합전략 없음"); return { action: "hold", detail: "no composite" }; }

  // 스캐너 봇: root_node가 scanner면 멀티심볼 랭킹 경로로 분기.
  if ((comp.root_node as { type?: string })?.type === "scanner") {
    return tickScanner(bot, comp.root_node as ScannerNode, comp.risk_sizing as BacktestConfig["riskSizing"]);
  }

  const interval = secsToInterval(bot.interval_seconds); // 폴링 주기 → kline 타임프레임(인트라데이 자동). 시간대 조건 해금.
  // 데이터 소스 broker-aware: 크립토=Binance public klines, KR(키움/한투)=브로커 어댑터 getCandles(일봉).
  //   KR 종목코드는 Binance에 없으므로 어댑터에서 OHLCV를 가져와야 지표 평가 가능(없으면 빈 배열→데이터부족 hold).
  const dataBroker = (["binance", "kis", "kiwoom"].includes(bot.broker) ? bot.broker : "binance") as Broker;
  let fetched: Bar[];
  if (dataBroker === "binance") {
    fetched = await fetchKlines(bot.symbol, interval, 300);
  } else if (dataBroker === "kiwoom") {
    const da = getAdapter(dataBroker, "spot")?.adapter as { getCandles?: (s: string, i: string, c: number) => Promise<Bar[]> } | undefined;
    fetched = da?.getCandles ? await da.getCandles(bot.symbol, interval, 300) : [];
  } else {
    // KIS 캔들 API 미연동(audit P1-22) — 조용한 빈배열 hold(데이터 부족으로 위장) 대신 명시 고지 후 hold(fail-closed honesty).
    store.insertLog(botId, "error", `${dataBroker} 캔들 데이터 미지원 — 현재 Binance 공개 데이터만 사용 가능(이 봇은 평가 불가). 종목/브로커 확인 필요.`);
    store.setBotPositionState(botId, bot.position_state);
    return { action: "hold", detail: `${dataBroker} 캔들 미지원 — 평가 불가` };
  }
  // 마지막 봉은 '형성 중'(미완결) → 백테스트는 닫힌 봉만 보므로 제거(backtest≡live). 닫힌 봉마다 최대 1회 정착 행동
  //  → 같은 형성봉의 재틱마다 넷이 다단계로 변해 멱등키가 충돌·드롭되던 문제(2차 동일방향 델타 누락) 제거.
  const data = fetched.length > 1 ? fetched.slice(0, -1) : fetched;
  if (data.length < 30) { store.setBotPositionState(botId, bot.position_state); return { action: "hold", detail: `데이터 부족(${data.length})` }; }
  // 캔들 무결성(audit P1-22): interval 불일치(요청≠응답 주기) / 봉 누락(데이터 깨짐) 시 신호 평가 금지(hold).
  //   crypto=24/7 엄격 연속, KR=중앙값 기반(주말/공휴일 갭 허용). backtest도 동일 fetch라 양쪽 일관(패리티 보존).
  const contig = validateCandleContiguity(data, interval, dataBroker === "binance" ? "crypto" : "kr");
  if (!contig.valid) { store.insertLog(botId, "error", `캔들 무결성 실패 → 평가 보류(${contig.reason})`); store.setBotPositionState(botId, bot.position_state); return { action: "hold", detail: `캔들 무결성 실패: ${contig.reason}` }; }
  const price = data[data.length - 1].close;

  // 스프레드 조건이 있으면 상대심볼(symbolB)을 동일 봉에 정렬해 주입 → 라이브에서도 spread 평가(backtest≡live).
  const root = comp.root_node as StrategyNode;
  const spreadSyms = collectSpreadSymbols(root);
  const auxSeries = spreadSyms.length ? await buildAuxSeries(data, spreadSyms, interval) : undefined;
  // 멀티타임프레임: timeframe 지정된 지표조건들의 상위TF 봉을 페치·정렬해 주입(라이브에서도 MTF 평가, backtest≡live).
  const mtfNeeds = collectMtfConditions(root);
  const mtfSeries = mtfNeeds.length ? await buildMtfSeries(data as unknown as MtfBar[], mtfNeeds, (tf, lim) => fetchKlines(bot.symbol, tf, lim) as unknown as Promise<MtfBar[]>) : undefined;
  // 멀티타임프레임 regime: timeframe 지정된 regime 조건들의 상위TF OHLC를 페치·정렬해 주입("1h 추세 레짐 + 5m 진입", backtest≡live).
  const mtfRegimeNeeds = collectMtfRegimeConditions(root);
  const mtfRegimeSeries = mtfRegimeNeeds.length ? await buildMtfRegimeSeries(data as unknown as MtfBar[], mtfRegimeNeeds, (tf, lim) => fetchKlines(bot.symbol, tf, lim) as unknown as Promise<MtfBar[]>) : undefined;
  // 이벤트 조건의 명명 캘린더(FOMC 등) 주입. 인라인 times는 조건에 내장돼 주입 불필요.
  const calNames = collectEventCalendars(root);
  const eventCalendars = calNames.length ? buildEventCalendars(calNames) : undefined;

  // riskSizing(opt-in): 엔진 진입 사이징에 반영 → 백테 trade 수량 → derivePosition want.qty → 라이브 주문에 그대로(backtest≡live).
  const cfg: BacktestConfig = { strategyId: "runner", symbol: bot.symbol, startDate: data[0].date, endDate: data[data.length - 1].date, initialCapital: bot.capital, commission: 0.1, timeframe: interval, auxSeries, mtfSeries, mtfRegimeSeries, eventCalendars, riskSizing: comp.risk_sizing as BacktestConfig["riskSizing"] };
  const risk = {
    stopLossPercent: comp.stop_loss_percent, takeProfitPercent: comp.take_profit_percent,
    tpLadder: comp.tp_ladder as never, scaleIn: comp.scale_in as never, pyramid: comp.pyramid as never,
    trailingStopPercent: comp.trailing_stop_percent,
  };
  const res = runCompositeBacktest(root, data as unknown as Parameters<typeof runCompositeBacktest>[1], cfg, 0, risk);
  const want = derivePosition(res.trades);
  let cur = bot.position_state as PaperPosition | null;
  const lastIso = data[data.length - 1].datetime;

  // ── P0-4 체결 reconcile(라이브 전용, 신호평가 전): 키움/KIS는 주문 시점 체결확인 불가(getOrderByClientId 미지원)
  //    → 매수 시장가가 pending+price0로 동결(fail-closed)된 뒤 거래소가 지연체결하면 거래소엔 실보유·장부엔 0(역방향
  //    발산). 틱 시작 시 거래소 실보유(getPositions)를 조회해 봇 장부를 거래소 진실로 동기화한다. 이후 curQty/델타가
  //    정정된 cur를 본다. 가드 술어가 'mode=live + 게이트통과 + getOrderByClientId 미지원'으로 좁아 바이낸스(지원)·
  //    페이퍼(mode!=live)·게이트OFF는 미진입 → getPositions 미호출 → 거동·오버헤드 0(회귀 0). 스캐너 경로는 별도(아래).
  cur = await bootSeedLivePosition(bot, cur); // P0-1: 재시작 첫 틱 1회, 게이트 무관 read-only 복원
  cur = await reconcileLivePosition(bot, cur, lastIso);

  const curQty = cur && cur.status === "open" ? cur.qty : 0;
  // 체결 채널: 라이브로 연 포지션인가. 레거시 상태(live 필드 없음)는 페이퍼로 보수 처리(실주문 안 나감 — 안전측).
  const curLive = curQty > 1e-9 ? (cur?.live ?? false) : false;

  // ── P0-2 에스컬레이션: 라이브 포지션의 상주 보호주문 동기화가 연속 실패하면 '손절 없는 나체 포지션'을
  //    계속 들고 있지 않는다(fail-closed). 손절류(고정/트레일링)를 설정한 포지션만 대상 — 사용자가 보호를 원했는데
  //    거래소에 보호가 없는 상태가 PROTECTIVE_MAX_FAILS틱 지속되면 비상 시장가 청산.
  if (cur && curQty > 1e-9 && curLive && (cur.protFails ?? 0) >= PROTECTIVE_MAX_FAILS && (risk.stopLossPercent != null || risk.trailingStopPercent != null)) {
    const ec = await fillOrder(bot, "sell", curQty, price, bot.symbol, { posLive: true, barIso: lastIso });
    if (!ec.failed) {
      const pnl = (ec.price - cur.entryAvg) * curQty;
      // 체결 기록+장부 0을 원자화(P1-21) — 사이 크래시 시 '체결 기록만 있고 장부 보유 잔존' 갭 차단.
      store.tx(() => {
        store.insertTrade({ bot_id: botId, side: "sell", price: ec.price, qty: curQty, pnl, is_paper: ec.live ? 0 : 1, reason: `비상 청산(보호주문 ${cur.protFails}회 연속 실패, fail-closed)`, idempotency_key: `${botId}:${lastIso}:ec` });
        store.setBotPositionState(botId, null, true, true);
      });
      await syncBotProtective(bot, true, bot.symbol, 0, cur.entryAvg, 0, risk, cur.protectiveIds ?? []); // 잔여 보호주문 취소(베스트에포트)
      audit({ event: "emergency_close_protective_failed", botId, qty: curQty, price: ec.price, fails: cur.protFails });
      store.insertLog(botId, "sell", `[${ec.live ? "실거래" : "페이퍼"}] 비상 청산 -${curQty} @ ${ec.price} — 보호주문 ${cur.protFails}회 연속 실패(나체 포지션 금지)`);
      return { action: "sell", detail: `비상 청산(보호주문 실패 ${cur.protFails}회, pnl=${pnl.toFixed(2)})` };
    }
    store.insertLog(botId, "error", `비상 청산도 실패(${ec.note}) — ⚠️ 수동 개입 필요(거래소에서 직접 청산/손절 확인)`);
    store.setBotPositionState(botId, cur);
    return { action: "hold", detail: "비상 청산 실패 — 수동 개입 필요" };
  }

  // (B) 윈도우 안전장치: 보유 중인데 엔진이 윈도우(300봉) 내에서 어떤 체결도 못 봤다면(진입이 윈도우 밖으로 밀려남)
  //  넷=0을 '청산 신호'로 오인해 전량 덤핑하지 말고 보유 유지(무정보 청산 방지). 실제 청산은 res.trades에 매도가 잡힐 때만.
  if (curQty > 1e-9 && res.trades.length === 0) {
    store.setBotPositionState(botId, cur);
    return { action: "hold", detail: `보유 유지 ${curQty} @ ${price}(윈도우 내 신호 없음, 진입 봉 윈도우 밖 가능)` };
  }
  // 멱등키는 봉 오픈시각(datetime, 전체 ISO) 기준 — date(YYYY-MM-DD)면 인트라데이 봇이 하루 1회 매매만 기록되어
  // 같은 날 재진입이 영구 차단됨(backtest≠live). 스캐너 경로와 동일 granularity.
  const idem = (sfx: string) => `${botId}:${lastIso}:${sfx}`;

  // ── 수량 델타(qty-delta) 정합 ──
  // 엔진의 넷 포지션(want.qty)을 라이브 보유수량(curQty)에 봉마다 추종 → tpLadder(부분익절)·scaleIn(물타기)·
  // pyramid(추가매수)의 단계적 수량 변화가 라이브에도 부분 체결로 반영됨(이전엔 flat↔holding 이진 전이라
  // 라더/스케일인/피라미딩이 발산했음). 단순 진입/청산은 dq=전량이라 기존 동작과 동일 → backtest≡live.
  const plan = planPositionDelta(curQty, want, price, bot.capital);

  if (plan.side === "buy") {
    // 포트폴리오 레벨 캡(opt-in): 진입 델타에만 적용(매도/청산 무관). 미설정이면 gate.qty===plan.qty(거동 변화 0).
    //  - blocked: 과노출/MDD halt → 진입 스킵(보유 유지). - 축소: MDD 디리스킹 배수로 델타 감소(증액 없음).
    const gate = applyPortfolioGate(bot.symbol, plan.qty, price);
    if (gate.blocked) {
      store.insertLog(botId, "gate", `포트폴리오 캡: 진입 차단(${gate.reasons.join("; ") || "한도 초과"}) → 보유 유지`);
      store.setBotPositionState(botId, cur);
      return { action: "hold", detail: `포트폴리오 캡 진입 차단(${gate.reasons.join("; ") || "한도"})` };
    }
    const buyQty = gate.qty;                          // 캡 적용 후 실제 매수 델타(미설정=plan.qty 그대로)
    const scaled = buyQty < plan.qty;                 // MDD 디리스킹으로 축소됐는가
    // 신규 진입 또는 추가매수(스케일인/피라미딩). entryAvg는 엔진 가중평단(want.entryAvg)으로 갱신.
    //   채널: 신규 진입=미정(undefined → 라이브 시도, 명확실패만 페이퍼) / 추가매수=기존 포지션 채널 고정.
    const fill = await fillOrder(bot, "buy", buyQty, price, bot.symbol, { posLive: curQty > 1e-9 ? curLive : undefined, barIso: lastIso });
    if (fill.failed) {
      // P0-1: 라이브 주문 실패/결과불명 → 페이퍼로 위장 기록하지 않고 동결(장부·상태 무변경). 다음 틱 재시도.
      store.setBotPositionState(botId, cur);
      return { action: "hold", detail: `라이브 매수 실패 — 동결(${fill.note})` };
    }
    // 부분체결(audit P1-1): 장부는 '의도 수량'이 아니라 '실제 체결 수량'으로 기록 — 거래소 진실과 일치.
    //   페이퍼는 전량 체결 가정(filledQty 부재 → buyQty). 라이브 부분체결이면 정직 고지(침묵 금지).
    const gotQty = fill.live && fill.filledQty != null && fill.filledQty > 0 ? fill.filledQty : buyQty;
    const partialFill = fill.live && gotQty < buyQty - 1e-12;
    if (partialFill) store.insertLog(botId, "live", `⚠️ 부분체결: 매수 의도 ${buyQty} 중 ${gotQty}만 체결 — 장부는 체결분만 기록`);
    const actualWantQty = (scaled || partialFill) ? curQty + gotQty : plan.wantQty; // 축소/부분체결 시 실제 도달 넷(다음 틱 재매수 폭주 방지)
    const reason = plan.partial ? "추가매수(스케일인/피라미딩)" : "전략 진입";
    // 평단: 미축소·전량체결이면 엔진 가중평단 그대로(기존 동작 동일). 축소/부분체결이면 기존보유+실체결분의 가중평균.
    const entryAvg = (scaled || partialFill)
      ? (curQty + gotQty > 0 ? (curQty * (cur?.entryAvg ?? fill.price) + gotQty * fill.price) / (curQty + gotQty) : fill.price)
      : (want.entryAvg > 0 ? want.entryAvg : fill.price);
    const peakPrice = Math.max(cur?.peakPrice ?? entryAvg, price);
    const nextLive = curQty > 1e-9 ? curLive : fill.live; // 채널은 진입 체결로 고정(추가매수는 기존 채널 유지)
    const openedAt = cur?.openedAt ?? new Date().toISOString();
    // 체결 기록+장부 갱신 원자화(P1-21): 보호주문 동기화(async)는 tx 밖 후속 — 사이 크래시여도 장부는 이미 일관.
    const t = store.tx(() => {
      const t0 = store.insertTrade({ bot_id: botId, side: "buy", price: fill.price, qty: gotQty, pnl: 0, is_paper: fill.live ? 0 : 1, reason, idempotency_key: idem("buy") });
      if (t0) store.setBotPositionState(botId, { status: "open", entryAvg, qty: actualWantQty, openedAt, live: nextLive, peakPrice, protectiveIds: cur?.protectiveIds ?? [], protFails: cur?.protFails ?? 0 } satisfies PaperPosition, true, true);
      return t0;
    });
    if (t) {
      // 라이브 채널: 거래소 상주 보호주문(SL/TP/트레일링) 배치/갱신. 페이퍼 채널: no-op(엔진이 시뮬레이트).
      const ps = await syncBotProtective(bot, nextLive, bot.symbol, actualWantQty, entryAvg, peakPrice, risk, cur?.protectiveIds ?? []);
      const protFails = nextProtFails(cur?.protFails, ps, (risk.stopLossPercent != null || risk.trailingStopPercent != null));
      if (ps.failed > 0) noteProtectiveFailure(botId, protFails);
      store.setBotPositionState(botId, { status: "open", entryAvg, qty: actualWantQty, openedAt, live: nextLive, peakPrice, protectiveIds: ps.ids, protFails } satisfies PaperPosition, true, true);
      const capNote = scaled ? ` [포트폴리오 캡 ×축소 ${plan.qty}→${buyQty}]` : "";
      store.insertLog(botId, "buy", `[${fill.live ? "실거래" : "페이퍼"}] ${reason} +${gotQty} → 보유 ${actualWantQty} @ ${fill.price}(평단 ${entryAvg.toFixed(2)})${capNote}`);
      return { action: "buy", detail: `${reason} +${gotQty} (보유 ${actualWantQty}, ${fill.note})${capNote}` };
    }
    return { action: "hold", detail: "매수 중복 스킵" };
  }

  if (plan.side === "sell") {
    // 부분 익절(라더) 또는 전량 청산. 실현손익은 매도분 × (체결가 − 진입평단). 평단은 부분매도 시 불변.
    //   채널 고정: 라이브 포지션은 라이브로만 매도(실패=동결), 페이퍼 포지션은 실주문 없이 페이퍼 매도.
    const fill = await fillOrder(bot, "sell", plan.qty, price, bot.symbol, { posLive: curLive, barIso: lastIso });
    if (fill.failed) {
      // P0-1 핵심: 실매도 실패를 페이퍼로 기록하면 장부=청산/거래소=실보유(손절 없는 고아 포지션)로 발산 → 동결.
      store.setBotPositionState(botId, cur);
      return { action: "hold", detail: `라이브 매도 실패 — 동결(${fill.note})` };
    }
    const refAvg = cur?.entryAvg ?? fill.price;
    // 부분체결(audit P1-1): 실현손익·잔여 수량을 '실제 체결분' 기준으로 — 의도수량 기록은 거래소와 발산.
    const soldQty = fill.live && fill.filledQty != null && fill.filledQty > 0 ? fill.filledQty : plan.qty;
    const partialSell = fill.live && soldQty < plan.qty - 1e-12;
    if (partialSell) store.insertLog(botId, "live", `⚠️ 부분체결: 매도 의도 ${plan.qty} 중 ${soldQty}만 체결 — 잔여 보유 유지(다음 틱 재평가)`);
    const remainQty = partialSell ? Math.max(0, curQty - soldQty) : plan.wantQty;
    const stillOpen = remainQty > 1e-9;
    const realPnl = (fill.price - refAvg) * soldQty;
    const reason = plan.partial ? "부분 익절(라더)" : "전략 청산";
    const peakPrice = stillOpen ? Math.max(cur?.peakPrice ?? refAvg, price) : 0;
    const openedAt = cur?.openedAt ?? new Date().toISOString();
    // 체결 기록+장부 갱신 원자화(P1-21). 보호주문 재동기화(async)는 tx 밖 후속(멱등 — clientOrderId 기준).
    const t = store.tx(() => {
      const t0 = store.insertTrade({ bot_id: botId, side: "sell", price: fill.price, qty: soldQty, pnl: realPnl, is_paper: fill.live ? 0 : 1, reason, idempotency_key: idem("sell") });
      if (t0) store.setBotPositionState(botId, stillOpen ? { status: "open", entryAvg: refAvg, qty: remainQty, openedAt, live: curLive, peakPrice, protectiveIds: cur?.protectiveIds ?? [], protFails: cur?.protFails ?? 0 } satisfies PaperPosition : null, true, true);
      return t0;
    });
    if (t) {
      // 부분이면 줄어든 수량으로 보호주문 재동기화, 전량 청산이면 desired=[]→전부 취소(고아주문 0).
      const ps = await syncBotProtective(bot, curLive, bot.symbol, remainQty, refAvg, peakPrice, risk, cur?.protectiveIds ?? []);
      const protFails = nextProtFails(cur?.protFails, ps, (risk.stopLossPercent != null || risk.trailingStopPercent != null));
      if (ps.failed > 0) noteProtectiveFailure(botId, protFails);
      const next: PaperPosition | null = stillOpen ? { status: "open", entryAvg: refAvg, qty: remainQty, openedAt, live: curLive, peakPrice, protectiveIds: ps.ids, protFails } : null;
      store.setBotPositionState(botId, next, true, true);
      store.insertLog(botId, "sell", `[${fill.live ? "실거래" : "페이퍼"}] ${reason} -${soldQty} → 보유 ${remainQty} @ ${fill.price} pnl=${realPnl.toFixed(2)}`);
      return { action: "sell", detail: `${reason} -${soldQty} (보유 ${remainQty}, pnl=${realPnl.toFixed(2)}, ${fill.note})` };
    }
    return { action: "hold", detail: "매도 중복 스킵" };
  }

  // 유지(hold). 보유 중이면 트레일링 갱신: peakPrice 올리고 상주 보호주문 재동기화(고점 추종 → 손절가 상향).
  if (curQty > 1e-9 && cur) {
    const peakPrice = Math.max(cur.peakPrice ?? cur.entryAvg, price);
    const ps = await syncBotProtective(bot, curLive, bot.symbol, curQty, cur.entryAvg, peakPrice, risk, cur.protectiveIds ?? []);
    const protFails = nextProtFails(cur.protFails, ps, (risk.stopLossPercent != null || risk.trailingStopPercent != null));
    if (ps.failed > 0) noteProtectiveFailure(botId, protFails);
    store.setBotPositionState(botId, { ...cur, peakPrice, protectiveIds: ps.ids, protFails });
    return { action: "hold", detail: `보유중 ${curQty} @ ${price}` };
  }
  store.setBotPositionState(botId, cur);
  return { action: "hold", detail: `관망 @ ${price}` };
}

/**
 * 보호주문 연속실패 카운터 갱신(audit P1-4/P1-9). 성공=0 리셋. SL leg 실패 + 손절 설정 포지션이면
 * 한도로 즉시 점프 — 'TP만 걸리고 SL 없는 편다리'를 3틱(기본 180초) 들고 있지 않고 다음 틱에 비상 청산.
 */
function nextProtFails(prev: number | undefined, ps: { failed: number; slFailed: boolean }, hasStop: boolean): number {
  if (ps.failed <= 0) return 0;
  if (ps.slFailed && hasStop) return PROTECTIVE_MAX_FAILS;
  return (prev ?? 0) + 1;
}

/** 보호주문 동기화 실패 기록(P0-2) — 연속 실패 수를 로그+감사. PROTECTIVE_MAX_FAILS 도달 시 다음 틱에 비상 청산. */
function noteProtectiveFailure(botId: string, fails: number): void {
  store.insertLog(botId, "error", `보호주문 동기화 실패 ${fails}회 연속 — ${PROTECTIVE_MAX_FAILS}회 도달 시 비상 청산(fail-closed)`);
  audit({ event: "protective_failed", botId, fails });
}

type ScannerPositions = Record<string, PaperPosition>;

/** 최신 봉 시각이 스케줄 hour에 드는지(tz 적용). schedule 없거나 hour 비면 항상 활성. */
function inSchedule(iso: string, schedule?: { hour: number[]; tz?: string }): boolean {
  if (!schedule || !Array.isArray(schedule.hour) || schedule.hour.length === 0) return true;
  const d = new Date(iso);
  const h = schedule.tz
    ? Number(new Intl.DateTimeFormat("en-GB", { timeZone: schedule.tz, hour: "2-digit", hour12: false }).formatToParts(d).find((x) => x.type === "hour")?.value ?? "0") % 24
    : d.getUTCHours();
  return schedule.hour.includes(h);
}

/**
 * 스캐너 봇 1틱: 유니버스 멀티심볼 페치 → 랭킹 → 상위 N → then 전략 평가 → 종목별 진입/청산.
 * 체결은 fillOrder 경유 — mode=live+게이트통과(마스터스위치+심볼allowlist+노셔널캡+일일손실서킷)면 심볼별 실주문,
 * 아니면 페이퍼 폴백(fail-closed). 기본(키없음/마스터OFF)은 전부 페이퍼. position_state=심볼→포지션 맵.
 * 안전: 멀티심볼 실거래는 심볼 allowlist가 통제 — allowlist에 없는 심볼은 자동 페이퍼.
 *
 * 스코프: P0-4 체결 reconcile(reconcileLivePosition)은 단일봇 경로(tickBot)만 — 스캐너는 position_state가
 *   심볼→포지션 맵이라 거래소 보유의 봇 귀속이 단일봇과 다르고, 키움 멀티심볼 라이브는 비대상이라 이번 제외.
 *   (스캐너 심볼맵 reconcile은 후속 작업.)
 */
async function tickScanner(bot: store.BotRow, node: ScannerNode, riskSizing?: BacktestConfig["riskSizing"]): Promise<{ action: "buy" | "sell" | "hold"; detail: string }> {
  const interval = secsToInterval(bot.interval_seconds);
  const fetched = await Promise.all(node.universe.map(async (sym) => {
    try { const raw = await fetchKlines(sym, interval, 300); const bars = raw.length > 1 ? raw.slice(0, -1) : raw; return { symbol: sym, bars }; } // 형성 중 봉 제거(닫힌 봉 기준)
    catch { return null; }
  }));
  // 캔들 무결성(audit P1-22): 봉 누락/interval 불일치 심볼은 랭킹·평가에서 제외(crypto 유니버스 → 엄격 연속).
  const entries = fetched.filter((x): x is { symbol: string; bars: Bar[] } => {
    if (!x || x.bars.length < 30) return false;
    const c = validateCandleContiguity(x.bars, interval, "crypto");
    if (!c.valid) { store.insertLog(bot.id, "gate", `${x.symbol} 캔들 무결성 실패 → 랭킹 제외(${c.reason})`); return false; }
    return true;
  });
  const positions: ScannerPositions = (bot.position_state as ScannerPositions | null) || {};
  const held = Object.keys(positions);
  if (entries.length < 2) { store.setBotPositionState(bot.id, positions); return { action: "hold", detail: `유니버스 데이터 부족(${entries.length})` }; }

  const barsOf: Record<string, Bar[]> = {};
  for (const e of entries) barsOf[e.symbol] = e.bars;
  const nowIso = entries[0].bars[entries[0].bars.length - 1].datetime;
  const active = inSchedule(nowIso, node.schedule);

  const ranked = rankUniverse(entries.map((e) => ({ symbol: e.symbol, bars: e.bars as unknown as RankBar[] })), node.rank.metric, node.rank.top, node.rank.order, node.rank.period);
  const topSymbols = ranked.map((r) => r.symbol);
  // 자본 분할: 실제 보유 가능 슬롯 수(top과 유니버스 크기 중 작은 값)로 나눔 — top>유니버스면 과소배분 방지.
  const slots = Math.max(1, Math.min(node.rank.top, node.universe.length));
  const perSymCapital = bot.capital / slots;

  // 보유 + 상위N 종목의 then 전략 평가 → 보유 희망 여부
  const evalSet = new Set<string>([...held, ...topSymbols]);
  const wantHold: Record<string, boolean> = {};
  const priceOf: Record<string, number> = {};
  // then 전략의 표현력 조건 needs를 1회 산출(이벤트=절대캘린더라 1회 빌드, spread/MTF는 심볼별 주입) → 스캐너 then도 backtest≡live.
  const thenSpreadSyms = collectSpreadSymbols(node.then);
  const thenMtfNeeds = collectMtfConditions(node.then);
  const thenMtfRegimeNeeds = collectMtfRegimeConditions(node.then);
  const thenCalNames = collectEventCalendars(node.then);
  const thenEvents = thenCalNames.length ? buildEventCalendars(thenCalNames) : undefined;
  for (const sym of evalSet) {
    const bars = barsOf[sym];
    if (!bars) { wantHold[sym] = false; continue; } // 데이터 없음 → 청산쪽
    priceOf[sym] = bars[bars.length - 1].close;
    const auxSeries = thenSpreadSyms.length ? await buildAuxSeries(bars, thenSpreadSyms, interval) : undefined;
    const mtfSeries = thenMtfNeeds.length ? await buildMtfSeries(bars as unknown as MtfBar[], thenMtfNeeds, (tf, lim) => fetchKlines(sym, tf, lim) as unknown as Promise<MtfBar[]>) : undefined;
    const mtfRegimeSeries = thenMtfRegimeNeeds.length ? await buildMtfRegimeSeries(bars as unknown as MtfBar[], thenMtfRegimeNeeds, (tf, lim) => fetchKlines(sym, tf, lim) as unknown as Promise<MtfBar[]>) : undefined;
    const cfg: BacktestConfig = { strategyId: "scanner", symbol: sym, startDate: bars[0].date, endDate: bars[bars.length - 1].date, initialCapital: perSymCapital, commission: 0.1, timeframe: interval, auxSeries, mtfSeries, mtfRegimeSeries, eventCalendars: thenEvents };
    const res = runCompositeBacktest(node.then, bars as unknown as Parameters<typeof runCompositeBacktest>[1], cfg);
    wantHold[sym] = derivePosition(res.trades).holding;
  }

  // 스케줄 비활성: 신규 진입 0 + 보유는 then 청산 신호로만 정리(강제 플랫 아님 — 라이드스루).
  const { toOpen, toClose } = decideScannerActions(topSymbols, held, wantHold, { allowOpen: active, rankExit: active });
  // 멱등키는 각 심볼 자기 봉의 datetime 기준(entries[0] 공유 시각은 선두 심볼 페치 실패 시 비결정적).
  const barIso = (sym: string) => (barsOf[sym]?.[barsOf[sym].length - 1]?.datetime ?? nowIso);
  let opens = 0, closes = 0;
  // 청산 먼저(자본 회수). mode=live + 게이트통과면 심볼별 실주문(allowlist·하드리밋), 아니면 페이퍼 폴백(fail-closed).
  for (const sym of toClose) {
    const pos = positions[sym]; const price = priceOf[sym];
    if (!pos) { delete positions[sym]; continue; }
    if (price === undefined) { store.insertLog(bot.id, "gate", `${sym} 청산 보류(가격 없음, 다음 틱 재시도)`); continue; } // 데이터 부재 → 다음 틱
    // 채널 고정(P0-1): 라이브로 연 심볼은 라이브로만 청산(실패=보유 유지+재시도), 페이퍼 심볼은 실주문 없이 페이퍼 청산.
    const fill = await fillOrder(bot, "sell", pos.qty, price, sym, { posLive: pos.live ?? false, barIso: barIso(sym) });
    if (fill.failed) { store.insertLog(bot.id, "error", `${sym} 라이브 청산 실패 — 보유 유지(${fill.note}), 다음 틱 재시도`); continue; }
    // 부분체결(audit P1-23): 실제 체결분만 차감(단일봇 경로와 동일). 의도수량으로 기록하면 장부=0/거래소=실보유 발산.
    const soldQty = fill.live && fill.filledQty != null && fill.filledQty > 0 ? fill.filledQty : pos.qty;
    const partialSell = fill.live && soldQty < pos.qty - 1e-12;
    const realPnl = (fill.price - pos.entryAvg) * soldQty;
    const t = store.insertTrade({ bot_id: bot.id, side: "sell", price: fill.price, qty: soldQty, pnl: realPnl, is_paper: fill.live ? 0 : 1, reason: `스캐너 청산(${sym})`, idempotency_key: `${bot.id}:${sym}:${barIso(sym)}:sell` });
    if (t) {
      if (partialSell) { positions[sym] = { ...pos, qty: pos.qty - soldQty }; store.insertLog(bot.id, "live", `⚠️ ${sym} 부분 청산: 의도 ${pos.qty} 중 ${soldQty}만 체결 — 잔여 ${pos.qty - soldQty} 보유 유지`); }
      else delete positions[sym];
      closes++; store.insertLog(bot.id, "sell", `[${fill.live ? "실거래" : "페이퍼"}] ${sym} 청산 qty=${soldQty} @ ${fill.price} pnl=${realPnl.toFixed(2)}`);
    }
  }
  // 신규 진입
  for (const sym of toOpen) {
    const price = priceOf[sym];
    if (price === undefined || price <= 0) continue;
    // riskSizing 있으면 변동성 타게팅/ATR/Kelly(심볼별 종가·고저로 산출), 없으면 기존 floor(perSymCapital/price) 그대로(회귀 0).
    const symBars = barsOf[sym] ?? [];
    const qty = riskSizing
      ? computeOrderQty({ equity: perSymCapital, price, commissionPct: 0.1, closes: symBars.map((b) => b.close), highs: symBars.map((b) => b.high), lows: symBars.map((b) => b.low), timeframe: interval, legacyQuantityPercent: 100, riskSizing, symbol: sym }).qty
      : Math.floor(perSymCapital / price);
    if (qty <= 0) continue;
    // 포트폴리오 레벨 캡(opt-in): 심볼별 진입에 적용. 미설정이면 gate.qty===qty(거동 변화 0). blocked면 이 심볼 진입 스킵.
    const gate = applyPortfolioGate(sym, qty, price);
    if (gate.blocked) { store.insertLog(bot.id, "gate", `포트폴리오 캡: ${sym} 진입 차단(${gate.reasons.join("; ") || "한도"})`); continue; }
    const buyQty = gate.qty;
    const fill = await fillOrder(bot, "buy", buyQty, price, sym, { barIso: barIso(sym) });
    if (fill.failed) { store.insertLog(bot.id, "error", `${sym} 라이브 진입 실패 — 스킵(${fill.note})`); continue; } // 모호실패=기록 금지(P0-1)
    // 부분체결(audit P1-23): 실제 체결분만 장부 기록(의도수량 기록 시 거래소와 발산).
    const gotQty = fill.live && fill.filledQty != null && fill.filledQty > 0 ? fill.filledQty : buyQty;
    if (fill.live && gotQty < buyQty - 1e-12) store.insertLog(bot.id, "live", `⚠️ ${sym} 부분체결: 의도 ${buyQty} 중 ${gotQty}만 체결 — 체결분만 기록`);
    const t = store.insertTrade({ bot_id: bot.id, side: "buy", price: fill.price, qty: gotQty, pnl: 0, is_paper: fill.live ? 0 : 1, reason: `스캐너 진입(${sym}, ${node.rank.metric} 상위)`, idempotency_key: `${bot.id}:${sym}:${barIso(sym)}:buy` });
    if (t) { positions[sym] = { status: "open", entryAvg: fill.price, qty: gotQty, openedAt: new Date().toISOString(), live: fill.live }; opens++; store.insertLog(bot.id, "buy", `[${fill.live ? "실거래" : "페이퍼"}] ${sym} 진입 qty=${gotQty} @ ${fill.price}${gotQty < qty ? ` [축소/부분 ${qty}→${gotQty}]` : ""}`); }
  }

  store.setBotPositionState(bot.id, positions, true, opens + closes > 0);
  const detail = `랭킹 상위[${topSymbols.join(",") || "-"}] 진입${opens}/청산${closes} 보유[${Object.keys(positions).join(",") || "-"}]${active ? "" : " (스케줄 비활성)"}`;
  return { action: opens > 0 ? "buy" : closes > 0 ? "sell" : "hold", detail };
}

/** 러너 데몬: 가동 봇을 interval마다 tick. graceful shutdown 지원. */
export class Runner {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private alive = true;
  private backupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // 주기 백업(P1-21): 기동 직후 1회 + 24h마다. 실패는 backupDb가 내부 고지(거래 비차단). unref=프로세스 종료 비차단.
    store.backupDb();
    this.backupTimer = setInterval(() => { store.backupDb(); }, 24 * 3600 * 1000);
    this.backupTimer.unref?.();
  }

  start(botId: string): void {
    const bot = store.getBot(botId);
    if (!bot) return;
    store.setBotStatus(botId, "running");
    if (this.timers.has(botId)) return;
    const run = () => { if (this.alive) tickBot(botId).catch((e) => store.insertLog(botId, "error", String(e instanceof Error ? e.message : e))); };
    run();
    this.timers.set(botId, setInterval(run, Math.max(15, bot.interval_seconds) * 1000));
  }
  stop(botId: string): void {
    const t = this.timers.get(botId); if (t) { clearInterval(t); this.timers.delete(botId); }
    store.setBotStatus(botId, "stopped");
  }
  resumeAll(): void { for (const b of store.listRunningBots()) this.start(b.id); }
  shutdown(): void { this.alive = false; for (const t of this.timers.values()) clearInterval(t); this.timers.clear(); if (this.backupTimer) { clearInterval(this.backupTimer); this.backupTimer = null; } }
}

let _runner: Runner | null = null;
export function runner(): Runner { if (!_runner) _runner = new Runner(); return _runner; }

/**
 * 글로벌 킬스위치 실행부(audit P1-17). 전 가동 봇 정지 + (옵션) 라이브 오픈 포지션 시장가 청산.
 * 청산은 fillOrder 안전경로 재사용(liveGate/checkLimits/멱등 cid — 새 주문 경로 0). 호출 측은 청산을 끝낸
 * '뒤에' LIVE_TRADING_HALT를 설정해야 한다(HALT 먼저 켜면 청산 주문도 게이트에 막힘).
 * 실패는 삼키지 않고 집계 반환 — 봇별 청산 실패 시 거래소 수동 정리 필요(로그·감사 기록).
 */
export async function emergencyStopAll(opts?: { closePositions?: boolean }): Promise<{ stopped: number; closed: number; failed: number }> {
  const bots = store.listRunningBots();
  let closed = 0, failed = 0;
  for (const bot of bots) runner().stop(bot.id); // 먼저 전부 정지(추가 진입 차단)
  if (opts?.closePositions) {
    for (const bot of bots) {
      const cur = bot.position_state as PaperPosition | null;
      if (bot.mode !== "live" || !cur || cur.status !== "open" || !(cur.qty > 1e-9) || cur.live !== true) continue; // 라이브 채널 오픈 포지션만
      try {
        const live = liveAdapterFor(bot);
        const px = live ? (await (live.adapter as { getPrice: (s: string) => Promise<{ price: number }> }).getPrice(bot.symbol)).price : 0;
        if (!(px > 0)) { failed++; store.insertLog(bot.id, "error", "비상 전체청산: 시세 조회 실패 — 거래소에서 수동 청산 필요"); continue; }
        const ec = await fillOrder(bot, "sell", cur.qty, px, bot.symbol, { posLive: true });
        if (ec.failed) { failed++; store.insertLog(bot.id, "error", `비상 전체청산 실패(${ec.note}) — 거래소에서 수동 청산 필요`); continue; }
        const soldQty = ec.filledQty != null && ec.filledQty > 0 ? ec.filledQty : cur.qty;
        const pnl = (ec.price - cur.entryAvg) * soldQty;
        store.tx(() => {
          store.insertTrade({ bot_id: bot.id, side: "sell", price: ec.price, qty: soldQty, pnl, is_paper: ec.live ? 0 : 1, reason: "비상 전체청산(킬스위치)", idempotency_key: `${bot.id}:${Date.now()}:halt` });
          store.setBotPositionState(bot.id, null, true, true);
        });
        await syncBotProtective(bot, true, bot.symbol, 0, cur.entryAvg, 0, {}, cur.protectiveIds ?? []); // 잔여 보호주문 취소(베스트에포트)
        store.insertLog(bot.id, "sell", `[킬스위치] 비상 전체청산 -${soldQty} @ ${ec.price} pnl=${pnl.toFixed(2)}`);
        closed++;
      } catch (e) {
        failed++;
        store.insertLog(bot.id, "error", `비상 전체청산 예외(${e instanceof Error ? e.message : e}) — 수동 확인 필요`);
      }
    }
  }
  audit({ event: "emergency_stop_all", stopped: bots.length, closed, failed, closePositions: !!opts?.closePositions });
  return { stopped: bots.length, closed, failed };
}
