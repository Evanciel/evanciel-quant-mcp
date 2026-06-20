# toss-broker Planning Document

> **Summary**: 토스증권 Open API를 quant-mcp의 4번째 브로커 어댑터로 통합 (KR+US, 풀 어댑터 + 대시보드 풀 통합, 주문 쓰기는 페이퍼 기본)
>
> **Project**: quant-mcp
> **Version**: 0.1.0
> **Author**: Evanciel
> **Date**: 2026-06-19
> **Status**: Draft

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | 현재 KR 브로커는 KIS·키움뿐. 토스 Open API는 표준 OAuth2·RESTful·decimal 문자열로 가장 깔끔한 연동 후보이며 KR+US를 단일 API로 제공 → 사용자 브로커 선택지 확대 + US 주식 신규 지원. |
| **Solution** | 키움 어댑터(`src/brokers/kiwoom.ts`)를 템플릿으로 전용 `TossBrokerAdapter` 신설 + 기존 멀티브로커 배선 9곳에 `toss` 등록 + 대시보드 풀 통합. 주문 쓰기는 기존 `LIVE_TRADING_ENABLED` 게이트 뒤 페이퍼 기본. |
| **Function/UX Effect** | 대시보드에서 토스 계좌로 KR/US 시세·차트 조회, 보유·미체결 확인, 수동/봇 주문 가능. 기존 안전망(notional cap·allowlist·일일손실 서킷·감사로그) 그대로 상속. |
| **Core Value** | 검증된 단일 안전경로(`placeOrder`)에 토스를 plug-in하여, 코드 중복 없이 브로커 다양성과 US 시장 접근을 동시에 확보. |

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | KR 브로커 선택지 확대 + 토스 단일 API로 US 주식 신규 지원. 기존 어댑터 계약에 무손실 plug-in. |
| **WHO** | quant-mcp로 KR/US 주식을 자동매매·모니터링하는 BYOK 사용자(본인 토스 계좌). |
| **RISK** | 토스 **모의서버 부재** → 주문 쓰기 라이브 검증만 가능. US 통화/소수주 처리로 quoteCurrency 로직이 브로커 단위→심볼 단위로 확장돼 회귀 위험. |
| **SUCCESS** | 읽기 경로 라이브 E2E 통과(토큰→계좌→시세→캔들→보유→미체결). 주문 쓰기 페이퍼 기본 + 소액 라이브 1건 검증. 기존 465 테스트 무회귀 + tsc 0. |
| **SCOPE** | (1) 어댑터 (2) 멀티브로커 배선 (3) US 통화/소수주 (4) 대시보드 통합 (5) E2E·단위테스트. OCO/보호주문·`getOrderByClientId`는 의도적 제외. |

---

## 1. Overview

### 1.1 Purpose

토스증권 Open API(`https://openapi.tossinvest.com`, OpenAPI v1.1.1)를 quant-mcp의 `BrokerAdapter` 포트(src/brokers/types.ts)를 구현하는 4번째 어댑터로 통합한다. KR(KRX)과 US(NYSE/NASDAQ) 주식을 단일 계좌로 시세 조회·매매·모니터링한다.

### 1.2 Background

- 기존 KR 브로커(KIS/Kiwoom)는 wire가 제각각이고 모의서버 응답에 깜짝 변수가 많았다(P1-10 교훈). 토스는 표준 OAuth2 + 표준 `ApiResponse`/`ErrorResponse` envelope + 순수 decimal 문자열로 가장 일관적이다.
- 토스는 **KR과 US를 단일 API로** 제공 → US 주식 지원을 별도 브로커 없이 확보.
- 사전 정밀 분석 완료: 엔드포인트 20개, 스키마 53개, 주문 본문 oneOf 매핑까지 문서화.

### 1.3 Related Documents

