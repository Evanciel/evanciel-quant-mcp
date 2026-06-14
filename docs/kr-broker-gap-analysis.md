# 한투(KIS) · 키움(Kiwoom) 어댑터 — 공식문서 대조 갭 분석

> 작성 2026-06-08. **공식 출처와 대조**해 어댑터(`src/brokers/kis.ts`, `kiwoom.ts`)의 실스펙 일치 여부를 점검.
> 정직: 이 분석은 **공식 문서/레퍼런스 구현 대조 + 코드 수정**까지다. **실 모의서버(KIS 모의 29443 / 키움 mockapi) E2E는 아직**(키 필요, Binance testnet처럼 머니패스 검증해야 "작동 확정"). 현 상태 = "스펙 일치(검증됨) + 모의 E2E 대기".

## 참고한 공식 출처

| 브로커 | 출처 | 용도 |
|---|---|---|
| KIS(한투) | `github.com/koreainvestment/open-trading-api` (공식 레포) `examples_llm/domestic_stock/{order_cash,order_rvsecncl,inquire_balance}` | tr_id·필수 바디 필드 대조 |
| KIS | apiportal.koreainvestment.com (개발자센터 포털) | 엔드포인트·OAuth |
| 키움 | `openapi.kiwoom.com/m/guide/apiguide` (공식 REST 가이드) | kt10000/10001 주문 바디·trde_tp·헤더 |
| 키움 | `github.com/dongbin300/KiwoomRestApi.Net` (.NET 래퍼) | kt10003 취소 바디(stk_cd 필수) 확인 |

## 발견·수정한 갭

### 🔴 KIS-1: 주문/취소 tr_id가 구버전 (수정됨)
- **이전**: buy `TTTC0802U` / sell `TTTC0801U` / cancel `TTTC0803U`
- **공식 현행(2025 NXT 대체거래소 개편)**: buy `TTTC0012U` / sell `TTTC0011U` / cancel `TTTC0013U` (mock = `V`-prefix)
- 영향: 구 tr_id로는 현행 API에서 **주문/취소 거부 가능**. → `kis.ts` TR_IDS 갱신.
- 잔고 `TTTC8434R`/`VTTC8434R`는 변경 없음(일치).

### 🔴 KIS-2: 필수 필드 `EXCG_ID_DVSN_CD` 누락 (수정됨)
- 공식 order-cash·order-rvsecncl 모두 `EXCG_ID_DVSN_CD`("KRX") **필수**(NXT 개편 이후). 어댑터 바디에 없었음 → **주문/취소 거부**.
- → placeOrder/cancelOrder 바디에 `EXCG_ID_DVSN_CD="KRX"` 추가.

### 🟡 키움-1: 취소(kt10003) `stk_cd` 필수인데 빈 값 전송 (수정됨)
- 공식 가이드 + .NET 래퍼: kt10003 바디 `dmst_stex_tp` + `orig_ord_no` + **`stk_cd`(필수)** + `cncl_qty`.
- 어댑터는 `stk_cd: ""`(취소 시그니처에 symbol 없음) → 거부 가능. (Binance에서 잡았던 -1102 취소 symbol 누락과 동일 계열)
- → `cancelOrder(orderId, symbol?)`로 symbol 인자 추가, `stk_cd`에 채움. KIS cancel은 ORGN_ODNO 기준이라 symbol 불요(시그니처만 정합).

### 🔴 공통-1: KRW 봇에 USDT 기준 안전 캡 적용 버그 (수정됨)
- 직전 "라이브 친화" 작업의 `DEFAULT_LIVE_MAX_NOTIONAL`이 **USDT 기준 단일값**(50/100).
- 한투/키움은 **KRW** → 캡 50 = 50원 → 주식 1주(수만 원)도 notional 초과로 **전량 거부**(KR 거래 불가).
- → `safety.ts` `LIVE_DEFAULTS_BY_CCY`(USDT cap 100/서킷 50, KRW cap 150,000/서킷 75,000). `checkLimits(quoteCurrency)` 통화 인식. 러너가 broker→통화 전달(binance=USDT, kis/kiwoom=KRW). `enableLive`는 미지정 캡을 **저장 안 함**(통화별 기본이 적용되도록).

