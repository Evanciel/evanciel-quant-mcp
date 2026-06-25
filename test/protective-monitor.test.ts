/**
 * protective-monitor.test.ts — 데몬 측 합성 보호 평가(evaluateProtectiveExit) 단위 테스트.
 * 엔진/protective 산식 정렬, 경계, 우선순위(SL>trail>TP), fail-safe(무효 입력=미청산).
 */
import { describe, it, expect } from "vitest";
import { evaluateProtectiveExit } from "../src/core/execution/protective-monitor.js";

describe("evaluateProtectiveExit (현물 롱)", () => {
  it("보호 설정 없으면 미청산", () => {
    expect(evaluateProtectiveExit({ entryAvg: 100, price: 50 }).hit).toBe(false); // 반토막이어도 SL 없으면 미동작
  });

  it("고정 SL: 손절선 이하면 청산(경계 포함), 위면 미청산", () => {
    // sl 10% → 손절선 90
    expect(evaluateProtectiveExit({ entryAvg: 100, price: 89.9, stopLossPercent: 10 })).toMatchObject({ hit: true, kind: "sl" });
    expect(evaluateProtectiveExit({ entryAvg: 100, price: 90, stopLossPercent: 10 }).hit).toBe(true);   // 경계(=)도 청산
    expect(evaluateProtectiveExit({ entryAvg: 100, price: 90.1, stopLossPercent: 10 }).hit).toBe(false);
  });

  it("TP: 익절선 이상이면 청산(경계 포함)", () => {
    // tp 15% → 익절선 115
    expect(evaluateProtectiveExit({ entryAvg: 100, price: 115, takeProfitPercent: 15 })).toMatchObject({ hit: true, kind: "tp" });
    expect(evaluateProtectiveExit({ entryAvg: 100, price: 114.9, takeProfitPercent: 15 }).hit).toBe(false);
  });

  it("트레일링: 고점 대비 하락폭 초과 시 청산(peak=max(peakPrice,price))", () => {
    // 고점 120, trail 10% → 트레일선 108
    expect(evaluateProtectiveExit({ entryAvg: 100, peakPrice: 120, price: 108, trailingStopPercent: 10 })).toMatchObject({ hit: true, kind: "trail" });
    expect(evaluateProtectiveExit({ entryAvg: 100, peakPrice: 120, price: 108.1, trailingStopPercent: 10 }).hit).toBe(false);
    // 신고가 갱신 중(price>peakPrice)엔 미청산
    expect(evaluateProtectiveExit({ entryAvg: 100, peakPrice: 120, price: 130, trailingStopPercent: 10 }).hit).toBe(false);
    // peakPrice 미지정 → entryAvg 폴백(고점=현재가 기준)
    expect(evaluateProtectiveExit({ entryAvg: 100, price: 100, trailingStopPercent: 10 }).hit).toBe(false);
  });

  it("우선순위: SL이 트레일링/TP보다 먼저(손실 제한 우선)", () => {
    // SL과 트레일링 둘 다 성립하는 가격 → kind=sl
    const r = evaluateProtectiveExit({ entryAvg: 100, peakPrice: 120, price: 80, stopLossPercent: 10, trailingStopPercent: 10 });
    expect(r.hit).toBe(true);
    expect(r.kind).toBe("sl");
  });

  it("fail-safe: 무효 입력(평단/현재가 ≤ 0)은 미청산", () => {
    expect(evaluateProtectiveExit({ entryAvg: 0, price: 50, stopLossPercent: 10 }).hit).toBe(false);
    expect(evaluateProtectiveExit({ entryAvg: 100, price: 0, stopLossPercent: 10 }).hit).toBe(false);
    expect(evaluateProtectiveExit({ entryAvg: 100, price: -5, stopLossPercent: 10 }).hit).toBe(false);
  });

  it("0/음수 퍼센트는 비활성(미동작)", () => {
    expect(evaluateProtectiveExit({ entryAvg: 100, price: 1, stopLossPercent: 0 }).hit).toBe(false);
    expect(evaluateProtectiveExit({ entryAvg: 100, price: 1, stopLossPercent: -10 }).hit).toBe(false);
  });
});
