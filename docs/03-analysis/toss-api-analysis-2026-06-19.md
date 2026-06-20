# 토스증권 Open API 분석 & 통합 설계 (2026-06-19)

> 원천: `https://developers.tossinvest.com/docs` (JS 렌더 SPA — `/llms.txt` 경유 발견)
> Canonical 스펙: `https://openapi.tossinvest.com/openapi-docs/latest/openapi.json` (v1.1.1, 로컬 사본 `docs/03-analysis/toss-api/openapi.json`)
> 목적: quant-mcp에 4번째 브로커 어댑터(`toss`) 추가 — Binance/KIS/Kiwoom와 동일한 안전경로에 plug-in.

---

## 1. API 한눈에

- **Base URL**: `https://openapi.tossinvest.com` (**단일 — mock/sandbox 별도 호스트 없음**) ⚠️
- **연동 방식**: REST only (WebSocket/스트리밍 없음)
- **인증**: OAuth 2.0 **Client Credentials Grant**
  - `POST /oauth2/token` (form-urlencoded): `grant_type=client_credentials`, `client_id`, `client_secret`
  - 응답: `{ access_token(JWT), token_type:"Bearer", expires_in: 86400 }` (~24h)
  - 모든 호출: `Authorization: Bearer {token}`
  - **계좌·자산·주문**은 추가로 `X-Tossinvest-Account: {accountSeq}` 헤더 필요 (정수, `GET /accounts`의 `accountSeq`)
- **클라이언트 발급**: 토스증권 WTS 로그인 → 설정 > Open API → `client_id`/`client_secret`
- **숫자 표현**: 가격·수량·금액 전부 **decimal 문자열**(`"72000"`, `"100.5"`). KR=정수(원), US=소수 가능.
- **시각**: ISO 8601 + `+09:00`(KST).

### 엔드포인트 맵 (20개)

| 카테고리 | 엔드포인트 | 토큰만 | 계좌헤더 | 비고 |
|---|---|:---:|:---:|---|
| Auth | `POST /oauth2/token` | — | — | 토큰 발급 |
| Market Data | `GET /api/v1/prices?symbols=` | ✅ | | 현재가(최대 200종목 콤마) |
| Market Data | `GET /api/v1/candles?symbol=&interval=&count=&before=&adjusted=` | ✅ | | **interval=`1m`\|`1d`만**, count≤200, 수정주가 기본 ON |
| Market Data | `GET /api/v1/orderbook` `/trades` `/price-limits` | ✅ | | 호가/체결/상하한가 |
| Stock Info | `GET /api/v1/stocks?symbols=` | ✅ | | **종목명(한글)·시장·통화·상태** ← 심볼 해석 |
| Stock Info | `GET /api/v1/stocks/{symbol}/warnings` | ✅ | | 매수 유의(정리매매·VI·투자경고…) |
| Market Info | `GET /api/v1/exchange-rate` `/market-calendar/KR\|US` | ✅ | | 환율·장 운영시간 |
| Account | `GET /api/v1/accounts` | ✅ | | 계좌 목록 → **accountSeq** |
| Asset | `GET /api/v1/holdings?symbol=` | ✅ | ✅ | 보유종목 + 합산 평가 |
| Order | `POST /api/v1/orders` | ✅ | ✅ | **주문 생성** |
| Order | `POST /api/v1/orders/{orderId}/modify` | ✅ | ✅ | 정정 → **새 orderId 발급** |
| Order | `POST /api/v1/orders/{orderId}/cancel` | ✅ | ✅ | 취소(빈 바디) → **새 orderId** |
| Order History | `GET /api/v1/orders?status=OPEN\|CLOSED` | ✅ | ✅ | **CLOSED 현재 미지원(400)** → OPEN만 |
| Order History | `GET /api/v1/orders/{orderId}` | ✅ | ✅ | **상세(체결 포함)** — 모든 상태 |
| Order Info | `GET /api/v1/buying-power?currency=` | ✅ | ✅ | 매수가능금액(현금) |
| Order Info | `GET /api/v1/sellable-quantity?symbol=` | ✅ | ✅ | 판매가능수량 |
| Order Info | `GET /api/v1/commissions` | ✅ | ✅ | 수수료율 |

### Rate Limits (클라이언트 × API 그룹, TPS)

`AUTH 5` · `ACCOUNT 1` · `ASSET 5` · `STOCK 5` · `MARKET_INFO 3` · `MARKET_DATA 10` · `MARKET_DATA_CHART 5` · `ORDER 6`(09:00~09:10 **3**) · `ORDER_HISTORY 5` · `ORDER_INFO 6`(피크 3)
- 응답 헤더 `X-RateLimit-Limit/Remaining/Reset`, 429 시 `Retry-After`. → 지수백오프+jitter.

### 에러 envelope

```json
{ "error": { "requestId": "...", "code": "order-not-found", "message": "...", "data": {...} } }
```
- 풍부한 코드: `invalid-request` `invalid-tick-size` `insufficient-buying-power` `order-hours-closed` `price-out-of-range` `confirm-high-value-required`(1억↑) `already-filled/canceled` `request-in-progress`(중복 clientOrderId) 등.
- `/oauth2/token`만 OAuth2 표준 포맷(`{error, error_description}`)으로 상이.

