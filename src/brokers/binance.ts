/**
 * brokers/binance.ts — Binance 어댑터 (v2, bring-your-own-keys). 현물(spot) + USDⓈ-M 선물(futures)을
 * 한 클래스로 처리하고 `credentials.market`('spot'|'futures', 기본 spot)으로 분기한다.
 *
 * 포트(BrokerAdapter, types.ts)의 정규화 도메인 형태(AccountBalance/Position/MarketPrice/OrderResult)만 반환.
 * 서명은 stock-autotrade의 실거래 어댑터(binance.ts / binance-futures.ts)에서 그대로 포팅:
 *   HMAC-SHA256(secret, exactQueryString) → query에 signature 추가, 헤더 X-MBX-APIKEY.
 *
 * ── 안전 원칙(설계 §5) ──
 *  - base URL은 URLS 맵에서 `credentials.env` + `credentials.market`으로만 선택. 메인넷을 주문 경로에
 *    하드코딩하지 않는다. env 누락/미지정 시 **항상 SAFE(testnet)** 로 폴백한다.
 *  - 현물 testnet 키와 선물 testnet 키는 **완전히 별개**(testnet.binance.vision ↔ testnet.binancefuture.com).
 *  - 시크릿은 절대 로깅하지 않는다. 서명된 URL/쿼리도 에러 메시지에 넣지 않는다(상태코드만 노출).
 *  - 모든 네트워크 호출에 AbortSignal.timeout 적용.
 */
import crypto from "node:crypto";
import type {
  BrokerType,
  BrokerCredentials,
  AccountBalance,
  Position,
  MarketPrice,
  OrderRequest,
  OrderResult,
} from "./types.js";
import { BaseBrokerAdapter } from "./base.js";

/** 시장 구분. credentials.market 으로 주입(기본 spot). */
type Market = "spot" | "futures";

/** 환경 선택자. credentials.env 로 주입. testnet/mock 은 모두 SAFE(테스트넷)로 취급. */
type Env = "testnet" | "mock" | "live";

/**
 * base URL 맵. env + market 조합으로만 호스트를 고른다(주문 경로에 메인넷 하드코딩 금지).
 * spot   : testnet=testnet.binance.vision        live=api.binance.com
 * futures: testnet=testnet.binancefuture.com     live=fapi.binance.com
 */
const URLS: Record<Market, Record<"safe" | "live", string>> = {
  spot: {
    safe: "https://testnet.binance.vision",
    live: "https://api.binance.com",
  },
  futures: {
    safe: "https://testnet.binancefuture.com",
    live: "https://fapi.binance.com",
  },
};

/** 마켓별 엔드포인트 경로. spot=/api/v3, futures=/fapi/v1·v2. */
const PATHS = {
  spot: {
    account: "/api/v3/account",
    order: "/api/v3/order",
    tickerPrice: "/api/v3/ticker/price",
    ticker24: "/api/v3/ticker/24hr",
    exchangeInfo: "/api/v3/exchangeInfo",
  },
  futures: {
    account: "/fapi/v2/account",
    positionRisk: "/fapi/v2/positionRisk",
    order: "/fapi/v1/order",
    tickerPrice: "/fapi/v1/ticker/price",
    ticker24: "/fapi/v1/ticker/24hr",
    exchangeInfo: "/fapi/v1/exchangeInfo",
  },
} as const;

/**
 * 선물 전용 주문 옵션. 포트의 OrderRequest를 확장하되, 호출측이 선물 의도를 명시할 때만 사용.
 * 일반 OrderRequest로 들어와도 동작(open=시장가/지정가, reduceOnly 미지정).
 */
export interface FuturesOrderRequest extends OrderRequest {
  /** 포지션 축소 전용(반대방향 신규진입 방지). 숏 커버/롱 청산에 사용. */
  reduceOnly?: boolean;
}

const TIMEOUT_MS = 10_000;

export class BinanceBrokerAdapter extends BaseBrokerAdapter {
  type: BrokerType = "binance";
  private readonly market: Market;
  private readonly baseUrl: string;
  private readonly paths: (typeof PATHS)[Market];

