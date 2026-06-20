/**
 * live-handlers.ts — v2.5 라이브 거래 MCP 툴(BYOK). 안전 프레임워크(safety.ts) 경유만.
 * place_order = fail-CLOSED 2단계 확인토큰 + 라이브게이트 + 서버측 하드리밋 + 감사로그.
 * 키 넣으면 testnet 즉시거래, 메인넷은 LIVE_TRADING_ENABLED + 2단계토큰 필수.
 */
import { getAdapter, configuredBrokers } from "../brokers/index.js";
import { liveGate, checkLimits, quoteCurrencyFor, orderHash, mintToken, consumeToken, audit, auditFailureCount, lastAuditError, type Broker } from "../brokers/safety.js";

export async function getPositions(a: { broker?: Broker; market?: "spot" | "futures" }) {
  const broker = a.broker || "binance", market = a.market || "spot";
  const got = getAdapter(broker, market);
  if (!got) return { ok: false, error: `${broker} 키 미설정(env). SETUP-LIVE.md 참고. (페이퍼 봇은 키 불필요)` };
  try { return { ok: true, broker, env: got.env, positions: await got.adapter.getPositions() }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

export async function getBalance(a: { broker?: Broker; market?: "spot" | "futures" }) {
  const broker = a.broker || "binance", market = a.market || "spot";
  const got = getAdapter(broker, market);
  if (!got) return { ok: false, error: `${broker} 키 미설정(env). SETUP-LIVE.md 참고.` };
  try { return { ok: true, broker, env: got.env, balance: await got.adapter.getBalance() }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

/**
 * 수동주문 입력 보조 시세(읽기전용, audit §7-4/8): 현재가 + 가용현금 + 해당 종목 보유수량.
 * 잘못된 심볼이면 getPrice가 실패 → 클라가 '종목 확인' 안내(자동완성 대체 검증). 시크릿/키 미노출.
 */
export async function getQuote(a: { broker?: Broker; market?: "spot" | "futures"; symbol: string }) {
  const broker = a.broker || "binance", market = a.market || "spot";
  const got = getAdapter(broker, market);
  if (!got) return { ok: false, error: `${broker} 키 미설정(env).` };
  try {
    const px = await got.adapter.getPrice(a.symbol);
    if (!(px.price > 0)) return { ok: false, error: `시세 0 — 종목(${a.symbol}) 확인 필요` };
    let cashBalance = 0, held = 0;
    try { cashBalance = (await got.adapter.getBalance()).cashBalance; } catch { /* 잔고 실패해도 시세는 반환 */ }
    try {
      const base = a.symbol.toUpperCase().replace(/(USDT|USDC|FDUSD|TUSD|BUSD)$/, "");
      for (const p of await got.adapter.getPositions()) {
        const ps = String(p.symbol).toUpperCase();
        if (ps === a.symbol.toUpperCase() || ps === base) held += Number((p as { free?: number }).free ?? p.quantity) || 0;
      }
    } catch { /* 보유 실패해도 시세는 반환 */ }
    return { ok: true, broker, env: got.env, symbol: a.symbol, price: px.price, cashBalance, held };
  } catch (e) { return { ok: false, error: `시세 조회 실패 — 종목(${a.symbol}) 확인: ${e instanceof Error ? e.message : e}` }; }
}

/** 미체결(상주) 주문 목록(읽기전용, audit P1-16/19). Binance·키움 지원, KIS는 fail-closed throw(미지원). 미구현 어댑터는 정직하게 미지원 반환. */
export async function getOpenOrders(a: { broker?: Broker; market?: "spot" | "futures"; symbol: string }) {
  const broker = a.broker || "binance", market = a.market || "spot";
  const got = getAdapter(broker, market);
  if (!got) return { ok: false, error: `${broker} 키 미설정(env). SETUP-LIVE.md 참고.` };
  if (typeof got.adapter.getOpenOrders !== "function") {
    return { ok: false, error: `${broker} 어댑터는 미체결 조회 미구현. 거래소 앱에서 확인하세요.` };
  }
  try { return { ok: true, broker, env: got.env, symbol: a.symbol, orders: await got.adapter.getOpenOrders(a.symbol) }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

/** 주문 상태 역쿼리(읽기전용, audit P1-16). orderId 또는 clientOrderId 중 하나 필수. 없으면 found:false. */
export async function getOrderStatus(a: { broker?: Broker; market?: "spot" | "futures"; symbol: string; orderId?: string; clientOrderId?: string }) {
  const broker = a.broker || "binance", market = a.market || "spot";
  const got = getAdapter(broker, market);
  if (!got) return { ok: false, error: `${broker} 키 미설정(env). SETUP-LIVE.md 참고.` };
  try {
    if (a.orderId && typeof got.adapter.getOrderById === "function") {
      const o = await got.adapter.getOrderById(a.symbol, a.orderId);
      return { ok: true, broker, env: got.env, found: !!o, order: o };
    }
    if (a.clientOrderId && typeof got.adapter.getOrderByClientId === "function") {
      const o = await got.adapter.getOrderByClientId(a.symbol, a.clientOrderId);
      return { ok: true, broker, env: got.env, found: !!o, order: o };
    }
    return { ok: false, error: a.orderId || a.clientOrderId ? `${broker} 어댑터는 주문 역쿼리 미구현(현재 Binance만).` : "orderId 또는 clientOrderId가 필요합니다." };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

/** 미체결 주문 취소(audit P1-19). 리스크 감소 방향 조작이라 2단계 토큰 없이 허용 — 감사로그는 남김. */
export async function cancelOrderById(a: { broker?: Broker; market?: "spot" | "futures"; symbol: string; orderId: string }) {
  const broker = a.broker || "binance", market = a.market || "spot";
  const got = getAdapter(broker, market);
  if (!got) return { ok: false, error: `${broker} 키 미설정(env).` };
  try {
    const cancelled = await got.adapter.cancelOrder(a.orderId, a.symbol);
    audit({ event: "manual_cancel", broker, env: got.env, symbol: a.symbol, orderId: a.orderId, cancelled });
    return { ok: true, broker, env: got.env, cancelled, note: cancelled ? "취소됨" : "취소 실패(이미 체결/취소됐을 수 있음 — get_order_status로 확인)" };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

/** 라이브 설정 상태(키 노출 0). 무엇이 켜져 있는지 한눈에 — 안내용. */
export function liveStatus() {
  const brokers = configuredBrokers();
  const masterOn = (process.env.LIVE_TRADING_ENABLED || "").trim() === "true";
  return {
    ok: true, masterSwitch: masterOn ? "ON" : "OFF(기본)",
    configured: brokers.length ? brokers : "없음(키 미설정 → 전부 페이퍼)",
    limits: {
      maxNotional: process.env.LIVE_MAX_NOTIONAL || "무제한(미설정)",
      symbolAllowlist: process.env.LIVE_SYMBOL_ALLOWLIST || "전체(미설정)",
      dailyLossLimit: process.env.LIVE_DAILY_LOSS_LIMIT || "없음(미설정)",
      dailyLossLimitUSDT: process.env.LIVE_DAILY_LOSS_LIMIT_USDT || "통화 기본값",
      dailyLossLimitKRW: process.env.LIVE_DAILY_LOSS_LIMIT_KRW || "통화 기본값",
    },
    // 감사로그 무결성(audit P1-24) — 누적 실패/마지막 에러/HALT 강제 여부.
    auditStatus: {
      failures: auditFailureCount(),
      lastError: lastAuditError() || null,
      haltEnforced: (process.env.AUDIT_FAILURE_HALT || "").trim() === "true",
    },
    note: "testnet/mock 키만 있으면 즉시 거래(가짜돈). 메인넷은 env=live + LIVE_TRADING_ENABLED=true + 주문별 2단계 확인토큰 필요.",
  };
}

export async function placeOrder(a: {
  broker?: Broker; market?: "spot" | "futures"; symbol: string; side: "buy" | "sell";
  type?: "market" | "limit"; quantity?: number; price?: number; orderAmount?: number; confirmToken?: string;
}) {
  const broker = a.broker || "binance", market = a.market || "spot", type = a.type || "market";
  const got = getAdapter(broker, market);
  if (!got) return { ok: false, error: `${broker} 키 미설정(env). 라이브 주문 불가. SETUP-LIVE.md 참고.` };

  const gate = liveGate(broker, market);
  if (!gate.allowed) return { ok: false, error: gate.reason, gate };

  // ── 금액기반 주문(US MARKET 전용, 수동 한정): quantity 대신 달러 금액. notional=orderAmount → 정규화/현재가 산출 스킵. ──
  //   동일 안전 골격 재사용: liveGate → checkLimits(USD) → 2단계 confirmToken(orderAmount 해시 바인딩) → audit → adapter.
  if (a.orderAmount != null && a.orderAmount > 0) {
    if (a.quantity != null) return { ok: false, error: "수량과 금액은 동시에 지정할 수 없습니다(하나만)." };
    if (broker !== "toss") return { ok: false, error: "금액기반 주문은 토스 US 시장가만 지원합니다." };
    if (type !== "market") return { ok: false, error: "금액기반 주문은 시장가(market)만 가능합니다." };
    if (quoteCurrencyFor(broker, a.symbol) !== "USD") return { ok: false, error: "금액기반 주문은 US 종목만 가능합니다(KR 불가)." };
    const notional = a.orderAmount;
    const lim = checkLimits({ symbol: a.symbol, notional, quoteCurrency: "USD" });
    if (!lim.ok) return { ok: false, error: `하드리밋 차단: ${lim.reason}` };
    const hash = orderHash({ broker, market, symbol: a.symbol, side: a.side, type, orderAmount: a.orderAmount, env: gate.env });
    if (!a.confirmToken) {
      const token = mintToken(hash);
      return {
        ok: true, phase: "preview", needConfirm: true, confirmToken: token,
        preview: { broker, market, env: gate.env, symbol: a.symbol, side: a.side, type, orderAmount: a.orderAmount, notional: +notional.toFixed(2), currency: "USD" },
        note: `⚠️ ${String(gate.env).toUpperCase()} 금액주문 프리뷰($${a.orderAmount}). 동일 인자 + 이 confirmToken으로 다시 호출해야 실제 주문(5분 TTL, 단일사용).`,
      };
    }
    if (!consumeToken(a.confirmToken, hash)) return { ok: false, error: "확인토큰 무효/만료/불일치 → 거절(fail-closed). 프리뷰부터 다시." };
    audit({ event: "order_attempt", broker, market, env: gate.env, symbol: a.symbol, side: a.side, type, orderAmount: a.orderAmount });
    try {
      const result = await got.adapter.placeOrder({ symbol: a.symbol, side: a.side, type: "market", quantity: 0, orderAmount: a.orderAmount });
      audit({ event: "order_result", broker, env: gate.env, orderId: result.orderId, status: result.status, symbol: result.symbol, side: result.side, orderAmount: a.orderAmount });
      return { ok: true, phase: "executed", broker, env: gate.env, result };
    } catch (e) {
      audit({ event: "order_error", broker, env: gate.env, error: e instanceof Error ? e.message : String(e) });
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── 수량기반 주문(기존 경로) ──
  if (a.quantity == null) return { ok: false, error: "수량(quantity) 또는 금액(orderAmount)이 필요합니다." };
  const qty = a.quantity;
  // 가격/노셔널 → 하드리밋. 통화 인식(Binance=USDT, 한투/키움=KRW, 토스=심볼별) → 통화별 캡 적용(KR에 USDT 캡 오판 방지).
  const quoteCurrency = quoteCurrencyFor(broker, a.symbol);
  let price = a.price ?? 0;
  if (!price) { try { price = (await got.adapter.getPrice(a.symbol)).price; } catch { price = 0; } }
  // 시장가인데 현재가 산출 실패(price=0) → 노셔널 불명. 메인넷(live)에서는 캡 적용 불가하므로 거절(fail-closed, 리스크통제).
  if (!(price > 0) && gate.env === "live") return { ok: false, error: "현재가 산출 실패 → 노셔널 불명. 메인넷 시장가 거절(지정가로 주문하세요)." };
  // ① 캡 검증을 '제출될 정규화 수량'으로(minNotional 상향분이 캡 초과한 채 제출되던 구멍 차단). 해시/프리뷰/주문 모두 effQty로 통일.
  let effQty = qty;
  if (typeof got.adapter.normalizeQuantity === "function" && price > 0) {
    try { effQty = await got.adapter.normalizeQuantity(a.symbol, qty, price); } catch { effQty = qty; }
  }
  if (!(effQty > 0)) return { ok: false, error: "정규화 후 수량 0(최소수량/스텝 미달)." };
  const notional = price * effQty;
  const lim = checkLimits({ symbol: a.symbol, notional, quoteCurrency });
  if (!lim.ok) return { ok: false, error: `하드리밋 차단: ${lim.reason}` };

  // 2단계 확인토큰(fail-CLOSED). INV-1: 해시 바인딩 수량 = 프리뷰 수량 = 실제 주문 수량(effQty).
  const hash = orderHash({ broker, market, symbol: a.symbol, side: a.side, type, quantity: effQty, price: a.price ?? null, env: gate.env });
  if (!a.confirmToken) {
    const token = mintToken(hash);
    return {
      ok: true, phase: "preview", needConfirm: true, confirmToken: token,
      preview: { broker, market, env: gate.env, symbol: a.symbol, side: a.side, type, quantity: effQty, price: a.price ?? "(시장가)", notional: +notional.toFixed(2) },
      note: `⚠️ ${String(gate.env).toUpperCase()} 주문 프리뷰. 검토 후 동일 인자 + 이 confirmToken으로 다시 place_order 호출해야 실제 주문(5분 TTL, 단일사용).`,
    };
  }
  if (!consumeToken(a.confirmToken, hash)) return { ok: false, error: "확인토큰 무효/만료/불일치 → 거절(fail-closed). 프리뷰부터 다시." };

  audit({ event: "order_attempt", broker, market, env: gate.env, symbol: a.symbol, side: a.side, type, quantity: effQty, price: a.price ?? null });
  try {
    const result = await got.adapter.placeOrder({ symbol: a.symbol, side: a.side, type, quantity: effQty, price: a.price });
    audit({ event: "order_result", broker, env: gate.env, orderId: result.orderId, status: result.status, symbol: result.symbol, side: result.side, qty: result.quantity, price: result.price });
    return { ok: true, phase: "executed", broker, env: gate.env, result };
  } catch (e) {
    audit({ event: "order_error", broker, env: gate.env, error: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 현물 OCO 보호주문(롱 포지션: 익절 LIMIT_MAKER + 손절 STOP_LOSS_LIMIT 묶음, 한쪽 체결 시 다른쪽 자동취소).
 * placeOrder와 동일 안전 골격 재사용(신규 안전로직 0): liveGate → 실보유수량 검증 → 방향 검증 → checkLimits(TP·SL 각각)
 * → 2단계 confirmToken(tp/sl/qty 해시 바인딩) → adapter.placeOco → audit. 서버가 클라 가격/수량/env 전부 불신·재계산.
 */
export async function placeProtective(a: {
  broker?: Broker; symbol: string; quantity: number;
  takeProfitPrice: number; stopPrice: number; stopLimitPrice?: number; confirmToken?: string;
}) {
  const broker = a.broker || "binance", market = "spot" as const; // OCO는 현물만
  const got = getAdapter(broker, market);
  if (!got) return { ok: false, error: `${broker} 키 미설정(env). 보호주문 불가. SETUP-LIVE.md 참고.` };
  const gate = liveGate(broker, market);
  if (!gate.allowed) return { ok: false, error: gate.reason, gate };
  if (typeof got.adapter.placeOco !== "function") return { ok: false, error: `${broker} 어댑터는 OCO 미지원(현물 크립토만).` };

  // 1) 실보유수량 검증 — 클라 quantity 불신. base=어댑터 권위(비표준 quote 페어 정확), held=매도가능(free, 잠긴 OCO 제외).
  let held = 0;
  try {
    let base = "";
    if (typeof got.adapter.baseAssetOf === "function") base = await got.adapter.baseAssetOf(a.symbol);
    if (!base) base = a.symbol.replace(/USDT$|USDC$|BUSD$|FDUSD$|TUSD$|DAI$|USDP$/i, ""); // 폴백(확장 정규식)
    const pos = (await got.adapter.getPositions()).find((p) => p.symbol.toUpperCase() === base.toUpperCase());
    held = pos?.free ?? pos?.quantity ?? 0; // ③ free 우선(locked 제외=-2010 사전차단), 미상이면 quantity 폴백
  } catch { held = 0; } // 조회 실패 → 0 → 아래에서 fail-closed 거절
  if (!(a.quantity > 0)) return { ok: false, error: "수량은 0보다 커야 합니다." };
  if (!(held > 0)) return { ok: false, error: "보유 수량 없음(거래소 조회 실패 또는 미보유) → 보호주문 거절(fail-closed)." };
  if (a.quantity > held + 1e-9) return { ok: false, error: `수량 ${a.quantity} > 실보유 ${held}. 보유분만 보호 가능.` };
  // 중복 등록 방지: 같은 심볼에 이미 상주 OCO가 있으면 거절(거래소 -2010 전에 fail-closed). 취소 후 재등록.
  if (typeof got.adapter.getOpenOco === "function") {
    try { const ex = await got.adapter.getOpenOco(a.symbol); if (ex) return { ok: false, error: `이미 ${a.symbol} 상주 OCO가 있습니다(취소 후 재등록).` }; } catch { /* 조회 실패 → 진행(거래소가 최종 방어) */ }
  }

  // 2) 방향 검증 — 현재가 서버 재계산. 익절>현재가>손절(SELL OCO 구조).
  let mark = 0;
  try { mark = (await got.adapter.getPrice(a.symbol)).price; } catch { mark = 0; }
  if (!(mark > 0)) return { ok: false, error: "현재가 산출 실패 → 방향 검증 불가. 보호주문 거절(fail-closed)." };
  if (!(a.takeProfitPrice > mark)) return { ok: false, error: `익절가 ${a.takeProfitPrice}는 현재가 ${mark}보다 높아야 합니다.` };
  if (!(a.stopPrice < mark)) return { ok: false, error: `손절가 ${a.stopPrice}는 현재가 ${mark}보다 낮아야 합니다.` };
  if (a.stopLimitPrice != null && a.stopLimitPrice > a.stopPrice) return { ok: false, error: "손절 지정가는 트리거가 이하여야 합니다." };

  // ① 캡 검증·해시·주문 모두 '제출될 정규화 수량(effQty)'으로 통일(placeOco가 내부에서 normalizeQuantity 절사 → 검증==제출).
  let effQty = a.quantity;
  if (typeof got.adapter.normalizeQuantity === "function") {
    try { effQty = await got.adapter.normalizeQuantity(a.symbol, a.quantity, a.stopPrice); } catch { effQty = a.quantity; }
  }
  if (!(effQty > 0)) return { ok: false, error: "정규화 후 수량 0(스텝/최소 미달)." };
  if (effQty > held + 1e-9) return { ok: false, error: `정규화 수량 ${effQty} > 실보유(매도가능) ${held}.` };

  // 3) 하드리밋 — TP·SL 노셔널 각각 캡(한쪽만 우회 불가). 정규화 수량 기준.
  const quoteCurrency = quoteCurrencyFor(broker, a.symbol);
  const tpLim = checkLimits({ symbol: a.symbol, notional: a.takeProfitPrice * effQty, quoteCurrency });
  if (!tpLim.ok) return { ok: false, error: `하드리밋 차단(익절): ${tpLim.reason}` };
  const slLim = checkLimits({ symbol: a.symbol, notional: a.stopPrice * effQty, quoteCurrency });
  if (!slLim.ok) return { ok: false, error: `하드리밋 차단(손절): ${slLim.reason}` };

  // 4) 2단계 confirmToken(fail-CLOSED) — kind:oco + tp/sl/qty(effQty) 해시 바인딩. INV-1: 해시=프리뷰=주문 수량 일치.
  const hash = orderHash({ broker, market, kind: "oco", symbol: a.symbol, quantity: effQty, tp: a.takeProfitPrice, sl: a.stopPrice, sll: a.stopLimitPrice ?? null, env: gate.env });
  if (!a.confirmToken) {
    const token = mintToken(hash);
    return {
      ok: true, phase: "preview", needConfirm: true, confirmToken: token,
      preview: { broker, market, env: gate.env, symbol: a.symbol, side: "sell", quantity: effQty, takeProfitPrice: a.takeProfitPrice, stopPrice: a.stopPrice, currentPrice: +mark.toFixed(8), held },
      note: `⚠️ ${String(gate.env).toUpperCase()} OCO 보호주문 프리뷰(익절+손절 묶음, 한쪽 체결 시 다른쪽 자동취소). 동일 인자+confirmToken으로 재호출해야 실제 주문(5분 TTL, 단일사용).`,
    };
  }
  if (!consumeToken(a.confirmToken, hash)) return { ok: false, error: "확인토큰 무효/만료/불일치 → 거절(fail-closed). 프리뷰부터 다시." };

  audit({ event: "oco_attempt", broker, market, env: gate.env, symbol: a.symbol, quantity: effQty, tp: a.takeProfitPrice, sl: a.stopPrice });
  try {
    const result = await got.adapter.placeOco({ symbol: a.symbol, quantity: effQty, takeProfitPrice: a.takeProfitPrice, stopPrice: a.stopPrice, stopLimitPrice: a.stopLimitPrice });
    audit({ event: "oco_result", broker, env: gate.env, orderListId: result.orderListId, symbol: a.symbol });
    return { ok: true, phase: "executed", broker, env: gate.env, result };
  } catch (e) {
    audit({ event: "oco_error", broker, env: gate.env, error: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 심볼의 상주 OCO 상태 + 실보유 조회(세션 간 복원·페이퍼봇 분기용). 키/시크릿 미노출. */
export async function getProtective(a: { broker?: Broker; symbol: string }) {
  const broker = a.broker || "binance", market = "spot" as const;
  const got = getAdapter(broker, market);
  if (!got) return { ok: false, active: false, held: 0, error: `${broker} 키 미설정(env).` };
  const gate = liveGate(broker, market);
  if (!gate.allowed) return { ok: false, active: false, held: 0, error: gate.reason };
  let held = 0;
  try {
    let base = "";
    if (typeof got.adapter.baseAssetOf === "function") base = await got.adapter.baseAssetOf(a.symbol);
    if (!base) base = a.symbol.replace(/USDT$|USDC$|BUSD$|FDUSD$|TUSD$|DAI$|USDP$/i, "");
    const pos = (await got.adapter.getPositions()).find((p) => p.symbol.toUpperCase() === base.toUpperCase());
    held = pos?.free ?? pos?.quantity ?? 0; // placeProtective와 동일 의미(매도가능 free 우선)
  } catch { held = 0; }
  let oco: { orderListId: string; tpPrice: number; slPrice: number } | null = null;
  if (typeof got.adapter.getOpenOco === "function") { try { oco = await got.adapter.getOpenOco(a.symbol); } catch { oco = null; } }
  return { ok: true, env: gate.env, held: +held, active: !!oco, orderListId: oco?.orderListId, tpPrice: oco?.tpPrice, slPrice: oco?.slPrice };
}

/** OCO 보호주문 취소(orderListId). liveGate 경유(주문 아님이라 캡 불필요) + adapter.cancelOco + audit. */
export async function cancelProtective(a: { broker?: Broker; symbol: string; orderListId: string }) {
  const broker = a.broker || "binance", market = "spot" as const;
  const got = getAdapter(broker, market);
  if (!got) return { ok: false, error: `${broker} 키 미설정(env).` };
  const gate = liveGate(broker, market);
  if (!gate.allowed) return { ok: false, error: gate.reason, gate };
  if (!a.symbol || !a.orderListId) return { ok: false, error: "symbol·orderListId 필요." };
  if (typeof got.adapter.cancelOco !== "function") return { ok: false, error: `${broker} 어댑터는 OCO 미지원.` };
  audit({ event: "oco_cancel_attempt", broker, env: gate.env, symbol: a.symbol, orderListId: a.orderListId });
  try {
    const canceled = await got.adapter.cancelOco(a.symbol, a.orderListId);
    audit({ event: "oco_cancel_result", broker, env: gate.env, symbol: a.symbol, orderListId: a.orderListId, canceled });
    return { ok: true, canceled };
  } catch (e) {
    audit({ event: "oco_cancel_error", broker, env: gate.env, error: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * read-only 실계정 스냅샷 — 대시보드 '거래소 실계정' 패널용. 키/시크릿 절대 미노출.
 * liveGate 경유(키 없으면 configured:false → 빈 패널, 메인넷+마스터OFF면 조회조차 차단). 쓰기 경로 없음.
 * symbols: 이 브로커 봇 심볼들(현물 OCO 요약 대상). getProtective 재사용(liveGate+held+OCO 묶음).
 */
export async function getAccount(a: { broker?: Broker; market?: "spot" | "futures"; symbols?: string[] }) {
  const broker = a.broker || "binance", market = a.market || "spot";
  const got = getAdapter(broker, market);
  if (!got) return { ok: false, configured: false, broker, reason: `${broker} 키 미설정(env). 페이퍼 유지.` };
  const gate = liveGate(broker, market);
  if (!gate.allowed) return { ok: false, configured: true, broker, env: gate.env, reason: gate.reason };
  let balance: { totalAsset: number; cashBalance: number; currency: string } | null = null;
  let balErr: string | undefined;
  try { balance = await got.adapter.getBalance(); } catch (e) { balErr = e instanceof Error ? e.message : String(e); }
  let positions: Awaited<ReturnType<typeof got.adapter.getPositions>> = [];
  let posErr: string | undefined;
  try { positions = await got.adapter.getPositions(); } catch (e) { posErr = e instanceof Error ? e.message : String(e); }
  const protective: { symbol: string; active: boolean; held: number; orderListId?: string; tpPrice?: number; slPrice?: number; error?: string }[] = [];
  if (market === "spot" && Array.isArray(a.symbols)) {
    for (const sym of [...new Set(a.symbols.filter((s) => typeof s === "string" && s))].slice(0, 20)) {
      const r = await getProtective({ broker, symbol: sym });
      protective.push({ symbol: sym, active: !!r.active, held: Number(r.held) || 0, orderListId: r.orderListId, tpPrice: r.tpPrice, slPrice: r.slPrice, error: r.ok ? undefined : r.error });
    }
  }
  return { ok: true, configured: true, broker, env: gate.env, balance, balErr, positions, posErr, protective };
}
