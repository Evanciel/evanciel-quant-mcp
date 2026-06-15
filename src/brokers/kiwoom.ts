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
import { BaseBrokerAdapter, withRetry } from "./base.js";
import { roundToKrxTick } from "./krx-tick.js";
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
  // 미체결요청(/api/dostk/acnt). 모의 E2E로 확정: 배열키 'oso', stex_tp 필수(숫자). audit P1-10.
  openOrders: "ka10075",
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

// KRX 호가단위 정렬은 공용 모듈(krx-tick.ts)로 추출 — KIS와 공유(audit P0-4).

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
    } catch (e) {
      // 타임아웃/네트워크 단절 — 원 에러명·메시지(시크릿 미포함 fetch 레이어 에러) 보존 →
      //   withRetry의 classifyRetryableError가 TimeoutError/AbortError/fetch failed 등을 재시도 가능으로 분류(audit P1-22).
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      throw new Error(`Kiwoom API request failed (network) [${detail}]`);
    }

    if (!res.ok) {
      // [http:N]/[retry-after:S] 마커를 심어 base.classifyRetryableError가 429/5xx/408만 재시도하도록(4xx 비재시도). audit P1-22.
      const ra = res.headers.get("retry-after");
      const markers = `[http:${res.status}]${ra && /^\d+$/.test(ra.trim()) ? ` [retry-after:${ra.trim()}]` : ""}`;
      throw new Error(`Kiwoom API error: ${res.status} ${markers}`);
    }

    const data = (await res.json().catch(() => ({}))) as KiwoomResponse;
    return {
      data,
      contYn: res.headers.get("cont-yn") ?? "N",
      nextKey: res.headers.get("next-key") ?? "",
    };
  }

  /**
   * 바디 레벨 성공 판정(return_code===0). 실패 시 일반 메시지로 throw(시크릿/원문 누출 없음).
   * P0: return_code 부재를 무조건 성공으로 간주하지 않는다 — 만료토큰/게이트웨이 오류 같은 비정형 응답이
   * '성공'이 되어 빈 데이터·유령 주문으로 이어지던 구멍. 시세류 등 정말 return_code가 없을 수 있는 응답만
   * 호출측이 데이터 존재 증거(okWithoutCode)를 제공해 통과시킨다.
   */
  private assertOk(data: KiwoomResponse, op: string, okWithoutCode?: (d: KiwoomResponse) => boolean): void {
    if (data.return_code == null) {
      if (okWithoutCode?.(data)) return;
      throw new Error(`Kiwoom ${op} failed (missing return_code)`);
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
      // return_code 부재 시 잔고 필드 존재를 성공 증거로(빈/비정형 응답이 '잔고 0'으로 둔갑하는 것 차단).
      this.assertOk(data, "getBalance", (d) => d.tot_evlt_amt != null || d.tot_evlu_amt != null || d.entr != null || d.prsm_dpst_aset_amt != null || Array.isArray(d.acnt_evlt_remn_indv_tot));

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
      // return_code 부재 시 보유배열 존재를 성공 증거로(비정형 응답이 '보유 0종목'으로 둔갑하는 것 차단).
      this.assertOk(data, "getPositions", (d) => Array.isArray(d.acnt_evlt_remn_indv_tot));

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
      // 호가 응답은 return_code가 빠질 수 있음 → 호가 필드 존재를 성공 증거로.
      this.assertOk(data, "getPrice", (d) => d.buy_fpr_bid != null || d.sel_fpr_bid != null);

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
   * 일봉 OHLCV(ka10081, /api/dostk/chart) — 러너/백테스트 지표 평가용. ⚠️ 모의서버 검증(2026-06):
   * 응답 stk_dt_pole_chart_qry 배열(open_pric/high_pric/low_pric/cur_prc/trde_qty/dt), 최신순 → 오래된순 정렬.
   * 가격 부호 접두는 abs로 정리. count개 최근봉. (분봉은 ka10080=후속. KR 라이브 봇=일봉 우선.)
   * 러너가 broker별로 이 메서드를 우선 사용(크립토=Binance public klines). interval은 현재 일봉 고정.
   */
  /** KR 주식은 정수주(소수주 미지원) → 수량 내림. Binance(stepSize 소수)와 달리 1주 단위. 미구현 시 소수주 거부됨. */
  async normalizeQuantity(_symbol: string, quantity: number): Promise<number> {
    return Math.max(0, Math.floor(quantity));
  }

  async getCandles(symbol: string, interval = "1d", count = 300): Promise<{ date: string; datetime: string; open: number; high: number; low: number; close: number; volume: number }[]> {
    const stk = this.normalizeSymbol(symbol);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const iv = String(interval).toLowerCase();
    // 모의서버 프로브(2026-06)로 응답키 확정: 분 ka10080(cntr_tm·stk_min_pole_chart_qry, tic_scope=분),
    //   일 ka10081(dt·stk_dt_pole_chart_qry), 주 ka10082(dt·stk_stk_pole_chart_qry), 월 ka10083(dt·stk_mth_pole_chart_qry).
    const MIN: Record<string, string> = { "1m": "1", "3m": "3", "5m": "5", "10m": "10", "15m": "15", "30m": "30", "45m": "45", "60m": "60", "1h": "60" };
    let apiId: string, arrKey: string, body: Record<string, unknown>, isMinute = false;
    if (MIN[iv]) { isMinute = true; apiId = "ka10080"; arrKey = "stk_min_pole_chart_qry"; body = { stk_cd: stk, tic_scope: MIN[iv], upd_stkpc_tp: "1" }; }
    else if (iv === "1w" || iv === "1week") { apiId = "ka10082"; arrKey = "stk_stk_pole_chart_qry"; body = { stk_cd: stk, base_dt: today, upd_stkpc_tp: "1" }; }
    else if (iv === "1mo" || iv === "1month" || iv === "1M".toLowerCase()) { apiId = "ka10083"; arrKey = "stk_mth_pole_chart_qry"; body = { stk_cd: stk, base_dt: today, upd_stkpc_tp: "1" }; }
    else { apiId = "ka10081"; arrKey = "stk_dt_pole_chart_qry"; body = { stk_cd: stk, base_dt: today, upd_stkpc_tp: "1" }; }
    // 캔들은 라이브 틱 평가 경로(러너) → 단발 실패(타임아웃/429/5xx)로 틱 전체가 죽지 않도록 재시도(audit P1-22, Binance fetchKlines와 대칭).
    //   GET-동등 멱등 읽기라 안전. 주문 POST(placeOrder/cancelOrder)는 절대 wrap 금지(비멱등).
    const { data } = await withRetry(() => this.post("/api/dostk/chart", apiId, body), { attempts: 3, baseDelayMs: 400, maxDelayMs: 8000 });
    // 차트 응답도 return_code 누락 가능성 → 차트 배열 존재를 성공 증거로.
    this.assertOk(data, "getCandles", (d) => Array.isArray((d as Record<string, unknown>)[arrKey]));
    const rows = Array.isArray((data as Record<string, unknown>)[arrKey]) ? ((data as Record<string, unknown>)[arrKey] as Record<string, unknown>[]) : [];
    const bars = rows
      .map((r) => {
        let date: string, datetime: string;
        // P0: 키움 시각은 KST 로컬 — 'Z'(UTC)로 라벨하면 epoch가 9시간 어긋나 시간대 조건·스케줄·MTF 정렬이
        // 전부 틀어진다 → '+09:00' 오프셋으로 명시(Date.parse가 올바른 epoch 산출).
        // ⚠️ 이 수정으로 기존 가동 KR 봇의 멱등키 문자열이 바뀌어 전환 직후 같은 봉 1회 재기록 가능(1회성).
        if (isMinute) {
          const t = String(r.cntr_tm ?? ""); // YYYYMMDDHHMMSS (KST)
          date = t.replace(/^(\d{4})(\d{2})(\d{2}).*/, "$1-$2-$3");
          datetime = t.length >= 14 ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}+09:00` : date + "T00:00:00+09:00";
        } else {
          date = String(r.dt ?? "").replace(/^(\d{4})(\d{2})(\d{2}).*/, "$1-$2-$3");
          datetime = date + "T00:00:00+09:00"; // KR 거래일 경계=KST 자정
        }
        return { date, datetime, open: Math.abs(toNum(r.open_pric)), high: Math.abs(toNum(r.high_pric)), low: Math.abs(toNum(r.low_pric)), close: Math.abs(toNum(r.cur_prc)), volume: toNum(r.trde_qty) };
      })
      .filter((b) => b.close > 0 && b.date.length === 10)
      .sort((a, b) => a.datetime.localeCompare(b.datetime)); // 오래된→최신
    return bars.slice(-count);
  }

  /**
   * 주문(/api/dostk/ordr, 단일 경로). 오퍼레이션=api-id 헤더(kt10000 매수/kt10001 매도).
   * 바디 snake_case: dmst_stex_tp('KRX')/stk_cd/ord_qty(string)/ord_uv(string,'0'=시장가)/trde_tp('0'지정/'3'시장).
   * 성공/주문번호는 바디 return_code===0 / ord_no.
   */
  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    // 거래소 상주 보호주문(stop_*/take_profit_*)은 키움 REST 미지원 — 지정가로 silent 둔갑 금지(fail-closed, audit P0-3).
    // KR은 봇 폴링 평가(소프트스톱)로만 SL/TP 동작. 상주스톱 필요 시 Binance만 가능.
    if (order.type !== "market" && order.type !== "limit") {
      throw new Error(`Kiwoom은 거래소 상주 보호주문(${order.type}) 미지원 — 일반 주문으로 대체하지 않음(fail-closed). market/limit만 허용.`);
    }
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

      // P0: 응답 신뢰성 검증 — return_code도 ord_no도 없는 응답(만료토큰/게이트웨이 오류 등)을
      // '접수(pending)'로 취급하면 유령 주문이 장부에 박힌다 → 실패로 throw.
      if (data.return_code == null && data.ord_no == null) {
        throw new Error("Kiwoom order response unrecognized (no return_code/ord_no)");
      }
      const rejected = data.return_code != null && Number(data.return_code) !== 0;
      if (rejected) {
        // 사유는 콘솔에만(시크릿 미포함). 호출측엔 rejected 상태로 정상 반환.
        console.warn(
          `[kiwoom] order rejected (return_code=${Number(data.return_code)})`,
        );
      }

      // 보완(타입 가드): ord_no가 객체/배열로 오는 비정상 응답이면 String()이 '[object Object]'를 orderId로
      //   만든다(유령 주문번호). 문자열/숫자만 허용 — 그 외 타입은 신뢰 불가로 throw. (assertOk와 중복 아닌 타입검증.)
      if (data.ord_no != null && typeof data.ord_no !== "string" && typeof data.ord_no !== "number") {
        throw new Error("Kiwoom order response invalid ord_no type (신뢰불가, fail-closed)");
      }
      const orderId = String((data.ord_no as string | number | undefined) ?? "");
      // 접수 성공 주장인데 주문번호가 없으면 신뢰 불가 → 유령 pending 금지(실패로 throw).
      if (!rejected && !orderId) {
        throw new Error("Kiwoom order accepted but ord_no missing");
      }
      return {
        orderId,
        symbol: stk,
        side: order.side,
        quantity: order.quantity,
        // 키움 접수 응답엔 체결가가 없다(시장가=0). 호출측(runner)이 '체결가 미확인'을 명시 기록/감사한다.
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

  /**
   * 미체결(상주/접수) 주문 목록(ka10075 미체결요청, /api/dostk/acnt). audit P1-10 / P1-19.
   * KR은 getOrderByClientId가 없어(주문 직후 즉시 체결확인 불가) '내 지정가가 아직 미체결로 떠 있나'를 이걸로 본다.
   * 모의 E2E(probe-kiwoom-open-orders.ts / verify-kiwoom-mock-open-orders-e2e.ts)로 응답키 확정:
   *   배열키 'oso', ord_no(주문번호) · oso_qty(미체결잔량) · io_tp_nm(±매수/매도=방향) · ord_pric(주문가) · ord_qty/cntr_qty(원/체결).
   *   요청 stex_tp(숫자 "0"=통합) 필수 — dmst_stex_tp="KRX"는 거부됨(필수 파라미터 누락).
   * ⚠️ getOrderByClientId/getOrderById는 추가하지 말 것 — runner reconcile 판별자(getOrderByClientId===undefined)가
   *   KR을 포지션 reconcile 경로로 보내는 근거다(types.ts:88, runner.ts:323). 추가 시 KR reconcile이 꺼져 유령 포지션.
   */
  async getOpenOrders(symbol: string): Promise<OrderResult[]> {
    try {
      const stk = symbol ? this.normalizeSymbol(symbol) : "";
      const { data } = await this.post("/api/dostk/acnt", API_ID.openOrders, {
        all_stk_tp: stk ? "0" : "1", // 0=종목지정 / 1=전체
        trde_tp: "0",                 // 0=전체 매매구분(매수+매도)
        stk_cd: stk,                  // 종목코드(미지정 시 전체)
        stex_tp: "0",                 // 0=통합(필수, 숫자). E2E 확인: stex_tp 누락 시 거부.
      });
      // return_code 부재를 성공으로 보지 않음 — 'oso' 배열 존재를 성공 증거로(getBalance 패턴, fail-closed).
      this.assertOk(data, "getOpenOrders", (d) => Array.isArray(d.oso));
      const rows = Array.isArray(data.oso) ? (data.oso as Record<string, unknown>[]) : [];
      const out: OrderResult[] = [];
      for (const r of rows) {
        const orderId = String(r.ord_no ?? "");
        const remain = toNum(r.oso_qty); // 미체결 잔량
        if (!orderId || orderId === "0" || remain <= 0) continue; // 체결완료/무효 행 스킵
        if (stk && this.normalizeSymbol(String(r.stk_cd ?? "")) !== stk) continue; // 요청 종목만(서버 폴백 방어)
        const sideText = String(r.io_tp_nm ?? ""); // "+매수"/"-매도" (trde_tp=보통/시장가는 주문유형이라 방향 아님)
        const side: "buy" | "sell" = sideText.includes("매도") ? "sell" : "buy";
        out.push({
          orderId,
          symbol: this.normalizeSymbol(String(r.stk_cd ?? stk)),
          side,
          quantity: remain, // 미체결 잔량(패널·reconcile 관심 = 남은 수량)
          price: Math.abs(toNum(r.ord_pric)), // 0=시장가 접수
          status: "pending", // 미체결 = 접수/부분 → pending
          executedQty: toNum(r.cntr_qty), // 체결분(부분체결 가시화)
          origQty: toNum(r.ord_qty), // 원주문수량
          timestamp: new Date(), // 키움 tm=HHMMSS(날짜없음) → now
        });
      }
      return out;
    } catch (error) {
      // fail-closed: 조회 실패는 빈 배열 금지(silent empty = '미체결 없음'으로 둔갑). throw → live-handler가 ok:false 변환.
      throw new Error(
        `Failed to fetch open orders for ${symbol || "all"}: ${error instanceof Error ? error.message : "unknown error"}`,
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
