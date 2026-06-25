/**
 * runner/runner.ts — 로컬 페이퍼/라이브 봇 러너. bot-runner route.ts 평가루프를 standalone으로 이식.
 * core 엔진(runCompositeBacktest) 재사용 → backtest≡live(신호·사이징). 페이퍼는 가상체결을 스토어에 기록.
 * mode=live는 fillOrder가 liveGate 통과 시 어댑터로 실주문(미통과 시 페이퍼 폴백). 봇 라이브는 주문별 2단계 토큰이 아니라
 * 게이트 + 하드리밋 + 멱등으로 통제(2단계 토큰은 수동 place_order/place_protective 전용). 메인넷은 마스터스위치 전까지 OFF.
 */
import type { StrategyNode, ScannerNode, BacktestConfig, EntryExecution, LimitBracketNode } from "../core/types/strategy.js";
import { decideLimitBracket, initLimitBracketState, findMyRestingOrder, type LimitBracketState } from "../core/execution/limit-bracket.js"; // 지속형 지정가 봇 순수 리듀서
import { isMarketOpen, sessionKey } from "../util/market-hours.js"; // 연속매매 게이트 + 세션키(멱등)
import { roundToKrxTick } from "../brokers/krx-tick.js"; // KR 가격 매칭(거래소 정렬가와 비교)
import { runCompositeBacktest } from "../core/backtest/engine.js";
import { elapsedClosedBars, checkSlippageCap, computeLimitPrice, clampTimeoutBars, clampMaxSlippagePct } from "../core/execution/entry.js"; // 봇 지정가 진입(audit P1-5)
import { fetchKlines, buildAuxSeries, type Bar } from "../data/binance-public.js";
import { validateCandleContiguity } from "../util/candle.js";
import { collectSpreadSymbols } from "../core/strategy/spread-symbols.js";
import { collectMtfConditions, buildMtfSeries, collectMtfRegimeConditions, buildMtfRegimeSeries, type MtfBar } from "../core/strategy/mtf.js";
import { collectEventCalendars, buildEventCalendars } from "../core/calendar/calendars.js";
import { rankUniverse, decideScannerActions, type RankBar } from "../core/scanner/rank.js";
import { planProtectiveOrders, syncProtective } from "../core/execution/protective.js";
import { evaluateProtectiveExit } from "../core/execution/protective-monitor.js"; // 데몬 측 합성 보호(거래소 상주 SL/TP 미지원 브로커)
import { loadTelegramConfig, broadcastTelegram } from "../core/alerts/telegram.js"; // 보호 손절/공백 알림(아웃바운드, 미설정이면 no-op)
import { sizeFromBalance, classifyFillStatus, reconcilePositionFromExchange, type ExchangePos } from "../core/execution/reconcile.js";
import { computeOrderQty } from "../core/risk/order-sizing.js"; // 스캐너 진입 사이징(opt-in 변동성 타게팅)
// 체결 reconcile(P0-4): 키움/KIS는 getOrderByClientId 미지원 → 주문 시점 체결확인 불가(지연체결). tickBot 시작 시
//   거래소 실보유(getPositions)를 조회해 봇 장부를 거래소 진실로 동기화(reconcilePositionFromExchange). 크립토(Binance,
//   getOrderByClientId 지원=주문 시점 즉시 filled 확인)는 reconcile 불필요 → 술어 미충족으로 미진입(회귀 0).
import * as store from "../store/db.js";
import { getAdapter } from "../brokers/index.js";
import { liveGate, checkLimits, quoteCurrencyFor, audit, loadPortfolioGateConfig, portfolioGate, type Broker } from "../brokers/safety.js";
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

type FillResult = { live: boolean; price: number; orderId?: string; note: string; filledQty?: number; failed?: boolean; unknown?: boolean; pending?: boolean; cid?: string; limitPrice?: number };

// 봇 진입 주문 의도(audit P1-5). undefined/market = 시장가(레거시 바이트 동일). limit은 binance 봇 한정(KR fail-closed).
type EntryExecPlan = { type: "limit"; limitPrice: number; timeoutBars: number; maxSlippagePct: number } | { type: "market" };