- 사전 분석: [docs/03-analysis/toss-api-analysis-2026-06-19.md](../../03-analysis/toss-api-analysis-2026-06-19.md)
- Canonical 스펙: `docs/03-analysis/toss-api/openapi.json` (로컬 사본, v1.1.1)
- 템플릿 어댑터: [src/brokers/kiwoom.ts](../../../src/brokers/kiwoom.ts)
- 어댑터 계약: [src/brokers/types.ts](../../../src/brokers/types.ts)

---

## 2. Scope

### 2.1 In Scope

- [ ] `TossBrokerAdapter` 신설: OAuth2 토큰 캐시(~24h), 표준 envelope 파서, `[http:N]`/`[retry-after:S]` 마커
- [ ] 필수 어댑터 메서드: `getBalance` `getPositions` `getPrice` `placeOrder` `cancelOrder`
- [ ] 선택 어댑터 메서드: `getOpenOrders` `getOrderById` `normalizeQuantity` + 확장 `getCandles`
- [ ] **KR + US 동시 지원**: 심볼 통화 인식(KR=KRW 정수주 / US=USD 소수주·금액주문), US 금액기반 시장가 주문(`orderAmount`)
- [ ] 멀티브로커 배선 9곳에 `toss` 등록(BrokerKey/BrokerType/getAdapter/configuredBrokers/safety.loadCredentials/schemas enum/runner/live-handlers)
- [ ] quoteCurrency 로직을 **브로커 단위 → 심볼/통화 단위**로 확장(USDT/KRW/USD 서킷·캡 분리)
- [ ] 자격증명: `TOSS_CLIENT_ID`/`TOSS_CLIENT_SECRET`/`TOSS_ACCOUNT_SEQ`/`TOSS_ENV` (BROKER_FIELDS 등록)
- [ ] **대시보드 풀 통합**: 브로커 드롭다운·자격증명 폼(자동), 토스 심볼 차트 소스, 수동주문 패널, 보유/미체결 패널
- [ ] 주문 쓰기 전 경로를 기존 `LIVE_TRADING_ENABLED` + notional cap + allowlist + 일일손실 서킷 + 감사로그에 연결(페이퍼 기본)
- [ ] 읽기 전용 라이브 E2E 스크립트(`scripts/verify-toss-e2e.ts`) + vitest 단위테스트(envelope·decimal·주문본문·에러분류)

### 2.2 Out of Scope

- OCO/거래소 상주 보호주문(stop_*/take_profit_*) → 토스 미지원, **fail-closed throw**(키움과 동일)
- `getOrderByClientId` → **의도적 미구현**(KR reconcile 라우팅 보존, kiwoom.ts:522 교훈)
- 주문 정정(`modify`) 어댑터 노출 → 토스 API엔 있으나 어댑터 계약에 메서드 없음 → v1 제외(취소 후 재주문으로 대체)
- 호가/체결/상하한가(`orderbook`/`trades`/`price-limits`)·환율·장운영시간 API → v1 핵심 경로 외(필요 시 후속)
- 실주문 자동 활성 → 키 확보 후 소액 수동검증으로만 활성

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| FR-01 | OAuth2 Client Credentials 토큰 발급·캐시(~24h, 만료 5분전 갱신), 시크릿 비노출 | High | Pending |
| FR-02 | `getBalance`: `/accounts`+`/buying-power`(+holdings 합산) → AccountBalance(통화별) | High | Pending |
| FR-03 | `getPositions`: `/holdings` items → Position[](symbol/qty/avgPrice/currentPrice/pnl), KR·US 혼재 | High | Pending |
| FR-04 | `getPrice`: `/prices?symbols=` → MarketPrice(lastPrice), decimal 문자열 파싱 | High | Pending |
| FR-05 | `getCandles`: `/candles?interval=1m\|1d` → OHLCV(KST +09:00 라벨), 러너/차트용 | High | Pending |
| FR-06 | `placeOrder`: `/orders` 수량기반(KR/US) + 금액기반(US MARKET). market/limit만, 보호주문 fail-closed | High | Pending |
| FR-07 | 주문 응답 신뢰성: `{orderId}` 부재 시 유령 pending 금지(throw). status="pending"(체결정보 없음) | High | Pending |
| FR-08 | `cancelOrder`: `/orders/{orderId}/cancel`(빈 바디), 성공 bool 반환 | High | Pending |
| FR-09 | `getOpenOrders`: `/orders?status=OPEN&symbol=` → OrderResult[](부분체결 executedQty/origQty) | High | Pending |
| FR-10 | `getOrderById`: `/orders/{orderId}` → 체결상세(수동 지정가 추적). 없으면 null | Medium | Pending |
| FR-11 | `normalizeQuantity`: KR=정수주(floor) / US=소수주 허용. 가격은 KRX 틱 정렬(KR) | High | Pending |
| FR-12 | 멀티브로커 배선 9곳 원자적 등록(BrokerKey/Type/getAdapter/configuredBrokers/safety/schemas/runner/live-handlers) | High | Pending |
| FR-13 | quoteCurrency 심볼/통화 단위 확장: KR→KRW, US→USD. notional cap·일일손실 서킷 통화별 분리 | High | Pending |
| FR-14 | 자격증명 등록(BROKER_FIELDS.toss) + CLI/대시보드 폼 자동 노출 | High | Pending |
| FR-15 | 대시보드: 토스 심볼 차트 소스(getCandles), 수동주문 패널, 보유/미체결 패널 | High | Pending |
| FR-16 | 에러분류: 표준 `{error:{code}}` 파싱 + `[http:N]` 마커로 429/5xx만 재시도(GET), 주문 POST 비재시도 | High | Pending |
| FR-17 | 읽기 전용 E2E 스크립트 + 단위테스트(envelope/decimal/주문본문/에러) | High | Pending |

