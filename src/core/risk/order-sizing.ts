/**
 * core/risk/order-sizing.ts — 봇 주문 목표수량 단일 산출(순수). Design §3.
 *
 * 핵심: 백테엔진(진입)과 러너(주문)가 **이 함수 하나만** 호출 → backtest≡live 구조 보장.
 * legacy(quantityPercent / floor(capital/price))와 vol_target(변동성 타게팅)을 내부 분기로 모두 처리.
 * legacy 경로는 기존 공식을 그대로 재현 → riskSizing 미설정 봇은 **바이트 동일**(회귀 0).
 *
 * 정직: vol_target = 변동성 반비례 사이징 = **리스크 통제**(고변동 작게/저변동 크게, 무레버리지). 알파 아님.
 */
import { floorQty } from "../position/qty.js";
import { computePositionSize, computeEwmaVol, annualizeVol, toLogReturns, computeFuturesSize } from "./sizing.js";
import { atr as atrIndicator } from "../strategy/indicators.js";

/**
 * 사이징 모드 설정(opt-in 디스크리미네이티드 유니언). 미지정(null)이면 legacy(quantityPercent).
 * 전부 "리스크 통제"이지 알파원이 아니다(리서치 결론). 입력은 전부 config(에이전트 선언) + 봇이 이미 보는 봉 데이터에서만
 * 도출 → 엔진·러너가 동일 config·동일 윈도우를 사용 → backtest≡live 구조 보장(런타임 체결이력 등 발산원 미사용).
 */
export type RiskSizingConfig =
  | VolTargetSizing
  | AtrSizing
  | KellySizing;

/** 변동성 타게팅: leverage=targetVol/realizedVol, [0,cap] 클램프. 고변동 작게/저변동 크게(무레버리지). */
export interface VolTargetSizing {
  method: "vol_target";
  targetVolAnnual: number; // 예: 0.2 (연 20%)
  leverageCap?: number; // 기본 1.0(현물 무레버리지)
  lookback?: number; // realizedVol 계산 봉수(기본=가용분)
}

/** ATR 사이징: 트레이드당 리스크를 equity의 riskPct로 고정. units=(equity×riskPct)/(ATR×atrMult), notional≤equity 캡. */
export interface AtrSizing {
  method: "atr";
  riskPct: number; // 트레이드당 리스크 비중(예: 0.01 = 1%)
  atrMult?: number; // 스톱거리 = ATR×atrMult (기본 2.0)
  atrPeriod?: number; // ATR 계산 기간(기본 14)
  lookback?: number; // ATR 계산용 최근 봉수(기본=가용분)
}

/** Fractional Kelly: f=winRate−(1−winRate)/(avgWin/avgLoss), ×fraction, [0,cap]. 통계는 config(정적·에이전트 선언). */
export interface KellySizing {
  method: "kelly";
  winRate: number; // 승률(0~1)
  avgWin: number; // 평균 이익 크기(양수)
  avgLoss: number; // 평균 손실 크기(양수)
  fraction?: number; // 켈리 분율(기본 0.5 = Half-Kelly)
  sampleSize?: number; // 통계 표본수(minSample 미만이면 fallback). 기본 0 → fallbackRiskPct.
}

export interface OrderQtyInput {
  equity: number; // 백테=러닝 balance, 라이브=bot.capital(또는 실잔고)
  price: number; // 진입 체결 추정가
  commissionPct: number; // 기존 사이징과 동일 수수료 반영(예: 0.1)
  closes: number[]; // realizedVol/ATR용 최근 종가(오름차순, 현재 봉 포함 가능)
  timeframe: string; // 연환산용(크립토 √365 계열)
  legacyQuantityPercent: number; // riskSizing 없을 때 기존 공식 재현(러너는 100=floor(capital/price) 동치)
  riskSizing?: RiskSizingConfig | null;
  highs?: number[]; // ATR 모드용 고가(closes와 동일 길이·정렬). 미제공/길이 불일치 시 ATR 산출 불가 → fixed(riskPct) 안전 폴백(노출=equity×riskPct, 무거래 아님 — order-sizing.test 'highs/lows 미제공' 케이스가 이 동작 고정).
  lows?: number[];  // ATR 모드용 저가(closes와 동일 길이·정렬). 미제공 시 highs와 동일하게 fixed(riskPct) 폴백.
  // ── 선물(레버리지) opt-in. 미지정/spot/leverage≤1이면 현물 경로 **바이트 동일**(회귀 0). ──
  market?: "spot" | "futures"; // 기본 spot. "futures"일 때만 leverage가 노출에 적용됨.
  leverage?: number;           // 명목 배율. >1 + market="futures"일 때만 활성. 그 외엔 무시(현물 동치).
  maxLeverage?: number;        // 레버리지 새너티 상한(기본 20). computeFuturesSize 클램프/캡 기준.
}

