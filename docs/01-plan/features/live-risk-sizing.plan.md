# Plan — 라이브 리스크 사이징 배선 (live-risk-sizing)

> 작성: 2026-06-10 · 단계: Plan · repo: quant-mcp
> 갭 출처: docs(stock-autotrade)/03-analysis/quant-mcp-real-trading-gap.md §6 P1 #8 "라이브 리스크 사이징 배선"

## Executive Summary

| 관점 | 내용 |
|---|---|
| **Problem** | 리스크 엔진(EWMA 볼타게팅·ATR·Kelly, `src/core/risk/sizing.ts`)이 `suggest_position_size` MCP 조언 툴로만 존재하고, 봇 러너·백테엔진은 `floor(capital/price)`·`quantityPercent`로 **단순 사이징**. 리스크 지능이 실행과 분리 → "risk filter, not alpha source" 정체성이 라이브에서 거짓. |
| **Solution** | 변동성 타게팅(vol_target) 사이징을 **단일 순수함수**로 만들어 백테엔진 진입 사이징 + 러너 주문 사이징 **양쪽에서 동일 호출** → 리스크 기반 수량이 실주문에 반영되며 **backtest≡live 구조 보존**. |
| **Function/UX 효과** | composite에 `riskSizing` 설정 시(opt-in), 봇이 변동성에 반비례해 포지션 크기 자동 조절(고변동=작게, 저변동=크게, leverageCap≤1 현물 무레버리지). 미설정 봇은 기존 `quantityPercent` 그대로(백워드 호환). |
| **Core Value** | 프로젝트 자기명제("가치=리스크 통제")를 **라이브 실행에서 진실로** 만든다. 새 알파가 아니라 알려진 리스크 통제를 실주문에 배선. |

## Context Anchor

