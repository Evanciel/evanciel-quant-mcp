# quant-mcp 전체 감사 리포트 (Full Audit)

- **일자**: 2026-06-12
- **범위**: 10개 차원 (execution / risk / kr-broker / backtest / runner / mcp-design / dashboard-ux / security-ops / industry / trading-ux)
- **방법**: 차원별 감사 → 적대적 검증(adversarial verification) 통과분만 채택. 검증에서 기각된 항목은 부록에 기재.
- **포지셔닝 전제**: "리스크 필터, 알파 아님" — 실매매 전용 프로그램 관점에서 평가.

---

## 1. 총평 — 실매매 전용 프로그램 완성도: **65 / 100**

| 영역 | 점수 | 한 줄 평가 |
|---|---|---|
| 실행안전성 (Execution) | **78** | fail-closed·멱등 clientOrderId·2단계 토큰은 업계 상위권. 부분체결/429/OCO 양다리 검증 공백이 감점 요인. |
| 리스크 (Risk) | **75** | 3중 게이트(liveGate+checkLimits+portfolioGate)+MDD 디리스킹은 견고. peakEquity 영속성·동일심볼 다중봇 ambiguous 자동차단 부재가 감점. |
| KR 브로커 | **55** | 키움 모의 E2E 4/4 PASS·KRW 캡 버그 수정은 성과. 그러나 거래소 상주 SL/TP 부재, KIS 호가단위 미정렬(RC4003 예측 실패), KIS E2E 미실시로 실매매 준비도 미달. |
| 백테스트 정합성 | **80** | 시그널 패리티(동일 순수함수)+DSR/PSR+70/30 OOS는 비교 플랫폼 중 최상위. 라더 평단 추적 발산·갭 손절 모델 미명시가 감점. |
| 운영 (Ops/Runner) | **50** | **가장 취약**. 봇 생존이 MCP stdio 프로세스에 종속(24/7 무인가동 인프라 0), 원격 킬스위치 부재, 크래시 복구 타이밍 공백(P0-5). 라이브 자금 투입 전 필수 보강 영역. |
| UX (대시보드/트레이딩) | **60** | OCO 드래그·2단계 주문·실계정 패널은 차별화. 그러나 주문/체결 내역 화면 전무, 미체결 주문 관리 불가, 잔고/수량 프리셋 부재 — "주문은 되는데 추적이 안 되는" 상태. |

**종합 판단**: 리스크 가드 코어와 백테스트 정직성은 Freqtrade/NautilusTrader급 설계 사상을 갖췄으나, **"24/7 실전 운영" 레이어(데몬화·원격제어·주문 생명주기 추적)가 가장 큰 공백**이다. Binance testnet 머니패스는 검증됐지만, 메인넷·KR 실계좌 투입은 P0 4건 해소 전까지 보류 권고.

---

## 2. 강점 요약 (중복 제거)

### 실행·안전 아키텍처
- **fail-closed 일관 적용**: 형식 변형·미지 상태·체결 미확인 등 모호 상황에서 throw/거절 — 유령 주문·유령 포지션 적극 차단 (`src/brokers/*`, `src/runner/runner.ts`)
- **2단계 확인 토큰**: orderHash + confirmToken + 5분 TTL + 단일사용, 프리뷰 해시와 실행 입력 바인딩 (`src/brokers/safety.ts`)
- **3중 게이트 AND 결합**: liveGate(마스터스위치) + checkLimits(노셔널캡/allowlist/일일손실 서킷) + portfolioGate(heat/MDD) — 우회 불가
- **멱등 clientOrderId + reconcile/adopt**: 같은 봉 재시도 입양, 거래소 진실 수렴 (`src/core/execution/reconcile.ts`)
- **보호주문 멱등 동기화 + 연속실패 에스컬레이션**: PROTECTIVE_MAX_FAILS 도달 시 비상 청산 — 나체 포지션 장기 방치 금지
- **Zod 스키마 응답 검증**: 미지 상태/부재 필드 throw, silent NaN 차단

