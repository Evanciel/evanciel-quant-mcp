# Design — 라이브 리스크 사이징 배선 (live-risk-sizing)

> 작성: 2026-06-10 · 단계: Design · 선택 아키텍처: **C. 실용균형** · Plan: `docs/01-plan/features/live-risk-sizing.plan.md`

## Context Anchor

| 항목 | 값 |
|---|---|
| **WHY** | 리스크 모듈이 조언 툴로만 있고 실주문 사이징은 순진함 → 정체성 구멍(갭문서 P1 #8) |
| **WHO** | quant-mcp 봇 운용 에이전트/사장님(페이퍼 우선, testnet 검증 후 라이브) |
| **RISK** | backtest≡live 깨짐 / realizedVol→0 무한레버리지 / 기존 봇 회귀 |
| **SUCCESS** | 엔진·러너 qty 동일(패리티) + opt-in(미설정 무변화) + testnet 실주문 E2E |
| **SCOPE** | vol_target 단일 · 포지션단위만 · 현물 leverageCap≤1 |

## 1. Overview

opt-in `riskSizing` 설정이 있는 composite 봇은 **변동성 타게팅**으로 포지션 수량을 산출한다. 핵심은 **단일 순수함수 `computeOrderQty()`**가 legacy(quantityPercent / floor(capital/price))와 vol_target을 **모두 내부 처리**하고, 백테엔진 2곳 + 러너 2곳이 이 함수를 **균일 호출**하는 것(분기 산재 0). legacy 분기는 현재 공식을 그대로 재현 → 미설정 봇 **바이트 동일**(회귀 0), 그리고 함수 공유로 **backtest≡live 구조 보장**.

## 2. 선택 아키텍처 (C. 실용균형) 근거

- A(분기 산재)는 4곳 중복 → 유지보수 약점. B(PositionSizer 전면 통일)는 legacy 재작성으로 SC2(바이트 동일) 위험.
- **C**: 함수 1개가 권위. 호출지점은 `computeOrderQty({...})` 한 형태. legacy 경로는 함수 내부에서 기존 공식 그대로 → 회귀 0이 **구성적으로 보장**. vol_target 추가도 함수 내부 분기 1곳.

## 3. 코어 함수 설계 — `src/core/risk/order-sizing.ts` (신규, 순수)

```ts
import { floorQty } from "../position/qty.js";
import { computePositionSize, computeEwmaVol, annualizeVol, toLogReturns } from "./sizing.js";

export interface RiskSizingConfig {
  method: "vol_target";                 // 이번엔 vol_target만(enum 확장 여지)
  targetVolAnnual: number;              // 예: 0.2 (연 20%)
  leverageCap?: number;                 // 기본 1.0(현물 무레버리지)
  lookback?: number;                    // realizedVol 계산 봉수(기본=가용분, 최대 가용)
}

export interface OrderQtyInput {
  equity: number;                       // 백테=러닝 balance, 라이브=bot.capital(또는 실잔고)
  price: number;                        // 진입 체결 추정가
  commissionPct: number;                // 기존 사이징과 동일 수수료 반영(예: 0.1)
  closes: number[];                     // realizedVol용 최근 종가(오름차순, 현재 봉 포함 가능)
  timeframe: string;                    // 연환산용(크립토 √365 계열)
  // legacy 경로 입력(riskSizing 없을 때) — 기존 공식 재현
  legacyQuantityPercent: number;        // 단일/복합 진입의 quantityPercent (러너는 100 등 호출측 규약)
  riskSizing?: RiskSizingConfig | null; // 있으면 vol_target, 없으면 legacy
}

/** 단일 진입 목표수량(정규화/캡 전). 부수효과 0 → 엔진·러너 공용 = backtest≡live. */
export function computeOrderQty(i: OrderQtyInput): { qty: number; notional: number; detail: Record<string, unknown> } {
  const px = i.price * (1 + i.commissionPct / 100);
  if (!(i.equity > 0) || !(px > 0)) return { qty: 0, notional: 0, detail: { error: "equity/price<=0" } };

  // ── legacy: 기존 공식 그대로(바이트 동일) ──
  if (!i.riskSizing) {
    const invest = i.equity * (i.legacyQuantityPercent / 100);
    return { qty: floorQty(invest / px), notional: invest, detail: { mode: "legacy", legacyQuantityPercent: i.legacyQuantityPercent } };
  }

  // ── vol_target ──
  const lookback = i.riskSizing.lookback && i.riskSizing.lookback > 0 ? i.riskSizing.lookback : i.closes.length;
  const slice = i.closes.slice(-Math.max(2, lookback));
  const realizedVolAnnual = annualizeVol(computeEwmaVol(toLogReturns(slice)), i.timeframe);
  const sized = computePositionSize({
    method: "vol_target", equity: i.equity, price: i.price,
    targetVolAnnual: i.riskSizing.targetVolAnnual,
    realizedVolAnnual,                       // 0이면 computeVolTargetLeverage가 0 반환(무한레버리지 가드)
    leverageCap: i.riskSizing.leverageCap ?? 1.0,
  });
  return { qty: floorQty(sized.notional / px), notional: sized.notional, detail: { mode: "vol_target", realizedVolAnnual, ...sized.detail } };
}
```

**가드**(SC3): equity/price≤0→0 · realizedVol≤0→computeVolTargetLeverage가 0 · 표본<2→EwmaVol 0→레버리지 0→qty 0(무거래, 예외 없음) · NaN→Number.isFinite 필터(EwmaVol 내장).

## 4. 통합 지점 (4곳, 균일 호출)

| # | 파일:위치 | 현재 | 변경 |
|---|---|---|---|
| 1 | `engine.ts` 단일진입 (~233) | `invest=balance*qp/100; qty=floorQty(invest/px)` | `qty=computeOrderQty({equity:balance, price:fillPrice, commissionPct:commission, closes, timeframe, legacyQuantityPercent:rule.quantityPercent, riskSizing}).qty` |
| 2 | `engine.ts` 복합진입 (~797) | 동일 패턴 | 동일 치환(복합 진입가/balance 사용) |
| 3 | `runner.ts` `planPositionDelta` (~133) | `Math.max(1,floor(capital/price))` | `computeOrderQty({equity:capital, price, commissionPct:0.1, closes, timeframe, legacyQuantityPercent:100, riskSizing}).qty` (보유의도 시) |
| 4 | `runner.ts` 스캐너 (~343) | `floor(perSymCapital/price)` | 동일 치환(perSymCapital, 심볼별 closes) |

- **closes 출처**: 엔진=`data[0..i]` 슬라이스(현재 봉까지), 러너=300봉 윈도우. 동일 봉 → 동일 realizedVol → 동일 qty.
- **legacyQuantityPercent 규약**: 엔진은 `rule.quantityPercent`(현 값), 러너는 100(=`floor(capital/price)`와 동치: invest=capital×100/100=capital). **이로써 legacy 경로가 현재 러너 공식과 바이트 동일**.
- riskSizing은 composite에서 읽어 엔진 config + 러너에 전달(아래 §5).

## 5. 스토어 / 스키마 변경

- **컬럼 추가**(`src/store/db.ts`): CREATE TABLE composite_strategies에 `risk_sizing TEXT` 추가 + **기존 DB용 멱등 ALTER**:
  ```ts
  try { d.exec(`ALTER TABLE composite_strategies ADD COLUMN risk_sizing TEXT`); } catch { /* 이미 존재 */ }
  ```
  (node:sqlite는 중복 컬럼에 throw → try/catch가 멱등 마이그레이션.)
- `CompositeRow` 타입에 `risk_sizing: unknown | null` + insert/get에 `J()/P()` 직렬화(기존 tp_ladder 패턴 동일).
- **검증**(`src/mcp-server/schemas.ts`): `riskSizing: z.object({ method: z.literal("vol_target"), targetVolAnnual: z.number().positive().max(2), leverageCap: z.number().positive().max(1).optional(), lookback: z.number().int().positive().optional() }).optional()` (cap≤1 현물 강제, targetVol 상한 200% 새너티).

## 6. SDK / MCP

- `bot-handlers.ts` deploy/save 경로에 `riskSizing` 전달 → insertComposite.
- JARVIS-PROMPT: "riskSizing(vol_target) = 변동성 반비례 사이징 = **리스크 통제**(고변동 작게/저변동 크게, 무레버리지). 알파 아님. 미설정 시 기존 quantityPercent."

## 7. 테스트 계획

- **L1 단위**(`test/order-sizing.test.ts`): legacy=기존공식 동일 · vol_target 고변동<저변동 수량 · realizedVol0→qty0 · 표본<2→qty0 · cap 클램프 · NaN 가드.
- **L2 패리티**(`test/risk-sizing-parity.test.ts`)(SC1/SC4): 동일 (closes,equity,price,cfg)로 "엔진 호출형태 == 러너 호출형태" qty 일치. + legacy 분기가 현 `floor(capital/price)` / `balance*qp` 재현(SC2).
- **L3 회귀**: 기존 vitest 전부 GREEN(미설정 봇 무변화).
- **L4 testnet E2E**(SC5): vol_target 봇 배포→tickBot→실 testnet 매수(수량이 변동성 반영)→청산, 에러 0. (Track1 verify-testnet-bot-e2e 패턴 재사용.)

## 8. 리스크 & 완화 (Plan §5 상속)

realizedVol→0 무한레버리지=내장 클램프+cap≤1 · 회귀=legacy 바이트동일(파리티) · 안전캡 우회=사이징은 목표수량만, liveGate/checkLimits/sizeFromBalance 불변.

## 9. 영향 파일

신규: `src/core/risk/order-sizing.ts`, `test/order-sizing.test.ts`, `test/risk-sizing-parity.test.ts`
수정: `src/core/backtest/engine.ts`(2곳), `src/runner/runner.ts`(2곳), `src/store/db.ts`(컬럼+ALTER+직렬화+타입), `src/mcp-server/schemas.ts`(zod), `src/mcp-server/bot-handlers.ts`(deploy 전달+JARVIS).

## 10. 구현 순서 (Session Guide)

1. **module-1 코어**: `order-sizing.ts` + `order-sizing.test.ts`(L1) → 순수함수 단독 GREEN.
2. **module-2 스토어/스키마**: db.ts 컬럼+ALTER+직렬화+타입, schemas.ts zod → 영속/검증.
3. **module-3 배선**: engine.ts 2곳 + runner.ts 2곳 치환 → `risk-sizing-parity.test.ts`(L2) + 회귀(L3).
4. **module-4 SDK**: bot-handlers deploy({riskSizing}) + JARVIS-PROMPT.
5. **module-5 검증**: tsc0 + 전체 vitest + testnet E2E(L4) → 커밋.

## 11. 다음 단계

`/pdca do live-risk-sizing` (전체) 또는 `--scope module-1`부터 점진 구현.
