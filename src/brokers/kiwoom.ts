/**
 * brokers/kiwoom.ts — 키움증권(Kiwoom) 전용 어댑터 (quant-mcp v2, BYOK).
 *
 * ⚠️ 키움은 한국투자(KIS)와 **wire 비호환** → KIS 어댑터를 재사용/서브클래싱하지 않는 전용 구현.
 *   설계: docs/02-design/quant-mcp-v2-design.md §7. 키움 고유 규약(KIS와 다른 점):
 *     - 인증: POST {base}/oauth2/token, 헤더 api-id:au10001, 바디 필드명이 'secretkey'(KIS는 'appsecret').
 *     - 데이터 콜 헤더: authorization:Bearer + api-id **만**. hashkey/appsecret/custtype 전부 없음(KIS와 상이).
 *     - 주문: 단일 경로 /api/dostk/ordr, 오퍼레이션을 **api-id 헤더**로 구분(kt10000 매수/kt10001 매도/kt10003 취소).
 *     - 계좌: /api/dostk/acnt, api-id kt00018(잔고)/ka10072(보유종목손익).
 *     - 바디는 snake_case(stk_cd/ord_qty/ord_uv/trde_tp/dmst_stex_tp). 페이징은 cont-yn/next-key **헤더**.
 *     - 성공/실패는 **바디** return_code(0=성공)/return_msg. 주문번호=ord_no.
 *
 * 보안(§6 BYOK 위생): 자격증명은 caller가 주입한 this.credentials(Record<string,string>)에서만 읽음
 *   (process.env 직접 접근 금지 — caller가 env를 credentials로 주입). 시크릿/서명헤더 절대 로그 금지.
 *   베이스URL은 credentials.env로만 선택(메인넷 하드코딩 금지), env 누락 시 SAFE값(mock)으로 폴백.
 */
import { BaseBrokerAdapter } from "./base.js";
import type {
  BrokerType,
  BrokerCredentials,
  AccountBalance,
  Position,
  MarketPrice,
  OrderRequest,
  OrderResult,
} from "./types.js";

/** 베이스URL 1곳 집중(메인넷 하드코딩 금지). host만 교체 — 기본=SAFE(mock). */
const URLS = {
  mock: "https://mockapi.kiwoom.com",
  live: "https://api.kiwoom.com",
} as const;

type KiwoomEnv = keyof typeof URLS;

/** 키움 REST api-id(오퍼레이션 식별자). 단일 경로 + 헤더로 오퍼레이션 분기. */
const API_ID = {
  token: "au10001",
  buy: "kt10000",
  sell: "kt10001",
  cancel: "kt10003",
  balance: "kt00018",
  holdings: "ka10072",
  // 주식 시세(현재가/호가) — 시세 단일종목 조회. KIS와 별개 경로(/api/dostk/mrkcond).
  quote: "ka10004",
} as const;

const TIMEOUT_MS = 10000;
/** 키움 토큰 수명 ~24h. 실제 만료보다 5분 일찍 갱신(엣지케이스 회피). */
const TOKEN_SKEW_MS = 5 * 60 * 1000;

