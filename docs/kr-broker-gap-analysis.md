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