### 백테스트·리서치
- **backtest≡live 시그널 패리티**: evaluateCondition/openPosition/evaluateLadderTick 등 동일 순수함수 공용 (`src/core/backtest/engine.ts`)
- **DSR/PSR/MinTRL 완전 구현 + 70/30 OOS 게이트**: 비교 대상 6개 플랫폼 중 어디에도 없는 과적합 필터 차별화
- **MTF lookahead-0**: 상위TF 전방채움, 닫힌 봉만 노출, 레짐 휘프소 방어
- **보수적 슬리피지**: 항상 불리한 방향으로 계산

### 보안·운영 기조
- **시크릿 zero-echo**: 토큰 미반환·미로깅·마스킹, 자격증명 화이트리스트 + 제어문자 거부
- **웹훅 SSRF 게이트**: https-only/호스트 화이트리스트/IP·비표준포트 거절/리다이렉트 차단
- **대시보드 CSRF 이중 방어**: SameSite=Lax + Origin 포트 정밀검사, 127.0.0.1 바인딩
- **감사로그 append-only JSONL** + 실패 카운터 노출

### KR 브로커·UX
- **KRX 호가단위 자동 정렬(키움)** + 공식문서 대조로 tr_id/EXCG_ID_DVSN_CD 갭 사전 색출, KRW 통화별 안전 캡 분기
- **키움 모의서버 E2E 4/4 PASS** (실버그 3건 발견·수정)
- **차트-OCO 연동 UI**: 익절/손절 선 드래그 조정 — 토스·업비트에도 없는 수준
- **MCP 네이티브 + 페이퍼 우선 + 키리스 진입장벽 0**: 6개 비교 플랫폼 모두 없는 고유 카테고리
- **테스트 364개 + 테스트넷 머니패스 검증**

---

## 3. P0 — 실자금 위험 (즉시)

### P0-1. 엔진 포지션 상태 기동 시드 공백 — 크래시 복구 타이밍·게이트 의존 갭
- **근거**: `src/runner/runner.ts:288~364`, `src/mcp-server/index.ts:180`, `docs/p0-execution-layer.md`
- **내용**: fillOrder 성공 ↔ setBotPositionState 사이 크래시 시 DB position_state=null인데 거래소엔 실포지션 존재. reconcileLivePosition이 복원하지만 **LIVE_TRADING_ENABLED=false로 재기동하면 liveAdapterFor가 null → reconcile 자체가 스킵**되어 발산 상태(거래소=실보유, 장부=0, 손절 없음)가 게이트 재활성화까지 지속. "재시작+gate-on+state-null" 시나리오 테스트도 부재.
- **권고**: tickBot 첫 호출 시 position_state=null && mode=live면 getPositions로 거래소 진실 복원(adopt 로직 재사용). fill 직후 state 영속을 같은 단위로 묶고, 재시작 복원 통합 테스트 추가.

### P0-2. 24/7 무인 가동 인프라 부재 — 봇 생존이 MCP stdio 프로세스에 종속 (라이브 기준 CRITICAL)
- **근거**: `src/mcp-server/index.ts:177~182`, `src/runner/runner.ts:731~750`, Dockerfile 부재
- **내용**: Claude/Cursor 클라이언트가 stdio 프로세스를 살려둬야 봇이 돈다. 크래시 자동재시작·하트비트·죽음 알림 0. Freqtrade/Hummingbot/Jesse는 Docker 상시가동 전제, 3Commas는 클라우드 호스팅이 제품. 거래소 상주 SL/TP(Binance)가 부분 완충하나 KR 브로커는 그마저 없음(P0-3과 결합 시 치명).
- **권고**: MCP와 분리된 headless runner 데몬 모드(`npm run daemon`) + Dockerfile + restart:always + 하트비트 미수신 웹훅 경보. **라이브 자금 투입 전 필수**.