/** -로 시작하는 부호 보존 정수 파싱(키움 손익/수량 등 음수 가능 필드). */
function toNum(v: unknown): number {
  if (v == null) return 0;
  const n = parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * KRX 호가단위(2023 개편). 가격대별 틱. ⚠️ 모의서버 검증(2026-06): 지정가가 틱에 안 맞으면
 * return_code=20(RC4003 호가단위 오류)로 거부 → placeOrder가 지정가를 이 틱으로 정렬해야 함.
 */
function krxTick(price: number): number {
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}
function roundToKrxTick(price: number): number {
  if (!(price > 0)) return price;
  const t = krxTick(price);
  return Math.round(price / t) * t;
}

interface KiwoomResponse {
  return_code?: number;
  return_msg?: string;
  [key: string]: unknown;
}

export class KiwoomBrokerAdapter extends BaseBrokerAdapter {
  type: BrokerType = "kiwoom";

  private readonly env: KiwoomEnv;
  private readonly baseUrl: string;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(credentials: BrokerCredentials = {}) {
    super(credentials);
    // env 선택자는 credentials에서만(caller 주입). 누락/미지원 → SAFE(mock)로 폴백. 메인넷 하드코딩 금지.
    const raw = (credentials.env ?? "").toLowerCase();
    this.env = raw === "live" ? "live" : "mock";
    this.baseUrl = URLS[this.env];
  }

  // ── 자격증명 접근 헬퍼(undefined-safe). 시크릿은 절대 로그/메시지 노출 금지. ──
  private get appkey(): string {
    return this.credentials.appkey ?? this.credentials.appKey ?? "";
  }
  private get secretkey(): string {
    // 키움 바디 필드명은 'secretkey'. 다양한 입력 키를 허용하되 외부 노출은 금지.
    return (
      this.credentials.secretkey ??
      this.credentials.secretKey ??
      this.credentials.appsecret ??
      this.credentials.appSecret ??
      ""
    );
  }
  /** 계좌번호(잔고/주문 바디에 필요할 수 있음). 키움은 토큰에 계좌 매핑되나, 일부 응답 매핑에 사용. */
  private get accountNo(): string {
    return this.credentials.accountNo ?? this.credentials.cano ?? "";
  }

  private isTokenExpired(): boolean {
    return Date.now() >= this.tokenExpiresAt - TOKEN_SKEW_MS;
  }

  /** OAuth2 client_credentials → Bearer(~24h 캐시). 바디 필드명 'secretkey'(KIS와 상이). */
  private async getToken(): Promise<string> {
    if (this.accessToken && !this.isTokenExpired()) {
      return this.accessToken;
    }
    if (!this.appkey || !this.secretkey) {
      throw new Error("Kiwoom credentials missing (appkey/secretkey required)");
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/oauth2/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          "api-id": API_ID.token,
        },
        body: JSON.stringify({
          grant_type: "client_credentials",
          appkey: this.appkey,
          secretkey: this.secretkey,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // 네트워크/타임아웃 — 시크릿/URL 노출 없는 일반 메시지.
      throw new Error("Kiwoom token request failed (network)");
    }

    if (!res.ok) {
      // 응답 바디(서명/시크릿 미포함)는 흘리지 않고 상태코드만 노출.
      throw new Error(`Kiwoom token request failed: ${res.status}`);
    }

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // 키움 바디 레벨 에러도 검사(HTTP 200 + return_code!=0 가능).
    if (data.return_code != null && Number(data.return_code) !== 0) {
      throw new Error("Kiwoom token request rejected");
    }
    const token = (data.token ?? data.access_token) as string | undefined;
    if (!token) {
      throw new Error("Kiwoom token response missing token");
    }

    this.accessToken = token;
    // expires_dt(yyyyMMddHHmmss) 또는 expires_in(초) 모두 대응. 없으면 보수적으로 1h.
    const expiresIn = this.parseTokenLifetimeMs(data);
    this.tokenExpiresAt = Date.now() + expiresIn;
    return token;
  }

  private parseTokenLifetimeMs(data: Record<string, unknown>): number {
    const expiresIn = data.expires_in;
    if (expiresIn != null) {
      const secs = toNum(expiresIn);
      if (secs > 0) return secs * 1000;
    }
    const expiresDt = data.expires_dt;
    if (typeof expiresDt === "string" && /^\d{14}$/.test(expiresDt)) {
      // yyyyMMddHHmmss (KST). Date.parse 가능한 ISO 형태로 변환.
      const y = expiresDt.slice(0, 4);
      const mo = expiresDt.slice(4, 6);
      const d = expiresDt.slice(6, 8);
      const h = expiresDt.slice(8, 10);
      const mi = expiresDt.slice(10, 12);
      const s = expiresDt.slice(12, 14);
      const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`);
      if (Number.isFinite(t)) {
        const delta = t - Date.now();
        if (delta > 0) return delta;
      }
    }
    return 3600 * 1000;
  }

  /**
   * 공통 POST 데이터 콜. 헤더는 authorization:Bearer + api-id **만**(hashkey/appsecret/custtype 없음).
   * cont-yn/next-key 페이징 헤더를 옵션으로 받고, 응답 헤더의 다음 키를 반환.
   */
  private async post(
    path: string,
    apiId: string,
    body: Record<string, unknown>,
    cont?: { contYn?: string; nextKey?: string },
  ): Promise<{ data: KiwoomResponse; contYn: string; nextKey: string }> {
    const token = await this.getToken();
    const headers: Record<string, string> = {
      "Content-Type": "application/json;charset=UTF-8",
      authorization: `Bearer ${token}`,
      "api-id": apiId,
    };
    if (cont?.contYn) headers["cont-yn"] = cont.contYn;
    if (cont?.nextKey) headers["next-key"] = cont.nextKey;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Error("Kiwoom API request failed (network)");
    }

    if (!res.ok) {
      throw new Error(`Kiwoom API error: ${res.status}`);
    }

    const data = (await res.json().catch(() => ({}))) as KiwoomResponse;
    return {
      data,
      contYn: res.headers.get("cont-yn") ?? "N",
      nextKey: res.headers.get("next-key") ?? "",
    };
  }

  /** 바디 레벨 성공 판정(return_code===0). 실패 시 일반 메시지로 throw(시크릿/원문 누출 없음). */
  private assertOk(data: KiwoomResponse, op: string): void {
    if (data.return_code == null) {
      // 일부 시세 응답은 return_code 미포함 → 데이터 존재로 성공 간주(여기선 통과).
      return;
    }
    if (Number(data.return_code) !== 0) {
      const code = Number(data.return_code);
      // return_msg는 보통 시크릿 미포함(한국어 사유)이나, 외부 노출 보수화를 위해 코드만 노출.
      throw new Error(`Kiwoom ${op} failed (return_code=${code})`);
    }
  }

  /**
   * 계좌 평가잔고(kt00018, /api/dostk/acnt). 총평가/예수금을 normalized AccountBalance로 매핑.
   * 키움 응답 필드는 버전별 편차가 있어 다중 후보 키를 안전 폴백.
   */
  async getBalance(): Promise<AccountBalance> {
    try {
      const { data } = await this.post("/api/dostk/acnt", API_ID.balance, {
        qry_tp: "1",
        dmst_stex_tp: "KRX",
      });
      this.assertOk(data, "getBalance");

      // 총평가금액(예수금+평가) / 예수금(D+2 또는 추정예수금) 후보.
      const total =
        toNum(data.tot_evlt_amt) ||
        toNum(data.tot_evlu_amt) ||
        toNum(data.prsm_dpst_aset_amt) ||
        toNum(data.tot_est_amt);
      const cash =
        toNum(data.entr) ||
        toNum(data.dnca_tot_amt) ||
        toNum(data.prsm_dpst_aset_amt) ||
        toNum(data.d2_entra);

      return {
        totalAsset: total,
        cashBalance: cash,
        currency: "KRW",
      };
    } catch (error) {
      throw new Error(
        `Failed to fetch balance: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  /**
   * 보유종목/평가손익. ⚠️ 모의서버 검증(2026-06): ka10072는 strt_dt(시작일) 필수인 '일자별 실현손익'이라
   * 현재 보유종목 용도엔 부적합 → **계좌평가잔고 kt00018의 acnt_evlt_remn_indv_tot 배열**에 보유종목이 들어있음.
   * (kt00018은 getBalance와 동일 엔드포인트, 응답에 합산 + 개별 보유 배열 동시 포함.)
   */
  async getPositions(): Promise<Position[]> {
    try {
      const { data } = await this.post(
        "/api/dostk/acnt",
        API_ID.balance,
        { qry_tp: "1", dmst_stex_tp: "KRX" },
      );
      this.assertOk(data, "getPositions");

      const rows = Array.isArray(data.acnt_evlt_remn_indv_tot)
        ? (data.acnt_evlt_remn_indv_tot as Record<string, unknown>[])
        : [];
      const positions: Position[] = [];
      for (const item of rows) {
        const qty = toNum(item.rmnd_qty ?? item.hldg_qty ?? item.cur_qty ?? item.trde_able_qty);
        if (qty === 0) continue;
        positions.push({
          symbol: this.normalizeSymbol(String(item.stk_cd ?? item.pdno ?? "")),
          name: String(item.stk_nm ?? item.prdt_name ?? "").trim(),
          quantity: qty,
          avgPrice: toNum(item.pur_pric ?? item.pchs_avg_pric ?? item.buy_uv),
          currentPrice: toNum(item.cur_prc ?? item.prpr ?? item.now_pric),
          pnl: toNum(item.evltv_prft ?? item.evlu_pfls_amt ?? item.pl_amt),
          pnlPercent: toNum(item.prft_rt ?? item.evlu_pfls_rt ?? item.pl_rt),
        });
      }
      return positions;
    } catch (error) {
      throw new Error(
        `Failed to fetch positions: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  /**
   * 현재가 시세. ⚠️ 모의서버 검증(2026-06): ka10004는 '주식호가'(orderbook)라 cur_prc 필드가 없음 →
   * 최우선 매수/매도호가(buy_fpr_bid/sel_fpr_bid)의 mid를 현재가로 사용. 부호 접두는 toNum+abs로 정리.
   * (last-traded-price/등락은 별도 api-id 필요 → 주문 참조가엔 mid로 충분, change=0.)
   */
  async getPrice(symbol: string): Promise<MarketPrice> {
    try {
      const stk = this.normalizeSymbol(symbol);
      const { data } = await this.post("/api/dostk/mrkcond", API_ID.quote, {
        stk_cd: stk,
      });
      this.assertOk(data, "getPrice");

      const bestBid = Math.abs(toNum(data.buy_fpr_bid));
      const bestAsk = Math.abs(toNum(data.sel_fpr_bid));
      const price = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk);
      return {
        symbol: stk,
        price,
        change: 0,
        changePercent: 0,
        volume: toNum(data.tot_buy_req) + toNum(data.tot_sel_req),
        timestamp: new Date(),
      };
    } catch (error) {
      throw new Error(
        `Failed to fetch price for ${symbol}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  /**
   * 주문(/api/dostk/ordr, 단일 경로). 오퍼레이션=api-id 헤더(kt10000 매수/kt10001 매도).
   * 바디 snake_case: dmst_stex_tp('KRX')/stk_cd/ord_qty(string)/ord_uv(string,'0'=시장가)/trde_tp('0'지정/'3'시장).
   * 성공/주문번호는 바디 return_code===0 / ord_no.
   */
  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    try {
      const apiId = order.side === "buy" ? API_ID.buy : API_ID.sell;
      const isMarket = order.type === "market";
      const stk = this.normalizeSymbol(order.symbol);

      const body: Record<string, unknown> = {
        dmst_stex_tp: "KRX",
        stk_cd: stk,
        ord_qty: String(order.quantity),
        // 지정가는 가격(KRX 틱 정렬 필수 — 미정렬 시 RC4003 거부), 시장가는 '0'.
        ord_uv: isMarket ? "0" : String(roundToKrxTick(order.price ?? 0)),
        // '0'=보통(지정가), '3'=시장가.
        trde_tp: isMarket ? "3" : "0",
      };

      const { data } = await this.post("/api/dostk/ordr", apiId, body);

      const rejected = data.return_code != null && Number(data.return_code) !== 0;
      if (rejected) {
        // 사유는 콘솔에만(시크릿 미포함). 호출측엔 rejected 상태로 정상 반환.
        console.warn(
          `[kiwoom] order rejected (return_code=${Number(data.return_code)})`,
        );
      }

      const orderId = String((data.ord_no as string | undefined) ?? "");
      return {
        orderId,
        symbol: stk,
        side: order.side,
        quantity: order.quantity,
        price: isMarket ? 0 : order.price ?? 0,
        // 키움 주문 접수=비동기(체결 별도). 접수 성공이면 pending, 실패면 rejected.
        status: rejected ? "rejected" : "pending",
        timestamp: new Date(),
      };
    } catch (error) {
      throw new Error(
        `Failed to place ${order.side} order for ${order.symbol}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }

  /**
   * 주문 취소(/api/dostk/ordr, api-id kt10003). 원주문번호=orig_ord_no.
   * 키움 kt10003은 **stk_cd 필수**(공식 가이드 + .NET 래퍼 확인) → symbol 인자로 채움. cncl_qty '0'=잔량 전부.
   */
  async cancelOrder(orderId: string, symbol?: string): Promise<boolean> {
    try {
      const body: Record<string, unknown> = {
        dmst_stex_tp: "KRX",
        orig_ord_no: orderId,
        // 키움 취소는 종목코드 필수. symbol 미지정 시 빈 값(거래소가 거부할 수 있음 → 호출측이 symbol 전달 권장).
        stk_cd: symbol ? this.normalizeSymbol(symbol) : "",
        cncl_qty: "0",
      };
      const { data } = await this.post("/api/dostk/ordr", API_ID.cancel, body);

      const ok = data.return_code != null && Number(data.return_code) === 0;
      if (!ok) {
        console.warn(
          `[kiwoom] cancel rejected (return_code=${
            data.return_code != null ? Number(data.return_code) : "n/a"
          })`,
        );
      }
      return ok;
    } catch (error) {
      throw new Error(
        `Failed to cancel order ${orderId}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }

  // ── 내부 유틸 ──

  /** 키움 응답에서 종목 배열을 안전 추출(필드명 버전 편차 흡수). */
  private extractRows(data: KiwoomResponse): Record<string, unknown>[] {
    const candidates = [
      data.acnt_evlt_remn_indv_tot,
      data.stk_acnt_evlt_remn,
      data.evlt_remn,
      data.output1,
      data.output,
      data.stk_list,
      data.list,
    ];
    for (const c of candidates) {
      if (Array.isArray(c)) return c as Record<string, unknown>[];
    }
    return [];
  }

  /** 종목코드 정규화: 6자리 숫자 KRW 종목은 접두 'A'/접미 거래소 코드 제거(예: 'A005930'→'005930'). */
  private normalizeSymbol(symbol: string): string {
    const s = symbol.trim().toUpperCase();
    // 'A005930' 같은 접두 제거
    const noPrefix = /^[A-Z]\d{6}$/.test(s) ? s.slice(1) : s;
    // '005930.KS' / '005930_AL' 같은 접미 제거
    const m = noPrefix.match(/^(\d{6})\b/);
    return m ? m[1] : noPrefix;
  }
}
