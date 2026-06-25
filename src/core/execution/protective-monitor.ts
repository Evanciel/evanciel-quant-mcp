/**
 * protective-monitor.ts — 데몬 측 "합성 상주 보호"의 순수 평가 로직.
 *
 * 거래소 상주 SL/TP를 지원하지 않는 브로커(KR)의 라이브 포지션을 전략 봉 주기와 무관하게
 * 고빈도로 감시할 때, 현재가 한 점으로 보호 청산 여부를 판정한다. 부수효과 0(순수) → 테스트·재사용 용이.
 *
 * 산식은 엔진(core/backtest/engine.ts 고정 SL/TP)·protective.ts(트레일링) 기준과 **동일**하게 정렬한다.
 *   - 현물 롱 only(현재 러너는 현물). 숏/선물은 향후.
 *   - 우선순위: 손실 제한(SL → 트레일링) 먼저, 그 다음 TP. 같은 가격에 SL과 TP가 동시 성립할 수 없으나(롱),
 *     보호 의도상 손절을 우선 검사.
 */

export type ProtectiveExitKind = "sl" | "trail" | "tp";

export interface ProtectiveExitInput {
  entryAvg: number;                       // 진입 평단
  peakPrice?: number;                     // 진입 후 고점(트레일링 기준). 미지정 시 entryAvg로 폴백.
  price: number;                          // 현재가(getPrice 단건)
  stopLossPercent?: number | null;        // 고정 SL %
  takeProfitPercent?: number | null;      // TP %
  trailingStopPercent?: number | null;    // 트레일링 SL %
}

export interface ProtectiveExitResult {
  hit: boolean;
  kind: ProtectiveExitKind | null;
  level: number | null;                   // 트리거된 기준 가격(로그/감사용)
}

const NONE: ProtectiveExitResult = { hit: false, kind: null, level: null };

/**
 * 현물 롱 포지션의 보호 청산 여부를 현재가 한 점으로 판정.
 * 입력이 무효(평단/현재가 ≤ 0)면 hit=false(fail-safe: 모니터는 청산 안 함 → 다음 스윕 재시도).
 */
export function evaluateProtectiveExit(p: ProtectiveExitInput): ProtectiveExitResult {
  const { entryAvg, price } = p;
  if (!(entryAvg > 0) || !(price > 0)) return NONE;

  // ① 고정 SL: 현재가 ≤ 평단×(1 - sl/100). (engine.ts: stopLevel = avgEntryPrice*(1-sl/100))
  if (p.stopLossPercent != null && p.stopLossPercent > 0) {
    const slLevel = entryAvg * (1 - p.stopLossPercent / 100);
    if (price <= slLevel) return { hit: true, kind: "sl", level: slLevel };
  }

  // ② 트레일링 SL: 고점×(1 - trail/100). (protective.ts: trailStop = extreme*(1-trail/100), 롱)
  if (p.trailingStopPercent != null && p.trailingStopPercent > 0) {
    const peak = Math.max(p.peakPrice && p.peakPrice > 0 ? p.peakPrice : entryAvg, price);
    const trailLevel = peak * (1 - p.trailingStopPercent / 100);
    if (price <= trailLevel) return { hit: true, kind: "trail", level: trailLevel };
  }

  // ③ TP: 현재가 ≥ 평단×(1 + tp/100). (engine.ts: tpHit = pnlPercent >= tp)
  if (p.takeProfitPercent != null && p.takeProfitPercent > 0) {
    const tpLevel = entryAvg * (1 + p.takeProfitPercent / 100);
    if (price >= tpLevel) return { hit: true, kind: "tp", level: tpLevel };
  }

  return NONE;
}