---

## 2. 주문 생성 본문 (가장 중요)

`POST /api/v1/orders` = `OrderCreateRequest` (oneOf):

**(A) 수량 기반** (KR/US 공통):
```json
{ "clientOrderId":"my-001"?, "symbol":"005930", "side":"BUY|SELL",
  "orderType":"LIMIT|MARKET", "timeInForce":"DAY|CLS"?,
  "quantity":"10", "price":"70000"?, "confirmHighValueOrder":false? }
```
- `price`: LIMIT 필수 / MARKET 전달금지. KR=정수(호가단위 정렬 필요).
- `quantity`: 정수만(소수 불가). 소수주는 (B) 사용.
- `timeInForce`: 기본 DAY. `LIMIT`+`CLS`=LOC(종가지정가).
- `clientOrderId`: 멱등키(최대 36자, 영숫자·`-`·`_`). 동일값 재요청 시 이전 결과 재반환.

**(B) 금액 기반** (US MARKET 전용): `{symbol, side, orderType:"MARKET", orderAmount:"100.5"}`

**응답** = `OrderResponse` = `{ orderId, clientOrderId }` **(체결정보 없음!)** ⚠️
→ 접수만 확인. 실제 상태/체결은 `GET /orders/{orderId}` 재조회 필요.

**정정/취소 응답** = `OrderOperationResponse` = `{ orderId }` — **원주문과 다른 새 orderId**.

### 주문 상세 (`GET /orders/{orderId}` = `Order`)
```
orderId, symbol, side(BUY/SELL), orderType(LIMIT/MARKET), timeInForce(DAY/CLS/OPG),
status(OrderStatus), price, quantity, orderAmount, currency, orderedAt, canceledAt,
execution: { filledQuantity, averageFilledPrice, filledAmount, commission, tax, filledAt, settlementDate }
```
**OrderStatus**: `PENDING` `PENDING_CANCEL` `PENDING_REPLACE` `PARTIAL_FILLED` `FILLED` `CANCELED` `REJECTED` `CANCEL_REJECTED` `REPLACE_REJECTED` `REPLACED`

---

## 3. BrokerAdapter 매핑 (src/brokers/types.ts 계약)

| 어댑터 메서드 | 토스 엔드포인트 | 매핑 메모 |
|---|---|---|
| `getBalance()` | `GET /accounts`+`/buying-power?currency=KRW` | totalAsset=holdings 평가합 or buying-power, cash=cashBuyingPower, currency=KRW |
| `getPositions()` | `GET /holdings` | items[]→Position. qty/avgPrice(averagePurchasePrice)/currentPrice(lastPrice)/pnl(profitLoss.amount)/pnlPercent(rate) |
| `getPrice(symbol)` | `GET /prices?symbols=` | lastPrice→price. change/changePercent=0(미제공). volume 별도 |
| `placeOrder(order)` | `POST /orders` (수량기반) | side buy/sell→BUY/SELL, type market/limit→MARKET/LIMIT. **stop_*/take_profit_*는 미지원→fail-closed throw**(키움과 동일). price=KRX틱 정렬. status="pending"(응답에 체결X) |
| `cancelOrder(id,sym)` | `POST /orders/{id}/cancel` | 빈 바디. return의 새 orderId는 무시(bool 반환) |
| `getOpenOrders(sym)` | `GET /orders?status=OPEN&symbol=` | orders[]→OrderResult. status 매핑, executedQty=execution.filledQuantity |
| `getOrderById(sym,id)` | `GET /orders/{orderId}` | 수동 지정가 체결 추적용. 전체 상태 조회 가능 |
| `normalizeQuantity()` | (로컬) | KR 정수주 → `Math.floor`. (키움과 동일) |
| `getCandles()` (확장) | `GET /candles` | interval **1m/1d만**. Candle decimal 문자열 → number. KST `+09:00` 라벨 |

**미구현(=undefined 유지)**: `getOrderByClientId`, `placeOco`/`cancelOco`/`getOpenOco`, `baseAssetOf`, `cancelOrderByClientId`.
- ⚠️ **`getOrderByClientId`는 추가 금지**: runner reconcile이 `getOrderByClientId===undefined`로 KR 브로커를 *포지션 reconcile* 경로로 보낸다(types.ts:88, runner.ts, kiwoom.ts:522 교훈). 추가 시 KR reconcile 꺼져 유령 포지션 위험.

### 토스 vs 키움 (둘 다 한국, wire 비교)

