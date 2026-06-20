# toss-broker Completion Report

> **Status**: Complete (코드·검증 완료, 라이브 읽기 검증 통과 / 실주문은 사용자 수동검증 대기)
>
> **Project**: quant-mcp
> **Version**: 0.1.0
> **Author**: Evanciel
> **Completion Date**: 2026-06-20
> **PDCA Cycle**: #1 (plan→design→do→check→report)

---

## Executive Summary

### 1.1 Project Overview

| Item | Content |
|------|---------|
| Feature | toss-broker (토스증권 Open API, 4번째 브로커, KR+US) |
| Start Date | 2026-06-19 |
| End Date | 2026-06-20 |
| Duration | ~1 작업 세션 (PDCA 전 단계 + 울트라코드 다단계 검증) |

### 1.2 Results Summary

```
┌─────────────────────────────────────────────┐
│  Match Rate: 100%                            │
├─────────────────────────────────────────────┤
│  ✅ 충족(FR):     17 / 17                     │
│  ✅ 안전강화:      2 / 2 (서킷 IN-widen, 하드블록) │
│  ✅ 라이브 E2E:    8 / 8 (읽기 전용)            │
│  🛑 실주문:        사용자 수동검증 대기(설계상)    │
└─────────────────────────────────────────────┘
```

### 1.3 Value Delivered

| Perspective | Content |
|-------------|---------|
| **Problem** | KR 브로커가 KIS·키움뿐. 토스 단일 API로 선택지 확대 + US 주식 신규 지원 필요 |
| **Solution** | 전용 `TossBrokerAdapter`(키움 템플릿) + 멀티브로커 배선 + 대시보드 통합. 주문 쓰기 페이퍼 기본 + 어댑터 하드블록 |
| **Function/UX Effect** | 라이브 검증: 토큰·KR/US 시세(삼성 350,500/AAPL 297.2)·일봉·잔고(12,469,078원)·보유 10종목·미체결 조회 정상. tsc 0, 585 테스트 |
| **Core Value** | 검증된 단일 안전경로(placeOrder)에 토스를 무손실 plug-in — 브로커 다양성 + US 시장 접근 + 모의호스트 부재 리스크 봉쇄 |

---

## 1.4 Success Criteria Final Status

| # | Criteria | Status | Evidence |
|---|---------|:------:|----------|
| SC-1 | FR-01~17 구현 | ✅ Met | Check 100% (docs/03-analysis/toss-broker.analysis.md) |
| SC-2 | 읽기 라이브 E2E 통과 | ✅ Met | scripts/verify-toss-e2e.ts → 8/8 (토큰·계좌·KR/US 시세·캔들·잔고·보유·미체결) |
| SC-3 | 주문 쓰기 페이퍼 기본 + 하드블록 | ✅ Met | toss.ts assertWriteAllowed (env=live+master), test/toss-adapter.test.ts |
| SC-4 | 기존 테스트 무회귀 + tsc 0 | ✅ Met | 547→585 passed (회귀 0), tsc 0 |
| SC-5 | getOrderByClientId 미구현(reconcile 보존) | ✅ Met | toss.ts(미정의) + test/toss-adapter.test.ts 단언 |
| SC-6 | 실주문 소액 검증 | ⏳ 대기 | 사용자: LIVE_TRADING_ENABLED=true + 소액 1건 (설계상 자동 금지) |

**Success Rate**: 5/6 Met (83%), 1건은 설계상 사용자 수동(실주문)

## 1.5 Decision Record Summary

| Source | Decision | Followed? | Outcome |
|--------|----------|:---------:|---------|
| [Design] | Option C(Pragmatic) + 2 안전강화 | ✅ | match rate 100%, 회귀 0 |
| [Design] | 일일손실 서킷 coarse `IN(...,'toss')`(GLOB 대신) | ✅ | fail-safe 과집계, test/safety.test.ts 검증 |
| [Design] | 토스 모의호스트 부재 → env=live 기본 + 어댑터 라이브-쓰기 하드블록 | ✅ | 페이퍼인데 실호스트 무캡 도달 구멍 봉쇄 |
| [Design] | getOrderById 구현 / getOrderByClientId 미구현 | ✅ | reconcile 라우팅 보존(적대검증 확인) |
| [검증] | 키 네이밍 별칭 허용(TOSS_API_KEY↔CLIENT_ID, KIS 패턴) | ✅ | 사용자 .env.local 무리네임 인식 |

