# 실행/리스크 머니패스 적대적 감사 (2026-06-22)

> 방법: 울트라코드 다중에이전트 감사(8 차원 병렬 색출). 3-렌즈 적대검증 단계는 서버측 일시 rate-limit으로 미완 →
> **각 발견을 메인루프에서 실제 코드로 직접 검증하며 수정**(adversarial-verify-as-you-fix). 26 발견 raw 보존.
> 스코프: 마지막 전체 감사(2026-06-12) 이후 30+커밋, 특히 한 번도 감사 안 된 **토스(KR+US) 머니패스**.
> 불변식: backtest≡live · fail-closed · testnet-게이트 · 메인넷 OFF.

## 요약

| 심각도 | 건수 | 처리 |
|---|---|---|
| CRITICAL | 1 | 1 수정(Batch 1) |
| HIGH | 8(고유 7) | 3 수정(B1) · 3 예정(B2) · 1 검증=오탐 |
| MEDIUM | 16(고유 ~13) | Batch 3(개별 재검증 후) |

핵심 성과: 적대검증을 코드로 직접 수행해 **오탐 1건(#2)을 색출** — 그대로 "수정"했으면 정상 동작(토스 US 소수주)을 깨뜨릴 뻔했다.

---

## Batch 1 — CRITICAL + HIGH (수정·테스트·커밋 완료)

### #1 [CRITICAL] 현물 SL+TP 동시 → 건강 포지션 비상 강제청산
- **원인**: `nextProtFails`(runner.ts)가 TP leg 실패까지 누적 → 현물에서 SL+TP를 동시에 걸면 TP 매도가 base 잔량 부족(-2010)으로 매 틱 실패 → protFails→MAX → `runner.ts:810` 비상 시장가 청산이 **SL이 정상인 건강한 포지션**에 발동.
- **수정**: 비상 청산 카운터를 **손절(SL) 부재(나체)만 추적**하도록 변경 — SL 정상 + 다른 leg(TP)만 실패 시 카운터 0(비상 금지). SL leg 실패 시는 종전대로 즉시 한도(나체 방지). 거래소 collision 여부와 무관하게 치명적 결과 제거.
- **후속(testnet 게이트)**: 봇 현물 보호주문을 네이티브 OCO(`placeOco`, 이미 manual 경로에 존재·하드닝됨)로 라우팅 → 거래소 상주 TP 복원. 라이브 변이라 testnet 검증 후 배선(프로젝트 정직 원칙).
- 테스트: live-fail-safety.test.ts `nextProtFails` 4케이스.

### #10 [HIGH·보안] /api/credentials가 2단계 게이트 우회해 메인넷 ARM
- **원인**: 대시보드 POST /api/credentials가 본문 문자열을 그대로 upsert → `LIVE_TRADING_ENABLED`/`LIVE_MAX_NOTIONAL`/allowlist/일일손실이 ALL_KEYS에 포함돼 설정됨. /api/live의 2단계 confirmToken + audit를 우회한 권한상승.
- **수정**: `sanitizeCredentialPost()` 순수헬퍼로 LIVE_SETTING_KEYS 드롭(브로커 자격증명·ENV·알림만 통과). 라이브 무장은 audit·confirm 강제하는 /api/live 전용.
- 테스트: credentials.test.ts 2케이스.

### #3 / #7 [HIGH] 일일손실 서킷 Toss 통화 이중계상 fail-open
- **원인**: `dailyRealizedLoss`가 toss 행을 USD·KRW 버킷 **양쪽**에 합산. pnl은 부호 있는 통화별 실수라 한 통화 '이익'이 다른 통화 '손실'을 가려 서킷 fail-OPEN(메인넷 보호 무력화), 반대로 오발화도.
- **수정**: toss 행을 심볼 통화(`isKrSymbol`, quoteCurrencyFor와 동일 단일 진실원)로 분리 합산 — KR→KRW, US→USD. fail-closed(조회실패 NEGATIVE_INFINITY) 유지.
- 테스트: safety.test.ts 통화분리 + US + **fail-open 회귀**(KR 이익이 USD 손실 안 가림).

### #17 [MED·안전] cancelOrderById가 liveGate 우회
- **원인**: 취소가 liveGate 없이 메인넷 실행(master OFF·LIVE_TRADING_HALT 킬스위치 중에도) → 상주 보호주문(SL/TP) 박탈 = 리스크 증가.
- **수정**: `cancelProtective`와 동일하게 `liveGate` 적용(2단계 토큰만 불요, HALT 절대 우회 금지).
- 테스트: live-fail-safety.test.ts HALT 차단 + 정상 취소.

### #2 [HIGH] → **검증 결과 오탐(FALSE POSITIVE)**
- 주장: US toss 봇이 소수 수량 전송 → Toss `^\d+$` 정수전용 거부 → 머니패스 불능.
- **반증**: `docs/03-analysis/toss-api/openapi.json:2713 fractionalQuantityUsMarketOnly` + 예시 `"quantity": "0.5"` — **US 시장가 소수주는 스펙이 명시 허용**. 어댑터 `fractionalOk = !kr && isMarket`는 정합. 코드 변경 없음(수정했으면 정상 기능 파괴).

---

## Batch 2 — HIGH 나머지 (reconcile/fill-flow, 진행 예정)

- **#4** reconcile 수동보유 오입양: reconcileLivePosition/forceReconcileOnUnknown adopt가 ledger 캡 없이 raw 거래소 수량 채택 → 사용자 수동보유 입양·매도. min(ledger/curQty) 캡. ⚠️ KR은 adopt가 자기 체결 인지 경로라 fillOrder 흐름 정밀 확인 후 적용.
- **#5** Binance 진입 유령 + 봉롤오버 이중매수: buy-side unknown이 unknownCount 미증가 + Binance reconcile skip + boot-seed ledger 의존 → 유령 영구 + 이중매수.
- **#6** 상주 SL/TP 체결 Binance 미reconcile: 유령보유·미기록 손익·오버셀. protectiveIds 잔존 시 reconcile 또는 getOpenOrders 폴링 + 매도 캡.
- **#9** (B) 윈도우스크롤 가드 부족(P0-5 interim): trades.length===0만 방어 → 장기보유(진입봉 300봉 밖)에서 윈도우 내 buy+exit 사이클 있으면 전량청산/재매수. 가드 확대 + 스캐너 가드.

## Batch 3 — MEDIUM (개별 재검증 후)

toss 세션게이트(#11)·toss 인터벌 검증(#12)·트레일링 place-then-cancel(#14)·getOpenOco 2-leg 검증(#15)·protective coid 충돌내성(#16)·affordability 재확인 fail-closed·포트폴리오게이트 is_paper/통화 필터(#runner4/#store24)·스캐너 intra-tick heat(#21)·스캐너 tx 원자성(#25)·킬스위치 스캐너맵(#22)·TP intrabar 패리티(#20)·배너 broker-aware env/통화(#18)·#13 toss US FX 사이징 footgun.

> 각 MEDIUM은 Batch 1의 #2처럼 코드로 재검증 후 진행(오탐/이미완화 가능). 다수가 opt-in(포트폴리오게이트) 또는 현재 미도달(스캐너 라이브 거절됨) = latent.

---

## 불변
메인넷 실거래 OFF 유지. 전 수정 backtest≡live·fail-closed 보존. 각 배치 tsc 0 + vitest 그린 후 커밋(author=eshurei 고정).