### P0-3. KR 실매매 상주 손절(거래소 SL/TP) 미지원 — 봇 다운 시 손절 공백
- **근거**: `src/brokers/kis.ts:449`, `src/brokers/kiwoom.ts:424`, `docs/kr-broker-gap-analysis.md:47`, `docs/mainnet-pilot-runbook.md:89`
- **내용**: KIS/키움 placeOrder는 stop_market/take_profit_market을 일반 지정가로 취급. runner는 브로커 구분 없이 syncBotProtective를 호출 → KR에서 보호주문이 **조용히 일반 주문으로 둔갑**. 봇 크래시 시 포지션 무방비(문서엔 정직하게 명시됨 — 숨은 버그가 아닌 인지된 아키텍처 한계).
- **권고**: KR 브로커에서 protective 타입 수신 시 명시적 거절+경고(silent 둔갑 금지). 소프트스톱(봇 폴링 손절) 구현 전까지 KR 라이브는 모의 한정. 장기: 정정주문 기반 상주스톱.

### P0-4. KIS 호가단위(KRX tick) 미정렬 — 지정가 주문 예측 가능한 RC4003 거부
- **근거**: `src/brokers/kis.ts:451,459` (ORD_UNPR 직송), `src/brokers/kiwoom.ts:63~76,432` (roundToKrxTick 키움 전용)
- **내용**: roundToKrxTick이 kiwoom.ts에만 존재. KIS 지정가는 틱 미정렬 가격이 그대로 전송 → 실매매에서 RC4003 거부로 주문 실패가 **예측 가능하게** 발생. live-handlers·safety 어디에도 사전 검증 없음.
- **권고**: roundToKrxTick을 공용 모듈로 추출해 kis.ts placeOrder에 적용. KIS 모의서버(openapivts 29443) E2E(토큰→잔고→시세→주문→취소)도 함께 완료할 것(키움 E2E에서 스펙만으로 못 잡는 런타임 버그 3건이 나온 전례).

---

## 4. P1 — 실매매 신뢰성 핵심

### 주문 실행·생명주기
| # | 항목 | 근거 | 권고 |
|---|---|---|---|
| 1 | **PARTIALLY_FILLED 처리 공백** — fillOrder가 filledQty를 반환하지만 호출부는 의도 수량(actualWantQty)으로 장부 기록. 잔여 미체결분 자동취소 로직 0 → 고아 지정가 잔존 가능 | `src/brokers/binance.ts:51,356~361`, `src/runner/runner.ts:569` | OrderResult에 executedQty/origQty 분리 노출, 부분체결 시 잔여분 취소 또는 filledQty로 장부 기록 |
| 2 | **getOrderByClientId 재조회 실패 시 unknown 동결만** — placeOrder+재조회 동시 실패 지속 시 장부-거래소 발산, 백오프 재시도 없음 | `src/runner/runner.ts:113~183` | 지수백오프 재시도 또는 unknown 누적 카운트 → 강제 reconcile 수렴 |
| 3 | **429 레이트리밋 무처리** — Retry-After/X-MBX-RateLimit 헤더 파싱·백오프·토큰버킷 전무 (Kiwoom/KIS는 4s 캐시로 완충, Binance는 무방비) | `src/brokers/binance.ts:236~266` | brokers/base.ts 공통 레이어: 재시도 가능(429/5xx/타임아웃) vs 불가(잔고부족) 구분 + 지수백오프 |
| 4 | **OCO 양다리 상태 미검증 + 보호주문 부분 성공 허용** — placeOco 응답이 2-leg 구조만 확인, SL 실패+TP 성공 시 일시 나체 노출(3틱 에스컬레이션이 상한) | `src/mcp-server/live-handlers.ts:119~161`, `src/core/execution/protective.ts:110` | 양다리 NEW/PENDING 확인, SL 누락 시 즉시 에스컬레이션(3틱 대기 금지) |
| 5 | **라이브 진입 시장가 전용** — limit/post-only/슬리피지 캡 없음 (Roadmap에 인지된 한계) | `src/runner/runner.ts:129`, README:294 | limit-or-cancel(타임아웃 후 시장가 폴백) + 슬리피지 % 캡을 전략 스키마 execution 노드로 |

