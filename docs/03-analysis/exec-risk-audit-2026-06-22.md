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

## Batch 2 — reconcile/window cluster

### #9 [HIGH] (B) 윈도우스크롤 가드 — ✅ **수정 완료(Batch 2)**
진입봉이 300봉 윈도우 밖으로 밀린 장기보유에서 엔진 넷(윈도우만 본)을 잘못 신뢰 → 윈도우 안 buy+exit 사이클을 '청산'으로 오인해 전량 덤핑, 또는 라더 축소분을 풀자본 재진입으로 오인해 초과 재매수(둘 다 trades.length>0이라 기존 가드 미포착). **수정**: `openedAt`이 윈도우의 가장 오래된 봉보다 앞서면(=스크롤아웃) 엔진 넷 보류·보유 유지(SL/TP는 거래소 상주 스톱이 계속 보호). 결정적 판정(엔진은 항상 flat 시작이라 'first action=buy' 휴리스틱은 무용 → 시간 비교로 정확). backtest≡live 유지(라이브 한정 보수 가드, 진입봉 in-window면 정상 동작). 테스트 2. 근본해결=엔진 포지션 시드(P0-5, 후속). 스캐너도 동일 갭(현재 paper-only·라이브 거절)=후속.

### #4 [HIGH] reconcile 수동보유 오입양 — ⏸ **testnet/KR-mock 검증 게이트 후속(naive 캡 금지)**
reconcileLivePosition(KR)/forceReconcileOnUnknown(binance) adopt가 ledger 캡 없이 raw 거래소 수량 채택 → 사용자 수동보유 입양·매도 위험.
⚠️ **코드 검증 핵심 발견**: KR 시장가는 `pending`→fillOrder가 **동결(거래 미기록, fillOrder:186-189)** 하고, 봇이 자기 체결을 **reconcile adopt(ledger=0)로 인지**한다. 따라서 finding 제안의 naive `min(ledger,...)` 캡은 **KR 자기체결 인지 자체를 깨뜨린다**(KR 모의 E2E 회귀). binance forceReconcile은 자기체결이 즉시 기록(ledger>0)이라 캡이 안전하지만, KR은 **placed-but-pending 의도수량 추적기**(binance `pendingEntry` 유사)가 있어야 안전 → KR-mock E2E 검증 후 배선(P1-5와 동일 디시플린). 메인넷 OFF·KR 라이브 키 부재로 현재 latent.

### #5 [HIGH] Binance 진입 유령 + 봉롤오버 이중매수 — ⏸ **binance testnet 검증 게이트 후속**
buy-side unknown이 unknownCount 미증가(fresh entry는 담을 상태가 null) + Binance reconcile skip → 진입 유령 영구 + 다음 봉 다른 cid로 이중매수. 안전 수정=fresh-entry pending 마커 + 직전봉 cid 선조회(머니패스 라이브 변이 → testnet 검증 필요).

### #6 [HIGH] 상주 SL/TP 체결 Binance 미reconcile — ⏸ **binance testnet 검증 게이트 후속**
상주 STOP/TP 체결을 binance 봇이 인지 못함(reconcile skip) → 유령보유·미기록 손익·오버셀. 수정=protectiveIds 잔존 시 getOpenOrders/getPositions 폴링으로 체결 장부화 + 라이브 SELL을 거래소 free로 캡. #1 봇 OCO 라우팅과 함께 testnet 검증.

> **Batch 5 — fail-closed 디펜시브 부분 수정(키 불요·단위테스트)**: #4의 **binance forceReconcile adopt 근거 캡**(adoptQty=min(거래소, max(curQty,ledger)) → 수동보유 오입양 차단; binance는 자기체결을 즉시 장부 기록하므로 캡 안전. KR adopt는 pending→동결로 ledger=0 자기체결이라 동일 캡 적용 불가=KR pending-tracker 후속) + #5의 **fresh-entry 직전 봉 cid 선조회**(유령 입양→이중매수 차단). 둘 다 '더 보수적으로만' 동작하는 fail-closed 가드라 실거래소 거동 가정과 무관하게 안전 → 키 없이 적용·테스트(620 그린).
> ⏸ **잔여 active-mechanism(testnet/KR-mock 키 필요)**: #4 KR pending-order 추적기 · #5 fresh-entry buy-unknown 카운터+유령 회수 · #6 상주스톱 체결 폴링 reconcile + 라이브 SELL 거래소-free 캡 · #1 봇 OCO 라우팅(상주 TP 복원) · #20 TP intrabar 패리티(#1과 결합). 전부 **실거래소 거동 검증이 전제**(#2 오탐이 증명: 거래소 거동 가정은 틀릴 수 있다 → 새 active 메커니즘은 testnet 없이 배선 금지). 메인넷 OFF·키 부재로 latent.

## Batch 3 — MEDIUM

### ✅ #12 toss 인터벌 검증 — 수정 완료(Batch 3)
토스는 캔들 1m/1d만 지원 → 그 외 인터벌 봇은 러너 getCandles throw로 '러닝이지만 평가 불가'한 유령봇(페이퍼·라이브 공통). create_bot이 사전 거절 + 러너 getCandles try/catch 안전망(generic crash 대신 명시 hold). 테스트 3.

### ✅ Batch 4 — 안전 MEDIUM 3건 수정 완료
- **#15 getOpenOco 2-leg 검증**: read-back에서 정확히 2-leg + 양가격>0일 때만 유효 OCO 인정, 그 외 null(편다리/유령 OCO를 '보호됨' 오표시 → placeProtective 재보호 거절/silent 미보호 차단). fail-closed.
- **#16 protective coid 충돌내성**: 32비트 imul 해시 → sha256 앞 30자(120비트). fleet(한 계좌 다봇/심볼)에서 cross-bot 충돌(A의 cancel이 B 보호주문 취소=나체, 중복 cid 거부=편다리) 사실상 0. 결정적·거래소 한도 내. 테스트(봇/심볼별 cid 상이·결정적·charset).
- **#18 배너 broker-aware env**: liveSettingsStatus.env를 설정된 브로커별 env 합산으로(BINANCE_ENV 단독 → KR-only 메인넷 'testnet' 오표시 방지) + 배너 하드코딩 'USDT' 제거. 테스트.

### ⏸ 잔여 MEDIUM (latent/paper-only/opt-in — 현재 머니 노출 없음, 우선순위·키 따라 후속)
- **#22 킬스위치 스캐너 심볼맵 청산**: latent(스캐너 라이브 start_bot 거절로 도달 불가 — 방어적). #25 **스캐너 라이브 fill tx 원자화**: 스캐너 라이브 거절이라 paper-only(실손 무영향) + collect-then-commit 리팩토링 위험. 포트폴리오게이트 **is_paper/통화 필터**: opt-in(QUANT_MCP_PORTFOLIO_* 기본 OFF).
- **라이브변이/testnet 게이트**: #11 toss 세션게이트 · #14 트레일링 place-then-cancel · affordability 재확인 · #20 TP intrabar 패리티(백테 통계 이동→신중) · #13 toss US FX 사이징.

---

## 불변
메인넷 실거래 OFF 유지. 전 수정 backtest≡live·fail-closed 보존. 각 배치 tsc 0 + vitest 그린 후 커밋(author=eshurei 고정).