export interface OrderQtyResult {
  qty: number; // 정규화/캡 전 목표수량(floorQty 적용)
  notional: number;
  detail: Record<string, unknown>;
}

/** 선물 레버리지가 실제로 활성인지(= market="futures" 그리고 leverage>1). 그 외엔 현물 경로(바이트 동일). */
function leverageActive(i: OrderQtyInput): boolean {
  return i.market === "futures" && Number.isFinite(i.leverage) && (i.leverage as number) > 1;
}

/**
 * 목표수량 마감 단계. baseNotional = 각 사이징 모드가 산출한 '현물 환산 노출'(notional≤equity).
 *  - 현물(또는 leverage≤1): qty=floorQty(baseNotional/px), notional=baseNotional, detail 그대로 → 기존 동작 **바이트 동일**.
 *  - 선물(market=futures & leverage>1): computeFuturesSize로 notional=baseNotional×leverage(캡 equity×leverage),
 *    qty=floorQty(notional/px). detail에 leverage/margin/liqPrice/baseNotional 추가(현물 경로엔 미추가 → 회귀 0).
 * 단일 마감점이라 모든 모드(legacy/vol_target/atr/kelly)가 동일하게 레버리지 적용 → backtest≡live 유지.
 */
function finalizeQty(baseNotional: number, px: number, i: OrderQtyInput, detail: Record<string, unknown>): OrderQtyResult {
  if (!leverageActive(i)) {
    // 현물 경로: 기존 공식 그대로(추가 필드 0). 회귀 0.
    return { qty: floorQty(baseNotional / px), notional: baseNotional, detail };
  }
  // ⚠️ 머니패스 안전: baseNotional≤0은 모드의 '의도적 무거래'(zero-edge Kelly fraction 0, flat vol_target 무한레버리지 가드 → notional 0).
  //   computeFuturesSize도 이제 baseNotional 비유한/≤0 → 전부 0(fail-closed)이라 이중 방어. 여기서 선제 반환하는 이유:
  //   0 노출을 그대로 보존(현물과 동일 '베팅 안 함') + 선물 detail 페이로드(futuresLeverage/margin/baseNotional) 구성.
  if (!(baseNotional > 0)) return { qty: 0, notional: 0, detail: { ...detail, market: "futures", futuresLeverage: Math.min(Math.max(i.leverage as number, 1), i.maxLeverage && i.maxLeverage > 0 ? i.maxLeverage : 20), margin: 0, baseNotional: 0 } };
  // 선물 경로(opt-in): baseNotional을 레버리지배로 확대(정규화-후-캡). 수수료반영가(px)로 수량 산출(현물과 동일 규약).
  // 주의: detail에 모드 고유 'leverage'(vol_target의 변동성 레버리지 등)가 이미 있을 수 있어 충돌 방지차 선물 배율은 'futuresLeverage'로 노출.
  const f = computeFuturesSize({ equity: i.equity, price: px, leverage: i.leverage as number, baseNotional, maxLeverage: i.maxLeverage });
  return {
    qty: floorQty(f.notional / px),
    notional: f.notional,
    detail: { ...detail, market: "futures", futuresLeverage: f.leverage, margin: f.margin, liqPrice: f.liqPrice, baseNotional },
  };
}

/**
 * 단일 진입 목표수량. 부수효과 0 → 엔진·러너 공용.
 * 안전(전 모드 공통): equity/price≤0 → 0. computePositionSize의 wrap이 notional∈[0,equity] 클램프(정규화-후-캡, 머니패스 안전).
 *  - vol_target: realizedVol≤0/표본<2 → 레버리지 0(무한레버리지 가드) → qty 0.
 *  - atr: highs/lows 미제공 또는 ATR≤0 → computePositionSize가 fixed(riskPct)로 안전 폴백(노출 0 아님, 기존 read-tool과 동일 의미).
 *  - kelly: 표본<minSample 또는 비정상 통계 → fallbackRiskPct 폴백(computeFractionalKelly 가드).
 *  - futures(opt-in): market="futures"+leverage>1이면 위 모드의 노출을 레버리지배로 확대(notional≤equity×leverage, margin≤equity).
 *    미지정/spot/leverage≤1이면 현물 경로 바이트 동일. 레버리지는 노출 배율이지 알파 아님(손실도 배가) — 리스크 통제는 상주 SL/청산가 담당.
 */