### 리스크·정합성
| # | 항목 | 근거 | 권고 |
|---|---|---|---|
| 6 | **일일손실 한도 통화 인식 불완전** — 명시 설정 시 단일 숫자가 전 통화에 적용(KRW+USDT 합산 비교) | `src/brokers/safety.ts:62~89,229` | LIVE_DAILY_LOSS_LIMIT_USDT/_KRW 분리 또는 통화별 집계 |
| 7 | **MDD 서킷 peakEquity 비영속 + 미실현손익 미포함** — 봇 재시작 시 peak 리셋, mark-to-market 제외(보수적이긴 함) | `src/runner/runner.ts:371~412`, `src/core/risk/portfolio.ts:19` | peakEquity DB 영속 + 재시작 복원, 미실현 포함 옵션 |
| 8 | **동일 심볼 다중 라이브 봇 ambiguous 시 경고만** — 자동 pause 없이 다음 틱 매수 가능 | `src/runner/runner.ts:314~320` | UNIQUE(symbol,broker) 제약 + ambiguous 감지 시 setBotStatus('error') |
| 9 | **PROTECTIVE_MAX_FAILS=3 하드코딩** — interval 60s면 최대 180초 나체 노출, env 조정 불가 | `src/runner/runner.ts:26~27,504~518` | LIVE_PROTECTIVE_FAIL_LIMIT env화 + 실패 원인별 차등(네트워크=백오프, 거부=즉시) |
| 10 | **KR 체결 clientId 즉시 reconcile 미구현** — 포지션 폴링(~4s)만으로 보완, 그 사이 발산 창 존재 | `docs/mainnet-pilot-runbook.md:89,91` | cancelOrderByClientId 등 KR reconcile 메서드 구현, 주문 후 체결확인 운영 절차 명문화 |

### 백테스트 정합성
| # | 항목 | 근거 | 권고 |
|---|---|---|---|
| 11 | **라더 모드 평단 추적 발산** — 백테는 PositionState.entryAvg를 틱마다 갱신, 라이브는 derivePosition(trades) 무상태 도출 → 다단 스케일인+부분 익절 시 평단/PnL 귀속 발산 | `engine.ts:858~881` vs `runner.ts:485~486` | evaluateLadderTick을 러너에 이식하거나 PositionState를 DB 영속 후 사용 |
| 12 | **손절이 close 기준만 평가** — 갭다운/플래시크래시 시 백테=close 손실, 실거래(상주 STOP_MARKET)=low 체결 → 실측 발산 | `engine.ts:162~194,786`, `ladder.ts:143` | gapHandling: 'close'\|'worst' 옵션 또는 한계 명시 주석 |
| 13 | **weighted 노드 라이브 자본분할 미구현** — 백테는 자식별 자본 분할, 라이브는 단일 병합 포지션으로 실행(검증·거부 없음) | `engine.ts:640~649`, `runner.ts` derivePosition | 라이브 게이트에서 weighted 거부 또는 자본분할 실행 구현 + 문서화 |

### 운영·관측성
| # | 항목 | 근거 | 권고 |
|---|---|---|---|
| 14 | **원격 킬스위치/강제청산 채널 부재** — Telegram 0건, 웹훅은 발신 전용, 대시보드는 localhost. 외출 중 비상 대응 불가 (KR 상주손절 부재와 결합 시 치명) | `src/core/alerts/webhook.ts` | Telegram bot(/status /stop /forceexit) + authorized chat id 화이트리스트, 기존 two-step-token 재사용 |
| 15 | **러너 크래시/예외 push 알림 부재** — tickBot 에러는 DB 로그만, uncaughtException 핸들러 없음(pull 방식 의존) | `src/runner/runner.ts:741`, `index.ts:182` | 미처리 예외 → 웹훅 발사, 워치독 타이머, 헬스체크 엔드포인트 |
| 16 | **MCP 주문 역쿼리 도구 부재** — getOpenOrders/getOrderByClientId 구현돼 있으나 MCP 미노출 → 에이전트가 체결 재확인 불가 | `src/mcp-server/index.ts:145~167`, `src/brokers/types.ts:81~84` | get_open_orders / get_order_status 도구 추가 |
| 17 | **글로벌 킬스위치 부재** — shutdown()은 타이머 정지만, LIVE_TRADING_ENABLED=false도 기존 포지션 미정리 | `src/runner/runner.ts:750` | emergencyShutdown(closePositions) + LIVE_TRADING_HALT 플래그 |