### 3.2 Non-Functional Requirements

| Category | Criteria | Measurement Method |
|----------|----------|-------------------|
| 안전성 | 주문 쓰기는 `LIVE_TRADING_ENABLED` 미설정 시 페이퍼. 보호주문 fail-closed | 단위테스트 + 기존 safety 게이트 통과 |
| 신뢰성 | 모호 응답(토큰만료/게이트웨이)을 성공으로 오인 금지(fail-closed) | 단위테스트(비정형 응답 → throw) |
| Rate Limit | ORDER 6/s(피크 3/s)·MARKET_DATA 10/s 등 그룹별. 429 시 Retry-After 백오프 | 캔들/시세 GET에 withRetry(주문 POST 제외) |
| 보안(BYOK) | 시크릿은 credentials 주입에서만 읽음(process.env 직접접근 금지), 로그 비노출 | 코드리뷰 + 키움 패턴 준수 |
| 무회귀 | 기존 465 vitest 테스트 + tsc 0 유지 | `npm test` / `npm run typecheck` |

---

## 4. Success Criteria

### 4.1 Definition of Done

- [ ] FR-01~17 구현 완료
- [ ] vitest 단위테스트 작성·통과(토스 어댑터 신규 케이스 포함)
- [ ] 읽기 전용 라이브 E2E 통과: 토큰→`/accounts`→`/prices`→`/candles`→`/holdings`→`/orders?status=OPEN`
- [ ] 주문 쓰기 페이퍼 경로 검증(게이트 OFF 시 실주문 미발생) + (키 확보 시) 소액 라이브 1건 `GET /orders/{id}` 대조
- [ ] 사전 분석 문서 ↔ 구현 일치(gap analyze)

### 4.2 Quality Criteria

- [ ] tsc 0 (typecheck)
- [ ] 기존 465 테스트 무회귀
- [ ] 시크릿/서명 로그 비노출 확인

---

