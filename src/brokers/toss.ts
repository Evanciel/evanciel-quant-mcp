/**
 * brokers/toss.ts — 토스증권(Toss Securities) Open API 전용 어댑터 (quant-mcp v2, BYOK). KR + US.
 *
 * 설계: docs/02-design/features/toss-broker.design.md (Option C + 2 안전강화). 분석: docs/03-analysis/toss-api-analysis-2026-06-19.md.
 * 토스는 KIS/키움과 wire 비호환 → 전용 어댑터(서브클래싱 금지). 토스 고유 규약:
 *   - 인증: POST /oauth2/token (form-urlencoded, client_credentials) → Bearer(~24h). 표준 OAuth2.
 *   - 모든 호출: Authorization: Bearer. 계좌·자산·주문은 X-Tossinvest-Account: {accountSeq} 헤더 추가.
 *   - 성공 envelope: HTTP 2xx + { result: ... }. 실패: 4xx/5xx + { error: { code, message } }. (token 응답만 OAuth2 표준)
 *   - 숫자는 전부 **부호 있는 순수 decimal 문자열**(키움과 달리 abs 금지 — 음수 pnl 보존).
 *   - 주문 응답은 { orderId, clientOrderId }뿐(체결정보 없음) → status="pending", 체결은 getOrderById 재조회.
 *
 * 🔴 안전강화②(라이브-쓰기 하드블록): 토스는 **모의 호스트가 없다**(단일 라이브 호스트). 따라서 placeOrder/cancelOrder는
 *   어댑터 레벨에서 env="live"(+주문은 LIVE_TRADING_ENABLED)일 때만 허용 — checkLimits 마스터-OFF 단락(safety.ts:97)으로
 *   "페이퍼인데 실호스트 무캡 도달"하던 구멍을 봉쇄(defense-in-depth, liveGate와 독립). 페이퍼 매매는 러너가 liveGate 미통과로 시뮬레이션.
 *
 * 불변식(절대 위반 금지):
 *   - getOrderByClientId **미구현**(undefined 유지) → runner reconcile이 토스를 KR 포지션-reconcile 경로로 라우팅(runner.ts:351). 추가 시 유령 포지션.
 *   - 보호주문(stop_x / take_profit_x) 미지원 → fail-closed throw(지정가 silent 둔갑 금지).
 *   - 주문 POST(placeOrder/cancelOrder)는 절대 withRetry 금지(비멱등, 이중주문). GET 읽기만 재시도.
 *
 * 보안(BYOK): 시크릿(clientSecret)은 주입된 this.credentials에서만 읽음(process.env 직접접근 금지). 토큰/시크릿 절대 로그 금지.
 *   (예외: LIVE_TRADING_ENABLED는 시크릿이 아닌 글로벌 운영 플래그 — 하드블록 defense-in-depth용으로만 process.env 조회.)
 */
import { BaseBrokerAdapter, withRetry } from "./base.js";
import { roundToKrxTick, isKrSymbol } from "./krx-tick.js";
import type {
  BrokerType,
  BrokerCredentials,
  AccountBalance,
  Position,
  MarketPrice,
  OrderRequest,
  OrderResult,
} from "./types.js";

const BASE_URL = "https://openapi.tossinvest.com"; // 단일 호스트(메인넷 하드코딩 아님 — 토스는 모의/별도 호스트가 없음)
const TIMEOUT_MS = 10_000;
/** 토큰 수명 ~24h. 실제 만료보다 5분 일찍 갱신(엣지케이스 회피). */
const TOKEN_SKEW_MS = 5 * 60 * 1000;
const CANDLE_PAGE_MAX = 200; // 토스 캔들 1페이지 최대 봉 수

/** decimal 문자열 → number. ⚠️ no-abs: 토스 decimal은 부호 보존(음수 pnl을 abs로 양수 둔갑 → 서킷 오작동 방지). 비유한=0. */
function toNum(v: unknown): number {
  if (v == null) return 0;
  const n = parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : 0;
}

interface TossEnvelope {
  result?: unknown;
  error?: { code?: string; message?: string };
}

export class TossBrokerAdapter extends BaseBrokerAdapter {
  type: BrokerType = "toss";