| | 키움 | 토스 |
|---|---|---|
| 인증 | OAuth2 + `api-id` 헤더 | OAuth2 표준 + `Authorization: Bearer` |
| 계좌 지정 | 토큰에 내재 | **`X-Tossinvest-Account` 헤더(accountSeq)** |
| 성공 판정 | 바디 `return_code===0` | **HTTP 2xx + `{result}` / 4xx+ `{error}`** (표준) |
| 주문 경로 | 단일 `/ordr` + api-id 분기 | RESTful `/orders` `/orders/{id}/cancel` |
| 숫자 | 부호접두 문자열(abs 필요) | **순수 decimal 문자열** |
| 체결 추적 | getOpenOrders만 | **getOpenOrders + getOrderById(체결상세)** ← 더 풍부 |
| 캔들 | 분/일/주/월 | **1m/1d만** |
| **모의서버** | mockapi.kiwoom.com 있음 | **❌ 없음(라이브 단일)** |

→ 토스가 전반적으로 **더 깔끔**. 키움 어댑터가 거의 그대로 템플릿. wire는 별개라 전용 `TossBrokerAdapter` 클래스(서브클래싱 금지).

---

## 4. ⚠️ 핵심 리스크: 모의(mock) 환경 부재

이 프로젝트의 안전 문화는 **"모의 E2E 검증 전엔 라이브 파싱 투입 금지"**(P1-10 교훈). 그러나 **토스 Open API는 단일 라이브 호스트뿐 — 모의 주문 서버가 없다.**

함의:
- 시세/종목/계좌/보유/주문조회(GET)는 **읽기 전용 → 라이브 호출해도 안전**(돈 안 나감). 키만 있으면 즉시 E2E 가능.
- **주문 생성/정정/취소(POST)만 위험** + 모의 검증 불가. 단, 토스 주문 응답은 단순(`{orderId,clientOrderId}`)하고 `GET /orders/{id}`로 상태 재확인 가능 → 키움 모의서버에서 겪은 "응답키 깜짝" 리스크는 낮음.
- 기존 안전망이 그대로 적용됨: `LIVE_TRADING_ENABLED` 마스터 스위치 / `LIVE_MAX_NOTIONAL`(KRW) / `LIVE_SYMBOL_ALLOWLIST` / 일일손실 서킷 / 감사로그. **기본은 페이퍼**, 명시 활성 전엔 실주문 안 나감.

**권장 안전 전략**: 주문-쓰기 경로(placeOrder/cancel/modify)는 구현하되 기존 라이브 게이트 뒤에 두고(기본 페이퍼), 실주문은 **키 확보 후 1주 소액 수동 검증 + `GET /orders/{id}` 대조**로만 활성. 데이터/조회 경로는 즉시 실연동.

---

## 5. 변경 대상 파일 (구현 시)

**신규**
- `src/brokers/toss.ts` — `TossBrokerAdapter`(키움 템플릿 기반): OAuth 토큰 캐시, envelope 파서, 어댑터 메서드, `[http:N]` 마커, decimal 파서, `getCandles`.
- (선택) `src/data/toss-data.ts` — 캔들/현재가 조회(단, **토큰 필요** → binance-public처럼 keyless 아님. 어댑터 재사용이 더 단순할 수 있음).
- `scripts/verify-toss-e2e.ts` — 읽기 전용 E2E(토큰→accounts→prices→candles→holdings→orders OPEN). 키 확보 시 실행.

**수정(배선 — 원자적으로)**
- `src/setup/credentials.ts` — `BrokerKey`에 `"toss"`, `BROKER_FIELDS.toss`(`TOSS_CLIENT_ID`/`TOSS_CLIENT_SECRET`/`TOSS_ACCOUNT_SEQ`/`TOSS_ENV`).
- `src/brokers/types.ts` — `BrokerType`에 `"toss"`.
- `src/brokers/index.ts` — `getAdapter` 분기 + `configuredBrokers()`.
- `src/brokers/safety.ts` — `loadCredentials` 토스 env 추출.
- `src/mcp-server/schemas.ts` — broker enum에 `"toss"`.
- `src/runner/runner.ts` — broker enum 캐스트 + quoteCurrency(KRW).
- `src/mcp-server/live-handlers.ts` — quoteCurrency 판정(toss→KRW).
- `src/dashboard/server.ts` — 브로커 드롭다운/폼은 `BROKER_FIELDS` 순회라 자동. 단 토스 심볼 캔들 소스 배선 확인.

**테스트**
- `tests/`에 토스 어댑터 단위테스트(envelope 파싱·decimal·주문본문 매핑·에러분류). vitest.

---

## 6. 미해결 결정 (구현 전 확정 필요)

1. **주문-쓰기 경로 범위**: (A) 풀 구현 + 라이브 게이트 뒤 페이퍼 기본(권장) / (B) 읽기 전용 먼저, 쓰기는 별도 패스 / (C) 처음부터 라이브 활성.
2. **데이터 레이어**: 토스 캔들이 토큰을 요구하므로 `src/data/*` 분리 대신 어댑터 `getCandles` 직접 사용 검토.
3. **심볼 해석**: 이름→코드 역검색 API 없음(getStocks는 코드→이름). 기존 KR 이름 해석기 재사용 + `GET /stocks`로 코드→메타 보강.
4. **US 주식**: 토스는 US도 지원(소수주/금액주문). 1차는 KR 전용으로 한정할지.
5. **PDCA**: 파일 10+·실거래 안전설계 → `/pdca plan` 권장 vs 바로 구현.
