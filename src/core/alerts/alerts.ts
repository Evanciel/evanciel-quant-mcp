/**
 * core/alerts/alerts.ts — 봇 이벤트 알림 엔진(순수 코어).
 *
 * 설계:
 *  - detectAlerts: 스냅샷 2개(prev/next)를 diff → AlertEvent[] (순수함수, 부수효과 0 → 단위테스트 가능).
 *  - Debouncer: 같은 종류 알림 폭주 억제(key당 TTL). 만료 스윕으로 Map 무한증식 방지(메모리 누수 차단).
 *  - AlertBuffer: 최근 N개 링버퍼(대시보드 피드/SSE용).
 *  배달(webhook)은 webhook.ts가 담당. 이 파일은 "무엇을 알릴지"만 결정한다.
 */

export type AlertLevel = "info" | "warn" | "critical";

export interface AlertEvent {
  id: string;
  ts: string;
  level: AlertLevel;
  kind: string; // bot_error | bot_stopped | bot_started | trade_closed | position_opened | position_closed
  botId?: string;
  botName?: string;
  symbol?: string;
  message: string;
}

/** detectAlerts 입력 — snapshot() 봇 행에서 필요한 필드만(느슨한 계약). */
export interface BotAlertView {
  id: string;
  name: string;
  symbol: string;
  status: string;
  closes: number;
  realizedPnl: number;
  openCount: number; // 열린 포지션 수(extractPositions 길이 등에서 유도)
}

const won = (n: number) => { const v = Number.isFinite(n) ? n : 0; return v >= 0 ? `+${v}` : `${v}`; };

/**
 * 직전/현재 봇 스냅샷을 비교해 알림 이벤트를 생성한다(순수).
 * @param nowMs id 생성용 단조 시각(호출측이 Date.now() 주입 → 순수성 유지).
 */
export function detectAlerts(prev: BotAlertView[] | null, next: BotAlertView[], nowMs: number, nowIso: string): AlertEvent[] {
  if (!prev) return []; // 첫 틱: 기준선만 잡고 알림 없음
  const prevById = new Map(prev.map((b) => [b.id, b]));
  const out: AlertEvent[] = [];
  let seq = 0;
  const mk = (b: BotAlertView, level: AlertLevel, kind: string, message: string): AlertEvent => ({
    id: `${kind}:${b.id}:${nowMs}:${seq++}`, ts: nowIso, level, kind, botId: b.id, botName: b.name, symbol: b.symbol, message,
  });

  for (const b of next) {
    const p = prevById.get(b.id);
    if (!p) continue; // 신규 봇은 기준선만(다음 틱부터 비교)

    // 1) 상태 전이
    if (p.status === "running" && b.status !== "running") {
      if (b.status === "error") out.push(mk(b, "critical", "bot_error", `${b.name}(${b.symbol}) 봇 오류 상태 진입`));
      else out.push(mk(b, "warn", "bot_stopped", `${b.name}(${b.symbol}) 봇 중지(${b.status})`));
    } else if (p.status !== "running" && b.status === "running") {
      out.push(mk(b, "info", "bot_started", `${b.name}(${b.symbol}) 봇 가동`));
    }

    // 2) 청산(거래 종료) — realized PnL 변화
    if (b.closes > p.closes) {
      const delta = +(b.realizedPnl - p.realizedPnl).toFixed(2);
      out.push(mk(b, delta < 0 ? "warn" : "info", "trade_closed", `${b.name}(${b.symbol}) 청산 ${b.closes - p.closes}건 · 실현손익 ${won(delta)}`));
    }

    // 3) 포지션 진입/완전청산(열린 포지션 수 변화)
    if (b.openCount > p.openCount) out.push(mk(b, "info", "position_opened", `${b.name}(${b.symbol}) 포지션 진입`));
    else if (b.openCount < p.openCount && b.openCount === 0) out.push(mk(b, "info", "position_closed", `${b.name}(${b.symbol}) 포지션 전량 청산`));
  }
  return out;
}

/**
 * 디바운서 — key당 TTL 동안 재발신 억제. shouldSend 호출마다 만료분 스윕 → Map 무한증식 방지.
 * key 권장값 = `${kind}:${botId}` (같은 봇·같은 종류 폭주만 억제, 다른 봇/종류는 독립).
 */
export class Debouncer {
  private seen = new Map<string, number>(); // key -> 만료 ms
  shouldSend(key: string, nowMs: number, ttlMs: number): boolean {
    this.sweep(nowMs);
    const exp = this.seen.get(key);
    if (exp !== undefined && exp > nowMs) return false; // TTL 내 중복 → 억제
    this.seen.set(key, nowMs + ttlMs);
    return true;
  }
  /** 만료된 항목 제거(메모리 누수 방지). shouldSend가 매번 호출하지만 외부 주기호출도 가능. */
  sweep(nowMs: number): void {
    for (const [k, exp] of this.seen) if (exp <= nowMs) this.seen.delete(k);
  }
  get size(): number { return this.seen.size; }
}

/** 최근 알림 링버퍼(대시보드 피드/SSE). cap 초과 시 오래된 것부터 폐기. */
export class AlertBuffer {
  private buf: AlertEvent[] = [];
  constructor(private cap = 200) {}
  push(e: AlertEvent | AlertEvent[]): void {
    const arr = Array.isArray(e) ? e : [e];
    if (arr.length === 0) return;
    this.buf.push(...arr);
    if (this.buf.length > this.cap) this.buf.splice(0, this.buf.length - this.cap);
  }
  /** 최신순 최근 n개. */
  recent(n = 50): AlertEvent[] {
    return this.buf.slice(-n).reverse();
  }
  get size(): number { return this.buf.length; }
}
