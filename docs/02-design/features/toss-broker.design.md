# toss-broker Design Document

> **Summary**: 토스증권 Open API를 4번째 브로커 어댑터로 통합 — 설계안 **C(Pragmatic) + 2 안전강화**(불가괴 서킷 라우팅 + 토스 라이브-쓰기 하드블록)
>
> **Project**: quant-mcp
> **Version**: 0.1.0
> **Author**: Evanciel
> **Date**: 2026-06-19
> **Status**: Draft
> **Planning Doc**: [toss-broker.plan.md](../../01-plan/features/toss-broker.plan.md)
> **Analysis**: [toss-api-analysis-2026-06-19.md](../../03-analysis/toss-api-analysis-2026-06-19.md)
> **Design 워크플로우**: 12-agent (verify→options→judge→adversary→synthesize), Run `wf_ed3b575a-42c`

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | KR 브로커 선택지 확대 + 토스 단일 API로 US 주식 신규 지원. 기존 어댑터 계약에 무손실 plug-in. |
| **WHO** | quant-mcp로 KR/US 주식을 자동매매·모니터링하는 BYOK 사용자(본인 토스 계좌). |
| **RISK** | 토스 **모의서버 부재** → 주문 쓰기 라이브 검증만 가능. US 통화/소수주 처리로 quoteCurrency 로직이 브로커 단위→심볼 단위로 확장돼 회귀 위험. |
| **SUCCESS** | 읽기 경로 라이브 E2E 통과. 주문 쓰기 페이퍼 기본 + 소액 라이브 1건 검증. 기존 465 테스트 무회귀 + tsc 0. |
| **SCOPE** | (1) 어댑터 (2) 멀티브로커 배선 (3) US 통화/소수주 (4) 대시보드 통합 (5) E2E·단위테스트. OCO/보호주문·`getOrderByClientId`는 의도적 제외. |

---

## 1. Overview

### 1.1 Design Goals

- 토스증권 Open API(`https://openapi.tossinvest.com`, v1.1.1)를 `BrokerAdapter` 포트([src/brokers/types.ts:74](../../../src/brokers/types.ts))를 구현하는 전용 `TossBrokerAdapter`로 통합.
- KR(KRX 정수주) + US(USD 소수주·금액주문)를 단일 어댑터로 지원.
- 기존 안전경로(`placeOrder`→`liveGate`→`checkLimits`→`audit`→`adapter.placeOrder`)에 **코드 중복 없이** plug-in.
- 토스 고유 리스크(모의 호스트 부재)를 어댑터 레벨 하드블록으로 봉쇄.

### 1.2 Design Principles

- **전용 어댑터, 서브클래싱 금지** — KIS/키움과 wire 비호환. 템플릿만 차용([src/brokers/kiwoom.ts](../../../src/brokers/kiwoom.ts)).
- **Fail-closed** — 모호 응답·보호주문·미지원 인터벌·미확인 orderId는 전부 throw(유령 주문/silent 0 금지).
- **불변식 보존** — `getOrderByClientId` 미구현(reconcile 라우팅), 단일 주문 sink, no-retry-on-POST.
- **YAGNI** — 레지스트리 같은 speculative 추상화는 broker #5가 실제로 생길 때까지 미도입.

---

## 2. Architecture Options

### 2.0 Architecture Comparison