## 일치 확인된 부분(정상)

- **키움 주문 kt10000/10001**: `/api/dostk/ordr` + api-id 헤더 + 바디 `dmst_stex_tp/stk_cd/ord_qty/ord_uv/trde_tp`(0=지정가/3=시장가) — 공식과 **일치** ✓
- **키움 인증/헤더**: OAuth `secretkey` 필드, 데이터콜 authorization+api-id만(hashkey/custtype 없음), cont-yn/next-key 페이징 — 일치 ✓
- **KIS OAuth/hashkey/custtype 'P'**, order-cash 엔드포인트, ORD_DVSN(00 지정가/01 시장가), 잔고 tr_id — 일치 ✓
- **KIS 계좌 CANO-ACNT_PRDT_CD 분해, PDNO 6자리 정규화** — 일치 ✓

## 남은 한계(정직)

- ⏳ **모의서버 머니패스 E2E 미실시**: KIS 모의(openapivts 29443) / 키움 mockapi 로 실제 주문→체결→취소 검증해야 "작동 확정"(Binance는 testnet으로 실버그 6건 색출함). **모의투자 앱키/시크릿 필요**(채팅 미경유, `.env.local`).
- ⏳ **P0 상주 손절 미지원(KR)**: 거래소 상주 SL/TP는 Binance 전용. 한투/키움은 라이브 주문은 나가도 거래소 상주손절 없음 → 봇 다운 시 손절 공백. KR은 소프트스톱(봇 폴링) 또는 정정주문 기반 상주스톱 후속 과제.
- ⏳ **응답 필드 다중후보(`||`) 잔존**: 키움 잔고/보유 필드는 버전 편차 흡수용 다중후보 유지 → 모의 E2E로 실제 필드 확정 시 정리.
- ⏳ **정정(modify) 미구현**: 취소만. 정정(KIS RVSE_CNCL_DVSN_CD=01 / 키움 kt10002)은 후속.

## 결론

공식문서 대조로 **실제 거부를 유발할 치명 갭 3건(KIS tr_id·EXCG_ID, 키움 취소 stk_cd) + KRW 캡 버그**를 색출·수정. 이제 한투/키움은 **"현행 스펙 일치" 단계**. 다음 관문 = **모의서버 E2E**(키 주시면 Binance testnet과 동일 절차로 머니패스 확정).

## 키움 모의서버 E2E 검증 (2026-06-08) — 🟢 PASS, 추가 실버그 3건 색출·수정

키움 모의(mockapi.kiwoom.com) 키로 머니패스 E2E 실행 → **"스펙 일치"만으론 안 잡히는 런타임 버그 3건** 발견·수정 (Binance testnet과 동일 교훈: 실서버 안 돌리면 못 잡음).

- 🔴[키움-E2E-1] **getPrice가 0 반환**: `ka10004`는 현재가가 아니라 **주식호가(orderbook)** API라 `cur_prc` 필드 없음 → 최우선 매수/매도호가(`buy_fpr_bid`/`sel_fpr_bid`) mid를 현재가로 사용하도록 수정.
- 🔴[키움-E2E-2] **getPositions return_code=2**: `ka10072`는 `strt_dt`(시작일) 필수인 '일자별 실현손익'이라 보유종목 용도 부적합 → 보유종목은 **`kt00018`(계좌평가잔고)의 `acnt_evlt_remn_indv_tot` 배열**에 있음(잔고와 동일 응답). 그쪽 파싱으로 수정.
- 🔴[키움-E2E-3] **지정가 매수 return_code=20(RC4003 호가단위 오류)**: 지정가가 KRX 틱(200k~500k=500원)에 안 맞아 거부 → 어댑터에 `krxTick()`/`roundToKrxTick()` 추가, placeOrder가 지정가를 틱에 자동 정렬.

