# toss-us-followup Planning Document

> **Summary**: 토스 어댑터 US 완성도 2건 — ① 달러 금액기반 주문(orderAmount, 수동 한정) ② US 세션 게이팅(정적 RTH+DST)
>
> **Project**: quant-mcp
> **Version**: 0.1.0
> **Author**: Evanciel
> **Date**: 2026-06-21
> **Status**: Draft
> **선행**: toss-broker (PR #1 머지, 1a25c99)

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | 토스 어댑터는 US 주식을 지원하나 ① 달러 금액 지정 주문(소수주) 불가(quantity만) ② `isMarketOpen`이 US 심볼에도 KR 장시간을 적용해 US limit_bracket 봇이 US 장중 재주문 불가 |
| **Solution** | ① `orderAmount`를 **수동주문 경로 한정**으로 추가(place_order MCP + 대시보드, 봇 제외) ② `isMarketOpen`/`sessionKey`를 **심볼 인식**으로 확장(토스 US=정적 US RTH+DST) |
| **Function/UX Effect** | US 종목을 "10주" 대신 "$100"로 수동 매수 가능. US limit_bracket 봇이 실제 US 장중에만 재주문(KR 시간 오판 제거) |
| **Core Value** | 단일 주문경로·하드블록·no-retry·reconcile 불변식을 유지한 채 US 거래 완성도 향상. 봇 사이징 모델(수량기반)은 무손상 |

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | 토스 US 거래 완성도 — 달러 금액주문 + US 장시간 정확성 |
| **WHO** | 토스로 US 주식을 수동 매매하거나 US limit_bracket 봇을 쓰는 BYOK 사용자 |
| **RISK** | orderAmount는 주문계약 변경(invasive) — checkLimits 금액경로·2단계토큰 해시 영향 / US DST 계산 오류 시 세션 오판(단 fail-safe) |
| **SUCCESS** | 수동 달러주문 E2E(페이퍼/하드블록), US 세션 판정 단위테스트(DST 경계 포함), tsc 0, 무회귀 |
| **SCOPE** | FR-A orderAmount(수동 한정) / FR-B US 세션(정적 RTH+DST, 심볼 인식). 봇 금액주문·market-calendar API는 제외 |

---

## 1. Overview

### 1.1 Purpose

PR #1로 머지된 토스 어댑터(KR+US)의 US 측 완성도 2건을 보완한다. 둘 다 안전 결함이 아니라 US 사용 편의·정확성 개선이며, 기존 불변식을 보존한다.

### 1.2 Background

- 토스 스펙: `OrderCreateAmountBased`(US MARKET 전용, `orderAmount` 달러)는 소수주를 "금액"으로 지정하는 유일한 경로. 현재 어댑터는 quantity-based만 전송(US 소수주는 MARKET-quantity로만, 달러 지정 불가).
- `market-hours.ts:isMarketOpen(broker)`는 비-binance를 전부 KR 시간(09:00–15:18 KST)으로 처리 → 토스 US 심볼이 US 장중(밤 KST)에 `false` 반환 → US limit_bracket 봇 재주문 차단(기능 버그, 안전 무해).

### 1.3 Related Documents

- 선행: [toss-broker.plan.md](toss-broker.plan.md) · [toss-broker.design.md](../../02-design/features/toss-broker.design.md)
- 스펙: [openapi.json](../../03-analysis/toss-api/openapi.json) (`OrderCreateAmountBased` 5983–6038, `fractionalQuantityUsMarketOnly`)

---

## 2. Scope

### 2.1 In Scope

- [ ] **FR-A**: `orderAmount`(달러 금액 시장가) **수동주문 한정** — `OrderRequest.orderAmount?`, toss 어댑터 amount-based 본문, `live-handlers.placeOrder` 금액경로, `place_order` MCP 스키마, 대시보드 수동주문 금액 입력
- [ ] **FR-B**: `isMarketOpen`/`sessionKey` **심볼 인식** — 토스 US 심볼=정적 US RTH(09:30–16:00 ET)+DST, sync 유지. 러너 호출부 갱신
- [ ] 단위테스트(금액주문 본문·검증·하드블록, US 세션 DST 경계) + 수동 달러주문 페이퍼 검증

### 2.2 Out of Scope

- **봇 러너 금액주문** — 봇은 수량기반 사이징(sizeFromBalance) 유지(금액경로는 사이징 모델 불일치). orderAmount는 수동 전용
- **토스 market-calendar API 연동** — isMarketOpen sync 유지 위해 정적 RTH+DST 사용(API는 async·캐시 필요 → 후순위)
- **US 공휴일 캘린더** — 미반영(공휴일엔 거래소가 거부 = fail-safe, 기존 KR과 동일 정책)
- KR orderAmount(토스 스펙상 US MARKET 전용)

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| FR-A1 | `OrderRequest.orderAmount?: number`(선택) 추가 — quantity와 배타 | High | Pending |
| FR-A2 | toss 어댑터: orderAmount+US+MARKET → amount-based 본문 `{symbol,side,orderType:MARKET,orderAmount}`. KR/LIMIT+orderAmount → fail-closed throw | High | Pending |
| FR-A3 | `live-handlers.placeOrder`: orderAmount 경로 — notional=orderAmount, quoteCurrency=USD, checkLimits 적용, normalizeQuantity 스킵, 2단계 토큰 해시에 orderAmount 포함 | High | Pending |
| FR-A4 | `place_order` MCP 스키마에 `orderAmount` 추가(양수, 선택). quantity·orderAmount 동시 지정 거부 | High | Pending |
| FR-A5 | 대시보드 수동주문: US 토스 심볼에 "금액($)" 입력 토글 → `/api/order`에 orderAmount 전달 | Medium | Pending |
| FR-B1 | `isMarketOpen(broker, now, symbol?)` 심볼 인식 — 토스 US 심볼=정적 US RTH+DST(sync). KR·미지정=기존 동작(바이트 동일) | High | Pending |
| FR-B2 | `sessionKey(broker, now, symbol?)` — 토스 US=ET 날짜 경계. 러너 limit_bracket 호출부 심볼 전달 | Medium | Pending |
| FR-B3 | US DST 판정 순수함수(2주차 일요일 3월 ~ 1주차 일요일 11월 = EDT UTC-4, 그 외 EST UTC-5) | High | Pending |

### 3.2 Non-Functional Requirements

| Category | Criteria | Measurement |
|----------|----------|-------------|
| 불변식 | 단일 주문경로·하드블록·no-retry·reconcile 라우팅 유지 | 코드리뷰 + 기존 toss 테스트 |
| 무회귀 | 기존 binance/kis/kiwoom + toss quantity 경로 무변경 | 585 테스트 유지 + tsc 0 |
| 안전 | 금액주문도 liveGate·checkLimits·2단계토큰·하드블록 전부 경유 | 단위테스트 |
| 정확성 | US 세션 DST 경계 정확 | DST 전환일 단위테스트 |

---

## 4. Success Criteria

### 4.1 Definition of Done

- [ ] FR-A·FR-B 구현 + 단위테스트 통과
- [ ] 수동 달러주문: 페이퍼/하드블록 차단 확인(라이브 키 있으면 소액 1건은 사용자 수동)
- [ ] US 세션: DST 경계(3월/11월 전환) 단위테스트 통과
- [ ] tsc 0, 기존 테스트 무회귀

### 4.2 Quality Criteria

- [ ] orderAmount는 US MARKET에만(KR/LIMIT 거부) — fail-closed
- [ ] 금액주문 2단계 토큰 해시에 orderAmount 바인딩(프리뷰=실주문 일치)

---

## 5. Risks and Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| orderAmount가 checkLimits 수량경로와 충돌 | High | Medium | 금액경로 분기 명확화(notional=orderAmount, normalizeQuantity 스킵). 단위테스트로 캡 적용 검증 |
| 2단계 토큰 해시 누락(금액 프리뷰≠주문) | High | Low | orderHash에 orderAmount 포함, 프리뷰=실주문 동일 인자 검증(기존 INV-1 패턴) |
| US DST 계산 오류 | Medium | Medium | DST 순수함수 + 전환일 경계 단위테스트. 오판해도 거래소 거부=fail-safe |
| 봇이 실수로 금액경로 진입 | Medium | Low | orderAmount는 수동 핸들러/스키마에만 노출, 러너 미전달(범위 차단) |
| US 심볼 판정(isKrSymbol) 오분류 | Low | Low | krx-tick.isKrSymbol 단일 진실원 재사용 |

---

## 6. Impact Analysis

### 6.1 Changed Resources

| Resource | Type | Change |
|----------|------|--------|
| `OrderRequest` (types.ts) | Type | `orderAmount?: number` 추가 |
| `TossBrokerAdapter.placeOrder` (toss.ts) | Logic | amount-based 본문 분기 |
| `placeOrder` (live-handlers.ts) | Logic | 금액경로(notional=orderAmount, USD, 해시) |
| `placeOrderShape` (schemas.ts) | Schema | `orderAmount` 추가 |
| 대시보드 수동주문 (server.ts) | UI | 금액 입력 토글(US) |
| `isMarketOpen`/`sessionKey` (market-hours.ts) | Logic | 심볼 인식 + US RTH/DST |
| 러너 limit_bracket 호출부 (runner.ts) | Logic | isMarketOpen/sessionKey에 symbol 전달 |

### 6.2 Current Consumers

| Resource | Consumer | Impact |
|----------|----------|--------|
| `OrderRequest` | binance/kis/kiwoom 어댑터 placeOrder | None(orderAmount 선택, 미사용) |
| `isMarketOpen` | runner limit_bracket 게이트 | Needs verification(symbol 인자 추가, 기본 동작 보존) |
| `placeOrder`(live-handlers) | place_order MCP 툴, 대시보드 /api/order | Needs verification(quantity 경로 무변경) |
| 다른 브로커 어댑터 placeOrder | OrderRequest.orderAmount 무시 | None(toss만 처리) |

### 6.3 Verification

- [ ] quantity 경로(기존)·금액경로 분기 단위테스트로 회귀 가드
- [ ] isMarketOpen 심볼 미전달 시 기존 동작 바이트 동일(binance→true, KR→KR시간)
- [ ] 봇 경로엔 orderAmount 미노출(범위 차단) 확인

---

## 7. Architecture Considerations

### 7.1 Project Level

Dynamic(기존 멀티브로커 어댑터 패턴 확장). 신규 폴더 없음.

### 7.2 Key Decisions

| Decision | Selected | Rationale |
|----------|----------|-----------|
| orderAmount 범위 | **수동 전용** | 봇은 수량기반 사이징 — 금액경로는 모델 불일치(YAGNI) |
| US 세션 판정 | **정적 RTH+DST(sync)** | isMarketOpen sync 유지(러너 핫패스). API는 async·캐시 필요로 과함 |
| US 심볼 판정 | `isKrSymbol` 재사용 | 단일 진실원(통화·정수주와 동일 규약) |
| orderAmount 본문 | OrderRequest 선택필드 | 어댑터별 무시 가능, 토스만 처리 |

---

## 8. Convention Prerequisites

### 8.3 Environment Variables Needed

추가 없음(기존 TOSS_* 재사용).

---

## 9. Next Steps

1. [ ] `/pdca design toss-us-followup` — 아키텍처안(금액경로 분기 위치·DST 함수 배치) 선택
2. [ ] `/pdca do` — FR-A(금액주문) → FR-B(세션) 순
3. [ ] 단위테스트 + 수동 달러주문 검증

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-06-21 | Initial draft (orderAmount 수동한정 + US 세션 정적 RTH+DST) | Evanciel |