### 대시보드·트레이딩 UX (실매매 신뢰성 직결분)
| # | 항목 | 근거 | 권고 |
|---|---|---|---|
| 18 | **주문/체결 내역 화면 전무** — recentTrades(50)가 store에 있으나 대시보드 미호출. 수수료/체결가/슬리피지 감사 불가 | `src/dashboard/server.ts` (15개 API 중 trade history 0) | /api/trades + '주문/체결 내역' 탭(기간 필터·수수료·손익) |
| 19 | **미체결 주문 목록·취소 UI/API 부재** — getOpenOrders 구현돼 있으나 미노출, 취소는 OCO 전용. 지정가 주문 후 외부 거래소 앱 필요 | `server.ts:744~801`, `binance.ts:646` | /api/orders 조회+취소 패널 (Binance Open Orders 탭 수준) |
| 20 | **수동 지정가 체결 추적/알림 부재** — 주문번호 표시 후 끝, 체결 여부 통지 0 | `server.ts:1363`, alerts는 봇 이벤트 전용 | 수동 주문 ID 저장 → 폴링/user-data stream → SSE+웹훅 체결 통지 |

### 데이터·인프라
| # | 항목 | 근거 | 권고 |
|---|---|---|---|
| 21 | **SQLite WAL/트랜잭션/백업 부재** — PRAGMA 설정 0, position_state 3필드 비원자 갱신, 백업 함수 0 | `src/store/db.ts:6~77,127~131` | journal_mode=WAL + synchronous=NORMAL, 트랜잭션 래핑, 주기 백업 |
| 22 | **캔들 재시도/간극 감지 부재 + KR interval 침묵 불일치** — fetchKlines 단발 실패, 페이지네이션 중단 시 부분 데이터 통과, KR 봇에 5m 설정해도 일봉 반환(경고 없음) | `runner.ts:451~461`, `binance-public.ts:42~52` | 백오프 재시도, 타임스탬프 간극 경보, KR interval 검증 거절 |
| 23 | **스캐너 봇 reconcile 미적용** — 멀티심볼 라이브에서 부분 체결 시 가짜보유 잔존(인지된 후속 과제) | `runner.ts:641~643` | 심볼맵 reconcile 구현 전까지 스캐너 라이브 비권장 명시+경고 |
| 24 | **세션 쿠키 포트 비스코프 + 감사로그 실패 시 거래 지속** — 코드 내 주석으로는 문서화됐으나 SECURITY.md/SETUP-LIVE.md 미반영, auditFailureCount 모니터링 부재 | `server.ts:559,570`, `safety.ts:192~206` | "다중 사용자 호스트 부적합" 운영 문서 명시, AUDIT_FAILURE_HALT 옵션 또는 헬스 위젯 |

---

## 5. P2/P3 — 개선·폴리시