## 5. Risks and Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| 토스 모의서버 부재 → 주문 쓰기 검증 불가 | High | High | 읽기 경로만 라이브 E2E. 주문 쓰기는 게이트 뒤 페이퍼 기본 + 소액 라이브 1건+`GET /orders/{id}` 대조. 주문 응답이 단순(`{orderId}`)해 파싱 리스크 낮음 |
| US 통화/소수주 도입으로 quoteCurrency 회귀 | High | Medium | quoteCurrency를 심볼 통화 단위로 확장하되 기존 KRW/USDT 경로 단위테스트로 회귀 가드. holdings의 per-item currency 활용 |
| decimal 문자열 파싱 오류(정수/소수 혼동) | Medium | Medium | 전용 파서 + 단위테스트. KR 정수주/US 소수주 분기 명시 |
| `getOrderByClientId` 추가 시 KR reconcile 라우팅 붕괴 | High | Low | 의도적 미구현 + 주석 경고. types.ts:88/runner reconcile 판별자 보존 |
| Rate limit 429(특히 09:00~09:10 ORDER 3/s) | Medium | Medium | GET에 withRetry+백오프, 주문 POST는 비재시도(비멱등). clientOrderId 멱등키 활용 |
| 라이브 단일 호스트 → 실수로 실주문 | High | Low | `LIVE_TRADING_ENABLED` 마스터 스위치 기본 OFF + notional cap + allowlist + 일일손실 서킷 다중 방어 |

---

## 6. Impact Analysis

### 6.1 Changed Resources

| Resource | Type | Change Description |
|----------|------|--------------------|
| `BrokerKey` (credentials.ts) | Type | `"toss"` 추가 |
| `BrokerType` (types.ts) | Type | `"toss"` 추가 |
| `BROKER_FIELDS` (credentials.ts) | Config | `toss` 자격증명 필드 추가 |
| `getAdapter` / `configuredBrokers` (index.ts) | Factory | toss 분기 + 열거 추가 |
| `loadCredentials` (safety.ts) | Config | toss env 추출 |
| broker enum (schemas.ts) | Schema | MCP 입력 스키마에 `"toss"` |
| quoteCurrency 판정 (live-handlers.ts, runner.ts) | Logic | 브로커 단위 → 심볼/통화 단위 확장 |
| 대시보드 (server.ts) | UI/API | 차트 소스·수동주문·보유/미체결 toss 배선 |

### 6.2 Current Consumers

| Resource | Operation | Code Path | Impact |
|----------|-----------|-----------|--------|
| `BrokerKey`/`BROKER_FIELDS` | READ | setup/cli.ts, dashboard/server.ts(폼 순회) | None(자동 반영) — 검증 필요 |
| `getAdapter` | READ | live-handlers.ts, runner.ts, bot-handlers.ts | Needs verification(toss 분기 누락 시 런타임) |
| `configuredBrokers` | READ | 상태/감사 열거 경로 | Needs verification |
| broker enum | READ | 모든 MCP 주문/조회 툴 입력 | Breaking(누락 시 toss 입력 거부) |
| quoteCurrency 판정 | READ | checkLimits(notional cap·일일손실 서킷) | **Breaking 주의** — USD 도입이 기존 KRW/USDT 분기 회귀 가능 |

### 6.3 Verification

- [ ] 배선 9곳 모두 toss 등록 후 tsc 0 + 기존 테스트 무회귀
- [ ] quoteCurrency 변경이 기존 Binance(USDT)/KIS·키움(KRW) 경로를 깨지 않음(단위테스트)
- [ ] 자격증명 누락 시 안전 폴백(페이퍼), 권한/게이트 우회 없음

---

## 7. Architecture Considerations

> 참고: 본 프로젝트는 Next.js 웹앱이 아니라 **TypeScript Node MCP 서버 + 데몬 대시보드**다. 템플릿의 프론트엔드 항목은 해당 맥락으로 치환한다.

### 7.1 Project Level Selection

| Level | Characteristics | Selected |
|-------|-----------------|:--------:|
| Starter | 단순 정적 | ☐ |
| Dynamic | 기능 모듈 + 외부연동 | ☑ (멀티브로커 어댑터 패턴 — 기존 구조 준수) |
| Enterprise | 엄격 레이어 분리 | ☐ |

### 7.2 Key Architectural Decisions