export function computeOrderQty(i: OrderQtyInput): OrderQtyResult {
  const px = i.price * (1 + i.commissionPct / 100);
  if (!(i.equity > 0) || !(px > 0)) return { qty: 0, notional: 0, detail: { error: "equity/price<=0" } };

  // ── legacy: 기존 공식 그대로(바이트 동일). riskSizing 미설정 봇은 이 경로만 탐 → 회귀 0. ──
  // (선물 leverage opt-in 시에만 finalizeQty가 invest를 레버리지배로 확대. 현물은 invest 그대로.)
  if (!i.riskSizing) {
    const invest = i.equity * (i.legacyQuantityPercent / 100);
    return finalizeQty(invest, px, i, { mode: "legacy", legacyQuantityPercent: i.legacyQuantityPercent });
  }

  const rs = i.riskSizing;
  switch (rs.method) {
    case "vol_target": {
      // (기존 로직 바이트 동일 — 위치만 switch 분기로 이동)
      const lookback = rs.lookback && rs.lookback > 0 ? rs.lookback : i.closes.length;
      const slice = i.closes.slice(-Math.max(2, lookback));
      const realizedVolAnnual = annualizeVol(computeEwmaVol(toLogReturns(slice)), i.timeframe);
      const sized = computePositionSize({
        method: "vol_target",
        equity: i.equity,
        price: i.price,
        targetVolAnnual: rs.targetVolAnnual,
        realizedVolAnnual, // 0이면 computeVolTargetLeverage가 0 반환(무한레버리지 가드)
        leverageCap: rs.leverageCap ?? 1.0,
      });
      return finalizeQty(sized.notional, px, i, { mode: "vol_target", realizedVolAnnual, ...sized.detail });
    }

    case "atr": {
      // ATR을 봇이 보는 봉 윈도우에서 산출(엔진·러너 동일 윈도우 → backtest≡live). highs/lows 미제공 시 ATR 0 → fixed 폴백.
      const period = rs.atrPeriod && rs.atrPeriod > 0 ? rs.atrPeriod : 14;
      const lookback = rs.lookback && rs.lookback > 0 ? rs.lookback : i.closes.length;
      // closes/highs/lows를 동일 길이로 맞춘 뒤 lookback 슬라이스(끝에서). 길이 불일치/미제공이면 ATR 산출 불가 → atrNow 0.
      let atrNow = 0;
      const h = i.highs, l = i.lows, c = i.closes;
      if (h && l && h.length === c.length && l.length === c.length && c.length >= 2) {
        const n = Math.max(2, lookback);
        const cs = c.slice(-n), hs = h.slice(-n), ls = l.slice(-n);
        const arr = atrIndicator(cs, hs, ls, period);
        const last = arr[arr.length - 1];
        atrNow = Number.isFinite(last) && last > 0 ? last : 0;
      }
      const sized = computePositionSize({
        method: "atr",
        equity: i.equity,
        price: i.price,
        riskPct: rs.riskPct, // computePositionSize 내부 기본 0.01과 동일 의미(여기선 명시 전달)
        atr: atrNow,
        atrMult: rs.atrMult ?? 2.0,
      });
      return finalizeQty(sized.notional, px, i, { mode: "atr", atr: atrNow, atrPeriod: period, ...sized.detail });
    }

    case "kelly": {
      // 통계는 정적 config(에이전트 선언) — 런타임 체결이력 미사용 → 엔진·러너 동일 입력 → backtest≡live.
      const sized = computePositionSize({
        method: "kelly",
        equity: i.equity,
        price: i.price,
        winRate: rs.winRate,
        avgWin: rs.avgWin,
        avgLoss: rs.avgLoss,
        kellyFraction: rs.fraction ?? 0.5,
        sampleSize: rs.sampleSize ?? 0,
      });
      return finalizeQty(sized.notional, px, i, { mode: "kelly", ...sized.detail });
    }

    default: {
      // 미지원 method(타입상 도달 불가) → 안전하게 무거래.
      return { qty: 0, notional: 0, detail: { error: "unknown sizing method" } };
    }
  }
}