| 차원 | 항목 | 근거 | 핵심 권고 |
|---|---|---|---|
| execution | recvWindow/시계 drift 미보정 (-1021 진단 불가) | `binance.ts:246` | serverTime drift 측정·보정 |
| execution | clientOrderId 충돌 edge case (barIso NaN 시 초단위) | `runner.ts:109~111` | 해시 기반 생성 또는 barIso 강제 |
| execution | pending 지정가 최대 대기시간 정책 부재 | `binance.ts` | N분 경과 자동취소 + 주기 점검 |
| execution | 주문 경로 WS 미사용(폴링 시세) — 슬리피지 갭 | `runner.ts`, `live-handlers.ts:55` | 시세 신선도 로깅, user-data stream 구독 |
| risk | 포트폴리오 합산 노셔널 캡 부재(주문 단위만) | `safety.ts:76~91` | 진입 후 총 노셔널 vs 캡 비교 |
| risk | 선물 maxLeverage 기본 20× 고정(거래소 한도 미조회) | `sizing.ts:171~193` | 심볼별 한도 조회·캐시 |
| risk (P3) | 일일손실 KST 고정 경계 — Binance UTC와 9h 어긋남 | `safety.ts:215~225` | 브로커별 경계 offset 분리 |
| kr-broker | KIS/키움 getOpenOrders·정정(modify) 미구현 | `types.ts:81`, gap-analysis:49 | 미체결 조회 API 구현, 정정은 cancel+re-place로 후순위 |
| kr-broker | 시세 출처 차이(키움=호가 mid, KIS=체결가) 미문서화 | `kiwoom.ts:336~352` | 문서화 + 슬리피지 마진 권고 |
| backtest | 슬리피지 고정값(스프레드/볼륨 임팩트 미반영) | `engine.ts:209` | 동적 추정 옵션 (보수적이라 급하지 않음) |
| backtest | DSR fat-tail kurtosis 과대 추정 경고 미기술 | `deflated-sharpe.ts:87~98` | 주석+robust 추정 옵션 |
| backtest | 숏/롱 엔진 신호 스왑 발산 위험, NaN 워밍업 침묵 | `short-engine.ts`, `indicators.ts` | 교차 일치 테스트, 워밍업 메타 경고 |
| mcp-design | symbol regex 검증 불일치(create_bot만 엄격) | `schemas.ts` | 전 symbol 필드 regex 통일 |
| mcp-design | universe/candidates 배열 무상한, 페이지네이션 부재 | `index.ts:85~89` | max(100) + limit/offset |
| mcp-design | 도구 설명-스키마 불일치(MTF), 구조화 에러 부재 | `index.ts:33,51` | actionRequired 필드 등 structured error |
| mcp-design (P3) | 도구 개수 주석 불일치(8 vs 25) | `index.ts:2,184` | 상수화 + 테스트 검증 |
| dashboard | 종목 자동완성 부재, 미리보기 호가/잔고/수수료 미표시, 전량매도 버튼 부재 | `server.ts:1307~1353` | §7 로드맵 참조 |
| dashboard (P3) | 1500줄 단일파일, KR 20s 폴링, 모바일 터치/반응형, 다크모드 강제, a11y | `server.ts` 전반 | §7 로드맵 참조 |
| security-ops | SPOF 단일 프로세스, 토큰 TTL 5분 고지, credentials 응답 rejected 피드백, dailyRealizedLoss catch{0} fail-open, 의존성 audit 자동화 부재 | `safety.ts`, `package.json` | supervisor, 운영 가이드 명시, npm audit CI |
| industry (P3) | 인바운드 시그널(TradingView 웹훅) 불가, 전략 갤러리 부재, 모바일 접근성 | `webhook.ts`, `examples/` | HMAC 인바운드(페이퍼 전용), 전략 JSON 갤러리+import/export |

---

## 6. 업계 비교 갭 (딥리서치)

