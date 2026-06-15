/**
 * brokers/kis.ts — Korea Investment Securities (한국투자증권 / KIS) adapter.
 *
 * Implements the v2 BrokerAdapter port (src/brokers/types.ts) on top of BaseBrokerAdapter.
 * Ported from stock-autotrade/src/lib/brokers/hantoo.ts (OAuth + tr_id 2x2 logic) and the
 * quant-mcp v2 design §7.
 *
 * Wire facts (design §7):
 *   - OAuth2: POST {base}/oauth2/tokenP {grant_type:'client_credentials',appkey,appsecret}
 *     → access_token (~24h). CACHED in-memory; not minted per call.
 *   - Order: POST /uapi/domestic-stock/v1/trading/order-cash with headers
 *     authorization Bearer + appkey + appsecret + tr_id + custtype 'P' + hashkey.
 *   - hashkey: POST /uapi/hashkey of the JSON body → HASH header value.
 *   - tr_id 2x2: T=live / V=mock. Order codes updated for the 2025 NXT(대체거래소) revision —
 *     buy TTTC0012U / sell TTTC0011U / cancel TTTC0013U / balance TTTC8434R (mock = V-prefix).
 *     (Verified 2026-06 against official koreainvestment/open-trading-api examples_llm.)
 *   - Body fields are UPPER_SNAKE: CANO / ACNT_PRDT_CD / PDNO / ORD_DVSN / ORD_QTY / ORD_UNPR
 *     + EXCG_ID_DVSN_CD='KRX' (now REQUIRED on order-cash AND order-rvsecncl since the NXT revision).
 *   - Host:port — mock 29443 / live 9443. Success = rt_cd === '0'.
 *
 * Credentials (Record<string,string>, injected by caller — never read process.env here):
 *   { env: 'mock'|'live', appkey, appsecret, account }
 *   account is 'CANO-ACNT_PRDT_CD', e.g. '12345678-01' (8-digit account no + 2-digit product code).
 *
 * Security: secrets are never logged. Errors throw generic messages (no secret / signed url leak).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { BaseBrokerAdapter } from "./base.js";
import { roundToKrxTick } from "./krx-tick.js";
import type {
  BrokerType,
  AccountBalance,
  Position,
  MarketPrice,
  OrderRequest,
  OrderResult,
} from "./types.js";

/**
 * 주문 응답 안전필드 검증(fail-closed). KIS는 호출부의 rt_cd!=='0' 게이트가 1차 방어이나, rt_cd==='0'(접수 성공)인데
 * output.ODNO(주문번호)가 없거나 비문자열이면 현재 코드가 orderId='' 폴백으로 '유령 접수'를 만든다(주문번호 없는
 * pending = 신뢰불가). → rt_cd 게이트 '직후'에만 추가 검증(기존 rt_cd 로직 보존, 중복 게이트 회피).
 * 키움 'ord_no missing'(P0-3)과 동형. (라이브 미배선이라 현 영향 0 — 미래 배선 대비 하드닝.)
 */
const KisOrderOutputSchema = z
  .object({
    output: z.object({ ODNO: z.string().min(1) }).passthrough(),
  })
  .passthrough();

/** KIS environment selector. Defaults to the SAFE value (mock) when unset/unknown. */
type KisEnv = "mock" | "live";

/**
 * Base URLs keyed by env. NEVER hardcode the live host into the order path — it is selected
 * here by credentials.env, defaulting to the safe (mock/paper) endpoint when missing.
 */
const URLS: Record<KisEnv, string> = {
  mock: "https://openapivts.koreainvestment.com:29443",
  live: "https://openapi.koreainvestment.com:9443",
};

/**
 * tr_id table (2x2 + reads). T-prefix = live, V-prefix = mock.
 * Order tr_ids follow the 2025 NXT revision (buy 0012U / sell 0011U / cancel 0013U); balance 8434R unchanged.
 * Source: official koreainvestment/open-trading-api examples_llm/domestic_stock (order_cash, order_rvsecncl).
 */
const TR_IDS: Record<KisEnv, { buy: string; sell: string; balance: string; cancel: string }> = {
  live: { buy: "TTTC0012U", sell: "TTTC0011U", balance: "TTTC8434R", cancel: "TTTC0013U" },
  mock: { buy: "VTTC0012U", sell: "VTTC0011U", balance: "VTTC8434R", cancel: "VTTC0013U" },
};