  private readonly env: string; // "live" 기본(loadCredentials). 토스는 모의 호스트 없음.
  private readonly baseUrl = BASE_URL;
  private readonly accountSeq: string;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(credentials: BrokerCredentials = {}) {
    super(credentials);
    this.env = (credentials.env ?? "live").toString();
    // 계좌 식별 키(X-Tossinvest-Account). loadCredentials가 accountSeq로 주입(account 별칭도 허용).
    this.accountSeq = (this.credentials.accountSeq ?? this.credentials.account ?? "").toString().trim();
  }

  // ── 자격증명 접근(undefined-safe). 시크릿은 절대 로그/메시지 노출 금지. ──
  private get clientId(): string {
    return (this.credentials.clientId ?? this.credentials.client_id ?? "").toString();
  }
  private get clientSecret(): string {
    return (this.credentials.clientSecret ?? this.credentials.client_secret ?? "").toString();
  }

  /**
   * 🔴 라이브-쓰기 하드블록(fail-closed). 토스는 모의 호스트가 없어 모든 주문 POST가 실거래다.
   * placeOrder: env="live" + LIVE_TRADING_ENABLED=true 필수(마스터 OFF=페이퍼는 러너가 처리).
   * cancelOrder: env="live"만 요구(위험축소라 마스터 불요 — 라이브 주문이 있으면 항상 취소 가능, mock에선 차단).
   */
  private assertWriteAllowed(op: string, requireMaster: boolean): void {
    if (this.env !== "live") {
      throw new Error(`Toss ${op} 차단(fail-closed): 토스는 모의 호스트가 없어 모든 주문이 실거래입니다. TOSS_ENV=live 에서만 허용(현재 env=${this.env}).`);
    }
    if (requireMaster) {
      const master = (process.env.LIVE_TRADING_ENABLED ?? "").trim() === "true";
      if (!master) {
        throw new Error(`Toss ${op} 차단(fail-closed): LIVE_TRADING_ENABLED=true 필요(마스터 OFF=페이퍼). 페이퍼 매매는 러너가 liveGate 미통과로 시뮬레이션 처리합니다.`);
      }
    }
  }

  private isTokenExpired(): boolean {
    return Date.now() >= this.tokenExpiresAt - TOKEN_SKEW_MS;
  }

