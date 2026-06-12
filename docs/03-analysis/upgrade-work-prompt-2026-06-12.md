# quant-mcp 감사 기반 개선 업그레이드 작업 지시

> 사용법: 이 파일 전체를 새 Claude Code 세션에 붙여넣거나, "docs/03-analysis/upgrade-work-prompt-2026-06-12.md 읽고 그대로 수행해"라고 지시.
> 원본 감사: docs/03-analysis/full-audit-2026-06-12.md (2026-06-12, 적대적 검증 통과분)

## 0. 컨텍스트 로드 (작업 전 필수)

1. `docs/03-analysis/full-audit-2026-06-12.md` 전문을 읽어라 — 이 문서가 이번 작업의 **단일 진실 소스**다. P0 4건 / P1 24건 / 권장 실행 순서 Top 10이 정의되어 있다.
2. `docs/kr-broker-gap-analysis.md`, `docs/mainnet-pilot-runbook.md`, `docs/p0-execution-layer.md`를 참조 컨텍스트로 읽어라.
3. `.claude/context-save.md`로 직전 세션 상태를 확인하라.

## 1. 불변 원칙 (위반 시 작업 중단하고 보고)

- **fail-closed**: 모호하면 거절. 조용한 폴백/둔갑 금지. 새 코드도 이 원칙을 따른다.
- **안전경로 단일 관문**: 모든 주문은 `live-handlers.placeOrder`/`placeProtective` 경로만 경유. liveGate + checkLimits + portfolioGate + 2단계 토큰을 우회·재구현하는 코드 작성 금지.
- **backtest≡live 패리티**: 시그널/사이징 로직 변경 시 백테스트와 라이브가 같은 순수함수를 쓰는 구조를 유지. 한쪽만 고치면 패리티 위반 — 둘 다 고치거나 둘 다 거부.
- **정직성**: 미구현은 미구현이라고 명시(문서+코드 거절 메시지). 과장 문구 금지.
- **회귀 0**: 기존 364개 테스트는 항상 전부 통과. 동작 변경 시 해당 테스트도 의도적으로 갱신.
- 실거래 자금이 걸린 코드다. 확신 없는 변경은 하지 말고 질문하라.

## 2. 작업 스프린트 (순서 고정 — 효과/노력 기준, 감사 리포트 §8)

### Sprint 1 — KR 브로커 정직성 (P0-4, P0-3) [노력 낮음·효과 최대]
1. `roundToKrxTick`(kiwoom.ts:63~76)을 공용 모듈(예: `src/brokers/krx-tick.ts`)로 추출, `kis.ts` placeOrder의 ORD_UNPR(451,459)에 적용. 키움은 기존 동작 바이트 동일 유지.
2. KIS/키움 placeOrder가 protective 타입(stop_market/take_profit_market) 수신 시 **명시적으로 throw**(silent 지정가 둔갑 차단). runner의 syncBotProtective는 KR 브로커면 스킵+경고 1회 기록(틱마다 스팸 금지). 대시보드 OCO UI도 KR 종목이면 "미지원" 표시.
3. KIS 모의서버(openapivts:29443) E2E 스크립트: 토큰→잔고→시세→지정가 주문(틱 정렬 확인)→취소. `scripts/verify-kis-e2e.ts`로 작성 (키움 E2E 스크립트 패턴 재사용).

**완료 기준**: 틱 정렬 단위테스트(경계가격 표 기반) + KR protective 거절 테스트 + KIS E2E 5단계 PASS.

### Sprint 2 — 크래시 복구·영속성 (P0-1 + P1-7/8/21)
4. 기동 포지션 시드: tickBot 첫 호출 시 `position_state=null && mode=live`면 getPositions로 거래소 진실 복원(기존 adopt 로직 재사용). **gate-off(LIVE_TRADING_ENABLED=false) 재기동 시나리오 포함** — 게이트가 꺼져 있어도 조회(read-only)는 수행해 장부를 거래소에 수렴시킬 것.
5. SQLite: `journal_mode=WAL` + `synchronous=NORMAL`, position_state 3필드 갱신 트랜잭션 래핑, 주기 백업 함수.
6. peakEquity DB 영속+재시작 복원 (MDD 서킷 연속성).
7. 동일 심볼+브로커 다중 라이브 봇: ambiguous 감지 시 `setBotStatus('error')` 자동 정지 (경고만 금지).

**완료 기준**: "재시작+gate-off+state-null" 통합 테스트 신규 작성 + 기존 reconcile 테스트 전부 통과.

### Sprint 3 — 실행 견고성 (P1-1/2/3/4)
8. `brokers/base.ts`에 공통 재시도 레이어: 재시도 가능(429/5xx/타임아웃, Retry-After 존중, 지수백오프+상한) vs 불가(잔고부족/검증거부) 구분. **비멱등 주문 전송은 clientOrderId 멱등 보장 하에서만 재시도**.
9. 부분체결: OrderResult에 executedQty/origQty 분리, 체결 수량으로 장부 기록, 잔여 미체결분 자동 취소.
10. OCO 양다리 NEW/PENDING 검증, SL leg 실패 시 3틱 대기 없이 즉시 에스컬레이션.
11. getOrderByClientId 재조회 실패 시 지수백오프 재시도 → 누적 실패 시 강제 reconcile.