/** 거래소 ID 구분 코드. 2025 NXT(대체거래소) 개편 이후 주문/취소 바디 필수 필드. KRX=한국거래소. */
const EXCG_ID_DVSN_CD = "KRX";

/** inquire-price tr_id is identical for live and mock (read-only quotation). */
const TR_ID_PRICE = "FHKST01010100";

/** Network timeout for every request (ms). */
const REQUEST_TIMEOUT_MS = 10_000;

/** Refresh the cached token this many ms before its real expiry to avoid edge races. */
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Fallback token TTL (s) when the broker omits expires_in. KIS tokens live ~24h. */
const DEFAULT_TOKEN_TTL_SECONDS = 24 * 60 * 60;

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  token_type?: string;
}

interface HashkeyResponse {
  HASH?: string;
}

/** Common envelope fields on KIS REST responses. rt_cd '0' = success. */
interface KisEnvelope {
  rt_cd?: string;
  msg_cd?: string;
  msg1?: string;
}

interface BalanceHolding {
  pdno?: string;
  prdt_name?: string;
  hldg_qty?: string;
  pchs_avg_pric?: string;
  prpr?: string;
  evlu_pfls_amt?: string;
  evlu_pfls_rt?: string;
}

interface BalanceSummary {
  tot_evlu_amt?: string;
  dnca_tot_amt?: string;
}

interface BalanceResponse extends KisEnvelope {
  output1?: BalanceHolding[];
  output2?: BalanceSummary[];
}

interface PriceOutput {
  stck_prpr?: string;
  prdy_vrss?: string;
  prdy_ctrt?: string;
  acml_vol?: string;
}

interface PriceResponse extends KisEnvelope {
  output?: PriceOutput;
}

interface OrderOutput {
  ODNO?: string;
  ORD_TMD?: string;
}

interface OrderResponse extends KisEnvelope {
  output?: OrderOutput;
}

/** Coerce a possibly-missing string field to a finite number (0 on junk). */
function num(value: string | undefined | null): number {
  const n = Number.parseFloat(value ?? "");
  return Number.isFinite(n) ? n : 0;
}

/** Coerce a possibly-missing string field to a finite integer (0 on junk). */
function int(value: string | undefined | null): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

export class KisBrokerAdapter extends BaseBrokerAdapter {
  readonly type: BrokerType = "hantoo";

  private readonly env: KisEnv;
  private readonly baseUrl: string;
  private readonly appkey: string;
  private readonly appsecret: string;
  /** 8-digit account number (CANO). */
  private readonly cano: string;
  /** 2-digit account product code (ACNT_PRDT_CD). */
  private readonly acntPrdtCd: string;

  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  /** De-dupe concurrent token mints so a burst of calls issues a single OAuth request. */
  private tokenInFlight: Promise<string> | null = null;

  constructor(credentials: Record<string, string> = {}) {
    super(credentials);

    // env selector — default to the SAFE (mock/paper) endpoint when missing/unknown.
    const rawEnv = (credentials.env ?? "").trim().toLowerCase();
    this.env = rawEnv === "live" ? "live" : "mock";
    this.baseUrl = URLS[this.env];

    this.appkey = (credentials.appkey ?? "").trim();
    this.appsecret = (credentials.appsecret ?? "").trim();

    // account 'CANO-ACNT_PRDT_CD' e.g. '12345678-01'. Tolerate the no-dash 10-char form too.
    const account = (credentials.account ?? "").trim();
    if (account.includes("-")) {
      const [cano, prdt] = account.split("-");
      this.cano = (cano ?? "").trim();
      this.acntPrdtCd = (prdt ?? "").trim();
    } else if (account.length >= 10) {
      this.cano = account.slice(0, 8);
      this.acntPrdtCd = account.slice(8, 10);
    } else {
      this.cano = account;
      this.acntPrdtCd = "";
    }
  }

  // ----------------------------------------------------------------------------
  // Auth (OAuth2 client_credentials, ~24h token, cached)
  // ----------------------------------------------------------------------------

  private isTokenValid(): boolean {
    return this.accessToken !== null && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_SKEW_MS;
  }