---

## 2. Related Documents

| Phase | Document | Status |
|-------|----------|--------|
| 분석 | [toss-api-analysis-2026-06-19.md](../03-analysis/toss-api-analysis-2026-06-19.md) | ✅ |
| Plan | [toss-broker.plan.md](../01-plan/features/toss-broker.plan.md) | ✅ |
| Design | [toss-broker.design.md](../02-design/features/toss-broker.design.md) | ✅ |
| Check | [toss-broker.analysis.md](../03-analysis/toss-broker.analysis.md) | ✅ 100% |
| Report | 현재 문서 | ✅ |

---

## 3. Completed Items

### 3.1 Functional Requirements (17/17)

FR-01 토큰·FR-02 잔고·FR-03 보유·FR-04 시세·FR-05 캔들·FR-06 주문생성·FR-07 응답신뢰성·FR-08 취소·FR-09 미체결·FR-10 주문상세·FR-11 수량정규화·FR-12 배선9곳·FR-13 통화·FR-14 자격증명·FR-15 대시보드·FR-16 에러분류·FR-17 테스트/E2E — **전부 ✅** (증거: docs/03-analysis/toss-broker.analysis.md).

### 3.2 Non-Functional

| Item | Target | Achieved | Status |
|------|--------|----------|--------|
| 타입 안전 | tsc 0 | 0 errors | ✅ |
| 무회귀 | 기존 통과 유지 | 547→585 passed | ✅ |
| 보안(BYOK) | 시크릿 비노출 | credentials 주입만, 로그 0 | ✅ |
| Rate limit | 429 백오프(GET), 주문 비재시도 | base.withRetry GET만 | ✅ |

### 3.3 Deliverables

| Deliverable | Location | Status |
|-------------|----------|--------|
| 어댑터 | src/brokers/toss.ts | ✅ |
| 배선 | safety/index/types/credentials/schemas/live-handlers/runner/bot-handlers | ✅ |
| 대시보드 | src/dashboard/server.ts | ✅ |
| 테스트 | test/toss-adapter.test.ts(34)·toss-wiring.test.ts(3)·safety.test.ts(+1) | ✅ |
| E2E | scripts/verify-toss-e2e.ts (읽기 전용) | ✅ |
| 스펙·문서 | docs/03-analysis/toss-api/ + plan/design/analysis | ✅ |

---

## 4. Incomplete Items

### 4.1 Carried Over

| Item | Reason | Priority |
|------|--------|----------|
| 실주문 소액 검증 | 실제 돈 — 설계상 사용자 수동(LIVE_TRADING_ENABLED + 소액) | High(사용자 결정) |
| 데몬 재시작 → 대시보드 토스 실확인 | 라이브 트레이딩 데몬 — 사용자 타이밍 결정 | Medium |
| US 금액기반 주문(orderAmount) | v1 스코프 컷(US 소수주는 MARKET-quantity로 충분) | Low |

### 4.2 Cancelled/On Hold

| Item | Reason | Alternative |
|------|--------|-------------|
| OCO/거래소 상주 보호주문 | 토스 미지원 | fail-closed throw, 봇 폴링 소프트스톱 |

---

## 5. Quality Metrics

### 5.1 Final

| Metric | Target | Final |
|--------|--------|-------|
| Design Match Rate | 90% | **100%** |
| 테스트 | 무회귀 | 585 passed (+38) |
| tsc | 0 | 0 |
| 라이브 읽기 E2E | 통과 | 8/8 |
| 보안 이슈 | 0 Critical | 0 |

### 5.2 Resolved Issues (적대검증 + 실검증)