| 갭 | quant-mcp 현재 | 업계 표준 | 출처 |
|---|---|---|---|
| 주문 재시도/백오프 | 0건 (단발 실패) | Freqtrade emergency_exit 폴백·재시도, NautilusTrader 실행엔진 재시도+reconciliation 표준 | freqtrade.io/en/stable/stoploss/, nautilustrader.io/docs/latest/concepts/live/ |
| 지정가/실행 옵션 | 봇 진입 시장가 전용 | Freqtrade entry/exit pricing+limit 기본, Hummingbot order_refresh 지정가 갱신이 핵심 | freqtrade.io/en/stable/configuration/, hummingbot.org |
| 24/7 인프라 | Docker/데몬/워치독 0 | Freqtrade·Hummingbot·Jesse 모두 Docker 공식 배포, 3Commas는 클라우드 호스팅 자체가 제품 | hummingbot.org/docs/, jesse.trade, 3commas.io |
| 원격 양방향 제어 | 웹훅 발신 전용 | Freqtrade Telegram /stopentry·/forceexit·authorized_users, Hummingbot kill switch | freqtrade.io/en/stable/telegram-usage/, hummingbot.org/client/global-configs/kill-switch/ |
| 거래소 WS user-data | REST 폴링 전용 | NautilusTrader/Hummingbot/Freqtrade 모두 WS 시세+체결 스트림 표준 | nautilustrader.io/docs/latest/concepts/live/ |
| 백테스트 시각화 | JSON 지표만 | FreqUI backtesting view, Freqtrade 드로다운 하이라이트, Jesse 인터랙티브 차트 | freqtrade.io/en/develop/freq-ui/, freqtrade.io/en/stable/plotting/ |
| 파라미터 최적화 | 수동 반복 의존 | Freqtrade hyperopt, Jesse optimize+benchmark | freqtrade.io, docs.jesse.trade |
| 미체결 주문 관리 UI | 부재 | Binance Open Orders 탭(Cancel/Cancel All), 국내 MTS 일괄정정/취소 기본 화면 | binance.com/en/support/faq/c0669862…, hygood.co.kr MTS 매뉴얼 |
| 주문 폼 잔고/% 프리셋 | free-text만 | Binance 25/50/100% 슬라이더, 키움 주문가능금액 추정 | binance.com FAQ, download.kiwoom.com/hero4_help_new/0304.htm |
| 체결 푸시 알림 | 봇 이벤트만 | 토스증권 체결 푸시, 키움 캐치(KATCH) 체결 통지 | download.kiwoom.com/hero4_help_new/4003.htm |

**역으로, quant-mcp만의 고유 우위**: ① DSR/PSR+OOS 과적합 필터(6개 플랫폼 모두 없음) ② MCP 네이티브 에이전트 전략 조립 ③ backtest≡live 동일 순수함수 패리티 ④ 리테일 봇 평균을 상회하는 보안 기조(SSRF 게이트, two-step-token, 출금권한-OFF 프리플라이트).

---

## 7. UI/UX 개선 로드맵 (대시보드)

### Phase 1 — 거래 신뢰성 (P1, 즉시)
1. **주문/체결 내역 탭**: /api/trades 신설, 봇별·전체·기간 필터, 수수료/체결가/손익 열 (`server.ts` — recentTrades(50) 재사용)
2. **미체결 주문 패널**: /api/orders 조회+개별 취소, 지정가 확정 직후 이 패널로 안내
3. **수동 주문 체결 알림**: 주문 ID 추적 → SSE 알림 피드 + 웹훅 '체결 완료'

### Phase 2 — 주문 입력 품질 (P2)
4. **잔고/보유수량 표시 + 10/25/50/Max 버튼**: 모달 오픈 시 getAccount 페치, 매도 초과 입력 즉시 경고
5. **종목 자동완성**: /api/symbols?q= (Binance exchangeInfo 캐시 + KR 종목마스터), 선택 전 미리보기 비활성화
6. **미리보기 강화**: 예상 수수료(Binance taker/maker, KR 위탁+거래세)·순 체결예상금액·현재가 대비 % 힌트
7. **전량 매도 원클릭**: posRow에 보유수량 프리필+시장가 기본으로 2단계 모달 진입
8. **간이 호가**: 최소안 — 현재가·등락률 실시간 표시(토스식), 확장안 — depth5 5호가 탭하면 지정가 자동입력