// 주문 결과불명(unknown verdict) 누적 → 강제 reconcile 임계(audit P1-2). env LIVE_UNKNOWN_MAX_COUNT(1~20, 기본5).
const UNKNOWN_MAX_COUNT = (() => {
  const n = parseInt((process.env.LIVE_UNKNOWN_MAX_COUNT || "").trim(), 10);
  return Number.isFinite(n) && n >= 1 && n <= 20 ? n : 5;
})();

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
async function fillOrder(bot: store.BotRow, side: "buy" | "sell", qty: number, price: number, symbol: string = bot.symbol, opts?: { posLive?: boolean; barIso?: string; entry?: EntryExecPlan; allowKrLimit?: boolean }): Promise<FillResult> {
  if (bot.mode !== "live") return { live: false, price, note: "페이퍼" };
  if (opts?.posLive === false) return { live: false, price, note: "페이퍼 채널(실주문 없음)" }; // 페이퍼 포지션은 페이퍼로만 변경
  const mustLive = opts?.posLive === true;
  // 라이브 채널 포지션 관리 불가 시: 페이퍼로 위장 기록하지 않고 동결(failed) — 다음 틱 재시도.
  const blocked = (note: string): FillResult => {
    if (!mustLive) return { live: false, price, note: `${note}→페이퍼` };
    store.insertLog(bot.id, "error", `라이브 포지션 관리 불가(${note}) → 동결(기록 없음, 다음 틱 재시도)`);
    return { live: false, price, note, failed: true };
  };
  const broker = (["binance", "kis", "kiwoom", "toss"].includes(bot.broker) ? bot.broker : "binance") as Broker;
  const market = "spot" as "spot" | "futures"; // quant-mcp 러너는 현물만(선물 라이브는 stock-autotrade). 향후 선물 지원 시 심볼/설정 기반 분기.
  // 지정가 진입(audit P1-5): binance 한정. KR(kis/키움)은 getOrderByClientId 부재로 미체결 확인/타임아웃 불가 → fail-closed 거절(무음 시장가 강등 금지).
  const isLimit = opts?.entry?.type === "limit";
  // KR 지정가: 기본은 fail-closed 거절(P1-5 신호진입은 getOrderByClientId 부재로 타임아웃 확인 불가). 단 limit_bracket 봇은
  // 폴백 없는 순수 resting + getOpenOrders(ka10075) 기반 추적이라 KR 지정가가 목적 → opts.allowKrLimit로 허용.
  // (적대검증 safety#4: 신헬퍼 신설 대신 이 게이트 1개만 우회 → 9겹 안전망·P0-5 미확인동결 그대로. KR은 isLimit 분기에서 pending=resting 반환, 절대 bought 아님.)
  if (isLimit && !opts?.allowKrLimit && (broker === "kis" || broker === "kiwoom" || broker === "toss")) { store.insertLog(bot.id, "gate", `KR 지정가 진입 미지원(${broker}, audit P1-5)`); return blocked("KR 지정가 미지원"); }
  const gate = liveGate(broker, market);
  if (!gate.allowed) { store.insertLog(bot.id, "gate", `라이브 차단(${gate.reason})`); return blocked("게이트 차단"); }
  // 통화 인식: Binance=USDT, 한투/키움=KRW → 통화별 안전 기본 캡(KRW 봇에 달러캡 적용 버그 방지).
  const quoteCurrency = quoteCurrencyFor(broker, symbol);
  const got = getAdapter(broker, market);
  if (!got) { store.insertLog(bot.id, "gate", "어댑터 없음"); return blocked("어댑터없음"); }
  // 거래소 LOT_SIZE(stepSize)로 수량 정규화 — 안 하면 -1013(LOT_SIZE) 거부. minQty/minNotional 보정 포함.
  let nq = got.adapter.normalizeQuantity ? await got.adapter.normalizeQuantity(symbol, qty, price) : qty;
  // 실잔고 사이징(P0-2): 매수는 가용현금 초과 못 함(insufficient funds 거부 예방). 정적 capital이 실잔고보다 클 때.
  if (side === "buy" && got.adapter.getBalance) {
    try {
      const bal = await got.adapter.getBalance();
      // 통화 일치 시에만 실잔고 클램프. 토스 US 주문은 계좌현금=KRW인데 주문가=USD → 단위 불일치 클램프 금지(KRW÷USD=무의미).
      //   불일치 시 하드캡(checkLimits, 통화 인식)이 노셔널을 통제. (적대검증: 교차통화 affordability 버그.)
      const affordable = bal.currency === quoteCurrency ? sizeFromBalance(bal.cashBalance, price, 99) : 0; // 수수료 여유 1%
      if (affordable > 0 && affordable < nq) {
        nq = got.adapter.normalizeQuantity ? await got.adapter.normalizeQuantity(symbol, affordable, price) : affordable;
        store.insertLog(bot.id, "gate", `실잔고 제한: 주문 ${qty}→${nq}(가용현금 ${bal.cashBalance})`);
      }
    } catch { /* 잔고조회 실패 시 정규화수량 그대로(하드리밋이 상한) */ }
  }
  if (!(nq > 0)) { store.insertLog(bot.id, "gate", `수량 정규화/잔고 0(${qty}→${nq})`); return blocked("수량0"); }
  // ① 하드리밋(노셔널캡 + allowlist + 일일손실 서킷)을 '최종 제출 수량(nq)'으로 검증 — minNotional 상향분이 캡 넘으면 차단(검증==제출).
  const lim = checkLimits({ symbol, notional: price * nq, quoteCurrency, side }); // side: 누적 예산상한(Task #3)은 매수만
  if (!lim.ok) { store.insertLog(bot.id, "gate", `하드리밋(${symbol} ${lim.reason})`); return blocked("리밋"); }
  // clientOrderId ≤36자([a-zA-Z0-9-_]): botId 앞 8자 + side + symbol태그 + base36 봉시각. 봉 기준 '결정적' cid라
  // 같은 봉의 재시도가 같은 cid를 재사용 → 모호실패 후 재시도 시 거래소측 기존 주문을 조회/입양 가능(이중주문 방지).
  // ⚠️ symbol 태그 필수: 스캐너 봇은 한 봉에 여러 심볼을 같은 side로 진입 → symbol 없으면 cid 충돌 →
  //    거래소가 2번째 심볼 주문을 중복 cid로 거부 → 그 심볼이 페이퍼로 폴백(심볼축 live/paper 발산). symbol 태그로 차단.
  const barMs = opts?.barIso ? Date.parse(opts.barIso) : NaN;
  const symTag = symbol.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
  const cid = `o${bot.id.slice(0, 8)}${side[0]}${symTag}${(Number.isFinite(barMs) ? Math.floor(barMs / 1000) : Date.now()).toString(36)}`;
  // pre-check(입양): 같은 봉의 모호 실패 주문이 실제 나가 있으면 재주문 대신 그 체결을 채택(같은 봉 cid 한정).
  //   ⚠️ 적대검증 #5 후속: '직전 봉' cid로 확장하면 정상 완료된 라운드트립 진입(매수→청산→재매수, 스캘퍼/평균회귀에서 흔함)을
  //   유령으로 오입양해 합법 재진입을 누락하고 유령 포지션을 만든다(거동 가정 오류=#2 교훈). 유령↔이미-청산된-실체결 구분은
  //   거래소 거동 검증이 필요 → 직전봉 입양/유령 회수는 testnet-게이트 active-mechanism(#5)으로 보류. 여기선 같은 봉만(원래 안전 동작).
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
  const orderPrice = isLimit ? (opts!.entry as Extract<EntryExecPlan, { type: "limit" }>).limitPrice : undefined;
  try {
    const r = await got.adapter.placeOrder({ symbol, side, type: isLimit ? "limit" : "market", quantity: nq, clientOrderId: cid, ...(isLimit ? { price: orderPrice } : {}) });
    audit({ event: "bot_order_result", botId: bot.id, env: gate.env, orderId: r.orderId, status: r.status });
    // 거부는 체결이 아니다(P0-3: 키움 rejected가 정상 반환되어 live 기록되던 구멍). 진입=페이퍼 폴백 / 라이브채널=동결.
    if (r.status === "rejected") {
      store.insertLog(bot.id, "error", `[${gate.env}] 주문 거부 ${symbol} ${side} qty=${nq}`);
      return blocked("주문 거부");
    }
    // 지정가 진입(audit P1-5): pending=정상(호가 등록)이라 freeze 금지 → caller가 pendingEntry로 추적. 즉시 filled면 바로 반영.
    if (isLimit) {
      if (r.status === "filled" && typeof r.price === "number" && r.price > 0) {
        store.insertLog(bot.id, "live", `[${gate.env}] 지정가 즉시체결 ${symbol} ${side} qty=${nq} @${r.price} (${r.orderId})`);
        return { live: true, price: r.price, orderId: r.orderId, note: `${gate.env} 지정가 체결`, filledQty: r.quantity || nq, cid };
      }
      store.insertLog(bot.id, "live", `[${gate.env}] 지정가 접수(호가 등록) ${symbol} ${side} qty=${nq} @${orderPrice} (${r.orderId}) — 체결 대기`);
      audit({ event: "bot_limit_resting", botId: bot.id, env: gate.env, orderId: r.orderId, refPrice: orderPrice });
      return { live: false, pending: true, price: orderPrice ?? price, cid, limitPrice: orderPrice, orderId: r.orderId, note: `${gate.env} 지정가 대기`, filledQty: 0 };
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
    return { live: false, price, note: "실주문 결과 불명", failed: true, unknown: true };
  }
}

type LiveAdapter = NonNullable<ReturnType<typeof getAdapter>>["adapter"];
/** 라이브 봇의 어댑터 해석(mode=live + 게이트 통과 + 어댑터 존재 시). 아니면 null(페이퍼=엔진이 스톱 시뮬레이트). */
function liveAdapterFor(bot: store.BotRow): { adapter: LiveAdapter; env: string } | null {
  if (bot.mode !== "live") return null;
  const broker = (["binance", "kis", "kiwoom", "toss"].includes(bot.broker) ? bot.broker : "binance") as Broker;
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
  if (bot.broker === "kis" || bot.broker === "kiwoom" || bot.broker === "toss") {
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
  unknownCount?: number;     // 주문 결과불명(unknown verdict) 연속 누적(audit P1-2) — UNKNOWN_MAX_COUNT 도달 시 강제 getPositions reconcile로 수렴(단일봇 전용)
  // 지정가 진입 대기(audit P1-5, binance 라이브 한정). 신호 봉에 LIMIT 배치 후 체결/타임아웃까지 추적(크래시 생존 → cid로 재조회·중복방지).
  //   존재하면 무포지션(미체결) — resolvePendingEntry가 매 틱 최우선 해소(신호평가·reconcile 스킵). KR/스캐너는 진입 안 함(시장가).
  pendingEntry?: { cid: string; limitPrice: number; origQty: number; filledQty: number; placedBarIso: string; timeoutBars: number; maxSlippagePct: number };
  // 신규 진입 결과불명(#5, binance 라이브 한정). 시장가 진입 placeOrder가 unknown(타임아웃/네트워크)으로 끝나면 주문이
  //   거래소에 실렸는지 불명 → 마커 영속. resolveUnknownEntry가 매 틱 최우선 해소: 거래소 실보유를 의도수량(intendedQty)
  //   한도로 입양(=내 주문이 실림) 또는 RECON_CLEAR_MISSES틱 연속 부재 시 해제(=안 실림). 존재하는 동안 재진입 억제(이중매수 차단).
  pendingUnknownEntry?: { intendedQty: number; placedBarIso: string; misses: number };
}

/** 폴링 주기(초) → Binance kline 타임프레임. 인트라데이 봉이라야 시간대(hour) 조건이 의미. (export: create_bot 인터벌 검증 공유) */
export function secsToInterval(s: number): string {
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
export function derivePosition(trades: { action: string; price: number; quantity: number }[], seed?: { qty: number; entryAvg: number }): { holding: boolean; entryAvg: number; qty: number } {
  // P0-5: 시드(라이브 보유)로 시작하면 윈도우 트레이드를 그 위에 적용 → 엔진 시드 재실행 결과와 정합(backtest≡live).
  let qty = seed && seed.qty > 1e-9 ? seed.qty : 0;
  let cost = seed && seed.qty > 1e-9 ? seed.qty * seed.entryAvg : 0;
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
  if (cur?.pendingEntry) return cur; // audit P1-5 Q7: 지정가 대기 중엔 reconcile 미진입(resolvePendingEntry 전담, 이중입양 방지)
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
  if (cur?.pendingEntry) return cur; // audit P1-5 Q7: 지정가 대기 중엔 부트시드 미진입(resolvePendingEntry 전담)
  bootSeeded.add(bot.id);
  if (cur && cur.status === "open") return cur; // 장부 존재 → 주기 reconcile 책임(여긴 null 갭 전용)
  const ledger = store.liveOpenLedger(bot.id);
  if (!(ledger.qty > 1e-9)) return cur; // 라이브 체결 근거 0 → 거래소 보유는 수동 보유로 간주(채택 금지)
  const broker = (["binance", "kis", "kiwoom", "toss"].includes(bot.broker) ? bot.broker : "binance") as Broker;
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
      // 진입시각 불명(크래시/재시작 복구) → 과거 센티넬(epoch 0)로 기록. (B) 윈도우스크롤 가드가 이 포지션을 '스크롤아웃=보유유지'로
      //   fail-closed 처리(엔진 윈도우-블라인드 넷 불신, 상주 SL/TP가 보호) — openedAt=now면 가드가 '윈도우 내'로 오인해 장기보유를
      //   오청산할 수 있다(적대검증 #9 후속). 실제 진입봉이 윈도우 안이어도 보수적 보유가 안전(엔진 시드=P0-5 전까지).
      openedAt: new Date(0).toISOString(), live: true,
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

/**
 * unknown 누적 강제 reconcile(audit P1-2). 주문 결과불명(unknown)이 UNKNOWN_MAX_COUNT 연속 누적되면
 * reconcileLivePosition의 브로커 가드(바이낸스 skip)를 우회해 getPositions로 거래소 진실을 1회 강제 조회·수렴한다.
 *
 * 보수성(fail-closed): adopt(거래소 보유>0)·in_sync는 즉시 반영. no_exchange_pos(장부>0·거래소0)는 지연체결
 *   오삭제 방지를 위해 즉시 삭제하지 않고 reconMisses를 누적해 RECON_CLEAR_MISSES 연속 부재 시에만 clear한다.
 *   ※ 이 clear는 reconcileLivePosition의 clear 경로가 도달 불가한 바이낸스(getOrderByClientId 보유→reconcile skip)
 *     에서만 적용(KR은 reconcileLivePosition이 처리 — 중복 카운트 방지). 유령 포지션 영구 잔존 버그 수정(audit P1-2 후속).
 *   조회 실패=유지(다음 틱 재시도). adopt/in_sync에서 unknownCount=0 리셋(폭주 방지). no_exchange_pos 누적 중에는
 *   unknownCount를 ≥MAX로 유지해 다음 틱에도 재호출→reconMisses 확정 누적(3틱 clear).
 */
async function forceReconcileOnUnknown(bot: store.BotRow, cur: PaperPosition | null): Promise<PaperPosition | null> {
  if (cur?.pendingEntry) return cur; // audit P1-5 Q7: 지정가 대기 중엔 강제 reconcile 미진입(resolvePendingEntry 전담)
  const live = liveAdapterFor(bot);
  if (!live) return cur; // 게이트 미통과 → 다음 틱
  const adapter = live.adapter as { getPositions?: () => Promise<ExchangePos[]> };
  if (typeof adapter.getPositions !== "function") return cur;
  let exPos: ExchangePos[];
  try { exPos = await getReconcilePositions(bot.broker, live.env, () => (adapter.getPositions as () => Promise<ExchangePos[]>)()); }
  catch (e) { store.insertLog(bot.id, "error", `[${live.env}] unknown 누적 강제 reconcile 조회 실패(${e instanceof Error ? e.message : e}) → 유지(다음 틱)`); return cur; }
  audit({ event: "fill_unknown_reconcile_triggered", botId: bot.id, env: live.env, symbol: bot.symbol, count: cur?.unknownCount ?? 0 });
  const curQty = cur && cur.status === "open" ? cur.qty : 0;
  let rec = reconcilePositionFromExchange(curQty > 1e-9 ? { qty: curQty } : null, exPos, bot.symbol);
  if (rec.action === "no_exchange_pos" && bot.broker === "binance") rec = reconcilePositionFromExchange(curQty > 1e-9 ? { qty: curQty } : null, exPos, baseAsset(bot.symbol));
  if (rec.action === "adopt" && rec.next) {
    // 수동보유 오입양 방지(적대검증 #4) — **binance 전용 캡**(가드를 코드로 강제). getPositions는 계좌 단위라 봇 체결분 +
    //   사용자 수동보유가 섞인다. binance는 자기 체결을 즉시 장부 기록(fillConfirmed)하므로 ledger/curQty가 근거 상한 →
    //   그 이상(근거 없는 계좌 보유)은 수동보유로 간주해 미채택. ⚠️ KR(kis/키움/toss)은 시장가 pending→동결이라 ledger=0
    //   자기체결이 존재 → 동일 캡을 적용하면 KR own-fill을 수동보유로 오인·미채택(인지 붕괴)한다. forceReconcile은 브로커
    //   무관 호출되므로(unknownCount 누적) KR이 도달할 수 있어, 캡을 adapterHasOrderQuery(=binance)로 **명시 분기**한다
    //   (KR은 종전대로 raw 채택; KR pending-order 추적기는 testnet/KR-mock 후속).
    const adapterHasOrderQuery = (live.adapter as { getOrderByClientId?: unknown }).getOrderByClientId !== undefined;
    let adoptQty = rec.next.qty;
    if (adapterHasOrderQuery) {
      const ledgerQty = store.liveOpenLedger(bot.id).qty;
      adoptQty = Math.min(rec.next.qty, Math.max(curQty, ledgerQty));
      if (!(adoptQty > 1e-9)) {
        store.insertLog(bot.id, "gate", `[${live.env}] 강제 reconcile: ${bot.symbol} 거래소 보유 ${rec.next.qty} 있으나 봇 라이브 체결 근거 0(curQty/ledger) → 수동 보유로 간주, 미채택(오입양 방지).`);
        if (cur) { const next = { ...cur, unknownCount: 0 }; store.setBotPositionState(bot.id, next, true, false); return next; }
        return cur;
      }
    }
    const entryAvg = rec.next.entryAvg > 0 ? rec.next.entryAvg : (cur?.entryAvg ?? 0);
    const adopted: PaperPosition = { status: "open", entryAvg, qty: adoptQty, openedAt: cur?.openedAt ?? new Date().toISOString(), live: true, peakPrice: Math.max(cur?.peakPrice ?? entryAvg, entryAvg), protectiveIds: cur?.protectiveIds ?? [], protFails: cur?.protFails ?? 0, reconMisses: 0, unknownCount: 0 };
    store.setBotPositionState(bot.id, adopted, true, false);
    store.insertLog(bot.id, "live", `[${live.env}] unknown 누적 → 강제 reconcile 채택: ${bot.symbol} 장부 ${curQty}→${adoptQty}(거래소 ${rec.next.qty}, 평단 ${entryAvg})`);
    return adopted;
  }
  // no_exchange_pos + 라이브 보유: 거래소 부재(주문 미발행 또는 외부청산). reconcileLivePosition의 clear 경로는
  //   바이낸스(getOrderByClientId 보유 → reconcile skip, runner.ts:323)에서 도달 불가 → 유령 포지션이 영구 잔존하던
  //   버그(audit P1-2 후속). 여기서 동일한 보수적 reconMisses 누적·정정을 수행한다. KR은 reconcileLivePosition이
  //   이미 처리하므로 중복 카운트 방지 위해 'getOrderByClientId 보유 어댑터'(=바이낸스)에서만 적용.
  const adapterHasOrderQuery = (live.adapter as { getOrderByClientId?: unknown }).getOrderByClientId !== undefined;
  const curLive = curQty > 1e-9 ? (cur?.live ?? false) : false;
  if (rec.action === "no_exchange_pos" && adapterHasOrderQuery && curLive && cur && curQty > 1e-9) {
    const misses = (cur.reconMisses ?? 0) + 1;
    if (misses >= RECON_CLEAR_MISSES) {
      store.setBotPositionState(bot.id, null, true, false);
      store.insertLog(bot.id, "live", `[${live.env}] unknown 누적 강제 reconcile: ${bot.symbol} 거래소 ${RECON_CLEAR_MISSES}틱 연속 부재 → 장부 ${curQty}→0(거래소 진실 채택, audit P1-2)`);
      audit({ event: "reconcile_clear", botId: bot.id, env: live.env, symbol: bot.symbol, localQty: curQty, misses });
      return null;
    }
    // unknownCount는 리셋하지 않음(≥MAX 유지) → 다음 틱 line 641 재호출로 reconMisses 확정 누적(3틱 clear).
    const next: PaperPosition = { ...cur, reconMisses: misses };
    store.setBotPositionState(bot.id, next, true, false);
    store.insertLog(bot.id, "gate", `[${live.env}] unknown 누적 강제 reconcile: ${bot.symbol} 거래소 부재(${misses}/${RECON_CLEAR_MISSES}틱) — 보유 유지(지연체결 가능성)`);
    return next;
  }
  // in_sync / 거래소 보유 정상: 장부 변경 없이 카운터만 리셋(조회 성공=수렴 시도 완료).
  if (cur) { const next = { ...cur, unknownCount: 0 }; store.setBotPositionState(bot.id, next, true, false); return next; }
  return cur;
}

/**
 * #6 상주 보호주문(SL/TP) 거래소 체결 reconcile — **바이낸스 라이브 단일봇 한정**.
 *
 * 왜(명제 핵심): syncBotProtective가 건 거래소 상주 STOP/TP가 거래소에서 발동·체결되면 getOpenOrders에서 사라진다
 *   (OPEN만 반환). 그런데 바이낸스는 reconcileLivePosition을 스킵(getOrderByClientId 보유)하므로, 봇 장부는 그
 *   체결을 **영영 못 잡고** 유령 보유로 남는다(실현손익 미기록 + 다음 신호의 재매도 -2010 루프). '거래소 상주 스톱'이
 *   리스크통제의 핵심 가치인데 그 체결이 장부에 안 잡히면 가치가 무너진다 → 이 함수가 메운다.
 *
 * 동작: 라이브 보유 포지션의 각 protectiveIds cid를 getOrderByClientId로 조회 → filled면 SELL을 멱등 기록
 *   (idempotency_key=botId:prot:cid) + 포지션 차감/정리 + 잔여 leg 취소(고아 방지). 한 틱에 하나만 처리(보통 SL/TP 중 하나).
 * 가드: 라이브 보유(live=true, qty>0) + protectiveIds 존재 + getOrderByClientId 지원(=바이낸스; KR은 미적용).
 * 멱등/fail-closed: cid 기준 멱등키라 재조회해도 no-op. 조회 실패/모호(open/unknown)는 보유 유지(다음 틱 재시도).
 * backtest≡live 영향 없음: 거래소가 실제 발동한 체결을 장부에 사후 반영할 뿐(새 진입/청산 결정 아님).
 */
async function reconcileProtectiveFills(bot: store.BotRow, cur: PaperPosition | null, lastIso: string): Promise<{ position: PaperPosition | null; booked: boolean }> {
  if (!cur || cur.status !== "open" || !(cur.qty > 1e-9) || !cur.live) return { position: cur, booked: false };
  const ids = cur.protectiveIds ?? [];
  if (ids.length === 0) return { position: cur, booked: false };
  const live = liveAdapterFor(bot);
  if (!live) return { position: cur, booked: false };
  const adapter = live.adapter as {
    getOrderByClientId?: (s: string, c: string) => Promise<{ status: "filled" | "pending" | "rejected"; executedQty: number; price: number } | null>;
    cancelOrderByClientId?: (s: string, c: string) => Promise<boolean>;
  };
  const getOrder = adapter.getOrderByClientId?.bind(adapter);
  if (!getOrder) return { position: cur, booked: false }; // KR(키움/한투/토스)은 조회 미지원 → 미적용(거래소 상주 스톱 자체가 없음)

  // 모든 보호 leg 조회 → 체결분 **합산**(적대검증 F3: 다중 leg가 같은 틱에 체결되면 한 다리만 기록하던 break는 나머지 체결분을
  //   유실 → 장부 과대·오버셀 위험). 미체결/조회실패 leg는 분류해 잔존/취소 처리.
  const filledCids: string[] = [];
  let filledQtySum = 0, fillNotional = 0;
  const openCids: string[] = [];     // pending/rejected 등 아직 체결 아님 → 잔여 포지션이면 취소
  const queryFailed: string[] = [];  // 조회 실패 → 상태 불명, 잔존 추적(체결로 오기록 금지, fail-closed)
  for (const cid of ids) {
    let o: Awaited<ReturnType<typeof getOrder>>;
    try { o = await getOrder(bot.symbol, cid); }
    catch (e) { store.insertLog(bot.id, "error", `[${live.env}] 보호주문 체결조회 실패(${cid}: ${e instanceof Error ? e.message : e}) → 상태 불명, 잔존 추적`); queryFailed.push(cid); continue; }
    if (classifyFillStatus(o) === "filled" && o && o.executedQty > 1e-9) {
      filledCids.push(cid);
      const q = o.executedQty;
      filledQtySum += q;
      fillNotional += (o.price > 0 ? o.price : cur.entryAvg) * q;
    } else {
      openCids.push(cid); // 미체결(pending/rejected/not_placed/unknown) — 체결로 보지 않음(fail-closed)
    }
  }
  if (filledCids.length === 0) return { position: cur, booked: false };

  const totalFilled = Math.min(filledQtySum, cur.qty);                              // 포지션 초과 캡(reduceOnly 안전)
  const fillPrice = filledQtySum > 0 ? fillNotional / filledQtySum : cur.entryAvg;  // 수량가중 평균 체결가
  const remainQty = +(cur.qty - totalFilled).toFixed(8);
  const stillOpen = remainQty > 1e-9;

  // 미체결 leg 취소(체결 leg는 이미 소멸). 취소 실패분 + 조회 실패분은 remainIds로 추적(다음 틱 재조회/재시도).
  const remainIds: string[] = [];
  for (const cid of openCids) {
    try { const ok = adapter.cancelOrderByClientId ? await adapter.cancelOrderByClientId(bot.symbol, cid) : false; if (!ok) remainIds.push(cid); }
    catch { remainIds.push(cid); }
  }
  remainIds.push(...queryFailed);

  const pnl = (fillPrice - cur.entryAvg) * totalFilled;
  const next: PaperPosition | null = stillOpen ? { ...cur, qty: remainQty, protectiveIds: remainIds } : null;
  // 체결 기록 + 장부 갱신 원자화(멱등키=체결 cid 정렬조인 → 재조회/크래시 재시도에도 1회만). 중복이면 상태 변경 안 함.
  const idemKey = `${bot.id}:prot:${[...filledCids].sort().join("+")}`;
  const booked = store.tx(() => {
    const t0 = store.insertTrade({ bot_id: bot.id, side: "sell", price: fillPrice, qty: totalFilled, pnl, is_paper: 0, reason: "상주 SL/TP 거래소 체결(reconcile)", idempotency_key: idemKey });
    if (t0) store.setBotPositionState(bot.id, next, true, true);
    return t0;
  });
  if (!booked) return { position: cur, booked: false }; // 이미 기록됨(멱등) → 현 상태 유지(이중 정리 방지)
  audit({ event: "protective_fill_reconciled", botId: bot.id, env: live.env, cids: filledCids, qty: totalFilled, price: fillPrice, pnl, remainQty });
  store.insertLog(bot.id, "sell", `[실거래] 상주 보호주문 거래소 체결 reconcile -${totalFilled} @${fillPrice.toFixed(2)} (pnl=${pnl.toFixed(2)})${stillOpen ? ` — 잔여 ${remainQty} 보유` : " — 청산 완료"}`);
  return { position: next, booked: true };
}

// ── 데몬 측 합성 보호 모니터(거래소 상주 SL/TP 미지원 브로커 = KR). 전략 봉 주기와 분리된 고빈도 스윕이 호출. ──
/** 보호 스윕 주기(ms). 전략 봉 주기와 독립 — 일봉 봇도 초 단위 손절. env로 조정(3~60s 클램프, 기본 10s). */
const PROTECT_SWEEP_MS = (() => { const n = Number(String(process.env.QUANT_PROTECT_SWEEP_MS ?? "").trim()); return Number.isFinite(n) && n >= 3000 && n <= 60000 ? n : 10000; })();
/** 모니터 대상 브로커 — 거래소 상주 보호주문 미지원(KR). 바이낸스는 거래소 상주 SL/TP+#6 reconcile이 보호하므로 제외(이중청산 방지). */
const PROTECT_BROKERS = new Set(["kiwoom", "kis", "toss"]);
/** botId → 마지막 모니터 청산 시각(ms). 같은 봉 내 전략 틱의 재진입(엔진이 보유 원함) 억제용(engine sltpExited 의미를 라이브로 확장). */
const _protectiveExitAt = new Map<string, number>();
/** 보호 알림(best-effort 텔레그램 브로드캐스트, 미설정이면 no-op). fire-and-forget — 거래 비차단. */
function notifyProtective(text: string): void {
  try { const cfg = loadTelegramConfig(); if (cfg) void broadcastTelegram(cfg, text).catch(() => {}); } catch { /* 알림 실패는 거래에 영향 없음 */ }
}
/** 보호 공백(청산 실패) 알림 봇별 쿨다운 — 매 스윕(10s) 반복 스팸 방지. */
const GAP_ALERT_COOLDOWN_MS = 5 * 60_000;
const _lastGapAlertAt = new Map<string, number>();

/**
 * 보호 모니터 청산 — 열린 라이브 포지션이 SL/TP/트레일링 위반 시 **단일 fillOrder 안전경로**로 시장가 청산 + 기록.
 * fail-closed: fillOrder가 live 확정(체결)이 아니면(동결/실패/미확인) 장부 변경 없이 false 반환(다음 스윕 재시도) — 오기록 금지.
 * 기록 패턴은 reconcileProtectiveFills와 동형(tx + insertTrade + setBotPositionState, 멱등키로 1회).
 */
async function protectiveLiquidate(bot: store.BotRow, cur: PaperPosition, price: number, kind: string, level: number | null, env: string): Promise<boolean> {
  const qty = cur.qty;
  const barBucket = Math.floor(Date.now() / (Math.max(15, bot.interval_seconds) * 1000)); // 한 봉 주기당 1회 멱등(중복 청산 방지)
  const r = await fillOrder(bot, "sell", qty, price, bot.symbol, { posLive: true, barIso: new Date().toISOString() });
  if (!r.live) {
    store.insertLog(bot.id, "gate", `보호 모니터 ${kind} 청산 보류 — ${r.note ?? "체결 미확정"}(다음 스윕 재시도)`);
    const lastGap = _lastGapAlertAt.get(bot.id) ?? 0;
    if (Date.now() - lastGap > GAP_ALERT_COOLDOWN_MS) { _lastGapAlertAt.set(bot.id, Date.now()); notifyProtective(`⚠️ 보호 공백 — ${bot.symbol} ${kind} 위반인데 청산 미확정(${r.note ?? "?"}). 거래소 수동 확인 필요.`); }
    return false;
  }
  const fillPrice = r.price > 0 ? r.price : price;
  const filled = Math.min(r.filledQty && r.filledQty > 0 ? r.filledQty : qty, qty);
  const pnl = (fillPrice - cur.entryAvg) * filled;
  const remainQty = +(qty - filled).toFixed(8);
  const stillOpen = remainQty > 1e-9;
  const next: PaperPosition | null = stillOpen ? { ...cur, qty: remainQty } : null;
  const idemKey = `${bot.id}:protectmon:${barBucket}`;
  const booked = store.tx(() => {
    const t0 = store.insertTrade({ bot_id: bot.id, side: "sell", price: fillPrice, qty: filled, pnl, is_paper: 0, reason: `보호 모니터 ${kind} 청산${level != null ? ` (기준 ${level.toFixed(2)})` : ""}`, idempotency_key: idemKey });
    if (t0) store.setBotPositionState(bot.id, next, true, true);
    return t0;
  });
  if (!booked) return false; // 멱등(이미 같은 봉에 모니터 청산 기록) → 이중 정리 방지
  _protectiveExitAt.set(bot.id, Date.now());
  audit({ event: "protective_monitor_exit", botId: bot.id, env, symbol: bot.symbol, kind, price: fillPrice, qty: filled, pnl, level, remainQty });
  store.insertLog(bot.id, "sell", `[실거래] 보호 모니터 ${kind} 청산 -${filled} @${fillPrice.toFixed(2)} (pnl=${pnl.toFixed(2)})${stillOpen ? ` — 잔여 ${remainQty}` : " — 청산 완료"}`);
  notifyProtective(`🛑 보호 모니터 ${kind} 청산 — ${bot.symbol} -${filled} @${fillPrice.toFixed(2)} (pnl ${pnl.toFixed(2)})${stillOpen ? ` · 잔여 ${remainQty}` : ""}`);
  return true;
}

// ── 지정가 진입 대기(pendingEntry) 상태머신 (audit P1-5, binance 라이브 한정) ──
// 신호 봉에 LIMIT 배치 → 매 틱 resolvePendingEntry로 추적: 체결→개시 / 타임아웃→취소+캡게이트 시장가 폴백 / 거절→해제 / 조회실패→유지.
// backtest≡live: 백테 게이트(handlers.backtest)가 동일 worse-of 모델 검증. 라이브 체결가(limit 또는 캡 시장가) ≤ 게이트 모델 → never-optimistic.
// 모든 상태변경은 함수 내부에서 영속(setBotPositionState). 호출측(tickBot)은 hold 반환만.

/** 지정가 체결분으로 포지션 개시(base=null=신규) 또는 base에 가중평균 추가. 매수 분기 개시와 동형(insertTrade+상태 원자화+보호주문). */
async function bookEntryFill(bot: store.BotRow, fillPrice: number, qty: number, lastIso: string, risk: RiskCfg, base: PaperPosition | null, idemSfx: string, reason: string): Promise<{ cur: PaperPosition | null; detail: string }> {
  const baseQty = base && base.status === "open" ? base.qty : 0;
  const newQty = baseQty + qty;
  const entryAvg = newQty > 0 ? (baseQty * (base?.entryAvg ?? fillPrice) + qty * fillPrice) / newQty : fillPrice;
  const openedAt = base?.openedAt ?? new Date().toISOString();
  const peakPrice = Math.max(base?.peakPrice ?? entryAvg, fillPrice);
  const t = store.tx(() => {
    const t0 = store.insertTrade({ bot_id: bot.id, side: "buy", price: fillPrice, qty, pnl: 0, is_paper: 0, reason, idempotency_key: `${bot.id}:${lastIso}:${idemSfx}` });
    if (t0) store.setBotPositionState(bot.id, { status: "open", entryAvg, qty: newQty, openedAt, live: true, peakPrice, protectiveIds: base?.protectiveIds ?? [], protFails: base?.protFails ?? 0 } satisfies PaperPosition, true, true);
    return t0;
  });
  if (!t) return { cur: base, detail: "지정가 체결 기록 중복 스킵" };
  const ps = await syncBotProtective(bot, true, bot.symbol, newQty, entryAvg, peakPrice, risk, base?.protectiveIds ?? []);
  const protFails = nextProtFails(base?.protFails, ps, (risk.stopLossPercent != null || risk.trailingStopPercent != null));
  if (ps.failed > 0) noteProtectiveFailure(bot.id, protFails);
  const opened: PaperPosition = { status: "open", entryAvg, qty: newQty, openedAt, live: true, peakPrice, protectiveIds: ps.ids, protFails };
  store.setBotPositionState(bot.id, opened, true, true);
  store.insertLog(bot.id, "buy", `[실거래] ${reason} +${qty} → 보유 ${newQty} @${fillPrice}(평단 ${entryAvg.toFixed(2)})`);
  return { cur: opened, detail: `${reason} +${qty}(보유 ${newQty})` };
}

/** 지정가 타임아웃 시장가 폴백: 캡 게이트(현재가 vs 지정가) 통과 시에만 시장가 — 초과면 freeze(주문 안 냄, 잔량 드롭). base=부분체결 포지션(없으면 null). */
async function fillMarketFallback(bot: store.BotRow, remaining: number, limitPrice: number, maxSlippagePct: number, lastIso: string, risk: RiskCfg, base: PaperPosition | null): Promise<{ cur: PaperPosition | null; detail: string }> {
  const live = liveAdapterFor(bot);
  const adapter = live?.adapter;
  let quote = Number.POSITIVE_INFINITY; // 조회 실패 시 캡 통과 불가(보수적 freeze)
  try { if (adapter?.getPrice) { const p = await adapter.getPrice(bot.symbol); if (p.price > 0) quote = p.price; } } catch { /* quote=Inf 유지 */ }
  const cap = checkSlippageCap(limitPrice, quote, maxSlippagePct);
  if (!cap.ok) {
    audit({ event: "entry_slippage_cap_exceeded", botId: bot.id, limitPrice, quote: Number.isFinite(quote) ? quote : -1, deviationPct: Number.isFinite(cap.deviationPct) ? +cap.deviationPct.toFixed(3) : -1, cap: maxSlippagePct });
    store.insertLog(bot.id, "gate", `지정가 타임아웃 시장가 폴백 차단 — 슬리피지 ${Number.isFinite(cap.deviationPct) ? cap.deviationPct.toFixed(2) : "∞"}% > 캡 ${maxSlippagePct}%(잔량 ${remaining} 드롭, 다음 틱 재신호)`);
    if (!base) store.setBotPositionState(bot.id, null, true, false); // 부분체결 없음 → flat(대기 해제)
    return { cur: base, detail: `지정가 캡 초과 freeze(잔량 ${remaining} 드롭)` };
  }
  const fb = await fillOrder(bot, "buy", remaining, quote, bot.symbol, { posLive: true, barIso: lastIso }); // 시장가(entry 생략). cid=타임아웃봉 기준→placement cid와 구분.
  if (fb.failed || !fb.live) {
    store.insertLog(bot.id, "gate", `지정가 타임아웃 시장가 폴백 미체결(${fb.note}) — 잔량 ${remaining}(다음 틱)`);
    if (!base) store.setBotPositionState(bot.id, null, true, false);
    return { cur: base, detail: `시장가 폴백 미체결(${fb.note})` };
  }
  const gotQty = fb.filledQty && fb.filledQty > 0 ? fb.filledQty : remaining;
  return bookEntryFill(bot, fb.price, gotQty, lastIso, risk, base, "limitfallback", "지정가 타임아웃 시장가 폴백");
}

/** 지정가 진입 대기 해소. tickBot 최상단에서 신호평가·reconcile보다 먼저 호출(한 틱 1상태변경, reconcile와 배타). */
async function resolvePendingEntry(bot: store.BotRow, cur: PaperPosition, lastIso: string, risk: RiskCfg): Promise<{ cur: PaperPosition | null; detail: string }> {
  const pe = cur.pendingEntry!;
  const live = liveAdapterFor(bot);
  if (!live) { store.setBotPositionState(bot.id, cur, true, false); return { cur, detail: "지정가 대기 — 게이트 미통과(다음 틱)" }; }
  const adapter = live.adapter;
  const getOrder = adapter.getOrderByClientId?.bind(adapter);
  if (!getOrder) { store.setBotPositionState(bot.id, cur, true, false); return { cur, detail: "지정가 대기 — 조회 미지원(다음 틱)" }; }
  let o: Awaited<ReturnType<typeof getOrder>>;
  try { o = await getOrder(bot.symbol, pe.cid); }
  catch (e) { store.insertLog(bot.id, "gate", `[${live.env}] 지정가 조회 실패(${e instanceof Error ? e.message : e}) → 대기 유지(cid 멱등, 다음 틱)`); store.setBotPositionState(bot.id, cur, true, false); return { cur, detail: "지정가 조회 실패 — 대기 유지" }; }
  const verdict = classifyFillStatus(o);
  if (verdict === "filled") {
    const fillPrice = (o?.price && o.price > 0) ? o.price : pe.limitPrice;
    const filledQty = (o?.executedQty && o.executedQty > 0) ? o.executedQty : ((o?.quantity && o.quantity > 0) ? o.quantity : pe.origQty);
    audit({ event: "limit_entry_filled", botId: bot.id, env: live.env, fillPrice, filledQty });
    return bookEntryFill(bot, fillPrice, filledQty, lastIso, risk, null, "limitfill", "지정가 진입 체결");
  }
  if (verdict === "rejected") { // CANCELED/REJECTED/EXPIRED = 거래소 명시 종료 → 즉시 해제(재평가)
    store.insertLog(bot.id, "gate", `[${live.env}] 지정가 주문 거절/취소(rejected) → 대기 해제(다음 틱 재평가)`);
    store.setBotPositionState(bot.id, null, true, false);
    return { cur: null, detail: "지정가 거절/취소 — 대기 해제" };
  }
  // open / not_placed / unknown = 미확정. ⚠️ testnet 실측: 방금 낸 주문이 인덱싱 지연으로 조회 1회 null(not_placed) 가능 →
  //   즉시 해제하면 유령 주문 발생. '미확정'은 타임아웃 봉까지 유지(틱 간격이 인덱싱 지연 흡수) → 타임아웃 시 취소+캡게이트 시장가 폴백.
  const elapsed = elapsedClosedBars(pe.placedBarIso, lastIso, Math.max(1, bot.interval_seconds) * 1000);
  if (elapsed < pe.timeoutBars) { store.setBotPositionState(bot.id, cur, true, false); return { cur, detail: `지정가 대기(${elapsed}/${pe.timeoutBars}봉, ${verdict})` }; }
  // 타임아웃 → 취소 + (부분체결 개시) + 잔량 캡게이트 시장가 폴백.
  if (adapter.cancelOrderByClientId) { try { await adapter.cancelOrderByClientId(bot.symbol, pe.cid); } catch (e) { store.insertLog(bot.id, "gate", `지정가 취소 실패(${e instanceof Error ? e.message : e}) — 폴백 진행`); } }
  let executed = 0;
  try { const re = await getOrder(bot.symbol, pe.cid); executed = (re?.executedQty && re.executedQty > 0) ? re.executedQty : 0; } catch { /* 재조회 실패 → 보수적 executed=0 */ }
  audit({ event: "limit_entry_timeout", botId: bot.id, env: live.env, executed, origQty: pe.origQty });
  let base: PaperPosition | null = null;
  if (executed > 1e-9) base = (await bookEntryFill(bot, pe.limitPrice, executed, lastIso, risk, null, "limitpartial", "지정가 부분체결")).cur;
  const remaining = Math.max(0, pe.origQty - executed);
  if (remaining <= 1e-9) { if (!base) store.setBotPositionState(bot.id, null, true, false); return { cur: base, detail: `지정가 타임아웃 — 체결 ${executed}` }; }
  return fillMarketFallback(bot, remaining, pe.limitPrice, pe.maxSlippagePct, lastIso, risk, base);
}

/**
 * #5 신규 진입 결과불명 해소(바이낸스 라이브 한정). 시장가 진입 placeOrder가 unknown으로 끝난 뒤, 주문이 거래소에
 * 실렸는지를 거래소 실보유(getPositions)로 확인한다. tickBot 최상단에서 pendingEntry 다음, 신호평가·reconcile보다 먼저 호출.
 *
 * - 거래소에 보유 발견(adopt): 내 주문이 실린 것 → **의도수량(intendedQty) 한도**로 입양(수동보유 초과분 미입양 = 오입양 방지).
 *   BUY를 멱등 기록(placedBarIso 기준) + 포지션 확정 + 상주 보호주문 배치. 마커 제거 → 정상 운용 복귀.
 * - 거래소 부재(no_exchange_pos): 주문이 안 실렸을 가능성. RECON_CLEAR_MISSES틱 연속 부재면 마커 해제(재진입 허용),
 *   그 전엔 마커 유지(재진입 억제 = 바 롤오버 이중매수 차단). 조회 실패/게이트 미통과는 마커 유지(보수).
 * 멱등/fail-closed: 의도수량 한도 캡 → 절대 과입양 없음. 미해소 동안 tickBot이 hold 반환(신규 매수 0).
 * backtest 무관(라이브 전용 네트워크 실패 복구) — backtest≡live 영향 없음.
 */
async function resolveUnknownEntry(bot: store.BotRow, cur: PaperPosition, lastIso: string, price: number, risk: RiskCfg): Promise<PaperPosition | null> {
  const pue = cur.pendingUnknownEntry!;
  const live = liveAdapterFor(bot);
  if (!live) { store.setBotPositionState(bot.id, cur, true, false); return cur; } // 게이트 미통과 → 유지(다음 틱)
  const adapter = live.adapter as { getPositions?: () => Promise<ExchangePos[]> };
  if (typeof adapter.getPositions !== "function") { store.setBotPositionState(bot.id, null, true, false); return null; } // 조회 불가 어댑터 → 마커만 해제(보수: 억제 무한지속 금지)
  let exPos: ExchangePos[];
  try { exPos = await getReconcilePositions(bot.broker, live.env, () => (adapter.getPositions as () => Promise<ExchangePos[]>)()); }
  catch (e) {
    // 적대검증 F9: 조회 실패(rate-limit/broker down)도 '미확인'으로 카운트 → 무한 억제 금지. 임계 연속 실패 시 마커 해제.
    const m = (pue.misses ?? 0) + 1;
    if (m >= RECON_CLEAR_MISSES) {
      store.setBotPositionState(bot.id, null, true, false);
      store.insertLog(bot.id, "error", `[${live.env}] 진입 결과불명 조회 ${RECON_CLEAR_MISSES}회 연속 실패(${e instanceof Error ? e.message : e}) → 마커 해제(재진입 허용, 무한 억제 금지)`);
      return null;
    }
    const kept: PaperPosition = { ...cur, pendingUnknownEntry: { ...pue, misses: m } };
    store.setBotPositionState(bot.id, kept, true, false);
    store.insertLog(bot.id, "error", `[${live.env}] 진입 결과불명 조회 실패(${m}/${RECON_CLEAR_MISSES}, ${e instanceof Error ? e.message : e}) → 마커 유지`);
    return kept;
  }
  let rec = reconcilePositionFromExchange(null, exPos, bot.symbol);
  if (rec.action === "no_exchange_pos" && bot.broker === "binance") rec = reconcilePositionFromExchange(null, exPos, baseAsset(bot.symbol));

  // 적대검증 F8: 같은 심볼 다중 포지션 매칭(ambiguous)이면 봇 귀속 모호(수동/타봇 혼재 가능) → 입양 거부(fail-closed).
  //   아래 misses 누적 경로로 빠져 결국 마커 해제. (1봇1심볼 가정 — reconcilePositionFromExchange와 동일 전제.)
  if (rec.action === "adopt" && rec.ambiguous) {
    store.insertLog(bot.id, "gate", `[${live.env}] 진입 결과불명 입양 보류: ${bot.symbol} 거래소 다중 포지션(모호) — 오입양 방지`);
  }
  if (rec.action === "adopt" && !rec.ambiguous && rec.next && rec.next.qty > 1e-9) {
    const adoptQty = Math.min(rec.next.qty, pue.intendedQty); // 의도수량 한도 — 수동보유 초과분은 미입양(오입양 방지)
    if (adoptQty > 1e-9) {
      const entryAvg = rec.next.entryAvg > 0 ? rec.next.entryAvg : (price > 0 ? price : 0);
      const openedAt = cur.openedAt ?? new Date().toISOString();
      const peakPrice = Math.max(entryAvg, price);
      // 체결 기록 + 포지션 확정 원자화(멱등키=placedBarIso → 재시도/크래시에도 1회). 마커 제거.
      const booked = store.tx(() => {
        const t0 = store.insertTrade({ bot_id: bot.id, side: "buy", price: entryAvg, qty: adoptQty, pnl: 0, is_paper: 0, reason: "신규 진입 결과불명 → 거래소 reconcile 입양", idempotency_key: `${bot.id}:${pue.placedBarIso}:unkadopt` });
        if (t0) store.setBotPositionState(bot.id, { status: "open", entryAvg, qty: adoptQty, openedAt, live: true, peakPrice, protectiveIds: [], protFails: 0 } satisfies PaperPosition, true, true);
        return t0;
      });
      if (!booked) {
        // 멱등 중복(이미 입양됨) — 적대검증 F1/F7: 현재 거래소 qty로 덮으면 장부≠포지션 발산·나체 위험.
        //   **장부 진실(liveOpenLedger)**로 포지션 재구성해 trades≡position_state 보장. 마커 제거.
        const led = store.liveOpenLedger(bot.id);
        if (led.qty > 1e-9) {
          const adopted: PaperPosition = { status: "open", entryAvg: led.avgPrice, qty: led.qty, openedAt, live: true, peakPrice: Math.max(led.avgPrice, price), protectiveIds: cur.protectiveIds ?? [], protFails: cur.protFails ?? 0 };
          store.setBotPositionState(bot.id, adopted, true, false);
          return adopted;
        }
        store.setBotPositionState(bot.id, null, true, false); // 장부도 0 → 마커만 해제(유령 없음)
        return null;
      }
      const ps = await syncBotProtective(bot, true, bot.symbol, adoptQty, entryAvg, peakPrice, risk, []);
      const protFails = nextProtFails(0, ps, (risk.stopLossPercent != null || risk.trailingStopPercent != null));
      if (ps.failed > 0) noteProtectiveFailure(bot.id, protFails);
      const adopted: PaperPosition = { status: "open", entryAvg, qty: adoptQty, openedAt, live: true, peakPrice, protectiveIds: ps.ids, protFails };
      store.setBotPositionState(bot.id, adopted, true, true);
      audit({ event: "unknown_entry_adopted", botId: bot.id, env: live.env, qty: adoptQty, entryAvg, intendedQty: pue.intendedQty });
      store.insertLog(bot.id, "buy", `[실거래] 신규 진입 결과불명 → 거래소 보유 ${rec.next.qty} 확인, 의도 ${pue.intendedQty} 한도로 ${adoptQty} 입양 @${entryAvg}(상주 스톱 배치)`);
      return adopted;
    }
  }
  // 거래소 부재 → 주문 미발행 가능성. 연속 부재 누적 후 해제(그 전엔 재진입 억제 유지).
  const misses = (pue.misses ?? 0) + 1;
  if (misses >= RECON_CLEAR_MISSES) {
    store.setBotPositionState(bot.id, null, true, false);
    audit({ event: "unknown_entry_cleared", botId: bot.id, env: live.env, misses, intendedQty: pue.intendedQty });
    store.insertLog(bot.id, "gate", `[${live.env}] 신규 진입 결과불명: 거래소 ${RECON_CLEAR_MISSES}틱 연속 부재 → 주문 미발행 판정, 마커 해제(재진입 허용)`);
    return null;
  }
  const next: PaperPosition = { ...cur, pendingUnknownEntry: { ...pue, misses } };
  store.setBotPositionState(bot.id, next, true, false);
  store.insertLog(bot.id, "gate", `[${live.env}] 신규 진입 결과불명: 거래소 부재(${misses}/${RECON_CLEAR_MISSES}틱) — 재진입 억제 유지(지연반영 가능성)`);
  return next;
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
  // 지정가 브래킷 봇: 가격기반 주문관리(인디케이터 엔진/캔들 미사용). 장 열릴 때마다 미체결 지정가 재주문 → 체결 시 매도.
  if ((comp.root_node as { type?: string })?.type === "limit_bracket") {
    return tickLimitBracket(bot, comp.root_node as LimitBracketNode);
  }

  // 개장시간 게이트(Task #4): 일반 전략봇도 장중에만 평가/주문. binance=24/7(항상 open), KR/US(토스·키움·한투)는
  //  장마감·장외·주말엔 skip(hold) → '개장 시점 매매' 의미 보존 + 장외 주문시도·거부 로그 폭주 방지. limit_bracket
  //  봇은 이미 isMarketOpen 사용 — 일관화. KR/US는 장외 체결 자체가 없어 장외 전체-틱 skip 이 안전.
  //  ★opt-in(default OFF, QUANT_TICKBOT_MARKET_GATE=1) + 라이브 봇 한정 — 라이브 전환(go-live, #6 enableLive)에서
  //   켠다. 페이퍼/테스트(mode!=live 또는 env 미설정)는 미적용 → 무회귀. 휴장일 미반영은 거래소 거부 fail-safe.
  if (process.env.QUANT_TICKBOT_MARKET_GATE === "1" && bot.mode === "live" && !isMarketOpen(bot.broker as Broker, new Date(), bot.symbol)) {
    return { action: "hold", detail: "장 마감(개장시간 외) — 라이브 평가/주문 skip" };
  }

  const interval = secsToInterval(bot.interval_seconds); // 폴링 주기 → kline 타임프레임(인트라데이 자동). 시간대 조건 해금.
  // 데이터 소스 broker-aware: 크립토=Binance public klines, KR(키움/한투)=브로커 어댑터 getCandles(일봉).
  //   KR 종목코드는 Binance에 없으므로 어댑터에서 OHLCV를 가져와야 지표 평가 가능(없으면 빈 배열→데이터부족 hold).
  const dataBroker = (["binance", "kis", "kiwoom", "toss"].includes(bot.broker) ? bot.broker : "binance") as Broker;
  let fetched: Bar[];
  if (dataBroker === "binance") {
    fetched = await fetchKlines(bot.symbol, interval, 300);
  } else if (dataBroker === "kiwoom" || dataBroker === "toss") {
    const da = getAdapter(dataBroker, "spot")?.adapter as { getCandles?: (s: string, i: string, c: number) => Promise<Bar[]> } | undefined;
    try {
      fetched = da?.getCandles ? await da.getCandles(bot.symbol, interval, 300) : [];
    } catch (e) {
      // getCandles throw(예: 토스는 1m/1d만 지원 → 그 외 인터벌은 매 틱 throw)이 Runner.run의 generic catch까지
      // 흘러 '러닝인데 평가 불가'한 유령봇이 되는 것을 차단(적대검증 #12): 명시 로그 + hold. create_bot에서도 사전 거절.
      store.insertLog(botId, "error", `${dataBroker} 캔들 조회 실패(${interval}) — ${e instanceof Error ? e.message : e}${dataBroker === "toss" ? " (토스는 1m/1d만 지원)" : ""}. 평가 보류.`);
      store.setBotPositionState(botId, bot.position_state);
      return { action: "hold", detail: `${dataBroker} 캔들 조회 실패 — 평가 보류` };
    }
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
  //   crypto=24/7 엄격 연속, KR=중앙값 기반(주말/공휴일 갭 허용). 백테스트 핸들러도 fetchKlinesChecked로 동일 검증(handlers.ts) → 간극 시 양쪽 거부(패리티 보존, audit P1-22-02).
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
  // SL 체결 모델(audit P1-12 후속): gapHandling='worst' 고정 — 갭/플래시크래시 시 거래소 상주스톱(또는 KR 소프트스톱)은 봉 저가
  //   터치로 발동·시가 체결한다. 'close'(엔진 기본=낙관)면 러너 내부 시뮬이 라이브보다 낙관적(SL 미발동)이라 OOS/DSR 게이트가
  //   승인한 전략을 라이브에서 더 후하게 운용 → never-more-optimistic 위반. 게이트(handlers backtest/optimize)도 기본 'worst'로 맞춤.
  //   slippage도 명시(게이트 기본과 동일 0.05% — 드리프트 방지).
  const cfg: BacktestConfig = { strategyId: "runner", symbol: bot.symbol, startDate: data[0].date, endDate: data[data.length - 1].date, initialCapital: bot.capital, commission: 0.1, timeframe: interval, auxSeries, mtfSeries, mtfRegimeSeries, eventCalendars, riskSizing: comp.risk_sizing as BacktestConfig["riskSizing"], gapHandling: "worst", slippage: 0.05 };
  const risk = {
    stopLossPercent: comp.stop_loss_percent, takeProfitPercent: comp.take_profit_percent,
    tpLadder: comp.tp_ladder as never, scaleIn: comp.scale_in as never, pyramid: comp.pyramid as never,
    trailingStopPercent: comp.trailing_stop_percent,
  };
  const res = runCompositeBacktest(root, data as unknown as Parameters<typeof runCompositeBacktest>[1], cfg, 0, risk);
  let want = derivePosition(res.trades);
  let cur = bot.position_state as PaperPosition | null;
  const lastIso = data[data.length - 1].datetime;

  // 보호 모니터가 같은 봉 내 이 포지션을 청산했다면, 엔진(봉마감 평가)이 여전히 보유를 원해도 같은 봉 재진입을 억제한다
  //   (engine sltpExited "같은 봉 stop→재매수 금지"의 라이브 확장). 다음 봉부터 정상 신호 복귀. gapHandling='worst'로 보통
  //   다음 봉 엔진이 봉저가로 SL을 인지해 자연 일치하나, 데이터 granularity 차로 어긋나는 좁은 엣지를 막는 안전벨트.
  const _pExit = _protectiveExitAt.get(botId);
  if (_pExit && Date.now() - _pExit < Math.max(15, bot.interval_seconds) * 1000) {
    const _curQty = cur && cur.status === "open" ? cur.qty : 0;
    if (want.holding && _curQty <= 1e-9) {
      store.insertLog(botId, "gate", "보호 모니터 청산 직후 동일봉 재진입 억제 — 다음 봉 평가");
      store.setBotPositionState(botId, cur);
      return { action: "hold", detail: "보호 청산 후 동일봉 재진입 억제" };
    }
  }

  // 지정가 진입 대기 해소(audit P1-5 Q7): pendingEntry 있으면 최우선 처리(신호평가·reconcile보다 먼저). 체결→개시 /
  //   타임아웃→캡게이트 시장가 폴백 / 거절→해제. 대기 중이면 hold 반환 → bootSeed/reconcile/신호 전부 스킵(이중입양 방지).
  if (cur?.pendingEntry) {
    const peRisk: RiskCfg = { stopLossPercent: comp?.stop_loss_percent, takeProfitPercent: comp?.take_profit_percent, trailingStopPercent: comp?.trailing_stop_percent };
    const pr = await resolvePendingEntry(bot, cur, lastIso, peRisk);
    return { action: "hold", detail: pr.detail };
  }
  // #5 신규 진입 결과불명 해소(pendingEntry 다음 최우선). 미해소면 hold(재진입 억제=이중매수 차단). 해소(입양/해제) 시 계속 진행.
  if (cur?.pendingUnknownEntry) {
    cur = await resolveUnknownEntry(bot, cur, lastIso, price, risk);
    if (cur?.pendingUnknownEntry) return { action: "hold", detail: "신규 진입 결과불명 — 거래소 reconcile 회수 대기(재진입 억제)" };
    // 입양됐으면 cur=실포지션(아래 신호평가가 운용), 해제됐으면 cur=null(재평가). 둘 다 정상 진행.
  }

  // ── P0-4 체결 reconcile(라이브 전용, 신호평가 전): 키움/KIS는 주문 시점 체결확인 불가(getOrderByClientId 미지원)
  //    → 매수 시장가가 pending+price0로 동결(fail-closed)된 뒤 거래소가 지연체결하면 거래소엔 실보유·장부엔 0(역방향
  //    발산). 틱 시작 시 거래소 실보유(getPositions)를 조회해 봇 장부를 거래소 진실로 동기화한다. 이후 curQty/델타가
  //    정정된 cur를 본다. 가드 술어가 'mode=live + 게이트통과 + getOrderByClientId 미지원'으로 좁아 바이낸스(지원)·
  //    페이퍼(mode!=live)·게이트OFF는 미진입 → getPositions 미호출 → 거동·오버헤드 0(회귀 0). 스캐너 경로는 별도(아래).
  cur = await bootSeedLivePosition(bot, cur); // P0-1: 재시작 첫 틱 1회, 게이트 무관 read-only 복원
  cur = await reconcileLivePosition(bot, cur, lastIso);
  // P1-2: 주문 결과불명(unknown)이 임계 누적 → 강제 getPositions reconcile(바이낸스 가드 우회)로 1회 수렴.
  //   reconcileLivePosition(KR 전용)이 못 덮는 바이낸스 발산을 보완. 스캐너는 별도 경로(여기 미도달).
  if ((cur?.unknownCount ?? 0) >= UNKNOWN_MAX_COUNT) cur = await forceReconcileOnUnknown(bot, cur);
  // #6: 거래소 상주 SL/TP가 거래소에서 체결됐는지 확인해 장부에 사후 기록(바이낸스 라이브 한정, 신호평가 전).
  //   바이낸스는 위 reconcile들이 스킵하므로 상주 스톱 체결을 여기서만 잡는다. KR은 상주 스톱 미지원이라 no-op.
  const pfill = await reconcileProtectiveFills(bot, cur, lastIso);
  cur = pfill.position;
  if (pfill.booked) {
    // 적대검증 F4: 상주 보호주문이 이번 봉에 체결됐으면 같은 봉 재진입/재매매 금지(백테 sltpExited 미러 — 백테는 SL/TP
    //   청산 봉에 재진입 안 함). 다음 틱(다음 봉)에 재평가. 잔여 보유분 보호주문은 다음 틱 hold 경로가 재배치.
    return { action: "sell", detail: "상주 보호주문 거래소 체결 — 같은 봉 청산(재진입은 다음 틱)" };
  }

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

  // (B) 윈도우 안전장치(P0-5 interim, audit 적대검증 #9): 엔진은 매 호출 flat에서 300봉 윈도우만 재시뮬한다.
  //   진입 봉이 윈도우 밖으로 밀린 장기보유 포지션은 엔진이 진입을 못 봐 넷을 잘못 산출 → (a) 윈도우 안에 우연히
  //   buy+exit 사이클이 있으면 넷=0을 '청산'으로 오인해 전량 덤핑, (b) 라더로 줄였던 포지션을 풀 자본 재진입으로
  //   오인해 초과 재매수. 두 경우 모두 res.trades.length>0이라 기존 'trades===0' 가드로는 못 막았다(엔진은 항상
  //   flat에서 시작하므로 'first action=buy' 같은 휴리스틱은 무용 — 진입봉이 윈도우 안이어도 참).
  //   → 진입시각(openedAt)이 윈도우의 가장 오래된 봉보다 앞서면(=진입봉 스크롤아웃) 엔진 넷을 신뢰하지 않고 보유
  //   유지: 전략신호 청산·라더 델타는 보류하되, SL/TP는 거래소 상주 스톱이 계속 보호한다(fail-closed=의심 시 보유).
  //   진입봉이 윈도우 안에 들어올 때만 청산/델타 반영(엔진이 진입을 봐 backtest≡live). 근본해결=엔진 포지션 시드(P0-5 후속).
  const oldestBarMs = data.length ? Date.parse(data[0].datetime) : NaN;
  // openedAt(체결=벽시계)은 진입 봉이 '닫힌 뒤'(≈다음 봉 오픈)에 기록되므로 entryBar.open ≈ openedAt − 1봉(intervalMs).
  //   진입봉 open < oldestBar(윈도우 첫 봉) 이면 스크롤아웃. ⚠️ 적대검증 #9: 종전 `openedAt < oldestBar` 직접비교는
  //   off-by-one(openedAt≈oldestBar+ε)으로 진입봉이 막 윈도우를 벗어난 '첫 틱'을 놓쳐 그 1틱 동안 오청산이 가능했다.
  //   intervalMs 보정으로 진입봉이 벗어나는 즉시 가드 발동.
  const intervalMs = Math.max(1, bot.interval_seconds) * 1000;
  const openedMs = cur?.openedAt ? Date.parse(cur.openedAt) : NaN;
  const entryScrolledOut = Number.isFinite(openedMs) && Number.isFinite(oldestBarMs) && (openedMs - intervalMs) < oldestBarMs;
  // P0-5 근본해결: 진입봉 스크롤아웃 + 단순 SL/TP 경로(라더/스케일인/피라미딩 아님)면 엔진을 라이브 포지션으로 시드 재실행 →
  //   want가 청산/보유를 정확히 산출(엔진이 '이미 보유 중'으로 봐 backtest≡live). 보수적 hold(아래)는 라더류·in-window 무신호에만.
  const tpL = comp.tp_ladder as { length?: number } | null;
  const scI = comp.scale_in as { ladder?: unknown[] } | null;
  const pyr = comp.pyramid as { ladder?: unknown[] } | null;
  const simplePath = !(tpL && (tpL.length ?? 0) > 0) && !((scI?.ladder?.length ?? 0) > 0) && !((pyr?.ladder?.length ?? 0) > 0);
  if (curQty > 1e-9 && entryScrolledOut && simplePath && cur) {
    const seededRes = runCompositeBacktest(root, data as unknown as Parameters<typeof runCompositeBacktest>[1], cfg, 0, risk, { position: curQty, avgEntryPrice: cur.entryAvg });
    want = derivePosition(seededRes.trades, { qty: curQty, entryAvg: cur.entryAvg });
    store.insertLog(botId, "gate", `[P0-5] 진입봉 스크롤아웃 → 엔진 포지션 시드 재평가: ${want.holding ? `보유 유지 ${want.qty}` : "청산 신호"}`);
    // early-return 하지 않고 아래 정상 델타 경로로 진행(want가 청산이면 매도, 보유면 hold).
  } else if (curQty > 1e-9 && (res.trades.length === 0 || entryScrolledOut)) {
    // 보유 유지하되 트레일링/protFails는 계속 갱신: 고정 SL뿐 아니라 '트레일링 스탑'도 고점 추종(래칫업)해야 한다.
    //   ⚠️ 적대검증 #9 후속: 종전 bare hold(early-return)는 하단 트레일링 재동기화(line~1007) 도달을 막아 장기보유 동안
    //   트레일링이 마지막 값에 동결(고정스탑 퇴화)되고 protFails 감지도 멈췄다 — 무음 리스크통제 저하. 여기서 직접 재동기화.
    const why = res.trades.length === 0 ? "윈도우 내 신호 없음" : "진입봉 윈도우 밖(스크롤아웃) — 엔진 넷 신뢰 보류";
    if (curLive && cur) {
      const peakPrice = Math.max(cur.peakPrice ?? cur.entryAvg, price);
      const ps = await syncBotProtective(bot, curLive, bot.symbol, curQty, cur.entryAvg, peakPrice, risk, cur.protectiveIds ?? []);
      const pf = nextProtFails(cur.protFails, ps, (risk.stopLossPercent != null || risk.trailingStopPercent != null));
      if (ps.failed > 0) noteProtectiveFailure(botId, pf);
      store.setBotPositionState(botId, { ...cur, peakPrice, protectiveIds: ps.ids, protFails: pf });
    } else {
      store.setBotPositionState(botId, cur);
    }
    return { action: "hold", detail: `보유 유지 ${curQty} @ ${price}(${why}, 트레일링/상주 스톱 갱신)` };
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
    // 지정가 진입(audit P1-5): 신규 진입(curQty 0·추가매수 아님) + binance + entry_execution.type==='limit'일 때만 LIMIT.
    //   스케일인/피라미딩(추가매수)·KR·스캐너는 시장가 유지(단순·안전). 게이트는 시장가와 동일(liveGate/캡/사이징).
    const ee = bot.broker === "binance" ? (comp?.entry_execution as EntryExecution | null | undefined) : undefined;
    const useLimit = curQty < 1e-9 && !plan.partial && ee?.type === "limit";
    const entryPlan: EntryExecPlan | undefined = useLimit && ee
      ? { type: "limit", limitPrice: computeLimitPrice(price, ee.limitOffsetPct ?? 0), timeoutBars: clampTimeoutBars(ee.timeoutBars), maxSlippagePct: clampMaxSlippagePct(ee.maxSlippagePct) }
      : undefined;
    // 신규 진입 또는 추가매수(스케일인/피라미딩). entryAvg는 엔진 가중평단(want.entryAvg)으로 갱신.
    //   채널: 신규 진입=미정(undefined → 라이브 시도, 명확실패만 페이퍼) / 추가매수=기존 포지션 채널 고정.
    const fill = await fillOrder(bot, "buy", buyQty, price, bot.symbol, { posLive: curQty > 1e-9 ? curLive : undefined, barIso: lastIso, entry: entryPlan });
    // 지정가 접수(호가 등록) → pendingEntry 영속 + hold. 다음 틱부터 resolvePendingEntry가 체결/타임아웃 추적(크래시 생존, cid 멱등).
    if (fill.pending && fill.cid && fill.limitPrice != null && entryPlan?.type === "limit") {
      const marker: PaperPosition = { status: "open", entryAvg: 0, qty: 0, openedAt: cur?.openedAt ?? new Date().toISOString(), live: false,
        pendingEntry: { cid: fill.cid, limitPrice: fill.limitPrice, origQty: buyQty, filledQty: 0, placedBarIso: lastIso, timeoutBars: entryPlan.timeoutBars, maxSlippagePct: entryPlan.maxSlippagePct } };
      store.setBotPositionState(botId, marker, true, false);
      store.insertLog(botId, "gate", `[지정가] 진입 호가 등록 @${fill.limitPrice}(${entryPlan.timeoutBars}봉 타임아웃, 캡 ${entryPlan.maxSlippagePct}%) — 체결 대기`);
      return { action: "hold", detail: `지정가 진입 대기 @${fill.limitPrice}` };
    }
    if (fill.failed) {
      // #5 신규 진입 결과불명(unknown): 주문이 거래소에 실렸을 수 있다(유령) → 재진입 억제 마커 영속.
      //   다음 틱 resolveUnknownEntry가 거래소 실보유를 의도수량 한도로 입양(실림) 또는 N틱 부재 시 해제(안 실림).
      //   바이낸스 라이브 신규 진입(curQty 0·추가매수 아님)에만 — 추가매수/KR/페이퍼는 종전대로 동결.
      if (fill.unknown && curQty < 1e-9 && !plan.partial && bot.broker === "binance") {
        const marker: PaperPosition = { status: "open", entryAvg: 0, qty: 0, openedAt: cur?.openedAt ?? new Date().toISOString(), live: false, pendingUnknownEntry: { intendedQty: buyQty, placedBarIso: lastIso, misses: 0 } };
        store.setBotPositionState(botId, marker, true, false);
        store.insertLog(botId, "error", `신규 진입 결과불명(${fill.note}) → 재진입 억제 + 다음 틱 거래소 reconcile 회수 대기(의도 ${buyQty})`);
        return { action: "hold", detail: `진입 결과불명 — reconcile 회수 대기(${fill.note})` };
      }
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
      // P1-2: 결과불명(unknown)이면 누적 카운트 — 임계 도달 시 다음 틱에 강제 reconcile로 수렴(보유 장부에만 기록 가능).
      const frozen: PaperPosition | null = fill.unknown && cur && cur.status === "open" ? { ...cur, unknownCount: (cur.unknownCount ?? 0) + 1 } : cur;
      if (fill.unknown && frozen && frozen !== cur) { store.insertLog(botId, "error", `매도 결과불명 누적 ${frozen.unknownCount}/${UNKNOWN_MAX_COUNT} — 임계 시 강제 reconcile`); audit({ event: "fill_unknown_accumulated", botId, count: frozen.unknownCount }); }
      store.setBotPositionState(botId, frozen);
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
 * 보호주문 연속실패 카운터 갱신(audit P1-4/P1-9). 비상 청산(line 810)은 **손절(SL) 보호 부재 = 나체 포지션**만
 * 대상이다(TP는 이익실현이지 리스크 통제가 아님). 따라서 이 카운터도 SL leg 실패만 누적해야 한다.
 *  - SL leg 실패 + 손절 설정 → 즉시 한도(다음 틱 비상): 'SL 없는 나체'를 3틱 들고 있지 않는다(원동작 유지).
 *  - SL은 정상/이미 상주인데 **다른 leg(TP)만 실패** → 나체가 아니다 → 카운터 0(비상 금지).
 *    ⚠️ 버그 수정(적대검증): 종전 `prev+1` 누적은, 현물(spot)에서 SL+TP를 동시에 걸 때 TP 매도주문이 base 잔량을
 *    SL이 이미 예약해 -2010으로 매 틱 실패하면 protFails가 누적→MAX→**건강한(SL 정상) 포지션을 비상 시장가 청산**
 *    하던 치명 버그를 유발했다. 현물 SL+TP의 거래소 상주 공존은 OCO(placeOco)가 정답이며, 봇 경로 OCO 배선은
 *    testnet 검증 후속(현재 manual 경로만 OCO). 그 전까지 TP leg는 거래소 미상주여도 엔진(종가기준 TP)이 청산을
 *    수행하므로 backtest≡live·안전 불변.
 */
export function nextProtFails(prev: number | undefined, ps: { failed: number; slFailed: boolean }, hasStop: boolean): number {
  if (ps.failed <= 0) return 0;
  if (ps.slFailed && hasStop) return PROTECTIVE_MAX_FAILS; // 손절 leg 실패=나체 → 즉시 비상
  if (hasStop) return 0; // 손절 정상/상주, 다른 leg(TP 등)만 실패 → 나체 아님 → 비상 카운터 리셋(현물 SL+TP -2010 오청산 차단)
  return (prev ?? 0) + 1; // 손절 미설정(비상 대상 아님, line 810 게이트가 hasStop 요구) — 일반 실패 카운트만 유지
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
    // SL 체결 모델: 단일봇 cfg와 동일하게 'worst' 고정 + slippage 명시(라이브 보수 일관, audit P1-12 후속).
    const cfg: BacktestConfig = { strategyId: "scanner", symbol: sym, startDate: bars[0].date, endDate: bars[bars.length - 1].date, initialCapital: perSymCapital, commission: 0.1, timeframe: interval, auxSeries, mtfSeries, mtfRegimeSeries, eventCalendars: thenEvents, gapHandling: "worst", slippage: 0.05 };
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

// ── 지속형 지정가 봇(limit_bracket) — 순수 리듀서 decideLimitBracket의 I/O 래퍼 ──
//  매 틱: 거래소 관측(getOpenOrders/getPositions) → 리듀서 결정 → 실행(fillOrder 지정가/체결기록/취소/종료) → 영속.
//  안전: liveGate(메인넷 차단) + fillOrder 9겹 안전망(allowKrLimit로 KR 지정가만 허용) + 멱등(getOpenOrders+세션키) + fail-closed(조회 실패=무결정).

// 프로세스 생애 '재시작 그레이스' 추적(적대검증 safety#6 픽스): bootGraceDone를 DB에 영속하면 재시작 후 이미 true라
//   grace가 안 걸려 첫 틱에 즉시 주문→인덱싱 지연 시 이중주문. 인메모리 Set으로 '이 프로세스에서 첫 틱인가'를 판별(bootSeeded 패턴).
const lbBooted = new Set<string>();

/** 계좌 보유에서 종목 보유수량 추출(현물 baseAsset 환원). */
function lbHeldQty(positions: ExchangePos[], symbol: string, broker: Broker): number {
  const want = broker === "binance" ? baseAsset(symbol).toUpperCase() : symbol.toUpperCase();
  let q = 0;
  for (const p of positions) {
    const ps = String(p.symbol).toUpperCase();
    if (ps === want || (broker === "binance" && baseAsset(ps) === want)) q += Number(p.quantity) || 0;
  }
  return q;
}

/** limit_bracket 봇의 거래소 잔존 미체결 주문 취소(stopBot/done 정리, 적대검증 safety#1). best-effort, 실패는 loud 로그(삼키지 않음). */
export async function cancelLimitBracketRestingOrders(bot: store.BotRow): Promise<void> {
  const st = bot.position_state as LimitBracketState | null;
  if (!st || (!st.entryOrderId && !st.exitOrderId)) return;
  const live = liveAdapterFor(bot);
  if (!live) return; // 페이퍼=거래소 주문 없음
  for (const oid of [st.entryOrderId, st.exitOrderId]) {
    if (!oid) continue;
    try {
      const ok = await live.adapter.cancelOrder(oid, bot.symbol);
      store.insertLog(bot.id, ok ? "hold" : "error", `[지정가봇] 잔존주문 취소 ${oid}: ${ok ? "성공" : "실패 — 거래소에서 수동 확인 필요"}`);
    } catch (e) {
      store.insertLog(bot.id, "error", `[지정가봇] 잔존주문 취소 예외 ${oid}(${e instanceof Error ? e.message : e}) — 거래소 수동 확인 필요`);
    }
  }
}

async function tickLimitBracket(bot: store.BotRow, node: LimitBracketNode): Promise<{ action: "buy" | "sell" | "hold"; detail: string }> {
  const broker = (["binance", "kis", "kiwoom", "toss"].includes(bot.broker) ? bot.broker : "binance") as Broker;
  const now = new Date();
  const nowIso = now.toISOString();
  const live = liveAdapterFor(bot);
  const paper = !live;
  const sKey = sessionKey(broker, now, bot.symbol);          // 토스 US 심볼은 ET 세션 경계
  const marketOpen = isMarketOpen(broker, now, bot.symbol);  // 토스 US 심볼은 US RTH(09:30~16:00 ET)

  let st = bot.position_state as LimitBracketState | null;
  let restingBuy: ReturnType<typeof findMyRestingOrder>["order"] = null;
  let restingSell: ReturnType<typeof findMyRestingOrder>["order"] = null;
  let ownHeldDelta = 0;
  let refLow: number | undefined; let refHigh: number | undefined;

  if (live) {
    // 거래소 관측(fail-closed: 조회 실패 시 장부 무변경·무결정 → 다음 틱 재시도).
    let openOrders: { orderId: string; side: "buy" | "sell"; price: number; quantity: number; executedQty?: number }[] = [];
    try {
      const raw = live.adapter.getOpenOrders ? await live.adapter.getOpenOrders(node.symbol) : [];
      openOrders = raw.map((o) => ({ orderId: String(o.orderId), side: o.side, price: o.price, quantity: o.quantity, executedQty: o.executedQty }));
    } catch (e) {
      store.insertLog(bot.id, "error", `[지정가봇] 미체결조회 실패(${e instanceof Error ? e.message : e}) → 무결정(다음 틱 재시도)`);
      store.setBotPositionState(bot.id, st); return { action: "hold", detail: "미체결조회 실패 — 무결정" };
    }
    let held = 0;
    const getPos = live.adapter.getPositions;
    try {
      const pos = getPos ? await getReconcilePositions(broker, live.env, () => getPos.call(live.adapter)) : [];
      held = lbHeldQty(pos, node.symbol, broker);
    } catch (e) {
      store.insertLog(bot.id, "error", `[지정가봇] 보유조회 실패(${e instanceof Error ? e.message : e}) → 무결정(다음 틱 재시도)`);
      store.setBotPositionState(bot.id, st); return { action: "hold", detail: "보유조회 실패 — 무결정" };
    }
    if (!st) { st = initLimitBracketState(held, nowIso); store.insertLog(bot.id, "hold", `[지정가봇] 시작 — 기준 계좌보유 ${held}(이후 증가분만 봇 체결로 인식)`); }
    ownHeldDelta = Math.max(0, held - st.baselineQty);
    const buyTarget = broker === "binance" ? node.buyPrice : roundToKrxTick(node.buyPrice);
    const fb = findMyRestingOrder(openOrders, "buy", buyTarget, st.entryOrderId);
    const sellTarget = node.sellPrice != null ? (broker === "binance" ? node.sellPrice : roundToKrxTick(node.sellPrice)) : 0;
    const fs = node.sellPrice != null ? findMyRestingOrder(openOrders, "sell", sellTarget, st.exitOrderId) : { order: null, ambiguous: false };
    if (fb.ambiguous || fs.ambiguous) {
      store.insertLog(bot.id, "error", "[지정가봇] 미체결 주문 귀속 모호(같은 종목·가격 다건) → 동결(수동 정리 필요, fail-closed)");
      store.setBotPositionState(bot.id, st); return { action: "hold", detail: "주문 귀속 모호 — 동결" };
    }
    restingBuy = fb.order; restingSell = fs.order;
  } else {
    if (!st) st = initLimitBracketState(0, nowIso);
    // 페이퍼 가격교차 시뮬용 닫힌봉 저/고가(닫힌봉 = backtest 모델 일치).
    try {
      const iv = secsToInterval(bot.interval_seconds);
      let bars: Bar[] = [];
      if (broker === "binance") bars = await fetchKlines(node.symbol, iv, 3);
      else { const da = getAdapter(broker, "spot")?.adapter as { getCandles?: (s: string, i: string, c: number) => Promise<Bar[]> } | undefined; bars = da?.getCandles ? await da.getCandles(node.symbol, iv, 3) : []; }
      const closed = bars.length > 1 ? bars[bars.length - 2] : bars[bars.length - 1];
      if (closed) { refLow = closed.low; refHigh = closed.high; }
    } catch { /* 시세 없음 → 미교차(noop) */ }
  }

  // 재시작 그레이스 재적용: 이 프로세스에서 이 봇 첫 틱이면 bootGraceDone을 false로(영속값 무시) → 첫 틱 관측-only(주문 금지).
  if (!lbBooted.has(bot.id)) { st.bootGraceDone = false; lbBooted.add(bot.id); }
  const { state: next, action } = decideLimitBracket(node, st, { marketOpen, sessionKey: sKey, paper, restingBuy, restingSell, ownHeldDelta, refLow, refHigh });

  if (action.kind === "place") {
    const posLive = action.side === "sell" ? true : undefined; // 매도=라이브 보유는 라이브로만 청산(실패 동결) / 매수=신규(라이브 시도)
    let q = action.qty;
    if (action.side === "sell" && live) { const ledger = store.liveOpenLedger(bot.id).qty; if (ledger > 0) q = Math.min(q, ledger); } // 오버셀 방지(kr#1): 장부 미청산 상한
    if (!(q > 0)) { store.setBotPositionState(bot.id, next); return { action: "hold", detail: "주문 수량 0(장부 상한) — 보류" }; }
    const r = await fillOrder(bot, action.side, q, action.price, node.symbol, { entry: { type: "limit", limitPrice: action.price, timeoutBars: 1, maxSlippagePct: 0 }, allowKrLimit: true, posLive, barIso: nowIso });
    if (r.failed) { store.setBotPositionState(bot.id, next); return { action: "hold", detail: `주문 동결(${r.note}) — 다음 틱 재시도` }; }
    if (action.side === "buy") { if (r.orderId) next.entryOrderId = String(r.orderId); if (r.cid) next.entryCid = r.cid; }
    else { if (r.orderId) next.exitOrderId = String(r.orderId); if (r.cid) next.exitCid = r.cid; }
    store.setBotPositionState(bot.id, next, true, false);
    return { action: action.side, detail: `${action.reason}${r.pending ? " (호가등록)" : ""}` };
  }
  if (action.kind === "fill") {
    const isPaper = paper || next.live === false;
    const cum = action.side === "buy" ? next.filledQty : next.soldQty;
    const oid = action.side === "buy" ? (next.entryOrderId ?? "lb") : (next.exitOrderId ?? "lb");
    const pnl = action.side === "sell" ? (action.price - (next.entryAvg ?? action.price)) * action.qty : 0;
    store.tx(() => {
      store.insertTrade({ bot_id: bot.id, side: action.side, price: action.price, qty: action.qty, pnl, is_paper: isPaper ? 1 : 0, reason: `[지정가봇] ${action.reason}`, idempotency_key: `${bot.id}:${oid}:${action.side}:${cum.toFixed(8)}` });
      store.setBotPositionState(bot.id, next, true, true);
    });
    store.insertLog(bot.id, action.side, `[지정가봇] ${action.side === "buy" ? "매수" : "매도"} 체결 ${action.qty} @${action.price}${isPaper ? " (페이퍼)" : ""}`);
    return { action: action.side, detail: action.reason };
  }
  if (action.kind === "done") {
    store.setBotPositionState(bot.id, next, true, true);
    const botNow = store.getBot(bot.id); if (botNow) await cancelLimitBracketRestingOrders(botNow); // 잔존 반대편 주문 취소(저장 후 최신 state로)
    store.insertLog(bot.id, "hold", `[지정가봇] 종료 — ${action.reason}`);
    runner().stop(bot.id); // 상태 저장·정리 후 마지막(ambiguous_halt 순서 차용)
    return { action: "hold", detail: `종료: ${action.reason}` };
  }
  store.setBotPositionState(bot.id, next, true, false);
  return { action: "hold", detail: action.reason };
}

/** 러너 데몬: 가동 봇을 interval마다 tick. graceful shutdown 지원. */
export class Runner {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private alive = true;
  // per-bot 재진입 락(적대검증 races#1): tick이 interval보다 오래 걸리면(키움 다중 네트워크 호출 등)
  // setInterval이 같은 봇에 tick을 동시 재진입시켜 이중주문/lost-update 발생 → 진행 중이면 스킵. 전 봇 타입 적용.
  private ticking = new Set<string>();
  private backupTimer: ReturnType<typeof setInterval> | null = null;
  private protectiveTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // 주기 백업(P1-21): 기동 직후 1회 + 24h마다. 실패는 backupDb가 내부 고지(거래 비차단). unref=프로세스 종료 비차단.
    store.backupDb();
    this.backupTimer = setInterval(() => { store.backupDb(); }, 24 * 3600 * 1000);
    this.backupTimer.unref?.();
    // 보호 모니터 스윕(전역 단일 타이머): 전략 봉 주기와 무관하게 열린 라이브 포지션(KR)을 고빈도로 감시 → 일봉 봇도 초 단위 손절.
    this.protectiveTimer = setInterval(() => { this.protectiveSweep().catch(() => {}); }, PROTECT_SWEEP_MS);
    this.protectiveTimer.unref?.();
  }

  start(botId: string): void {
    const bot = store.getBot(botId);
    if (!bot) return;
    store.setBotStatus(botId, "running");
    if (this.timers.has(botId)) return;
    const run = () => {
      if (!this.alive) return;
      if (this.ticking.has(botId)) return; // 이전 틱 진행중 → 재진입 차단(이중주문·lost-update 방지)
      this.ticking.add(botId);
      tickBot(botId)
        .catch((e) => store.insertLog(botId, "error", String(e instanceof Error ? e.message : e)))
        .finally(() => this.ticking.delete(botId));
    };
    run();
    this.timers.set(botId, setInterval(run, Math.max(15, bot.interval_seconds) * 1000));
  }
  /** 보호 스윕(고빈도): 전략 봉 주기와 무관하게 열린 라이브 포지션(KR)을 현재가로 감시 → SL/TP/트레일링 위반 시 즉시 시장가 청산. */
  private async protectiveSweep(): Promise<void> {
    if (!this.alive) return;
    let bots: store.BotRow[]; try { bots = store.listRunningBots(); } catch { return; }
    for (const b of bots) {
      try {
        if (b.mode !== "live") continue;
        const cur0 = b.position_state as PaperPosition | null;
        if (!cur0 || cur0.status !== "open" || !(cur0.qty > 1e-9) || !cur0.live) continue; // 열린 라이브 포지션만
        // 대상: KR(거래소 상주 미지원 → 상시 모니터) + 바이낸스 백스톱(거래소 상주 보호주문 부재 시에만 —
        //   상주 존재 시 #6 reconcileProtectiveFills가 처리하므로 이중청산 방지). 상주 부재 창(진입 직후·sync 실패)을 메움.
        const hasResident = !!(cur0.protectiveIds && cur0.protectiveIds.length > 0);
        if (!(PROTECT_BROKERS.has(b.broker) || (b.broker === "binance" && !hasResident))) continue;
        if (this.ticking.has(b.id)) continue; // 전략 틱 진행 중 → 충돌 회피(다음 스윕)
        const comp = store.getComposite(b.composite_strategy_id);
        const sl = comp?.stop_loss_percent as number | null | undefined;
        const tp = comp?.take_profit_percent as number | null | undefined;
        const trail = comp?.trailing_stop_percent as number | null | undefined;
        if (!sl && !tp && !trail) continue; // 보호 설정 없음 → 감시 대상 아님
        if (!isMarketOpen(b.broker as Broker, new Date(), b.symbol)) continue; // 휴장/장외 → 청산 불가(유동성 없음)
        const live = liveAdapterFor(b);
        const getPrice = (live?.adapter as { getPrice?: (s: string) => Promise<{ price: number }> } | undefined)?.getPrice;
        if (!live || !getPrice) continue;
        let px: number;
        try { px = (await getPrice.call(live.adapter, b.symbol)).price; } catch { continue; } // 현재가 실패 → fail-closed 스킵(다음 스윕)
        if (!(px > 0)) continue;
        const peak = Math.max(cur0.peakPrice ?? cur0.entryAvg, px);
        const ev = evaluateProtectiveExit({ entryAvg: cur0.entryAvg, peakPrice: peak, price: px, stopLossPercent: sl, takeProfitPercent: tp, trailingStopPercent: trail });
        if (!ev.hit) {
          if (peak > (cur0.peakPrice ?? 0)) { try { store.setBotPositionState(b.id, { ...cur0, peakPrice: peak }, true, false); } catch { /* 경합 무시 */ } } // intra-bar 고점 추종(트레일 정확도)
          continue;
        }
        if (this.ticking.has(b.id)) continue; // getPrice await 사이 틱 시작 → 양보(이중청산 방지)
        this.ticking.add(b.id);
        try {
          const fresh = store.getBot(b.id)?.position_state as PaperPosition | null; // 락 획득 후 fresh 재확인(틱이 먼저 청산/상주배치 했을 수 있음)
          const freshResident = !!(fresh?.protectiveIds && fresh.protectiveIds.length > 0); // 바이낸스: 락 사이 상주주문 배치됐으면 백스톱 양보(이중청산 방지)
          if (fresh && fresh.status === "open" && fresh.qty > 1e-9 && fresh.live && !(b.broker === "binance" && freshResident)) {
            await protectiveLiquidate(b, fresh, px, ev.kind!, ev.level, live.env);
          }
        } finally { this.ticking.delete(b.id); }
      } catch (e) { try { store.insertLog(b.id, "error", `보호 스윕 오류: ${e instanceof Error ? e.message : e}`); } catch { /* 로그 실패 무시 */ } }
    }
  }
  stop(botId: string): void {
    const t = this.timers.get(botId); if (t) { clearInterval(t); this.timers.delete(botId); }
    store.setBotStatus(botId, "stopped");
  }
  resumeAll(): void { for (const b of store.listRunningBots()) this.start(b.id); }
  shutdown(): void { this.alive = false; for (const t of this.timers.values()) clearInterval(t); this.timers.clear(); if (this.backupTimer) { clearInterval(this.backupTimer); this.backupTimer = null; } if (this.protectiveTimer) { clearInterval(this.protectiveTimer); this.protectiveTimer = null; } }
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
  // limit_bracket 잔존 미체결 지정가 취소(적대검증 safety#1·#2): killswitch 시 거래소에 주문이 남아 봇 사후 체결되는 것 차단
  //   (특히 Binance GTC는 만료 안 됨 → 나체 노출). closePositions와 무관하게 항상 취소(주문≠포지션).
  for (const bot of bots) {
    try {
      if ((store.getComposite(bot.composite_strategy_id)?.root_node as { type?: string })?.type !== "limit_bracket") continue;
      const b2 = store.getBot(bot.id); if (b2) await cancelLimitBracketRestingOrders(b2);
    } catch (e) { store.insertLog(bot.id, "error", `비상정지 잔존주문 취소 예외(${e instanceof Error ? e.message : e})`); }
  }
  audit({ event: "emergency_stop_all", stopped: bots.length, closed, failed, closePositions: !!opts?.closePositions });
  return { stopped: bots.length, closed, failed };
}