  private async getToken(): Promise<string> {
    if (this.isTokenValid()) {
      return this.accessToken as string;
    }
    if (this.tokenInFlight) {
      return this.tokenInFlight;
    }
    if (!this.appkey || !this.appsecret) {
      throw new Error("KIS auth failed: missing API credentials");
    }

    this.tokenInFlight = this.mintToken().finally(() => {
      this.tokenInFlight = null;
    });
    return this.tokenInFlight;
  }

  private async mintToken(): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/oauth2/tokenP`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          appkey: this.appkey,
          appsecret: this.appsecret,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error("KIS auth request failed: network error");
    }

    if (!res.ok) {
      // Do not echo the body — KIS error bodies can reflect request fields.
      throw new Error(`KIS auth request failed: HTTP ${res.status}`);
    }

    let data: TokenResponse;
    try {
      data = (await res.json()) as TokenResponse;
    } catch {
      throw new Error("KIS auth failed: malformed token response");
    }

    if (!data.access_token) {
      throw new Error("KIS auth failed: missing access_token");
    }

    this.accessToken = data.access_token;
    const ttlSeconds =
      typeof data.expires_in === "number"
        ? data.expires_in
        : Number.parseInt(String(data.expires_in ?? ""), 10);
    const effectiveTtl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : DEFAULT_TOKEN_TTL_SECONDS;
    this.tokenExpiresAt = Date.now() + effectiveTtl * 1000;

    return this.accessToken;
  }

  /**
   * hashkey: KIS requires a server-issued hash of the request body for trading POSTs.
   * POST /uapi/hashkey {body} → { HASH }. Sent as the `hashkey` header on order-cash.
   */
  private async getHashkey(body: Record<string, string>): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/uapi/hashkey`, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          appkey: this.appkey,
          appsecret: this.appsecret,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error("KIS hashkey request failed: network error");
    }

    if (!res.ok) {
      throw new Error(`KIS hashkey request failed: HTTP ${res.status}`);
    }

    let data: HashkeyResponse;
    try {
      data = (await res.json()) as HashkeyResponse;
    } catch {
      throw new Error("KIS hashkey failed: malformed response");
    }

    if (!data.HASH) {
      throw new Error("KIS hashkey failed: missing HASH");
    }
    return data.HASH;
  }

  // ----------------------------------------------------------------------------
  // Generic signed request helper
  // ----------------------------------------------------------------------------

  private async request<T>(
    path: string,
    opts: {
      method?: "GET" | "POST";
      trId: string;
      body?: Record<string, string>;
      extraHeaders?: Record<string, string>;
    },
  ): Promise<T> {
    const token = await this.getToken();

    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey: this.appkey,
      appsecret: this.appsecret,
      tr_id: opts.trId,
      custtype: "P",
      ...opts.extraHeaders,
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error("KIS API request failed: network error");
    }

    if (!res.ok) {
      throw new Error(`KIS API error: HTTP ${res.status}`);
    }

    try {
      return (await res.json()) as T;
    } catch {
      throw new Error("KIS API error: malformed response");
    }
  }

  private assertAccount(action: string): void {
    if (!this.cano || !this.acntPrdtCd) {
      throw new Error(`Cannot ${action}: account is missing or malformed in credentials`);
    }
  }

  // ----------------------------------------------------------------------------
  // Reads — balance / positions / price
  // ----------------------------------------------------------------------------

  async getBalance(): Promise<AccountBalance> {
    this.assertAccount("fetch balance");

    const qs = this.balanceQuery();
    const data = await this.request<BalanceResponse>(
      `/uapi/domestic-stock/v1/trading/inquire-balance?${qs}`,
      { trId: TR_IDS[this.env].balance },
    );

    if (data.rt_cd !== "0") {
      throw new Error(`KIS balance query rejected: ${data.msg_cd ?? "unknown"}`);
    }

    const summary = data.output2?.[0] ?? {};
    return {
      totalAsset: num(summary.tot_evlu_amt),
      cashBalance: num(summary.dnca_tot_amt),
      currency: "KRW",
    };
  }

  async getPositions(): Promise<Position[]> {
    this.assertAccount("fetch positions");

    const qs = this.balanceQuery();
    const data = await this.request<BalanceResponse>(
      `/uapi/domestic-stock/v1/trading/inquire-balance?${qs}`,
      { trId: TR_IDS[this.env].balance },
    );

    if (data.rt_cd !== "0") {
      throw new Error(`KIS positions query rejected: ${data.msg_cd ?? "unknown"}`);
    }

    const holdings = Array.isArray(data.output1) ? data.output1 : [];
    return holdings
      .filter((h) => int(h.hldg_qty) > 0)
      .map((h) => ({
        symbol: h.pdno ?? "",
        name: h.prdt_name ?? "",
        quantity: int(h.hldg_qty),
        avgPrice: num(h.pchs_avg_pric),
        currentPrice: num(h.prpr),
        pnl: num(h.evlu_pfls_amt),
        pnlPercent: num(h.evlu_pfls_rt),
      }));
  }

  async getPrice(symbol: string): Promise<MarketPrice> {
    const code = this.toPdno(symbol);
    const qs = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: code,
    }).toString();

    const data = await this.request<PriceResponse>(
      `/uapi/domestic-stock/v1/quotations/inquire-price?${qs}`,
      { trId: TR_ID_PRICE },
    );

    if (data.rt_cd !== "0") {
      throw new Error(`KIS price query rejected for ${code}: ${data.msg_cd ?? "unknown"}`);
    }

    const out = data.output ?? {};
    return {
      symbol: code,
      price: num(out.stck_prpr),
      change: num(out.prdy_vrss),
      changePercent: num(out.prdy_ctrt),
      volume: int(out.acml_vol),
      timestamp: new Date(),
    };
  }

  // ----------------------------------------------------------------------------
  // Write — order-cash (live path is gated by env-derived tr_id, never hardcoded live)
  // ----------------------------------------------------------------------------

  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    // 거래소 상주 보호주문(stop_*/take_profit_*)은 KIS order-cash 미지원 — 지정가로 silent 둔갑 금지(fail-closed, audit P0-3).
    // KR은 봇 폴링 평가(소프트스톱)로만 SL/TP 동작. 상주스톱 필요 시 Binance만 가능.
    if (order.type !== "market" && order.type !== "limit") {
      throw new Error(`KIS는 거래소 상주 보호주문(${order.type}) 미지원 — 일반 주문으로 대체하지 않음(fail-closed). market/limit만 허용.`);
    }
    this.assertAccount("place order");

    const pdno = this.toPdno(order.symbol);
    // ORD_DVSN: '00' = limit, '01' = market.
    const ordDvsn = order.type === "market" ? "01" : "00";
    // Market orders carry price 0; limit orders require a price.
    // 지정가는 KRX 호가단위 정렬 필수 — 미정렬 가격 직송 시 예측 가능한 거부(RC4003 계열). (audit P0-4)
    const ordUnpr = order.type === "market" ? "0" : String(roundToKrxTick(order.price ?? 0));

    const body: Record<string, string> = {
      CANO: this.cano,
      ACNT_PRDT_CD: this.acntPrdtCd,
      PDNO: pdno,
      ORD_DVSN: ordDvsn,
      ORD_QTY: String(Math.trunc(order.quantity)),
      ORD_UNPR: ordUnpr,
      EXCG_ID_DVSN_CD, // NXT 개편 이후 필수(없으면 주문 거부)
    };

    const hashkey = await this.getHashkey(body);
    const trId = order.side === "buy" ? TR_IDS[this.env].buy : TR_IDS[this.env].sell;

    const data = await this.request<OrderResponse>(
      "/uapi/domestic-stock/v1/trading/order-cash",
      { method: "POST", trId, body, extraHeaders: { hashkey } },
    );

    const filled = data.rt_cd === "0";
    // 접수 성공(rt_cd '0') 주장인데 주문번호(ODNO)가 없으면 유령 pending → fail-closed로 throw.
    //   (거부 rt_cd!='0'은 ODNO 없는 게 정상 → rejected 상태로 흘려보냄. 검증은 접수 성공 케이스에만.)
    if (filled) {
      const p = KisOrderOutputSchema.safeParse(data);
      if (!p.success) {
        throw new Error(`KIS order accepted but ODNO missing (신뢰불가, fail-closed): ${p.error.issues[0]?.message ?? "schema"}`);
      }
    }
    return {
      orderId: data.output?.ODNO ?? "",
      symbol: pdno,
      side: order.side,
      quantity: order.quantity,
      // 지정가는 실제 전송된 틱 정렬가를 반환(요청 원가가 아님 — 장부/감사 정직성).
      price: order.type === "market" ? 0 : roundToKrxTick(order.price ?? 0),
      // KIS accepts the order into its queue on rt_cd '0'; settlement is async → "pending".
      status: filled ? "pending" : "rejected",
      timestamp: new Date(),
    };
  }

  async cancelOrder(orderId: string, _symbol?: string): Promise<boolean> {
    this.assertAccount("cancel order");

    if (!orderId) {
      throw new Error("Cannot cancel order: orderId is required");
    }

    // KIS cancel keys off ORGN_ODNO (original order no), not the stock code → _symbol unused (kept for port symmetry).
    const body: Record<string, string> = {
      CANO: this.cano,
      ACNT_PRDT_CD: this.acntPrdtCd,
      KRX_FWDG_ORD_ORGNO: "",
      ORGN_ODNO: orderId,
      ORD_DVSN: "00",
      RVSE_CNCL_DVSN_CD: "02", // 02 = cancel
      ORD_QTY: "0",
      ORD_UNPR: "0",
      QTY_ALL_ORD_YN: "Y", // cancel the full remaining quantity
      EXCG_ID_DVSN_CD, // NXT 개편 이후 필수
    };

    const hashkey = await this.getHashkey(body);

    const data = await this.request<OrderResponse>(
      "/uapi/domestic-stock/v1/trading/order-rvsecncl",
      { method: "POST", trId: TR_IDS[this.env].cancel, body, extraHeaders: { hashkey } },
    );

    return data.rt_cd === "0";
  }

  // ----------------------------------------------------------------------------
  // Optional port methods
  // ----------------------------------------------------------------------------

  /**
   * KRX equities trade in whole-share lots. Normalize to a non-negative integer count.
   * refPrice is unused for KRX (kept for interface symmetry with notional-sized brokers).
   */
  async normalizeQuantity(_symbol: string, quantity: number, _refPrice: number): Promise<number> {
    if (!Number.isFinite(quantity) || quantity <= 0) return 0;
    return Math.max(0, Math.trunc(quantity));
  }

  /**
   * 미체결(정정/취소가능) 주문 조회 — KIS 미구현(audit P1-10), fail-closed throw.
   * 요청부(inquire-psbl-rvsecncl, TTTC0084R/모의 VTTC0084R)는 확정이나 응답 필드 + KIS 모의키·E2E 부재 →
   * 검증 안 된 파싱을 넣으면 reconcile/패널이 거짓 '미체결 없음'을 신뢰. 빈 배열 반환 금지(silent empty=둔갑).
   * ⚠️ getOrderByClientId는 추가하지 말 것 — reconcile 판별자 유지(runner.ts:323). KIS는 포지션 reconcile 경로.
   */
  async getOpenOrders(_symbol: string): Promise<OrderResult[]> {
    throw new Error(
      "KIS 미체결 조회 미지원 — KIS 모의 E2E로 응답필드 확정 후 구현(audit P1-10). 빈 배열 반환 금지(fail-closed).",
    );
  }

  // ----------------------------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------------------------

  /** Build the inquire-balance query string (shared by getBalance/getPositions). */
  private balanceQuery(): string {
    return new URLSearchParams({
      CANO: this.cano,
      ACNT_PRDT_CD: this.acntPrdtCd,
      AFHR_FLPR_YN: "N",
      OFL_YN: "",
      INQR_DVSN: "02",
      UNPR_DVSN: "01",
      FUND_STTL_ICLD_YN: "N",
      FNCG_AMT_AUTO_RDPT_YN: "N",
      PRCS_DVSN: "01",
      CTX_AREA_FK100: "",
      CTX_AREA_NK100: "",
    }).toString();
  }

  /**
   * KIS PDNO is the 6-digit short code. Strip non-digits and left-pad/truncate to 6.
   * (Accepts inputs like '005930', '5930', or '005930.KS'.)
   */
  private toPdno(symbol: string): string {
    const digits = (symbol ?? "").replace(/[^0-9]/g, "");
    if (!digits) return "";
    if (digits.length >= 6) return digits.slice(-6);
    return digits.padStart(6, "0");
  }

  /** Deterministic helper retained for callers needing a body fingerprint (e.g. idempotency). */
  private bodyHash(body: Record<string, string>): string {
    return createHash("sha256").update(JSON.stringify(body)).digest("hex");
  }
}