| Issue | Resolution | Result |
|-------|------------|--------|
| M1: 러너 캔들 디스패치 toss 누락(시그널봇 영구 hold) | runner.ts:733 kiwoom 그룹 합류 | ✅ |
| M2: US LIMIT 소수수량 → API 400 거부 | LIMIT 정수 강제(MARKET만 소수) + 테스트 정정 | ✅ |
| M3: esbuild가 대시보드 정규식 `\d`→`d` cook | `[0-9]`로 교체(3곳) | ✅ |
| M4: 포지션 패널 통화에 심볼 미전달 | ccyOf(broker, symbol) | ✅ |
| N1: getOrderById가 CANCEL_REJECTED 오판 | REJECTED만 rejected | ✅ |
| 교차통화 affordability(KRW÷USD) | 통화 일치 시만 클램프 | ✅ |
| 키 네이밍/위치 불일치 | 별칭 허용 + E2E .env.local 로드 | ✅ |

---

## 6. Lessons Learned & Retrospective

### 6.1 Keep (잘된 것)

- **적대 검증 워크플로우의 효과**: tsc·585 테스트가 모두 통과한 코드에서 실버그 4건(특히 시그널봇 영구 hold, esbuild 정규식 cook)을 색출. 컴파일러·단위테스트만으론 못 잡는 결합/런타임 버그를 다관점 병렬 검토가 잡음.
- **라이브 읽기 E2E의 가치**: 모킹 테스트로는 보장 못 하던 실 API 필드 매핑(lastPrice·candle·holdings)을 실데이터로 확정.
- **설계 단계 안전강화**: "모의호스트 부재" 리스크를 설계에서 식별→어댑터 하드블록으로 선제 봉쇄.

### 6.2 Problem (개선점)

- **대시보드 JS가 tsc 미검사**: 템플릿 리터럴 내 JS는 타입체크·테스트 사각지대. esbuild `\d` cook 버그가 그 틈으로 들어옴. → 서빙된 HTML 검증(assert `[0-9]{6}`) 같은 가드 필요.
- **키 네이밍 컨벤션 불일치**: 다른 브로커(API_KEY) vs 토스(CLIENT_ID) 혼동 유발. → 별칭으로 흡수했으나 문서(.env.example)에 명시 필요(반영함).

### 6.3 Try (다음 시도)

- 대시보드 JS의 served-page 스모크 가드(번들 후 정규식/함수 존재 검증) 자동화.
- 신규 브로커 추가 시 cast-site 누락 방지 가드(toss-wiring.test.ts 패턴)를 템플릿화.

---

## 7. Next Steps

### 7.1 Immediate (사용자)

- [ ] `.env.local`에 `TOSS_ACCOUNT_SEQ=1` 추가됨 ✅ — 데몬 재시작 시 적용
- [ ] 데몬(7788) 재시작 → 대시보드에서 토스 선택·차트·통화 표시 눈으로 확인
- [ ] (선택) 실주문 소액 검증: `LIVE_TRADING_ENABLED=true` + 1건 → `GET /orders/{id}` 대조 후 OFF

### 7.2 Next PDCA Cycle (후보)

| Item | Priority |
|------|----------|
| US 금액기반 주문(orderAmount) + US 세션 게이팅 | Medium |
| 토스 종목 한글명→코드 해석기(현재 키움 맵 재사용) | Low |

---

## 9. Changelog

### toss-broker (2026-06-20)

**Added:**
- 토스증권 어댑터(`src/brokers/toss.ts`) — KR+US, OAuth2, 시세·계좌·보유·주문·미체결, 라이브-쓰기 하드블록
- 멀티브로커 배선(`toss`) + 대시보드 통합 + 읽기 전용 E2E 스크립트
- `quoteCurrencyFor`(통화 단일 진실원), `isKrSymbol`(krx-tick), 키 별칭 허용

**Changed:**
- quoteCurrency 판정을 브로커 단위 → 심볼/통화 단위(KRW/USDT/USD)로 확장(회귀 0)
- 일일손실 서킷에 toss 포함(coarse IN, fail-safe)

**Fixed:**
- (적대검증) 러너 캔들 디스패치·US LIMIT 수량·대시보드 정규식 cook·교차통화 affordability

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0 | 2026-06-20 | 완료 보고서 작성 (Check 100%, 라이브 E2E 8/8) | Evanciel |