  constructor(credentials: BrokerCredentials = {}) {
    super(credentials);
    // market: 'futures' 명시 시에만 선물, 그 외 전부 현물(안전 기본값).
    this.market =
      String(credentials.market || "spot").toLowerCase() === "futures"
        ? "futures"
        : "spot";
    this.baseUrl = URLS[this.market][this.resolveEnv() === "live" ? "live" : "safe"];
    this.paths = PATHS[this.market];
  }

  /**
   * env 선택자 정규화. 'live' 만 메인넷. testnet/mock/누락/미지정 → SAFE(testnet).
   * 알 수 없는 값도 안전을 위해 testnet 으로 폴백한다.
   */
  private resolveEnv(): Env {
    const raw = String(this.credentials.env || "").toLowerCase();
    if (raw === "live") return "live";
    if (raw === "mock") return "mock";
    return "testnet";
  }

  /** apiKey / apiSecret 을 credentials 에서 읽는다(별칭 허용). 시크릿은 로깅하지 않는다. */
  private get apiKey(): string {
    return String(this.credentials.apiKey || this.credentials.key || "");
  }
  private get apiSecret(): string {
    return String(
      this.credentials.apiSecret || this.credentials.secretKey || this.credentials.secret || "",
    );
  }

  /** HMAC-SHA256(secret, exact query string) → hex. 빈 secret이면 명확히 실패시킨다. */
  private sign(queryString: string): string {
    const secret = this.apiSecret;
    if (!secret) {
      throw new Error("Binance API secret이 설정되지 않았습니다.");
    }
    return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
  }

