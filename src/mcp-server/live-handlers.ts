/**
 * live-handlers.ts — v2.5 라이브 거래 MCP 툴(BYOK). 안전 프레임워크(safety.ts) 경유만.
 * place_order = fail-CLOSED 2단계 확인토큰 + 라이브게이트 + 서버측 하드리밋 + 감사로그.
 * 키 넣으면 testnet 즉시거래, 메인넷은 LIVE_TRADING_ENABLED + 2단계토큰 필수.
 */
import { getAdapter, configuredBrokers } from "../brokers/index.js";
import { liveGate, checkLimits, orderHash, mintToken, consumeToken, audit, type Broker } from "../brokers/safety.js";

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
    },
    note: "testnet/mock 키만 있으면 즉시 거래(가짜돈). 메인넷은 env=live + LIVE_TRADING_ENABLED=true + 주문별 2단계 확인토큰 필요.",
  };
}

export async function placeOrder(a: {
  broker?: Broker; market?: "spot" | "futures"; symbol: string; side: "buy" | "sell";
  type?: "market" | "limit"; quantity: number; price?: number; confirmToken?: string;
}) {
  const broker = a.broker || "binance", market = a.market || "spot", type = a.type || "market";
  const got = getAdapter(broker, market);
  if (!got) return { ok: false, error: `${broker} 키 미설정(env). 라이브 주문 불가. SETUP-LIVE.md 참고.` };

  const gate = liveGate(broker, market);
  if (!gate.allowed) return { ok: false, error: gate.reason, gate };

  // 가격/노셔널 → 하드리밋. 통화 인식(Binance=USDT, 한투/키움=KRW) → 통화별 캡 적용(KR에 USDT 캡 오판 방지).
  const quoteCurrency = broker === "binance" ? "USDT" : "KRW";
  let price = a.price ?? 0;
  if (!price) { try { price = (await got.adapter.getPrice(a.symbol)).price; } catch { price = 0; } }
  // 시장가인데 현재가 산출 실패(price=0) → 노셔널 불명. 메인넷(live)에서는 캡 적용 불가하므로 거절(fail-closed, 리스크통제).
  if (!(price > 0) && gate.env === "live") return { ok: false, error: "현재가 산출 실패 → 노셔널 불명. 메인넷 시장가 거절(지정가로 주문하세요)." };
  const notional = price * a.quantity;
  const lim = checkLimits({ symbol: a.symbol, notional, quoteCurrency });
  if (!lim.ok) return { ok: false, error: `하드리밋 차단: ${lim.reason}` };

  // 2단계 확인토큰(fail-CLOSED)
  const hash = orderHash({ broker, market, symbol: a.symbol, side: a.side, type, quantity: a.quantity, price: a.price ?? null, env: gate.env });
  if (!a.confirmToken) {
    const token = mintToken(hash);
    return {
      ok: true, phase: "preview", needConfirm: true, confirmToken: token,
      preview: { broker, market, env: gate.env, symbol: a.symbol, side: a.side, type, quantity: a.quantity, price: a.price ?? "(시장가)", notional: +notional.toFixed(2) },
      note: `⚠️ ${String(gate.env).toUpperCase()} 주문 프리뷰. 검토 후 동일 인자 + 이 confirmToken으로 다시 place_order 호출해야 실제 주문(5분 TTL, 단일사용).`,
    };
  }
  if (!consumeToken(a.confirmToken, hash)) return { ok: false, error: "확인토큰 무효/만료/불일치 → 거절(fail-closed). 프리뷰부터 다시." };

  audit({ event: "order_attempt", broker, market, env: gate.env, symbol: a.symbol, side: a.side, type, quantity: a.quantity, price: a.price ?? null });
  try {
    const result = await got.adapter.placeOrder({ symbol: a.symbol, side: a.side, type, quantity: a.quantity, price: a.price });
    audit({ event: "order_result", broker, env: gate.env, orderId: result.orderId, status: result.status, symbol: result.symbol, side: result.side, qty: result.quantity, price: result.price });
    return { ok: true, phase: "executed", broker, env: gate.env, result };
  } catch (e) {
    audit({ event: "order_error", broker, env: gate.env, error: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