| 항목 | 값 |
|---|---|
| **WHY** | 리스크 모듈이 조언 툴로만 있고 실주문 사이징은 순진함 → 정체성 구멍(갭문서 P1 #8) |
| **WHO** | quant-mcp로 봇 운용하는 에이전트/사장님(페이퍼 우선, testnet 검증 후 라이브) |
| **RISK** | backtest≡live 깨짐(엔진·러너 사이징 불일치) / realizedVol→0 무한레버리지 / 기존 봇 회귀 |
| **SUCCESS** | 동일 입력에 엔진·러너 qty 동일(패리티 테스트 PASS) + opt-in(미설정 봇 무변화) + testnet 실주문 E2E |
| **SCOPE** | vol_target 단일 모드 · 포지션단위만(포트폴리오 MDD/heat 제외) · 현물(leverageCap≤1) |

## 1. 요구사항 (Requirements)

- **R1**: 변동성 타게팅 사이징을 순수함수 `computeOrderQty(...)`로 구현. 입력=최근 종가(또는 returns)+timeframe+equity+price+commission+riskSizing설정 → 출력=정규화 전 목표 수량.
- **R2**: 백테엔진 단일전략 진입(engine.ts ~233)과 복합전략 진입(~797)에서, riskSizing 설정이 있으면 `computeOrderQty`로 수량 결정. 없으면 기존 `quantityPercent` 경로 유지.
- **R3**: 러너 `planPositionDelta`(runner.ts ~133)와 스캐너 사이징(~343)에서 동일 `computeOrderQty` 호출(엔진과 동일 입력 규약).
- **R4**: composite 스키마에 `riskSizing` 필드 추가(opt-in). 형태: `{ method:"vol_target", targetVolAnnual:number, leverageCap?:number, lookback?:number }`. 검증 스키마(Zod) + 마이그레이션(prod).
- **R5**: SDK `deploy({ riskSizing })` 노출 + JARVIS-PROMPT 정직 문구("변동성 타게팅 = 리스크 통제, 알파 아님").
- **R6**: realizedVol→0 / 표본부족 / NaN 가드(무한레버리지·0수량 폭주 방지). leverageCap 기본 1.0(현물).
- **R7**: 기존 안전경로(liveGate/checkLimits/sizeFromBalance/2단계토큰) 불변 — 사이징은 그 **앞단**에서 목표수량만 산출, 캡·잔고초과 방지는 기존 로직이 계속 강제.

## 2. 성공 기준 (Success Criteria)

- **SC1**: 패리티 테스트 — 동일 (bars, equity, price, riskSizing)에서 엔진 진입 qty == 러너 `computeOrderQty` qty (floorQty 동일). PASS.
- **SC2**: 백워드 호환 — riskSizing 미설정 시 엔진·러너 수량이 현재(quantityPercent/floor(capital/price))와 **바이트 동일**(회귀 0). 기존 vitest 전부 GREEN.
- **SC3**: 가드 — realizedVol=0/표본<2/NaN 입력에 qty=0 또는 안전 폴백(무한레버리지·예외 없음). 단위테스트로 증명.
- **SC4**: backtest≡live 의미 — vol_target 봇의 백테스트 진입 수량 시계열이, 같은 봉을 먹인 러너 평가의 수량과 일치(통합 패리티).
- **SC5**: testnet 실주문 E2E — vol_target 봇 배포 → tickBot → 변동성 반영된 수량으로 실 testnet 매수 → 청산. 콘솔/봇로그 에러 0.
- **SC6**: tsc 0, 전체 vitest GREEN(신규 테스트 포함).

## 3. 범위 (Scope)

### In
- vol_target 단일 사이징 모드(EWMA realizedVol → targetVol/realizedVol 레버리지, cap≤1).
- 순수 코어 `order-sizing.ts` + 엔진 2곳 + 러너 2곳 배선 + composite 스키마/검증/마이그레이션 + SDK + 테스트.
- opt-in(설정 없으면 무변화).

### Out (이번 아님)
- ATR/Kelly 모드(computePositionSize엔 있으나 이번엔 vol_target만 노출 — method enum은 확장 여지로 두되 vol_target만 검증).
- 포트폴리오 레벨 캡(MDD 서킷/heat/상관). MDD·일일손실은 이미 safety.ts에 존재.
- 지정가 라이브(v2 보류), 선물 사이징(현물 우선), 신규 데이터소스.

## 4. 설계 방향 스케치 (상세는 Design 단계)

- **핵심 불변식**: 엔진과 러너가 **같은 순수함수**를 호출해야 backtest≡live. 함수는 부수효과 0, 입력은 양쪽이 공유 가능한 원시값(closes/returns, equity, price, commission, cfg).
- **equity 기준**: 백테=러닝 balance(복리), 라이브=정적 `bot.capital`(또는 실잔고). 이 차이는 **기존 quantityPercent와 동일한 기존 설계 선택**이라 vol_target가 새로 도입하는 발산 아님(패리티 테스트는 동일 equity를 양쪽에 주입해 함수 동치를 증명).
- **realizedVol 산출**: `annualizeVol(computeEwmaVol(toLogReturns(closes)), timeframe)` 재사용. lookback 기본=윈도우 가용분.
- **notional→qty**: `computePositionSize({method:"vol_target",equity,targetVolAnnual,realizedVolAnnual,leverageCap})` → notional → `floorQty(notional/(price×(1+commission/100)))`.
- Design에서 3안(A 최소변경 / B 클린 / C 실용균형) 비교 예정. 유력=C(순수 헬퍼 1개 + 호출지점 4곳 가드 분기).

## 5. 리스크 & 완화

| 리스크 | 완화 |
|---|---|
| 엔진·러너 사이징 미세 불일치 → backtest≠live | 단일 순수함수 강제 + 패리티 테스트(SC1/SC4) |
| 기존 봇 수량 변동(회귀) | opt-in 분기, 미설정 시 기존 경로 바이트 동일(SC2) |
| realizedVol→0 무한레버리지 | computeVolTargetLeverage 내장 클램프 + cap≤1 + 가드 테스트(SC3) |
| 안전캡 우회 | 사이징은 목표수량만, liveGate/checkLimits/sizeFromBalance 불변(R7) |
| 마이그레이션 충돌(동시 세션) | 다음 빈 번호 확인 후 prod 적용, 커밋 시 내 파일만 add |

## 6. 영향 파일 (예상)

- 신규: `src/core/risk/order-sizing.ts`(순수) + `test/order-sizing.test.ts` + `test/risk-sizing-parity.test.ts`
- 수정: `src/core/backtest/engine.ts`(단일+복합 진입 2곳) · `src/runner/runner.ts`(planPositionDelta+scanner) · composite 스키마/검증(`src/core/validation/*` 또는 schema) · 마이그레이션 1개(prod) · `src/mcp-server/*`(deploy 파라미터+JARVIS-PROMPT)

## 7. 다음 단계

`/pdca design live-risk-sizing` — 3 아키텍처 옵션 비교 후 선택 → 구현.