  /**
   * 공통 HTTP. signed=true 면 timestamp + signature를 쿼리에 부여하고 X-MBX-APIKEY 헤더를 붙인다.
   * 비-2xx 응답은 상태코드 + (민감하지 않은) 본문만으로 throw. 서명된 URL/시크릿은 절대 노출하지 않는다.
   */
  private async request<T = Record<string, unknown>>(
    path: string,
    options?: { method?: string; signed?: boolean; params?: Record<string, string> },
  ): Promise<T> {
    const params = new URLSearchParams(options?.params || {});

    if (options?.signed) {
      if (!this.apiKey) {
        throw new Error("Binance API key가 설정되지 않았습니다.");
      }
      params.set("timestamp", Date.now().toString());
      params.set("signature", this.sign(params.toString()));
    }

    const qs = params.toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;

    const res = await fetch(url, {
      method: options?.method || "GET",
      headers: { "X-MBX-APIKEY": this.apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      // 본문에 Binance 에러 코드(-2013 등)가 들어오므로 reconcile 분기를 위해 포함하되,
      // 서명/시크릿은 URL이 아닌 헤더·쿼리에만 있으므로 본문에는 노출되지 않는다.
      const body = await res.text().catch(() => "");
      throw new Error(`Binance API error: ${res.status} ${res.statusText} ${body}`.trim());
    }
    return (await res.json()) as T;
  }

  // ── 수량 정규화(LOT_SIZE / MIN_NOTIONAL) ──
  private filterCache = new Map<
    string,
    { stepSize: number; minQty: number; minNotional: number; tickSize: number }
  >();

  private async symbolFilters(symbol: string) {
    const cached = this.filterCache.get(symbol);
    if (cached) return cached;

    const info = await this.request<{
      symbols?: Array<{ symbol: string; filters?: Array<Record<string, string>> }>;
    }>(this.paths.exchangeInfo, { params: { symbol } });

    const symInfo =
      info.symbols?.find((s) => s.symbol === symbol) || info.symbols?.[0];
    const filters = (symInfo?.filters || []) as Array<Record<string, string>>;

    const lot =
      filters.find(
        (x) => x.filterType === "LOT_SIZE" || x.filterType === "MARKET_LOT_SIZE",
      ) || {};
    const notional =
      filters.find(
        (x) => x.filterType === "NOTIONAL" || x.filterType === "MIN_NOTIONAL",
      ) || {};
    const price = filters.find((x) => x.filterType === "PRICE_FILTER") || {};

    const f = {
      stepSize: parseFloat(lot.stepSize || "0"),
      minQty: parseFloat(lot.minQty || "0"),
      minNotional: parseFloat(notional.notional || notional.minNotional || "0"),
      tickSize: parseFloat(price.tickSize || "0"),
    };
    this.filterCache.set(symbol, f);
    return f;
  }

  /**
   * 가격을 거래소 tickSize(PRICE_FILTER) 격자로 라운딩. 지정가·스톱가에 적용해야 -1013(PRICE_FILTER) 거부 방지.
   * tickSize 미상 시 원본 반환.
   */
  async normalizePrice(symbol: string, price: number): Promise<number> {
    const { tickSize } = await this.symbolFilters(symbol);
    if (!tickSize || !(price > 0)) return price;
    const rounded = Math.round(price / tickSize) * tickSize;
    const decimals = Math.max(0, Math.round(-Math.log10(tickSize)));
    return parseFloat(rounded.toFixed(decimals));
  }

  /**
   * 주문 수량을 거래소 stepSize로 절사 + minQty/minNotional 보정.
   * +1e-9 epsilon: IEEE-754 오차로 격자선 바로 위 값이 1스텝 깎이는 것 방지.
   */
  async normalizeQuantity(symbol: string, quantity: number, refPrice: number): Promise<number> {
    const { stepSize, minQty, minNotional } = await this.symbolFilters(symbol);
    if (!stepSize) return quantity;
    let q = Math.floor(quantity / stepSize + 1e-9) * stepSize;
    if (minNotional > 0 && refPrice > 0 && q * refPrice < minNotional) {
      q = Math.ceil(minNotional / refPrice / stepSize) * stepSize;
    }
    if (minQty > 0 && q < minQty) q = minQty;
    const decimals = Math.max(0, Math.round(-Math.log10(stepSize)));
    return parseFloat(q.toFixed(decimals));
  }

  /**
   * 체결 평균가 산출. 시장가 주문은 price=0으로 오므로 체결금액/체결수량으로 평단을 만든다.
   * 선물은 avgPrice / cumQuote, 현물은 price / cummulativeQuoteQty 키를 모두 시도한다.
   */
  private fillPriceFrom(data: Record<string, unknown>, fallback = 0): number {
    const price = parseFloat(String(data.avgPrice ?? data.price ?? "0"));
    if (price > 0) return price;
    const execQty = parseFloat(String(data.executedQty ?? "0"));
    const quoteQty = parseFloat(
      String(data.cumQuote ?? data.cummulativeQuoteQty ?? "0"),
    );
    if (execQty > 0 && quoteQty > 0) return quoteQty / execQty;
    return fallback;
  }

  /** Binance 주문 상태 → 포트 OrderResult.status. */
  private mapStatus(status: string): OrderResult["status"] {
    if (status === "FILLED") return "filled";
    if (status === "CANCELED" || status === "REJECTED" || status === "EXPIRED") {
      return "rejected";
    }
    return "pending";
  }

  // ───────────────────────── 잔고 ─────────────────────────
  async getBalance(): Promise<AccountBalance> {
    if (this.market === "futures") {
      const data = await this.request<{
        totalWalletBalance?: string;
        totalUnrealizedProfit?: string;
        availableBalance?: string;
      }>(this.paths.account, { signed: true });
      return {
        totalAsset:
          parseFloat(data.totalWalletBalance || "0") +
          parseFloat(data.totalUnrealizedProfit || "0"),
        cashBalance: parseFloat(data.availableBalance || "0"),
        currency: "USDT",
      };
    }

    const data = await this.request<{
      balances?: Array<{ asset: string; free: string; locked: string }>;
    }>(this.paths.account, { signed: true });
    const balances = data.balances || [];
    const usdt = balances.find((b) => b.asset === "USDT");
    const totalAsset = balances.reduce(
      (sum, b) => sum + parseFloat(b.free) + parseFloat(b.locked),
      0,
    );
    return {
      totalAsset,
      cashBalance: parseFloat(usdt?.free || "0"),
      currency: "USDT",
    };
  }

  /**
   * API 키 권한 점검(읽기전용, 메인넷 파일럿 사전점검용). 현물 baseUrl의 /sapi/v1/account/apiRestrictions.
   * enableWithdrawals=출금권한(반드시 false여야 안전), ipRestrict=IP 화이트리스트 여부(true 권장).
   * 선물 마켓/엔드포인트 미지원 환경에서는 null(점검 불가) 반환 — 호출측이 WARN으로 처리.
   */
  async apiRestrictions(): Promise<{ enableWithdrawals: boolean; ipRestrict: boolean; enableSpotTrading: boolean; enableFutures: boolean } | null> {
    if (this.market !== "spot") return null; // /sapi는 현물 베이스에만 존재
    try {
      const d = await this.request<Record<string, unknown>>("/sapi/v1/account/apiRestrictions", { signed: true });
      return {
        enableWithdrawals: d.enableWithdrawals === true,
        ipRestrict: d.ipRestrict === true,
        enableSpotTrading: d.enableSpotAndMarginTrading === true,
        enableFutures: d.enableFutures === true,
      };
    } catch { return null; } // testnet 등 미지원 → 점검 불가
  }

  // ─────────────────────── 포지션 ───────────────────────
  async getPositions(): Promise<Position[]> {
    if (this.market === "futures") {
      // /fapi/v2/positionRisk — positionAmt 부호=방향(음수=숏). liquidationPrice/unRealizedProfit 신뢰원.
      // (선물 전용 엔드포인트 → 유니온 타입의 this.paths 대신 PATHS.futures 직접 참조)
      const data = await this.request<Array<Record<string, string>>>(
        PATHS.futures.positionRisk,
        { signed: true },
      );
      const rows = Array.isArray(data) ? data : [];
      return rows
        .filter((p) => Math.abs(parseFloat(p.positionAmt || "0")) > 0)
        .map((p) => {
          const amt = parseFloat(p.positionAmt || "0");
          const entry = parseFloat(p.entryPrice || "0");
          const mark = parseFloat(p.markPrice || "0");
          const dir = amt < 0 ? -1 : 1;
          return {
            symbol: p.symbol,
            name: p.symbol,
            // 정규화 형태: 수량은 절대값. 방향은 pnlPercent 부호로 보존(숏은 가격 하락 시 양(+) 수익).
            quantity: Math.abs(amt),
            avgPrice: entry,
            currentPrice: mark,
            pnl: parseFloat(p.unRealizedProfit || "0"),
            pnlPercent:
              entry > 0 ? ((mark - entry) / entry) * 100 * dir : 0,
          };
        });
    }

    // 현물: 잔고에서 보유 자산을 포지션으로 유도(평단/현재가는 미상→0).
    const data = await this.request<{
      balances?: Array<{ asset: string; free: string; locked: string }>;
    }>(this.paths.account, { signed: true });
    return (data.balances || [])
      .filter((b) => parseFloat(b.free) + parseFloat(b.locked) > 0)
      .map((b) => ({
        symbol: b.asset,
        name: b.asset,
        quantity: parseFloat(b.free) + parseFloat(b.locked),
        avgPrice: 0,
        currentPrice: 0,
        pnl: 0,
        pnlPercent: 0,
      }));
  }

  // ─────────────────────── 시세 ───────────────────────
  async getPrice(symbol: string): Promise<MarketPrice> {
    const [tickerResult, statsResult] = await Promise.allSettled([
      this.request<{ price?: string }>(this.paths.tickerPrice, { params: { symbol } }),
      this.request<{ priceChange?: string; priceChangePercent?: string; volume?: string }>(
        this.paths.ticker24,
        { params: { symbol } },
      ),
    ]);

    if (tickerResult.status === "rejected") {
      // reason은 위에서 만든 일반 메시지(상태코드)뿐 → 시크릿 노출 없음.
      throw new Error(`Failed to fetch price for ${symbol}`);
    }

    const ticker = tickerResult.value;
    const stats = statsResult.status === "fulfilled" ? statsResult.value : null;
    if (statsResult.status === "rejected") {
      console.warn(`Failed to fetch 24hr stats for ${symbol}`);
    }

    return {
      symbol,
      price: parseFloat(ticker.price || "0"),
      change: parseFloat(stats?.priceChange || "0"),
      changePercent: parseFloat(stats?.priceChangePercent || "0"),
      volume: parseFloat(stats?.volume || "0"),
      timestamp: new Date(),
    };
  }

  // ─────────────────────── 주문 ───────────────────────
  /**
   * 시장가/지정가 주문. spot=/api/v3/order, futures=/fapi/v1/order.
   * - newClientOrderId(order.clientOrderId)로 멱등 reconcile 가능.
   * - 선물에서 reduceOnly 지정 시 포지션 축소 전용으로 전송(숏 커버 등).
   * - 시장가는 newOrderRespType=RESULT로 체결가(avgPrice/cummulativeQuoteQty) 즉시 수령.
   */
  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    const o = order as FuturesOrderRequest;
    const fut = this.market === "futures";
    // 주문 타입 매핑(spot/futures 상이). 보호주문(stop_*/take_profit_*)은 stopPrice 트리거 필요.
    const typeMap: Record<string, string> = {
      market: "MARKET",
      limit: "LIMIT",
      stop_market: fut ? "STOP_MARKET" : "STOP_LOSS",
      stop_limit: fut ? "STOP" : "STOP_LOSS_LIMIT",
      take_profit_market: fut ? "TAKE_PROFIT_MARKET" : "TAKE_PROFIT",
    };
    const params: Record<string, string> = {
      symbol: o.symbol,
      side: o.side.toUpperCase(),
      type: typeMap[o.type] ?? o.type.toUpperCase(),
      quantity: String(o.quantity),
    };

    if (o.type === "limit" && o.price != null) {
      params.price = String(await this.normalizePrice(o.symbol, o.price)); // tickSize 라운딩(-1013 방지)
      params.timeInForce = "GTC";
    }

    // 보호주문: 트리거 가격(stopPrice) 필수. stop_limit은 지정가(price)도 필요. 둘 다 tickSize 라운딩.
    if ((o.type === "stop_market" || o.type === "stop_limit" || o.type === "take_profit_market") && o.stopPrice != null) {
      params.stopPrice = String(await this.normalizePrice(o.symbol, o.stopPrice));
      if (o.type === "stop_limit" && o.price != null) { params.price = String(await this.normalizePrice(o.symbol, o.price)); params.timeInForce = "GTC"; }
    }

    // 포지션 축소 전용(보호주문·숏커버). 선물 reduceOnly 플래그.
    if (fut && o.reduceOnly) {
      params.reduceOnly = "true";
    }

    // 거래소 멱등키. 동일 clientOrderId 재전송 시 reconcile에 사용(중복 차단은 호출측 책임).
    if (o.clientOrderId) {
      params.newClientOrderId = o.clientOrderId;
    }

    // 시장가는 체결 결과를 즉시 받는다(지정가는 미체결 NEW가 정상이라 미적용).
    if (o.type === "market") {
      params.newOrderRespType = "RESULT";
    }

    const data = await this.request<Record<string, unknown>>(this.paths.order, {
      method: "POST",
      signed: true,
      params,
    });

    return {
      orderId: String(data.orderId ?? ""),
      symbol: o.symbol,
      side: o.side,
      quantity: parseFloat(String(data.executedQty ?? o.quantity ?? 0)),
      price: this.fillPriceFrom(data, o.type === "limit" ? Number(o.price ?? 0) : 0),
      status: this.mapStatus(String(data.status ?? "")),
      timestamp: new Date(Number(data.transactTime ?? data.updateTime ?? Date.now())),
    };
  }

  /**
   * clientOrderId로 주문 조회(모호한 placeOrder 실패 후 reconcile).
   * 주문 없음(-2013/does not exist) → null. 그 외 오류는 throw.
   */
  async getOrderByClientId(
    symbol: string,
    clientOrderId: string,
  ): Promise<OrderResult | null> {
    let data: Record<string, unknown>;
    try {
      data = await this.request<Record<string, unknown>>(this.paths.order, {
        method: "GET",
        signed: true,
        params: { symbol, origClientOrderId: clientOrderId },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("-2013") || msg.toLowerCase().includes("does not exist")) {
        return null;
      }
      throw e;
    }

    if (!data || data.orderId == null) return null;
    return {
      orderId: String(data.orderId),
      symbol,
      side: String(data.side ?? "").toUpperCase() === "SELL" ? "sell" : "buy",
      quantity: parseFloat(String(data.executedQty ?? data.origQty ?? "0")),
      price: this.fillPriceFrom(data),
      status: this.mapStatus(String(data.status ?? "")),
      timestamp: new Date(Number(data.updateTime ?? data.time ?? Date.now())),
    };
  }

  /**
   * 주문 취소. **현물·선물 모두 symbol 필수**(Binance DELETE /order). 이전엔 현물에서 symbol 누락 →
   * -1102(symbol 누락)로 취소 실패(testnet 검증서 적발). symbol 인자 우선, 없으면 credentials.symbol 폴백.
   */
  async cancelOrder(orderId: string, symbol?: string): Promise<boolean> {
    const sym = String(symbol || this.credentials.symbol || "");
    if (!sym) throw new Error("주문 취소에는 symbol이 필요합니다(인자 또는 credentials.symbol).");
    const data = await this.request<{ status?: string }>(this.paths.order, {
      method: "DELETE",
      signed: true,
      params: { orderId, symbol: sym },
    });
    return data.status === "CANCELED";
  }

  /**
   * clientOrderId로 주문 취소(상주 보호주문 정리/트레일링 교체용). Binance DELETE origClientOrderId + symbol.
   * 이미 체결/취소/없음(-2011)이면 false(throw 안 함) — 정리는 멱등적으로.
   */
  async cancelOrderByClientId(symbol: string, clientOrderId: string): Promise<boolean> {
    try {
      const data = await this.request<{ status?: string }>(this.paths.order, {
        method: "DELETE", signed: true, params: { origClientOrderId: clientOrderId, symbol },
      });
      return data.status === "CANCELED";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("-2011") || msg.toLowerCase().includes("unknown order")) return false; // 이미 없음
      throw e;
    }
  }

  /** 심볼의 미체결(상주) 주문 목록. 고아 보호주문 정리·점검용. spot=/api/v3/openOrders, futures=/fapi/v1/openOrders. */
  async getOpenOrders(symbol: string): Promise<OrderResult[]> {
    const path = this.market === "futures" ? "/fapi/v1/openOrders" : "/api/v3/openOrders";
    const data = await this.request<Array<Record<string, unknown>>>(path, { method: "GET", signed: true, params: { symbol } });
    return (Array.isArray(data) ? data : []).map((d) => ({
      orderId: String(d.orderId ?? ""),
      symbol,
      side: String(d.side ?? "").toUpperCase() === "SELL" ? "sell" : "buy",
      quantity: parseFloat(String(d.origQty ?? d.executedQty ?? "0")),
      price: parseFloat(String(d.stopPrice ?? d.price ?? "0")),
      status: this.mapStatus(String(d.status ?? "")),
      timestamp: new Date(Number(d.time ?? d.updateTime ?? Date.now())),
    }));
  }

  /**
   * 현물 OCO(One-Cancels-the-Other) 보호주문. **현물 SELL 전용**(롱 포지션 보호: 익절+손절 묶음).
   * - price=익절 LIMIT_MAKER(현재가 위), stopPrice=손절 트리거(현재가 아래), stopLimitPrice=손절 지정가.
   * - 한쪽 체결 시 거래소가 다른쪽을 자동취소(진짜 OCO). 선물은 OCO 미지원 → throw.
   * - 가격은 normalizePrice(tickSize), 수량은 normalizeQuantity(stepSize)로 라운딩(-1013/-1111 거부 방지).
   */
  async placeOco(p: { symbol: string; quantity: number; takeProfitPrice: number; stopPrice: number; stopLimitPrice?: number; listClientOrderId?: string }): Promise<{ orderListId: string; orders: OrderResult[] }> {
    if (this.market !== "spot") throw new Error("OCO 보호주문은 현물(spot)만 지원합니다.");
    const tp = await this.normalizePrice(p.symbol, p.takeProfitPrice);
    const stopTrigger = await this.normalizePrice(p.symbol, p.stopPrice);
    // 손절 지정가: 미지정 시 트리거보다 0.1% 아래(급락 시 STOP_LOSS_LIMIT 미체결 방지 — 손절은 확실히 나가야 함).
    let stopLimit = await this.normalizePrice(p.symbol, p.stopLimitPrice ?? p.stopPrice * 0.999);
    // 라운딩 충돌 방지(저가 토큰): 지정가가 트리거 이상이 되면 1틱 아래로 강제(STOP_LOSS_LIMIT는 지정가<트리거여야 체결).
    if (stopLimit >= stopTrigger) { const { tickSize } = await this.symbolFilters(p.symbol); stopLimit = await this.normalizePrice(p.symbol, stopTrigger - (tickSize || stopTrigger * 0.001)); }
    const qty = await this.normalizeQuantity(p.symbol, p.quantity, stopTrigger);
    if (!(tp > stopTrigger)) throw new Error(`OCO 가격 관계 오류: 익절가(${tp}) > 손절가(${stopTrigger}) 여야 합니다(SELL OCO).`);
    const params: Record<string, string> = {
      symbol: p.symbol, side: "SELL", quantity: String(qty),
      price: String(tp),                 // 익절 LIMIT_MAKER
      stopPrice: String(stopTrigger),    // 손절 트리거
      stopLimitPrice: String(stopLimit), // 손절 지정가
      stopLimitTimeInForce: "GTC", newOrderRespType: "FULL",
    };
    if (p.listClientOrderId) params.listClientOrderId = p.listClientOrderId; // 멱등키(리스트 단위)
    const data = await this.request<{ orderListId?: number | string; orderReports?: Array<Record<string, unknown>> }>("/api/v3/order/oco", { method: "POST", signed: true, params });
    const orders: OrderResult[] = (data.orderReports || []).map((d) => ({
      orderId: String(d.orderId ?? ""), symbol: p.symbol,
      side: "sell", quantity: parseFloat(String(d.origQty ?? qty)),
      price: parseFloat(String(d.price ?? d.stopPrice ?? "0")),
      status: this.mapStatus(String(d.status ?? "")),
      timestamp: new Date(Number(d.transactTime ?? Date.now())),
    }));
    return { orderListId: String(data.orderListId ?? ""), orders };
  }

  /** OCO 리스트 전체 취소. DELETE /api/v3/orderList?symbol&orderListId. 이미 없음/체결(-2011)은 false(멱등). */
  async cancelOco(symbol: string, orderListId: string): Promise<boolean> {
    if (this.market !== "spot") throw new Error("OCO 취소는 현물(spot)만 지원합니다.");
    try {
      const data = await this.request<{ listOrderStatus?: string }>("/api/v3/orderList", { method: "DELETE", signed: true, params: { symbol, orderListId } });
      return data.listOrderStatus === "ALL_DONE" || data.listOrderStatus === "ALL_FREE";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("-2011") || msg.toLowerCase().includes("unknown order")) return false;
      throw e;
    }
  }

  /** 심볼의 상주 OCO(보호주문) 조회. openOrders에서 orderListId 묶음 → {orderListId, tpPrice(LIMIT_MAKER), slPrice(STOP 트리거)}. 없으면 null. */
  async getOpenOco(symbol: string): Promise<{ orderListId: string; tpPrice: number; slPrice: number } | null> {
    if (this.market !== "spot") return null;
    const data = await this.request<Array<Record<string, unknown>>>("/api/v3/openOrders", { method: "GET", signed: true, params: { symbol } });
    const oco = (Array.isArray(data) ? data : []).filter((o) => String(o.orderListId ?? "-1") !== "-1");
    if (!oco.length) return null;
    const listId = String(oco[0].orderListId);
    const legs = oco.filter((o) => String(o.orderListId) === listId);
    let tpPrice = 0, slPrice = 0;
    for (const o of legs) {
      const type = String(o.type ?? "").toUpperCase();
      if (type.includes("STOP")) slPrice = parseFloat(String(o.stopPrice ?? o.price ?? "0"));
      else tpPrice = parseFloat(String(o.price ?? "0")); // LIMIT_MAKER 익절
    }
    return { orderListId: listId, tpPrice, slPrice };
  }
}
