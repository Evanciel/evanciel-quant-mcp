/**
 * 파생 신호(펀딩비/OI/롱숏) — 순수함수. Binance USDⓈ-M Futures 데이터에서 리스크/레짐 필터 피처 계산.
 *
 * 정직한 포지셔닝(리서치 결론, 두 엣지 클래스 분리):
 *  - 펀딩 CARRY(델타뉴트럴 수확) = STRONG·peer-reviewed(SSRN 4666425 ~43%ann) → 단 숏/선물 필요(③ 의존).
 *  - 방향성 신호(펀딩/OI/롱숏 z-score·틸트) = WEAK·레짐의존 → '진입 알파' 아니라 '리스크/레짐 필터'로만.
 * 함정 방어: 펀딩 간격 4h/8h 혼재(interval-aware 연율화 필수, x1095 하드코딩 금지), 펀딩 cap clamp로 극단 포화,
 *  globalLongShort=계좌수(노이즈)·topLongShortPosition=자본가중(우월). 데이터는 ~30일만 보존(소급 백필 불가).
 */

/**
 * 펀딩 연율화(APR) — interval-aware. APR = rate × (24/intervalHours) × 365.
 * ⚠️ 8h=×1095, 4h=×2190. intervalHours 하드코딩(8) 시 4h 심볼 2배 오차(리서치 #1 함정). fundingInfo로 per-symbol 확인.
 */
export function annualizeFunding(ratePerInterval: number, intervalHours = 8): number {
  if (!(intervalHours > 0)) return 0;
  return ratePerInterval * (24 / intervalHours) * 365;
}

/** 펀딩 z-score = (current − mean) / std. 크라우딩/스트레스 게이지. |z|>2 = 극단(컨트라리안 필터, 소액). */
export function fundingZScore(rates: number[], current?: number): number {
  const r = rates.filter((x) => Number.isFinite(x));
  if (r.length < 2) return 0;
  const cur = current ?? r[r.length - 1];
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const std = Math.sqrt(r.reduce((s, x) => s + (x - mean) ** 2, 0) / r.length);
  return std > 0 ? (cur - mean) / std : 0;
}

export type OiRegime = "trend_confirm" | "short_covering" | "crowding" | "capitulation" | "neutral";

/**
 * OI vs 가격 4분면 레짐(추세 확인용, 단독 진입 알파 아님):
 *  가격↑ OI↑ = trend_confirm(실추세/컨빅션) | 가격↑ OI↓ = short_covering(약함) |
 *  가격↓ OI↑ = crowding(신규 숏 유입/취약) | 가격↓ OI↓ = capitulation(청산 소진).
 * threshold = 유의 변화로 볼 최소 %(노이즈 컷).
 */
export function oiPriceRegime(oiChangePct: number, priceChangePct: number, threshold = 1): { regime: OiRegime; note: string } {
  const pUp = priceChangePct > threshold, pDn = priceChangePct < -threshold;
  const oUp = oiChangePct > threshold, oDn = oiChangePct < -threshold;
  if (pUp && oUp) return { regime: "trend_confirm", note: "가격↑+OI↑: 신규 자금 유입 추세(컨빅션)" };
  if (pUp && oDn) return { regime: "short_covering", note: "가격↑+OI↓: 숏커버링(약한 상승)" };
  if (pDn && oUp) return { regime: "crowding", note: "가격↓+OI↑: 신규 숏 유입(취약·반등 위험)" };
  if (pDn && oDn) return { regime: "capitulation", note: "가격↓+OI↓: 청산 소진(바닥 가능)" };
  return { regime: "neutral", note: "유의 변화 없음" };
}

/**
 * 롱숏 비율 틸트. ratio = long/short(또는 longAccount/shortAccount). >1 롱우세, <1 숏우세.
 * 자본가중 top-trader(topLongShortPositionRatio)가 '스마트머니'로 우월. 리테일 계좌수 비율은 컨트라리안 오버레이.
 */
