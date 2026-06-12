/**
 * brokers/base.ts — BaseBrokerAdapter (v2 scaffold). credentials 저장 + 포트 추상화만.
 * v2에서 BinanceBrokerAdapter / HantooBrokerAdapter / KiwoomBrokerAdapter 가 extends 한다.
 * KIS/키움은 토큰 인증 공유 → 향후 TokenAuthAdapter extends BaseBrokerAdapter 권장(설계 §5b).
 */
import type {
  BrokerAdapter,
  BrokerType,
  BrokerCredentials,
  AccountBalance,
  Position,
  MarketPrice,
  OrderRequest,
  OrderResult,
} from "./types.js";

// ── 공통 재시도 레이어(audit P1-3) ──
// 어댑터가 throw하는 에러 메시지에 [http:STATUS] / [retry-after:SEC] 마커를 심으면 여기서 분류한다.
// 재시도 가능: 429/418(레이트리밋)/408/5xx/타임아웃/네트워크 단절. 불가: 4xx 검증·잔고부족(재시도해도 같음).
// ⚠️ 비멱등 쓰기(주문 POST)는 transport 재시도 금지 — 첫 시도가 실제 나갔을 수 있다(이중주문).
//    주문의 재시도는 상위(runner)의 clientOrderId reconcile(같은 봉 같은 cid 조회→입양)이 담당한다.

export interface RetryClassification { retryable: boolean; retryAfterMs?: number }

/** 에러를 재시도 가능/불가로 분류. [http:N] 마커 또는 타임아웃/네트워크 에러명 기반(추측 금지 — 마커 없으면 불가). */
export function classifyRetryableError(e: unknown): RetryClassification {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const ra = msg.match(/\[retry-after:(\d+)\]/);
  const retryAfterMs = ra ? Math.min(60_000, parseInt(ra[1], 10) * 1000) : undefined;
  if (/TimeoutError|AbortError|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(msg)) {
    return { retryable: true, retryAfterMs };
  }
  const http = msg.match(/\[http:(\d{3})\]/);
  if (http) {
    const st = parseInt(http[1], 10);
    return { retryable: st === 408 || st === 418 || st === 429 || st >= 500, retryAfterMs };
  }
  return { retryable: false };
}

/**
 * 지수백오프 재시도(읽기/멱등 호출 전용). Retry-After 존중(상한 60s), 백오프 base×2^n + 지터, 상한 maxDelayMs.
 * 재시도 불가 에러는 즉시 전파. 마지막 시도 실패도 전파(삼키지 않음).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number; onRetry?: (e: unknown, attempt: number, delayMs: number) => void },
): Promise<T> {
  const attempts = Math.max(1, opts?.attempts ?? 3);
  const base = opts?.baseDelayMs ?? 400;
  const cap = opts?.maxDelayMs ?? 8_000;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const c = classifyRetryableError(e);
      if (!c.retryable || i === attempts - 1) throw e;
      const delay = Math.min(cap, c.retryAfterMs ?? base * 2 ** i + Math.floor(Math.random() * 100));
      opts?.onRetry?.(e, i + 1, delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr; // attempts<1 방어(도달 불가 경로)
}

export abstract class BaseBrokerAdapter implements BrokerAdapter {
  abstract type: BrokerType;
  protected credentials: BrokerCredentials;

  constructor(credentials: BrokerCredentials) {
    this.credentials = credentials;
  }

  abstract getBalance(): Promise<AccountBalance>;
  abstract getPositions(): Promise<Position[]>;
  abstract getPrice(symbol: string): Promise<MarketPrice>;
  abstract placeOrder(order: OrderRequest): Promise<OrderResult>;
  abstract cancelOrder(orderId: string): Promise<boolean>;
}