| Criteria | Option A: Minimal | Option B: Clean | Option C: Pragmatic |
|----------|:-:|:-:|:-:|
| **Approach** | 최소 변경, 최대 재사용 | 레지스트리+통화레이어+Position.currency | 통화헬퍼 1개로 균형 |
| **New Files** | 3 | 5 | 3 |
| **Modified Files** | 9 | ~12 (Broker 재배치) | 9 |
| **Complexity** | Low | High | Low-moderate |
| **Maintainability** | Medium (regex 4× 중복) | High (broker #5=1파일) | High (6곳 중복→헬퍼 1개) |
| **Effort** | **Lowest** (~57행) | High (6파일 churn) | Medium (~60행) |
| **Regression Risk** | **Lowest** (IN 리터럴, import-graph 무변경) | Highest (Broker 재배치 6파일 ripple) | Low (추가형, GLOB만 신규벡터) |
| **Judge 종합(유지/회귀/노력 평균)** | 7.7 | 6.3 | **8.3** |

**Selected**: **Option C + 2 hardenings** — **Rationale**: C가 종합 1위(8.3). 통화헬퍼 1개로 B 유지보수성의 ~90%를 near-A 회귀footprint로 확보(Broker 재배치·speculative 레지스트리 없음, YAGNI). 적대 검토가 3안 모두 못 막은 구멍 2개를 강화로 봉쇄:
- **강화①**: 일일손실 서킷 라우팅은 C의 `GLOB` 대신 **A의 coarse `IN(...,'toss')`** 채택 — KR+US 혼합 봇 손실을 양 통화 버킷에 중복 집계(과집계=서킷 *조기* 작동, fail-safe). `GLOB`≠`/^\d{6}$/` 미세 불일치 시 silent fail-open 회피.
- **강화②(최고 심각도)**: 토스 라이브-쓰기 하드블록 — 토스는 모의 호스트가 없어 `env="mock"` 주문이 `liveGate` 통과 + `checkLimits` 우회([safety.ts:97](../../../src/brokers/safety.ts))인데 실호스트 도달. `TossBrokerAdapter.placeOrder/cancelOrder`는 `env==="live" && LIVE_TRADING_ENABLED==="true"`가 아니면 throw.

### 2.1 Component Diagram

```
대시보드 /api/order ─┐
MCP place_order ─────┼─▶ live-handlers.placeOrder (단일 sink, server.ts:912)
러너 fillOrder ──────┘        │
                              ├─▶ quoteCurrencyFor(broker,symbol)  ← NEW (safety.ts)
                              ├─▶ liveGate (HALT/AUDIT_HALT/master)
                              ├─▶ checkLimits (cap·circuit, 통화별)
                              ├─▶ audit (사전 기록)
                              └─▶ getAdapter("toss") ─▶ TossBrokerAdapter
                                                          ├─ getToken (OAuth2, 24h 캐시)
                                                          ├─ placeOrder ── 🔴 live-write-block
                                                          ├─ getBalance/getPositions/getPrice
                                                          ├─ getOpenOrders/getOrderById
                                                          └─ getCandles (1m/1d)
                                                       ─▶ https://openapi.tossinvest.com
```

### 2.2 Data Flow (주문)

```
사용자 → placeOrder → quoteCurrencyFor → liveGate → checkLimits(통화별 cap/circuit)
       → audit(사전) → 🔴 live-write-block 검사 → POST /api/v1/orders → {orderId}
       → status="pending"(체결정보 없음) → (다음 틱) reconcile via getPositions
```

### 2.3 Dependencies

| Component | Depends On | Purpose |
|-----------|-----------|---------|
| `TossBrokerAdapter` | `base.ts`(BaseBrokerAdapter, withRetry), `krx-tick.ts`(roundToKrxTick) | 공통 재시도·KRX 틱 정렬 |
| `quoteCurrencyFor` | `LIVE_DEFAULTS_BY_CCY`(USD 기존재, safety.ts:81) | 통화별 cap/circuit 기본값 |
| `getAdapter("toss")` | `loadCredentials("toss")` | 자격증명 주입(BYOK) |

---

## 3. Data Model

### 3.1 Adapter 필드 & 토큰 캐시

```typescript
class TossBrokerAdapter extends BaseBrokerAdapter {
  type: BrokerType = "toss";
  private readonly env: "mock" | "live";        // loadCredentials 기본 "mock"
  private readonly baseUrl = "https://openapi.tossinvest.com"; // 단일 호스트(메인넷 하드코딩 아님 — 토스는 호스트 1개뿐)
  private readonly accountSeq: string;          // X-Tossinvest-Account 헤더
  private accessToken: string | null = null;    // OAuth2 Bearer, ~24h
  private tokenExpiresAt = 0;                    // TOKEN_SKEW_MS=5min 조기 갱신
}
```

### 3.2 토스 스키마 → BrokerAdapter 타입 매핑 (decimal 문자열 → number)

| BrokerAdapter 타입 | 토스 응답 → 필드 | 변환 |
|---|---|---|
| `MarketPrice.price` | `/prices` → `lastPrice` | `toNum`(no-abs) |
| `Position{symbol,quantity,avgPrice,currentPrice,pnl,pnlPercent}` | `/holdings` items → `symbol/quantity/averagePurchasePrice/lastPrice/profitLoss.amount/profitLoss.rate` | `toNum`(no-abs, 음수 pnl 보존) |
| `AccountBalance{totalAsset,cashBalance,currency}` | `/holdings` overview(`marketValue.amount`)+`/buying-power`(`cashBuyingPower`) | 통화별; KR=KRW |
| `OrderResult{orderId,status,...}` | `/orders` POST → `{orderId}` | status="pending"(체결정보 없음) |
| `OrderResult`(체결상세) | `/orders/{id}` → `Order.execution{filledQuantity,averageFilledPrice}` | `getOrderById` 전용 |
| `OrderResult[]`(미체결) | `/orders?status=OPEN` → `orders[]` | `executedQty=execution.filledQuantity`, `origQty=quantity` |
| Candle | `/candles` → `Candle{timestamp,openPrice,...,closePrice,volume}` | KST `+09:00` 라벨, decimal→number |

> ⚠️ **no-abs**: 키움 어댑터는 `Math.abs()`로 부호접두를 정리하나([kiwoom.ts:342](../../../src/brokers/kiwoom.ts)), 토스는 부호 없는 순수 decimal → **abs 적용 금지**(음수 pnl이 양수로 둔갑 → 서킷 오작동 방지).

### 3.3 통화 판정 (NEW: `quoteCurrencyFor`)

```typescript
// src/brokers/safety.ts
export function quoteCurrencyFor(broker: Broker, symbol?: string): string {
  if (broker === "binance") return "USDT";
  if (broker === "toss") return /^\d{6}$/.test((symbol ?? "").trim()) ? "KRW" : "USD"; // KR 6자리=KRW, else US=USD
  return "KRW"; // kis/kiwoom
}
```
- 머니패스 3곳 ternary 대체: [live-handlers.ts:127](../../../src/mcp-server/live-handlers.ts), [:215](../../../src/mcp-server/live-handlers.ts), [runner.ts:109](../../../src/runner/runner.ts).
- `binance→USDT`, `kis/kiwoom→KRW`는 **byte-identical**(기존 465 테스트로 회귀 증명).

---

## 4. API Specification (토스 엔드포인트 ↔ 어댑터 메서드)

All URIs relative to `https://openapi.tossinvest.com`. Auth: `Authorization: Bearer {token}`; 계좌/주문은 `X-Tossinvest-Account: {accountSeq}` 추가.

### 4.1 엔드포인트 ↔ 메서드

| 어댑터 메서드 | HTTP | 토스 엔드포인트 | 계좌헤더 | 비고 |
|---|---|---|:---:|---|
| `getToken`(내부) | POST | `/oauth2/token` (form) | — | client_credentials, 24h |
| `getPrice` | GET | `/api/v1/prices?symbols=` | — | lastPrice |
| `getCandles` | GET | `/api/v1/candles?symbol=&interval=1m\|1d&count=` | — | **1m/1d만**, 외 throw |
| `getBalance` | GET | `/api/v1/holdings` + `/api/v1/buying-power?currency=` | ✅ | 통화별 |
| `getPositions` | GET | `/api/v1/holdings` | ✅ | items[] |
| `placeOrder` | POST | `/api/v1/orders` | ✅ | 🔴 live-write-block |
| `cancelOrder` | POST | `/api/v1/orders/{orderId}/cancel` (빈 바디) | ✅ | 🔴 live-write-block |
| `getOpenOrders` | GET | `/api/v1/orders?status=OPEN&symbol=` | ✅ | CLOSED 미지원 |
| `getOrderById` | GET | `/api/v1/orders/{orderId}` | ✅ | 체결상세 |

### 4.2 주문 생성 본문 (`POST /api/v1/orders`)

**KR/US 수량기반** (기본):
```json
{ "clientOrderId":"qm-<bot>-<bar>"?, "symbol":"005930", "side":"BUY|SELL",
  "orderType":"LIMIT|MARKET", "timeInForce":"DAY",
  "quantity":"10", "price":"70000"? }
```
- KR: `quantity` 정수(floor), `price` LIMIT 시 KRX 틱 정렬(`roundToKrxTick`).
- US: `quantity` 소수 허용. `price` 미정렬(US 틱 없음).
- `orderType`은 `market`/`limit`만 매핑. `stop_*`/`take_profit_*`은 **throw**(fail-closed).

**US 금액기반 시장가** (소수주 대안, `orderAmount`):
```json
{ "symbol":"AAPL", "side":"BUY", "orderType":"MARKET", "orderAmount":"100.5" }
```

**응답**: `{ orderId, clientOrderId }` — **체결정보 없음** → `status:"pending"`. `orderId` 부재/비문자열 → throw(유령 주문 금지, [kiwoom.ts:455](../../../src/brokers/kiwoom.ts) 패턴).

---

## 5. UI/UX Design (대시보드 통합)

### 5.1 통합 지점 ([src/dashboard/server.ts](../../../src/dashboard/server.ts))

| 영역 | 변경 | 위치(근사) |
|---|---|---|
| 브로커 드롭다운 | `toss` 옵션 추가(3곳) | :1189, :1635, :1678 |
| `brokerLabel` | "토스증권" 라벨 | :1797 |
| 자격증명 폼 | **자동**(`BROKER_FIELDS` 순회) | 변경 불필요 |
| 차트 소스 | `candlesFor`/`candlesForSymbol`에 toss → `getAdapter("toss").getCandles` | :518, :587 |
| 통화 표시 | `ccyOf(broker)` → `ccyOf(broker, symbol)` (심볼 인식) | :1238 + 호출부 1560/1692/1713/1766/1893 |
| 보유/미체결 패널 | `getPositions`/`getOpenOrders` 경유(어댑터 generic) | 기존 경로 |
| 수동주문 | **새 경로 없음** — `/api/order`→`placeOrder` 단일 sink 유지 | :912 |

### 5.4 Page UI Checklist (대시보드)

- [ ] Dropdown: 브로커 선택에 "토스증권(toss)" 노출(주문/차트/봇생성 3곳)
- [ ] Form: 토스 자격증명 입력(TOSS_CLIENT_ID/SECRET/ACCOUNT_SEQ/ENV) — BROKER_FIELDS 자동
- [ ] Chart: 토스 KR(005930)·US(AAPL) 심볼 캔들 렌더(1d/1m), cachedRawCandles 적용
- [ ] Display: 통화 표시 — KR행 ₩(KRW), US행 $(USD) (서버 권위, 표시 drift는 무해)
- [ ] Panel: 보유종목(KR+US 혼재) 평가/손익 표시
- [ ] Panel: 미체결 주문(부분체결 잔량) 표시
- [ ] Order: 수동주문이 placeOrder 단일 경로로만 전송(우회 없음)

---

## 6. Error Handling

### 6.1 토스 에러 envelope & 분류

토스 에러: `{ "error": { "requestId", "code", "message", "data"? } }` (단, `/oauth2/token`은 OAuth2 표준 `{error, error_description}`).

| HTTP | 처리 | 재시도 |
|---|---|:---:|
| 2xx + `{result}` | 성공. **단 per-method 필드 존재 검증**(2xx만으로 성공 단정 금지 — 잘린 바디가 `{totalAsset:0}`로 둔갑 차단) | — |
| 400 `invalid-request`/`invalid-tick-size` | throw(요청 오류) | ✗ |
| 401 `expired-token`/`invalid-token` | 토큰 무효화 후 1회 재발급 | (토큰만) |
| 409 `request-in-progress`/`already-*` | 멱등 충돌 — clientOrderId 재요청 결과 반영 | ✗ |
| 422 `insufficient-buying-power`/`order-hours-closed`/`price-out-of-range` | rejected 반환 또는 throw | ✗ |
| 429 `rate-limit-exceeded` | `[http:429][retry-after:S]` 마커 → GET만 백오프 재시도 | GET만 |
| 5xx `internal-error`/`maintenance` | `[http:5xx]` 마커 → GET만 재시도 | GET만 |

- **주문 POST(`placeOrder`/`cancelOrder`)는 절대 `withRetry` 금지**(비멱등, 중복주문 = 최악). bare `post()` 호출. 429/5xx는 fail-fast → 다음 틱 reconcile 재시도.
- 마커 패턴은 [base.ts](../../../src/brokers/base.ts) `classifyRetryableError` + [kiwoom.ts:218](../../../src/brokers/kiwoom.ts) 답습.

---

## 7. Security Considerations

- [x] **BYOK 위생**: 시크릿은 주입된 `this.credentials`에서만 읽음(process.env 직접접근 금지). 시크릿/Bearer 절대 로그 금지.
- [x] **🔴 라이브-쓰기 하드블록**(강화②): `placeOrder`/`cancelOrder`는 `env==="live" && LIVE_TRADING_ENABLED==="true"`가 아니면 throw. 토스 모의 호스트 부재 + `checkLimits` 마스터-OFF 우회([safety.ts:97](../../../src/brokers/safety.ts))로 인한 "페이퍼인데 실호스트 무캡 도달" 봉쇄. 마스터 스위치 단락과 **독립**.
- [x] **Fail-closed 보호주문**: market/limit 외 throw(silent 하향 금지).
- [x] **유령 주문 차단**: orderId 부재/비문자열 → throw.
- [x] **Rate Limiting 존중**: 429 Retry-After 백오프(GET), 주문 POST fail-fast.
- [x] **reconcile 라우팅 보존**: `getOrderByClientId` 미구현 → KR 포지션-reconcile 경로 유지([runner.ts:351](../../../src/runner/runner.ts)).

---

## 8. Test Plan

### 8.1 Test Scope

| Type | Target | Tool | Phase |
|------|--------|------|-------|
| L1: 단위 | 어댑터 순수 로직(envelope/decimal/주문본문/통화/에러) | vitest | Do |
| L2: 읽기 E2E | 라이브 읽기 경로(토큰→계좌→시세→캔들→보유→미체결) | `scripts/verify-toss-e2e.ts` | Do(키 보유) |
| L3: 페이퍼/라이브 | 게이트 OFF=실주문 미발생 / 소액 라이브 1건 | 수동 + `GET /orders/{id}` 대조 | Check |

### 8.2 L1 단위 테스트 시나리오 ([tests/toss-adapter.test.ts](../../../tests/toss-adapter.test.ts))

| # | 테스트 | 기대 |
|---|---|---|
| 1 | envelope 파싱(`{result}`/`{error}`) + `[http:N]` 마커 | 성공/실패 정확 분류 |
| 2 | decimal 파싱 — KR 정수("10")·US 소수("0.5") + **no-abs** 음수 pnl | 부호 보존 |
| 3 | 주문본문 — KR LIMIT(틱 정렬)·US MARKET(금액)·passthrough | 정확 매핑 |
| 4 | 보호주문(stop_*) → throw | fail-closed |
| 5 | orderId 부재 → throw | 유령 차단 |
| 6 | **`quoteCurrencyFor` 회귀가드** — binance→USDT, kiwoom→KRW byte-identical, toss 005930→KRW/AAPL→USD | 무회귀 |
| 7 | `dailyRealizedLoss` — toss 거래가 KRW·USD 양 버킷에 집계(과집계 fail-safe) | 서킷 미누락 |
| 8 | **`getOrderByClientId === undefined`** 단언 | reconcile 라우팅 보존 |
| 9 | **라이브-쓰기 블록** — env="mock" 또는 LIVE_TRADING_ENABLED!=true 시 placeOrder throw | 무캡 실주문 차단 |
| 10 | **no-coerce-to-binance** — `broker:"toss"` 봇이 어떤 cast 사이트에서도 "binance"로 강등 안 됨 | silent 폴백 차단 |
| 11 | per-method 필드 검증 — 잘린 2xx 바디 → throw(not `{totalAsset:0}`) | silent 0 차단 |

### 8.3 L2 읽기 E2E ([scripts/verify-toss-e2e.ts](../../../scripts/verify-toss-e2e.ts))

토큰 발급 → `/accounts`(accountSeq 획득) → `/prices?symbols=005930,AAPL` → `/candles`(1d) → `/holdings` → `/orders?status=OPEN`. 각 단계 HTTP 200 + 응답 형태 검증. **주문 POST는 절대 호출 안 함**(읽기 전용).

### 8.5 Seed Data

해당 없음(라이브 읽기 — 실계좌 데이터). 단위테스트는 fetch mock 사용.

---

## 9. Clean Architecture (brokers 레이어)

### 9.4 This Feature's Layer Assignment

| Component | Layer | Location |
|-----------|-------|----------|
| `TossBrokerAdapter` | Infrastructure(브로커 어댑터) | `src/brokers/toss.ts` |
| `quoteCurrencyFor`, `loadCredentials`, `dailyRealizedLoss`, `checkLimits` | Application(안전·라우팅) | `src/brokers/safety.ts` |
| `BrokerAdapter`, `BrokerType`, `OrderRequest`... | Domain(계약·타입) | `src/brokers/types.ts` |
| `getAdapter`/`configuredBrokers` | Infrastructure(팩토리) | `src/brokers/index.ts` |
| `placeOrder`(단일 sink) | Application | `src/mcp-server/live-handlers.ts` |
| 대시보드 통합 | Presentation | `src/dashboard/server.ts` |

> 의존 규칙: 어댑터는 `types.ts`(Domain) + `base.ts`/`krx-tick.ts`(infra util)만 의존. `placeOrder` 안전경로 우회 금지.

---

## 10. Coding Convention Reference

### 10.4 This Feature's Conventions

| Item | Convention Applied |
|------|-------------------|
| 브로커 키 | 소문자 `toss`(BrokerKey/BrokerType 일관) |
| 파일 | `src/brokers/toss.ts`(camelCase), 클래스 `TossBrokerAdapter`(PascalCase) |
| Env vars | `TOSS_CLIENT_ID`/`TOSS_CLIENT_SECRET`/`TOSS_ACCOUNT_SEQ`/`TOSS_ENV` |
| 에러 | `[http:N]`/`[retry-after:S]` 마커, fail-closed, 시크릿 비노출 |
| 통화 | `quoteCurrencyFor(broker,symbol)` 단일 진실원 |

---

## 11. Implementation Guide

### 11.1 File Structure

```
src/brokers/toss.ts            ← 신규 어댑터(~360-420 LOC, kiwoom 템플릿)
src/brokers/{types,index,safety}.ts  ← toss 배선 + quoteCurrencyFor + dailyRealizedLoss
src/setup/credentials.ts       ← BrokerKey + BROKER_FIELDS.toss
src/mcp-server/{schemas,live-handlers}.ts, src/runner/runner.ts, src/mcp-server/bot-handlers.ts  ← 배선
src/dashboard/server.ts        ← 대시보드 통합
scripts/verify-toss-e2e.ts     ← 읽기 E2E
tests/toss-adapter.test.ts     ← 단위테스트
```

### 11.2 Implementation Order

1. [ ] `toss.ts` 어댑터(토큰→envelope→메서드→안전블록)
2. [ ] 배선(credentials/types/index/safety/schemas/live-handlers/runner/bot-handlers)
3. [ ] 통화 확장(`quoteCurrencyFor` + `dailyRealizedLoss` IN-widen)
4. [ ] 대시보드 통합
5. [ ] 단위테스트 + 읽기 E2E
6. [ ] tsc 0 + 기존 465 테스트 무회귀 확인

### 11.3 Session Guide

#### Module Map

| Module | Scope Key | Description | Est. Turns |
|--------|-----------|-------------|:---:|
| 어댑터 | `module-1` | `toss.ts` — 토큰 캐시, envelope 파서, 9 메서드, no-abs decimal, fail-closed, 🔴 live-write-block | 40-50 |
| 배선+통화 | `module-2` | credentials/types/index/safety(quoteCurrencyFor+dailyRealizedLoss IN-widen)/schemas/live-handlers/runner(4 cast+candle branch)/bot-handlers | 30-40 |
| 대시보드 | `module-3` | 드롭다운·차트소스·심볼인식 통화표시·보유/미체결 패널 | 25-35 |
| 검증 | `module-4` | `tests/toss-adapter.test.ts`(11 케이스) + `scripts/verify-toss-e2e.ts` + 무회귀 | 25-35 |

#### Recommended Session Plan

| Session | Phase | Scope | Turns |
|---------|-------|-------|:-----:|
| Session 1 | Plan + Design | 전체 | ✅ 완료 |
| Session 2 | Do | `--scope module-1,module-2` | 50-70 |
| Session 3 | Do | `--scope module-3,module-4` | 40-60 |
| Session 4 | Check + Report | 전체 | 30-40 |

#### 정확한 배선 사이트 (적대 검토 검증 완료)

- `["binance","kis","kiwoom"].includes(...)` 캐스트 4곳에 `"toss"` 추가: [runner.ts:98](../../../src/runner/runner.ts), :224, :457, :729 — **누락 시 toss 봇이 binance로 silent 강등(다른 거래소 실주문)**.
- zod enum 2곳: [schemas.ts:148](../../../src/mcp-server/schemas.ts)(createBotShape.broker), :176(brokerEnum).
- `getAdapter`/`configuredBrokers`: [index.ts](../../../src/brokers/index.ts) 분기 + 열거 추가.
- `loadCredentials`: [safety.ts](../../../src/brokers/safety.ts) toss 블록(env 기본 "mock").
- candle dispatch: [runner.ts:729](../../../src/runner/runner.ts) kiwoom 그룹에 합류.
- 보호주문 skip: [runner.ts:249](../../../src/runner/runner.ts) syncBotProtective에서 toss 제외(false PROTECTIVE_MAX_FAILS 방지).
- `market-hours.ts`는 **무변경**(toss는 비-binance라 KR/KST 브랜치로 자동 — US 세션게이팅은 v1 한계, limit_bracket 봇만 isMarketOpen 참조).

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-06-19 | Initial draft (Option C + 2 안전강화). 12-agent 워크플로우 기반 | Evanciel |