export function longShortTilt(ratio: number): { tilt: "long" | "short" | "balanced"; strength: number; note: string } {
  if (!(ratio > 0)) return { tilt: "balanced", strength: 0, note: "데이터 없음" };
  const dev = ratio - 1;
  const tilt = dev > 0.1 ? "long" : dev < -0.1 ? "short" : "balanced";
  return { tilt, strength: +Math.abs(dev).toFixed(3), note: `롱/숏 ${ratio.toFixed(2)} → ${tilt}` };
}

/** 백분율 변화. (now-then)/then × 100. then≤0 방어. */
export function pctChange(now: number, then: number): number {
  return then > 0 ? ((now - then) / then) * 100 : 0;
}

export interface DerivativesInput {
  symbol: string;
  fundingRate?: number;        // 현재(예측) 펀딩, per-interval 소수(예 0.0001)
  intervalHours?: number;      // 심볼 펀딩 간격(8 기본, 일부 alt 4)
  fundingHistory?: number[];   // 최근 펀딩 히스토리(z-score용)
  oiNow?: number; oiThen?: number;       // OI(USDT notional) 현재/과거
  priceNow?: number; priceThen?: number; // 가격 현재/과거(같은 기간)
  topPositionRatio?: number;   // 자본가중 top-trader long/short
  retailAccountRatio?: number; // 리테일 계좌수 long/short(컨트라리안)
  takerBuySellRatio?: number;  // 공격적 체결 매수/매도
}

/**
 * 종합 파생 신호 요약 — 리스크/레짐 필터 묶음(진입 알파 아님). 모든 산출은 OOS 검증 전 가중 0으로 취급.
 */
export function summarizeDerivatives(inp: DerivativesInput): {
  symbol: string;
  fundingApr: number | null;
  fundingZ: number | null;
  fundingExtreme: boolean;
  oiRegime: { regime: OiRegime; note: string } | null;
  topTraderTilt: ReturnType<typeof longShortTilt> | null;
  retailContrarian: ReturnType<typeof longShortTilt> | null;
  takerFlow: "buy" | "sell" | "balanced" | null;
  warnings: string[];
} {
  const warnings: string[] = [];
  const intervalHours = inp.intervalHours ?? 8;
  if (inp.intervalHours == null && inp.fundingRate != null) warnings.push("펀딩 간격 미지정 → 8h 가정(4h 심볼이면 연율 2배 오차, fundingInfo 확인 권장)");

  const fundingApr = inp.fundingRate != null ? +annualizeFunding(inp.fundingRate, intervalHours).toFixed(4) : null;
  const fundingZ = inp.fundingHistory && inp.fundingHistory.length >= 2
    ? +fundingZScore(inp.fundingHistory, inp.fundingRate).toFixed(3) : null;
  const fundingExtreme = fundingZ != null && Math.abs(fundingZ) > 2;

  const oiRegime = (inp.oiNow != null && inp.oiThen != null && inp.priceNow != null && inp.priceThen != null)
    ? oiPriceRegime(pctChange(inp.oiNow, inp.oiThen), pctChange(inp.priceNow, inp.priceThen)) : null;

  const topTraderTilt = inp.topPositionRatio != null ? longShortTilt(inp.topPositionRatio) : null;
  const retailContrarian = inp.retailAccountRatio != null ? longShortTilt(inp.retailAccountRatio) : null;
  const takerFlow = inp.takerBuySellRatio != null
    ? (inp.takerBuySellRatio > 1.05 ? "buy" : inp.takerBuySellRatio < 0.95 ? "sell" : "balanced") : null;

  if (fundingExtreme) warnings.push(`펀딩 극단(z=${fundingZ}) — 크라우딩/스트레스, cap clamp로 포화 가능. 컨트라리안 필터로만 소액.`);
  warnings.push("방향성 파생신호는 WEAK·레짐의존(리서치) — 진입 알파 아닌 리스크/레짐 필터. OOS 검증 전 사이징 가중 0.");

  return { symbol: inp.symbol, fundingApr, fundingZ, fundingExtreme, oiRegime, topTraderTilt, retailContrarian, takerFlow, warnings };
}