  /** OAuth2 client_credentials → Bearer(~24h 캐시). form-urlencoded. */
  private async getToken(): Promise<string> {
    if (this.accessToken && !this.isTokenExpired()) return this.accessToken;
    if (!this.clientId || !this.clientSecret) {
      throw new Error("Toss credentials missing (clientId/clientSecret required)");
    }
    let res: Response;
    try {
      const form = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
      });
      res = await fetch(`${this.baseUrl}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Error("Toss token request failed (network)");
    }
    if (!res.ok) throw new Error(`Toss token request failed: ${res.status}`); // 시크릿/바디 미노출, 상태코드만
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const token = data.access_token as string | undefined;
    if (!token) throw new Error("Toss token response missing access_token");
    this.accessToken = token;
    const secs = toNum(data.expires_in);
    this.tokenExpiresAt = Date.now() + (secs > 0 ? secs * 1000 : 3600 * 1000); // 없으면 보수적 1h
    return token;
  }

  /**
   * 공통 요청. account=true면 X-Tossinvest-Account 헤더. 성공 시 envelope.result 반환.
   * 실패는 [http:N]/[retry-after:S] 마커를 심어 throw(base.classifyRetryableError가 429/5xx/408만 재시도; 4xx 비재시도).
   * ⚠️ 이 메서드 자체는 재시도 안 함 — GET은 호출측 getJson(withRetry), 주문 POST는 절대 재시도 금지.
   */
  private async request(method: string, path: string, opts?: { account?: boolean; body?: unknown }): Promise<unknown> {
    const token = await this.getToken();
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (opts?.account) {
      if (!this.accountSeq) throw new Error("Toss accountSeq missing (X-Tossinvest-Account) — TOSS_ACCOUNT_SEQ 설정 필요");
      headers["X-Tossinvest-Account"] = this.accountSeq;
    }
    if (opts?.body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      // 타임아웃/네트워크 — 원 에러명 보존(withRetry가 TimeoutError/fetch failed 등을 재시도 가능으로 분류).
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      throw new Error(`Toss API request failed (network) [${detail}]`);
    }

    const text = await res.text().catch(() => "");
    let parsed: TossEnvelope = {};
    if (text) { try { parsed = JSON.parse(text) as TossEnvelope; } catch { /* 비-JSON 응답 */ } }

    if (!res.ok) {
      if (res.status === 401) this.accessToken = null; // 만료/무효 토큰 → 다음 호출 재발급
      const ra = res.headers.get("retry-after");
      const markers = `[http:${res.status}]${ra && /^\d+$/.test(ra.trim()) ? ` [retry-after:${ra.trim()}]` : ""}`;
      const code = parsed?.error?.code ? ` ${parsed.error.code}` : ""; // 에러코드는 시크릿 아님(식별용)
      throw new Error(`Toss API error: ${res.status}${code} ${markers}`);
    }
    return parsed.result;
  }

  /** GET 멱등 읽기 전용 재시도 래퍼(429/5xx/타임아웃). 주문 POST에는 절대 사용 금지. */
  private getJson(path: string, account = false): Promise<unknown> {
    return withRetry(() => this.request("GET", path, { account }), { attempts: 3, baseDelayMs: 400, maxDelayMs: 8000 });
  }

  // ── 시세 ──

  async getPrice(symbol: string): Promise<MarketPrice> {
    try {
      const sym = symbol.trim();
      const result = await this.getJson(`/api/v1/prices?symbols=${encodeURIComponent(sym)}`);
      const arr = Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
      const row = arr.find((r) => String(r.symbol).trim() === sym) ?? arr[0];
      if (!row) throw new Error(`시세 없음(${symbol})`); // fail-closed: 빈 응답을 가격 0으로 둔갑 금지
      return {
        symbol: sym,
        price: toNum(row.lastPrice),
        change: 0, // 토스 현재가 API는 등락 미제공(주문 참조가엔 현재가로 충분)
        changePercent: 0,
        volume: 0,
        timestamp: row.timestamp ? new Date(String(row.timestamp)) : new Date(),
      };
    } catch (error) {
      throw new Error(`Failed to fetch price for ${symbol}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  /**
   * OHLCV 캔들(러너/대시보드/백테스트). 토스는 **interval 1m/1d만** 지원 → 그 외 fail-closed throw(silent 빈배열 금지).
   * 페이지당 최대 200봉 → count>200이면 nextBefore 커서로 페이지네이션. timestamp는 ISO 8601(+09:00 KR / US 오프셋) 그대로 사용.
   */
  async getCandles(
    symbol: string,
    interval = "1d",
    count = 300,
  ): Promise<{ date: string; datetime: string; open: number; high: number; low: number; close: number; volume: number }[]> {
    const iv = String(interval).toLowerCase();
    const tossIv = iv === "1m" || iv === "1min" ? "1m" : iv === "1d" || iv === "1day" || iv === "day" ? "1d" : null;
    if (!tossIv) throw new Error(`Toss getCandles: interval '${interval}' 미지원(1m/1d만). 토스 봇은 1d 또는 1m 사용.`);
    const sym = symbol.trim();
    const target = Math.max(1, count);
    const byDt = new Map<string, { date: string; datetime: string; open: number; high: number; low: number; close: number; volume: number }>();
    let before: string | undefined;
    const maxPages = Math.ceil(target / CANDLE_PAGE_MAX) + 2; // 안전 상한(무한 루프 방지)
    for (let page = 0; page < maxPages && byDt.size < target; page++) {
      const pageSize = Math.min(CANDLE_PAGE_MAX, target - byDt.size + 1); // +1: 경계 중복 흡수
      let path = `/api/v1/candles?symbol=${encodeURIComponent(sym)}&interval=${tossIv}&count=${pageSize}`;
      if (before) path += `&before=${encodeURIComponent(before)}`;
      const result = (await this.getJson(path)) as { candles?: unknown; nextBefore?: unknown } | null;
      const candles = Array.isArray(result?.candles) ? (result!.candles as Record<string, unknown>[]) : [];
      if (!candles.length) break;
      for (const c of candles) {
        const ts = String(c.timestamp ?? "");
        if (!ts) continue;
        byDt.set(ts, {
          date: ts.slice(0, 10),
          datetime: ts, // ISO 8601 + 오프셋(Date.parse 정확)
          open: toNum(c.openPrice),
          high: toNum(c.highPrice),
          low: toNum(c.lowPrice),
          close: toNum(c.closePrice),
          volume: toNum(c.volume),
        });
      }
      const nb = result?.nextBefore;
      if (!nb || typeof nb !== "string") break;
      before = nb;
    }
    const bars = [...byDt.values()]
      .filter((b) => b.close > 0 && b.date.length === 10)
      .sort((a, b) => a.datetime.localeCompare(b.datetime)); // 오래된→최신
    return bars.slice(-target);
  }

  // ── 계좌·자산 ──

  /** 평가잔고 요약. 토스는 KR+US 혼합이나 AccountBalance는 단일 통화 → KRW 기준(국내 증권사 기축통화). cash=KRW 매수가능금액. */
  async getBalance(): Promise<AccountBalance> {
    try {
      const [ov, bp] = await Promise.all([
        this.getJson("/api/v1/holdings", true) as Promise<Record<string, unknown> | null>,
        this.getJson("/api/v1/buying-power?currency=KRW", true).catch(() => null) as Promise<Record<string, unknown> | null>,
      ]);
      // fail-closed: holdings 응답이 비정형(marketValue/items 부재)이면 throw(빈 응답을 '자산 0'으로 둔갑 금지).
      if (!ov || (ov.marketValue == null && ov.items == null)) {
        throw new Error("holdings 응답 비정형(marketValue/items 부재)");
      }
      const mv = (ov.marketValue ?? {}) as Record<string, unknown>;
      const amt = (mv.amount ?? {}) as Record<string, unknown>;
      const krwMarketValue = toNum(amt.krw); // KR 보유 평가액(환율 환산 미포함 — usd는 별도)
      const cash = bp ? toNum(bp.cashBuyingPower) : 0;
      return { totalAsset: krwMarketValue + cash, cashBalance: cash, currency: "KRW" };
    } catch (error) {
      throw new Error(`Failed to fetch balance: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  /** 보유 종목(KR+US 혼재). HoldingsOverview.items[] → Position[]. profitLoss.rate는 소수비율 → ×100(퍼센트). */
  async getPositions(): Promise<Position[]> {
    try {
      const ov = (await this.getJson("/api/v1/holdings", true)) as Record<string, unknown> | null;
      // fail-closed: items 배열 부재 = 비정형 → throw(빈 응답을 '보유 0'으로 둔갑 금지).
      if (!ov || !Array.isArray(ov.items)) throw new Error("holdings.items 배열 부재");
      const out: Position[] = [];
      for (const it of ov.items as Record<string, unknown>[]) {
        const qty = toNum(it.quantity);
        if (qty === 0) continue;
        const pl = (it.profitLoss ?? {}) as Record<string, unknown>;
        out.push({
          symbol: String(it.symbol ?? "").trim(),
          name: String(it.name ?? "").trim(),
          quantity: qty,
          avgPrice: toNum(it.averagePurchasePrice),
          currentPrice: toNum(it.lastPrice),
          pnl: toNum(pl.amount),
          pnlPercent: toNum(pl.rate) * 100, // 토스 rate=소수비율(0.1077) → 10.77(%)
        });
      }
      return out;
    } catch (error) {
      throw new Error(`Failed to fetch positions: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  // ── 주문(쓰기 — 🔴 하드블록 경유) ──

  /**
   * 주문 생성(POST /api/v1/orders). 수량기반(KR/US). market/limit만(보호주문 fail-closed).
   * 응답은 { orderId }뿐(체결정보 없음) → status="pending"(체결은 getOrderById 재조회). orderId 부재=유령주문 → throw.
   */
  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    if (order.type !== "market" && order.type !== "limit") {
      throw new Error(`Toss는 거래소 상주 보호주문(${order.type}) 미지원 — 일반 주문으로 대체하지 않음(fail-closed). market/limit만 허용.`);
    }
    this.assertWriteAllowed("placeOrder", true); // env=live + 마스터 ON 필수
    try {
      const sym = order.symbol.trim();
      const kr = isKrSymbol(sym);
      const isMarket = order.type === "market";
      const amountBased = order.orderAmount != null && order.orderAmount > 0;
      // 금액기반(orderAmount)은 US MARKET 전용(스펙 OrderCreateAmountBased). KR/지정가는 fail-closed.
      if (amountBased && (kr || !isMarket)) {
        throw new Error("Toss 금액기반 주문(orderAmount)은 US MARKET 전용 — KR/지정가 불가(fail-closed).");
      }
      const body: Record<string, unknown> = {
        symbol: sym,
        side: order.side === "buy" ? "BUY" : "SELL",
        orderType: isMarket ? "MARKET" : "LIMIT",
      };
      if (amountBased) {
        body.orderAmount = String(order.orderAmount); // 달러 금액(체결 수량은 거래소가 결정 — OrderCreateAmountBased)
      } else {
        // 수량: KR·US LIMIT은 정수(스펙 quantity=^\d+$). US MARKET만 소수주 허용(소수주는 LIMIT 불가 — fractionalQuantityUsMarketOnly).
        //   → US LIMIT에 소수 수량을 보내면 400 invalid-request로 silent 실패하던 버그 차단(적대검증 M2).
        const fractionalOk = !kr && isMarket;
        body.quantity = String(fractionalOk ? order.quantity : Math.max(0, Math.floor(order.quantity)));
        // 지정가: KR은 KRX 호가단위 정렬 필수(미정렬 시 invalid-tick-size 거부), US는 그대로.
        if (!isMarket) body.price = String(kr ? roundToKrxTick(order.price ?? 0) : (order.price ?? 0));
      }
      if (order.clientOrderId) body.clientOrderId = order.clientOrderId.slice(0, 36); // 멱등키(최대 36자)

      const result = (await this.request("POST", "/api/v1/orders", { account: true, body })) as { orderId?: unknown } | null;

      // fail-closed: orderId 부재/비문자열·숫자 = 신뢰불가 응답 → 유령 pending 금지(throw).
      if (result == null || (typeof result.orderId !== "string" && typeof result.orderId !== "number")) {
        throw new Error("Toss order response invalid (no orderId) — 신뢰불가(fail-closed)");
      }
      const orderId = String(result.orderId);
      if (!orderId) throw new Error("Toss order accepted but orderId empty");

      return {
        orderId,
        symbol: sym,
        side: order.side,
        quantity: order.quantity,
        // 토스 접수 응답엔 체결가 없음(시장가=0, 지정가=주문가). 호출측(runner)이 '체결가 미확인'을 reconcile로 확정.
        price: isMarket ? 0 : (order.price ?? 0),
        status: "pending", // 접수=비동기, 체결 별도(getOrderById/reconcile)
        timestamp: new Date(),
      };
    } catch (error) {
      throw new Error(`Failed to place ${order.side} order for ${order.symbol}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  /** 주문 취소(POST /api/v1/orders/{orderId}/cancel, 빈 바디). 2xx=접수(새 orderId 무시). 4xx(이미 체결/취소/없음)=false. */
  async cancelOrder(orderId: string, _symbol?: string): Promise<boolean> {
    this.assertWriteAllowed("cancelOrder", false); // env=live(마스터 불요 — 위험축소)
    try {
      await this.request("POST", `/api/v1/orders/${encodeURIComponent(orderId)}/cancel`, { account: true, body: {} });
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 4xx(이미 체결/취소/없음 등)는 취소 '거부'이지 시스템 오류가 아님 → false. 5xx/네트워크는 전파(상위 재시도/경보).
      if (/\[http:4\d\d\]/.test(msg)) {
        console.warn(`[toss] cancel rejected: ${msg}`);
        return false;
      }
      throw new Error(`Failed to cancel order ${orderId}: ${msg}`);
    }
  }

  // ── 주문 조회(읽기) ──

  /**
   * 미체결(상주) 주문 목록(GET /api/v1/orders?status=OPEN). audit P1-10 패턴.
   * fail-closed: orders 배열 부재 시 throw(silent 빈배열='미체결 없음' 둔갑 금지).
   * ⚠️ getOrderByClientId는 추가하지 말 것 — runner reconcile 판별자(getOrderByClientId===undefined)가 토스를 KR
   *   포지션-reconcile 경로로 보내는 근거다(runner.ts:351). 추가 시 KR reconcile이 꺼져 유령 포지션.
   */
  async getOpenOrders(symbol: string): Promise<OrderResult[]> {
    try {
      const sym = (symbol ?? "").trim();
      let path = "/api/v1/orders?status=OPEN";
      if (sym) path += `&symbol=${encodeURIComponent(sym)}`;
      const result = (await this.getJson(path, true)) as { orders?: unknown } | null;
      if (!result || !Array.isArray(result.orders)) throw new Error("orders 배열 부재");
      const out: OrderResult[] = [];
      for (const o of result.orders as Record<string, unknown>[]) {
        const orderId = String(o.orderId ?? "");
        if (!orderId) continue;
        if (sym && String(o.symbol ?? "").trim() !== sym) continue; // 요청 종목만(서버 폴백 방어)
        const exec = (o.execution ?? {}) as Record<string, unknown>;
        const filled = toNum(exec.filledQuantity);
        const origQty = toNum(o.quantity);
        out.push({
          orderId,
          symbol: String(o.symbol ?? sym).trim(),
          side: String(o.side ?? "").toUpperCase() === "SELL" ? "sell" : "buy",
          quantity: Math.max(0, origQty - filled), // 미체결 잔량
          price: toNum(o.price),
          status: "pending", // OPEN = 접수/부분 → pending
          executedQty: filled, // 부분체결 가시화
          origQty,
          timestamp: o.orderedAt ? new Date(String(o.orderedAt)) : new Date(),
        });
      }
      return out;
    } catch (error) {
      // fail-closed: 조회 실패는 빈 배열 금지(silent empty = '미체결 없음' 둔갑). throw → live-handler가 ok:false 변환.
      throw new Error(`Failed to fetch open orders for ${symbol || "all"}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  /** 주문 상세(GET /api/v1/orders/{orderId}). 수동 지정가 체결 추적(getOrderStatus). 없으면 null. */
  async getOrderById(symbol: string, orderId: string): Promise<OrderResult | null> {
    try {
      const o = (await this.getJson(`/api/v1/orders/${encodeURIComponent(orderId)}`, true)) as Record<string, unknown> | null;
      if (!o || !o.orderId) return null;
      const exec = (o.execution ?? {}) as Record<string, unknown>;
      const filled = toNum(exec.filledQuantity);
      const st = String(o.status ?? "").toUpperCase();
      // 종료상태만 'rejected'. CANCEL_REJECTED/REPLACE_REJECTED는 정정·취소 요청 거부일 뿐 원주문은 살아있음(이전 상태 복귀)
      //   → 'rejected'로 보면 살아있는 주문을 죽은 것으로 오판 → pending 유지(미상은 reconcile이 진실 판정). 적대검증 N1.
      const status: "filled" | "pending" | "rejected" = st === "FILLED" ? "filled" : st === "REJECTED" ? "rejected" : "pending";
      return {
        orderId: String(o.orderId),
        symbol: String(o.symbol ?? symbol).trim(),
        side: String(o.side ?? "").toUpperCase() === "SELL" ? "sell" : "buy",
        quantity: toNum(o.quantity),
        price: toNum(exec.averageFilledPrice) || toNum(o.price), // 체결 평균가 우선, 없으면 주문가
        status,
        executedQty: filled,
        origQty: toNum(o.quantity),
        timestamp: o.orderedAt ? new Date(String(o.orderedAt)) : new Date(),
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/order-not-found|\[http:404\]/i.test(msg)) return null; // 없는 주문 → null(정상)
      throw e;
    }
  }

  // ── 수량 정규화 ──

  /** KR=정수주(소수 거부 → floor), US=소수주 허용. 음수 방지. (보호주문 normalizeQuantity 호출 경로도 공유.) */
  async normalizeQuantity(symbol: string, quantity: number): Promise<number> {
    if (isKrSymbol(symbol)) return Math.max(0, Math.floor(quantity));
    return Math.max(0, quantity);
  }

  // getOrderByClientId / cancelOrderByClientId / placeOco / cancelOco / getOpenOco / baseAssetOf:
  //   **의도적 미구현(undefined)** — getOrderByClientId 부재가 reconcile 라우팅 근거(불변식). OCO/보호주문은 토스 미지원.
}
