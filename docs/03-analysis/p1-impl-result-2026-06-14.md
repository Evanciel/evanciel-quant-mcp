# P1 잔여 구현 결과 (2026-06-14)

> 입력: `p1-impl-plan-2026-06-14.md`(설계+적대검증). 울트라코드 설계 워크플로우(15 에이전트) 후 메인 루프 순차 구현.
> 테스트 448 → **465**. 커밋: 5d76833(P1-6,24) → 6e0dc65(P1-23) → 4855da3(P1-22) → fe97d72(P1-2).

## 처리 결과

| 항목 | 처리 | 커밋 | 비고 |
|---|---|---|---|
| **P1-6** 일일손실 통화 분리 | ✅ 구현 | 5d76833 | USDT/KRW 독립 서킷, 우선순위 분리>단일>기본 |
| **P1-24** 감사 fail-closed + HALT | ✅ 구현 | 5d76833 | **실버그 교정**: dailyRealizedLoss catch `return 0`(fail-open)→`NEGATIVE_INFINITY`. AUDIT_FAILURE_HALT, /api/audit-health, 문서 |
| **P1-23** 스캐너 부분체결 + 라이브 거절 | ✅ 구현 | 6e0dc65 | **실버그 교정**: tickScanner 의도수량 기록→체결분(gotQty/soldQty). scanner+live start_bot 거절 |
| **P1-22** 캔들 재시도 + 무결성 | ✅ 구현 | 4855da3 | fetchKlines withRetry, validateCandleContiguity(crypto 엄격/KR 중앙값), KIS 명시 hold. ※KIS hold는 계획(§순서3 line 81)의 throw 명시와 다른 **의도적 변경** — 안전속성(차단+경보+무거래) 동일, 단일 tick throw는 데몬 루프(runner.ts:950)에서 catch+log될 뿐이라 hold가 다봇 환경에 더 graceful(어떤 caller/test도 throw에 의존 안 함). ※후속 적대검증서 키움 getCandles withRetry 누락·백테 contiguity 미적용 추가 색출 → 2026-06-15 수정(아래 §후속) |
| **P1-2** unknown 누적 reconcile | ✅ 구현 | fe97d72 | UNKNOWN_MAX_COUNT, 강제 getPositions(바이낸스 가드 우회), 보수적 adopt만 |
| **P1-10** KR 체결 reconcile | 🟡 키움 完(2026-06-15) / KIS 보류 | — | 키움 ka10075 모의 E2E 확정 → getOpenOrders(키움) 구현·E2E 8/8 PASS. KIS는 키 부재 → fail-closed throw 스텁. 아래 §후속 |
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

1. **P1-10 KIS 절반** — KIS 모의키 확보 → inquire-psbl-rvsecncl(TTTC0084R) 응답필드 E2E 확정 → KIS getOpenOrders 본구현(현재 fail-closed throw 스텁). 키움 절반은 完(2026-06-15).
2. **P1-5 본구현** — 별도 설계 스프린트(상태머신 + 백테 타임아웃 모델 Option A/B 결정).
3. **Docker 재시작 시나리오**(P0-2 후속) — 엔진 확보 시.

## 후속 (2026-06-15): 적대검증 4건 수정 + P1-10 키움 完

> 이전 5건(P1-6/24/23/22/2) 머지 후 main HEAD를 **울트라코드 적대검증 워크플로우**(14에이전트, 5커밋 재감사 + 각 발견 재검증)로 재점검 → 7건 flag → 4건 확정(3건 오탐 기각). 전부 수정. 추가로 P1-10 키움 절반 완성. tsc 0, vitest **465 → 483**.

### 적대검증 확정 4건 (실코드 버그, 전부 수정)

1. **[P1-24 후속·low] 음수 env가 서킷/캡 무력화** (`safety.ts`): `LIVE_DAILY_LOSS_LIMIT_*`/`LIVE_MAX_NOTIONAL`에 음수(typo)가 들어가면 truthy라 circuit으로 채택되고 `circuit>0` 가드에 걸러져 **서킷이 조용히 꺼짐 + -Infinity fail-closed 센티넬까지 가려짐**. → `posNum`(유한 양수만 채택, 음수/garbage→0) 도입 → 통화 기본값으로 폴백. circuit·cap 양쪽 적용.
2. **[P1-22 후속·med] 키움 getCandles withRetry 누락** (`kiwoom.ts`): 계획은 "fetchKlines+Kiwoom 둘 다" 명시했으나 Binance만 wrap, 키움 캔들은 단발 → 일시 429/5xx에 틱 전체 사망. → `post()`에 `[http:N]/[retry-after]` 마커 + 네트워크 에러명 보존, `getCandles` 읽기경로 `withRetry`(주문 POST는 미wrap=비멱등).
3. **[P1-22 후속·med] 백테 contiguity 미적용 → 패리티 위반** (`handlers.ts`): 라이브 러너는 간극 데이터에 hold하나 backtest/optimize/short 핸들러는 무검증 통과 → "양쪽 hold" 패리티 주장이 거짓. → `fetchKlinesChecked`(fetch+validateCandleContiguity crypto, 무효 throw)로 backtest·backtestShort·optimize 일원화. runner 주석도 정정.
4. **[P1-2 후속·med] Binance 유령 포지션 영구 잔존** (`runner.ts`): `forceReconcileOnUnknown`이 `no_exchange_pos`(거래소 flat) 신선 진실을 버리고 unknownCount만 리셋 → 장부 유령보유 유지. clear를 위임한 reconcileLivePosition 경로는 Binance에서 도달 불가(getOrderByClientId 보유→reconcile skip). → forceReconcile에서 `getOrderByClientId 보유 어댑터(=Binance)` 한정으로 reconMisses 누적·RECON_CLEAR_MISSES(3틱) 후 clear(KR은 reconcileLivePosition이 처리 — 중복 카운트 방지).

기각 3건(오탐): unknown currency mix(런타임 도달 불가, Broker 닫힌유니온), KIS throw→hold(의도적 deviation·문서화), interval median band 30m/45m aliasing(secsToInterval가 45m 미생성).

### P1-10 키움 절반 完

- **ka10075 모의 E2E 확정**: POST `/api/dostk/acnt`, 배열키 `oso`, `stex_tp`(숫자) 필수(`dmst_stex_tp="KRX"` 거부), 행=`ord_no`/`oso_qty`(미체결잔량)/`io_tp_nm`(±매수매도=방향)/`ord_pric`/`ord_qty`/`cntr_qty`. 프로브 `scripts/probe-kiwoom-open-orders.ts`로 실응답 캡처 후 구현.
- **구현**: `kiwoom.ts getOpenOrders(symbol)`(fail-closed throw, assertOk 배열존재 가드), `kis.ts getOpenOrders`(키 부재 → fail-closed throw 스텁). MCP get_open_orders 툴 + 대시보드 미체결 패널이 키움 실데이터 표출(이미 배선됨, 어댑터 메서드만 부재였음).
- **불변 보존**: `getOrderByClientId`는 KR에서 undefined 유지(runner.ts:323 reconcile 판별자) — 단위테스트로 고정. backtest≡live 무영향(라이브 전용 READ).
- **E2E**: `scripts/verify-kiwoom-mock-open-orders-e2e.ts` 8/8 PASS(지정가 매수→getOpenOrders 매칭→취소→소멸).
- 실거래(메인넷) OFF 불변. KIS 절반은 키 대기.