### Phase 3 — 정보 구조·운영 (P2~P3)
9. **포지션 테이블화 + 정렬**: 종목/진입가/현재가/수익률 열, 손익률·시간순 정렬, 브로커별 요약 카드
10. **에러 UI**: 재시도 버튼, SSE 자동 재연결(지수백오프), critical 알림에 액션 제공
11. **위험 포지션 경고 패널**: 보호주문 탈락(손절 없음) 빨간 경고 + 종목 중복(ambiguous) 시각화

### Phase 4 — 폴리시 (P3)
12. KR 차트 폴링 20s→5~10s, 백테스트 결과 탭(에쿼티 커브+underwater+거래 마커), 터치 이벤트/반응형, 다크·라이트 토글, ARIA/a11y, 파일 모듈 분리(handlers/ui/services)

---

## 8. 권장 실행 순서 Top 10 (효과/노력)

| 순위 | 작업 | 근거 항목 | 효과 | 노력 |
|---|---|---|---|---|
| 1 | **KIS 호가단위 정렬** — roundToKrxTick 공용화 + kis.ts 적용 | P0-4 | 매우 높음 (예측 가능한 주문 실패 제거) | 낮음 (기존 함수 이식) |
| 2 | **KR 보호주문 silent 둔갑 차단** — KR 어댑터에서 protective 타입 명시 거절+경고 | P0-3 | 매우 높음 (가짜 안전감 제거) | 낮음 |
| 3 | **P0-5 기동 시드** — state-null+live 시 거래소 진실 복원, gate-off 시나리오 포함 + 테스트 | P0-1 | 매우 높음 (크래시 복구) | 중간 |
| 4 | **공통 재시도/백오프 레이어** — 429/5xx/타임아웃 멱등 재시도 (brokers/base.ts) | P1-3, industry | 높음 (모든 브로커 일괄 수혜) | 중간 |
| 5 | **헤드리스 데몬 + Docker** — npm run daemon, restart:always, 하트비트 경보 | P0-2 | 매우 높음 (24/7 전제조건) | 중간~높음 |
| 6 | **Telegram 원격 제어** — /status /stop /forceexit + chat id 화이트리스트 | P1-14 | 높음 (모바일 알림+킬스위치 동시 해결) | 중간 |
| 7 | **부분체결 처리** — executedQty 장부 반영 + 잔여분 취소 | P1-1 | 높음 | 중간 |
| 8 | **MCP 주문 역쿼리 + 대시보드 미체결/체결내역** — get_open_orders, /api/trades, /api/orders | P1-16,18,19 | 높음 (관측성 일괄) | 중간 |
| 9 | **SQLite WAL+트랜잭션+백업 / peakEquity 영속 / ambiguous 자동 pause** — 영속성 3종 묶음 | P1-7,8,21 | 중간~높음 | 낮음~중간 |
| 10 | **KIS 모의 E2E + 라더 평단 패리티 테스트** — openapivts 머니패스 5단계, evaluateLadderTick 러너 이식 검증 | P1-10,11, P0-4 후속 | 중간 (KR 실매매·백테 정직성 마감) | 중간 |

> 1~3번(노력 낮음·효과 최대)을 먼저 끝내면 KR 브로커가 "조용히 틀리는" 상태에서 "정직하게 거절하는" 상태로 바뀐다. 4~6번이 끝나야 메인넷 무인 운영의 전제가 성립한다.

---

## 부록 — 적대적 검증에서 오탐으로 기각된 항목

- **[security-ops] 자격증명 평문 저장 및 환경변수 메모리 노출**: 평문 저장 자체는 사실이나, 코드 전반에 자격증명 로깅/직렬화 0건·CLI 키입력 마스킹·에러 메시지 시크릿 제외 등 선언된 배포 모델(로컬 단일 사용자) 기준 완화가 충분해 위험 과장으로 기각. (잔여 개선점: 브로커 인스턴스 메모리 키 와이핑 — `kis.ts:162~163`, `binance.ts:214~219`)

*그 외 9개 차원에서는 기각 항목 없음 — 전 확정 항목이 검증 통과(다수는 severity 하향 조정 반영됨).*
