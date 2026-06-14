# P1 잔여 구현 결과 (2026-06-14)

> 입력: `p1-impl-plan-2026-06-14.md`(설계+적대검증). 울트라코드 설계 워크플로우(15 에이전트) 후 메인 루프 순차 구현.
> 테스트 448 → **465**. 커밋: 5d76833(P1-6,24) → 6e0dc65(P1-23) → 4855da3(P1-22) → fe97d72(P1-2).

## 처리 결과

| 항목 | 처리 | 커밋 | 비고 |
|---|---|---|---|
| **P1-6** 일일손실 통화 분리 | ✅ 구현 | 5d76833 | USDT/KRW 독립 서킷, 우선순위 분리>단일>기본 |
| **P1-24** 감사 fail-closed + HALT | ✅ 구현 | 5d76833 | **실버그 교정**: dailyRealizedLoss catch `return 0`(fail-open)→`NEGATIVE_INFINITY`. AUDIT_FAILURE_HALT, /api/audit-health, 문서 |
| **P1-23** 스캐너 부분체결 + 라이브 거절 | ✅ 구현 | 6e0dc65 | **실버그 교정**: tickScanner 의도수량 기록→체결분(gotQty/soldQty). scanner+live start_bot 거절 |
| **P1-22** 캔들 재시도 + 무결성 | ✅ 구현 | 4855da3 | fetchKlines withRetry, validateCandleContiguity(crypto 엄격/KR 중앙값), KIS 명시 hold |
| **P1-2** unknown 누적 reconcile | ✅ 구현 | fe97d72 | UNKNOWN_MAX_COUNT, 강제 getPositions(바이낸스 가드 우회), 보수적 adopt만 |
| **P1-10** KR 체결 reconcile | ⏸ 리서치 완료·구현 보류 | — | tr_id/엔드포인트 확정(KIS TTTC0084R/inquire-psbl-rvsecncl, 키움 ka10075), **응답필드 E2E 대기**. `kr-broker-gap-analysis.md` 기재 |
| **P1-5** 라이브 지정가 진입 | ⏸ 연기(사용자 결정) | — | 펜딩 상태머신·백테 타임아웃 모델 부재 → 패리티 붕괴 위험. `p1-impl-plan-2026-06-14.md` §순서7에 설계 보존 |

## 추가 색출 실버그 (계획 외)

1. **dailyRealizedLoss fail-open**: 손실 조회 실패 시 0 반환 → 일일손실 서킷 무력화. NEGATIVE_INFINITY로 fail-closed 교정. (설계계획은 POSITIVE_INFINITY를 제안했으나 비교식 `dl<=-circuit` 부호상 차단 안 됨 — 검증으로 바로잡음.)
2. **스캐너 부분체결 발산**: tickScanner가 의도수량으로 장부 기록(단일봇은 Sprint3에서 수정, 스캐너 경로 누락) → 라이브 부분체결 시 장부≠거래소.
3. **타입가드 오탐 방지**: 계획이 "역전"이라 지적한 reconcileLivePosition 가드는 실제로는 정상 — 잘못 고치면 KR reconcile 붕괴. 변경 안 함(검증으로 확인).

## 검증

- tsc 0, vitest **465/465**(P1 배치 +47: 통화분리 3 + 캔들 9 + 스캐너 3 + unknown 1 + 기존 회귀 보존).
- 실 Binance fetchKlines + 무결성 검증 스모크 PASS.
- ESM import 호이스팅 주의: 모듈 로드 시 평가되는 상수(UNKNOWN_MAX_COUNT 등)는 테스트에서 env 후설정 불가 → 기본값 기준 검증.

## 남은 후속 (외부 차단/사용자 결정)

1. **P1-10 본구현** — KIS 모의키 + 키움 모의키 확보 → 미체결 응답필드 E2E 확정 → getOpenOrders(KR) + reconcile 배선. 요청부 스펙은 확정됨.
2. **P1-5 본구현** — 별도 설계 스프린트(상태머신 + 백테 타임아웃 모델 Option A/B 결정).
3. **KIS 모의 E2E**(P0-4 후속), **Docker 재시작 시나리오**(P0-2 후속) — 키/엔진 확보 시.