**완료 기준**: 각 항목 단위테스트 + testnet 머니패스 재실행 PASS.

### Sprint 4 — 24/7 운영 인프라 (P0-2 + P1-14/15/17)
12. MCP stdio와 분리된 headless 데몬 모드(`npm run daemon`): 러너+대시보드만 기동, MCP 클라이언트 없이 24/7 가동. + Dockerfile(restart:always) + 헬스체크 엔드포인트.
13. uncaughtException/unhandledRejection → 웹훅 경보 발사 후 안전 종료. 하트비트 미수신 경보.
14. Telegram 봇(양방향): /status /stop_all /forceexit — authorized chat id 화이트리스트 필수, forceexit은 기존 2단계 토큰 패턴 재사용. **새 주문 경로 만들지 말고 placeOrder 경유.**
15. 글로벌 킬스위치: `LIVE_TRADING_HALT` + emergencyShutdown(전 봇 정지, 옵션으로 포지션 청산).

**완료 기준**: 데몬 기동→봇 동작→프로세스 kill→Docker 자동재시작→포지션 시드 복원(Sprint 2 연계) 시나리오 검증.

### Sprint 5 — 관측성·거래 추적 UX (P1-16/18/19/20, 감사 리포트 §7 Phase 1)
16. MCP 도구 추가: `get_open_orders`, `get_order_status` (기존 브로커 메서드 노출만).
17. 대시보드 "주문/체결 내역" 탭: /api/trades (recentTrades 재사용), 기간 필터+수수료+체결가+손익.
18. 미체결 주문 패널: /api/orders 조회+개별 취소. 수동 지정가 확정 직후 이 패널로 안내.
19. 수동 주문 체결 알림: 주문 ID 추적 폴링 → 알림 피드+웹훅 체결 통지.

**완료 기준**: Playwright E2E(탭 렌더→내역 표시→미체결 취소 플로우), 콘솔 에러 0.

### Sprint 6 — 백테스트 정합 + 주문 입력 품질 (P1-11/12/13 + §7 Phase 2)
20. 라더 평단 패리티: evaluateLadderTick을 러너에 이식(또는 PositionState DB 영속 사용) + 교차 일치 테스트.
21. 손절 갭 처리: `gapHandling: 'close'|'worst'` 옵션 (기본 'close' 유지=기존 결과 불변) + 문서 명시.
22. weighted 노드: 라이브 게이트에서 명시 거절 (자본분할 실행 구현 전까지) — silent 병합 금지.
23. 수동주문 모달: 가용잔고/보유수량 표시 + 25/50/Max 버튼, 종목 자동완성(/api/symbols, Binance exchangeInfo 캐시+KR 종목마스터), 예상 수수료 표시, 보유 포지션 전량매도 원클릭.

**완료 기준**: 라더 패리티 교차 테스트 + Playwright E2E.

## 3. 작업 프로토콜 (모든 스프린트 공통)

- 스프린트 시작 시: 해당 항목의 리포트 근거(파일:라인)를 직접 Read로 재확인 후 착수 (감사 시점 이후 코드가 바뀌었을 수 있음).
- 스프린트 단위로: `tsc --noEmit` 0 에러 → `vitest run` 전체 PASS → 커밋+푸시 → `/save`.
- 커밋 메시지에 해당 감사 항목 번호 명시 (예: `fix(kis): KRX 호가단위 정렬 — audit P0-4`).
- 버그 수정마다 그 버그를 재현하는 테스트를 먼저/함께 추가 (재발 방지).
- Sprint 1~2 완료 시점과 Sprint 4 완료 시점에 중간 보고: 변경 요약 + 남은 리스크.
- 막히면 임의 우회하지 말고 현재 상태 커밋 후 질문. 특히 거래소 API 스펙이 불확실하면 공식 문서 확인 전 구현 금지 (키움 E2E에서 스펙만으로 못 잡은 런타임 버그 3건 전례).
- 전부 완료 후: 감사 리포트의 점수표를 기준으로 자체 재평가 → `docs/03-analysis/`에 개선 후 재감사 요약 작성 → README/CHANGELOG 정직하게 갱신 (과장 금지).

## 4. 명시적 제외 (이번 작업 범위 아님)

- 메인넷/KR 실계좌 실거래 투입 (P0 전부 해소 후 별도 승인 필요)
- 전략 마켓플레이스, hyperopt 파라미터 최적화, TradingView 인바운드 웹훅 (P3)
- 대시보드 파일 모듈 분리·라이트모드·a11y (P3 — 별도 세션)
- 스캐너 봇 라이브 reconcile (경고 명시만 추가, 구현은 후속)