| Decision | Options | Selected | Rationale |
|----------|---------|----------|-----------|
| 어댑터 구조 | 전용 클래스 / KIS·키움 서브클래싱 | **전용 `TossBrokerAdapter`** | wire 비호환. 키움 교훈 — 공유 시 깨짐 |
| HTTP | fetch(내장) | **fetch + AbortSignal.timeout** | 기존 어댑터 일관성 |
| 토큰 캐시 | 인스턴스 필드(~24h) | **인스턴스 필드 + 5분 skew** | 키움/KIS 패턴 동일 |
| 재시도 | withRetry(GET만) | **GET 멱등만 재시도, 주문 POST 제외** | 비멱등 주문 중복 방지(P1-22) |
| 통화 처리 | 브로커 단위 / 심볼 단위 | **심볼/통화 단위** | KR+US 혼재 계좌 → KRW/USD 분리 필요 |
| 데이터 소스 | src/data 분리 / 어댑터 getCandles | **어댑터 getCandles 직접**(토큰 필요해 keyless 불가) | binance-public과 달리 인증 필수 → 설계 단계 확정 |
| 테스트 | vitest | **vitest 단위 + 읽기 E2E 스크립트** | 기존 인프라 |

### 7.3 Clean Architecture Approach

```
기존 멀티브로커 구조 준수(신규 폴더 없음):
  src/brokers/toss.ts        ← 신규 어댑터(키움 템플릿)
  src/brokers/{types,index,safety}.ts  ← toss 배선
  src/setup/credentials.ts   ← BROKER_FIELDS.toss
  src/mcp-server/{schemas,live-handlers}.ts, src/runner/runner.ts ← 배선
  src/dashboard/server.ts    ← 대시보드 통합
  scripts/verify-toss-e2e.ts ← 읽기 E2E
  tests/*.test.ts            ← 단위테스트
```

---

## 8. Convention Prerequisites

### 8.1 Existing Project Conventions

- [x] `CLAUDE.md`(전역) 코딩/안전 규약 존재
- [x] `tsconfig.json` 존재(strict)
- [x] vitest 설정(`npm test`)
- [x] 멀티브로커 어댑터 컨벤션(types.ts 계약, BYOK 위생, fail-closed)

### 8.2 Conventions to Define/Verify

| Category | Current State | To Define | Priority |
|----------|---------------|-----------|:--------:|
| Naming | exists(브로커 키 소문자) | `toss` 키 통일 | High |
| Env vars | exists(BROKER_FIELDS) | `TOSS_*` 4종 | High |
| Error handling | exists(`[http:N]` 마커, fail-closed) | 토스 표준 envelope 파서 | High |
| 통화 처리 | exists(KRW/USDT 분리) | USD 추가, 심볼 단위 판정 | High |

### 8.3 Environment Variables Needed

| Variable | Purpose | Scope | To Be Created |
|----------|---------|-------|:-------------:|
| `TOSS_CLIENT_ID` | OAuth client_id | Server(secret) | ☑ |
| `TOSS_CLIENT_SECRET` | OAuth client_secret | Server(secret) | ☑ |
| `TOSS_ACCOUNT_SEQ` | `X-Tossinvest-Account` 계좌 식별 | Server | ☑ |
| `TOSS_ENV` | 환경 플래그(live; 페이퍼 게이트는 LIVE_TRADING_ENABLED) | Server | ☑ |

### 8.4 Pipeline Integration

해당 없음(기존 어댑터 패턴 확장, 신규 스키마/컨벤션 페이즈 불필요).

---

## 9. Next Steps

1. [ ] `/pdca design toss-broker` — 3가지 아키텍처안 비교(특히 통화 처리·데이터 소스·대시보드 배선) 후 선택
2. [ ] 설계 승인 → `/pdca do toss-broker`로 구현(어댑터 → 배선 → 통화 → 대시보드 → E2E 순)
3. [ ] 읽기 E2E(키 보유) → 페이퍼 검증 → 소액 라이브 1건

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-06-19 | Initial draft (KR+US 풀 어댑터 + 대시보드 풀 통합) | Evanciel |