E2E 결과: 연결(토큰/잔고5억/현재가/보유) PASS + 주문(지정가 매수 접수 0100138 → kt10003+stk_cd 취소 → 미체결 확인) **4/4 PASS**. tsc0, vitest117.
검증 스크립트: `scripts/verify-kiwoom-mock-connection.ts`(읽기전용), `scripts/verify-kiwoom-mock-order-e2e.ts`(매수→취소).

**남은 한계**: 시장가 체결→보유종목 populate→매도 회수의 "체결 사이클"은 모의 시장시간/체결 시뮬 의존이라 미확정(지정가 접수+취소는 확정). 한투(KIS) 모의 E2E는 KIS 모의키 받으면 동일 절차. KR 상주손절(거래소 SL/TP)은 여전히 공백(소프트스톱 후속).

## KR 미체결 조회 tr_id 리서치 (2026-06-14, audit P1-10) — 엔드포인트·tr_id 확정 / 응답필드 E2E 대기

P1-10(KR 체결 즉시 reconcile)의 차단 요인이던 **미체결 조회 공식 tr_id를 공식 출처로 확정**. 단, 응답 필드명은 공식 문서에 미공개라 **모의 E2E 전 구현 보류**(키움 E2E-1/2/3 전례: 스펙만으론 런타임 버그 못 잡음).

### KIS — 정정취소가능주문조회 (미체결 = 정정/취소 가능 주문)
- **엔드포인트**: `GET /uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl`
- **tr_id**: 실전 `TTTC0084R` / 모의 `VTTC0084R`(V-prefix, 기존 TR_IDS 규약과 일치 — 단 모의값 E2E 확인 필요)
- **요청**: `CANO`, `ACNT_PRDT_CD`, `INQR_DVSN_1`(0=주문/1=종목), `INQR_DVSN_2`(0=전체/1=매도/2=매수), `CTX_AREA_FK100`, `CTX_AREA_NK100`(연속조회)
- **응답 output 필드**: 공식 LLM 예제에 미문서화(`odno`/`psbl_qty`/`ord_qty`/`pdno` 추정) → **E2E로 확정 필수**
- 출처: github.com/koreainvestment/open-trading-api `examples_llm/domestic_stock/inquire_psbl_rvsecncl`

### 키움 — 미체결요청
- **api-id**: `ka10075`(미체결요청), 보조 `ka10076`(체결요청). 경로는 계좌 조회 계열(`/api/dostk/acnt` 또는 `/api/dostk/ordr` 계열 — E2E 확인)
- **요청 바디(추정)**: `stk_cd`(종목, 선택), `trde_tp`(매매구분), `all_stk_tp`(전체/종목) — **필드명 E2E 확정 필요**
- **응답 배열 키(추정)**: `oso`(미체결) 등 — **E2E 확정 필요**
- 출처: openapi.kiwoom.com REST 가이드, github.com/younghwan91/kiwoom-rest-api(`unfilled_orders`), github.com/dongbin300/KiwoomRestApi.Net(`GetUnfilledOrdersAsync`)

### 판단(정직)
- **이번 세션 구현 안 함**: 엔드포인트/tr_id/요청은 확정이나 **응답 필드명 미확정** → 검증 안 된 파싱을 reconcile에 넣으면 키움 E2E-1/2/3과 동형 런타임 버그 위험(불변 원칙: KR 응답 스펙은 모의 E2E로 확정).
- **다음 단계**: KIS 모의키(`KIS_APPKEY/APPSECRET/ACCOUNT`) + 키움 모의키 확보 → `scripts/verify-kiwoom-mock-order-e2e.ts` 패턴으로 ka10075/inquire-psbl-rvsecncl 응답 필드 확정 → `getOpenOrders`(KR) 구현 → reconcileLivePosition KR 분기에 체결 즉시 확인 배선. 위 확정 스펙으로 요청부는 바로 작성 가능.
- **타입가드 점검 결과(정정)**: reconcileLivePosition의 `getOrderByClientId !== undefined` 가드는 **의도대로 정상**(Binance=보유→skip, KR=미보유→reconcile 진입). 역전 아님 — 변경 금지.
