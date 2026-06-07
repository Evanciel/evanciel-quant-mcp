# 라이브 거래 셋업 가이드 (BYOK)

> **핵심 안전 원칙**: 키를 넣으면 **testnet/mock은 즉시 거래(가짜돈)**, **메인넷(실돈)은 추가로 마스터 스위치 + 주문별 2단계 확인**이 필요합니다. 아무 설정도 안 하면 **전부 페이퍼**(가짜돈)로 안전하게 작동합니다.

키는 **환경변수로만** 주입합니다. **MCP 설정 JSON이나 채팅에 키를 절대 붙여넣지 마세요** (평문 노출 위험). `.env` 파일은 gitignore + `chmod 600` 권장, 또는 시크릿 매니저(1Password `op run`, Infisical, Doppler) 경유.

`live_status` 툴로 현재 무엇이 설정됐는지 언제든 확인할 수 있습니다(키는 노출 안 됨).

> **✅ 검증 상태 (2026-06-08)**: 머니패스가 **Binance testnet에서 E2E 검증 완료** — 봇 진입 시 거래소에 **상주 손절/익절(STOP/TP) 주문 자동 배치**(봇이 죽어도 거래소가 손절 보호), 트레일링 갱신, 청산 시 자동 취소(고아주문 0), 모호한 실패 시 체결 reconcile(중복주문 방지), 실잔고 기반 사이징(잔고초과 예방), 가격/수량 거래소 필터 정규화. 검증 스크립트: `scripts/verify-testnet-{connection,order-e2e,bot-e2e}.ts`. 상주주문 점검/정리: `scripts/testnet-cleanup-orders.ts`.

---

## 0. 페이퍼 (기본, 키 0개) — 이미 작동
키 없이 `save_strategy → create_bot(mode=paper) → start_bot → open_dashboard`. 가짜돈으로 전략을 안전하게 굴려봅니다.

## 1. 라이브 — Binance **testnet** (가짜돈, 즉시 거래)
1. **현물 testnet 키**: https://testnet.binance.vision (GitHub 로그인) → API Key/Secret 발급
2. **선물 testnet 키**(별개!): https://testnet.binancefuture.com → 별도 발급 (현물 키와 **호환 안 됨**)
3. 환경변수 설정 (예: `.env` 또는 MCP 클라이언트 env):
   ```bash
   BINANCE_ENV=testnet                 # 기본값이라 생략 가능
   BINANCE_API_KEY=<현물 testnet key>
   BINANCE_API_SECRET=<현물 testnet secret>
   BINANCE_FUTURES_API_KEY=<선물 testnet key>      # 선물 봇 쓸 때
   BINANCE_FUTURES_API_SECRET=<선물 testnet secret>
   ```
4. `create_bot(mode=live)` → `start_bot` → **testnet에서 즉시 실주문**. `get_balance`/`get_positions`로 실잔고 확인.
   - (`live_status`가 `binance testnet` allowed로 떠야 정상)

## 2. 라이브 — Binance **메인넷** (실돈! 신중히)
> ⚠️ testnet에서 충분히 검증한 뒤에만. 처음엔 **소액 1건 파일럿**.
1. **메인넷 키 발급** (binance.com): **반드시 [출금] 권한 OFF**, **IP 화이트리스트** 설정(봇 돌리는 PC IP). 거래 권한만.
2. 환경변수:
   ```bash
   BINANCE_ENV=live
   BINANCE_API_KEY=<메인넷 key>
   BINANCE_API_SECRET=<메인넷 secret>
   LIVE_TRADING_ENABLED=true           # ★ 마스터 스위치 — 이게 없으면 메인넷 차단(페이퍼 폴백)
   LIVE_MAX_NOTIONAL=200               # 주문당 최대 금액(USDT) — 사고 방지
   LIVE_SYMBOL_ALLOWLIST=BTCUSDT,ETHUSDT   # 허용 종목만
   LIVE_DAILY_LOSS_LIMIT=100          # 일일 실현손실 이 금액 넘으면 자동 거래중단(서킷)
   ```
3. **수동 주문(`place_order`)은 2단계**: 1차 호출=프리뷰+`confirmToken` 반환 → 검토 → 동일 인자 + `confirmToken`으로 2차 호출해야 실제 주문(5분 TTL, 단일사용). 토큰 없이는 **절대 실행 안 됨(fail-closed)**.
4. **자율 봇(`create_bot mode=live`)**은 사전승인 모델: 마스터 스위치 + 하드리밋 + 멱등으로 통제(봇은 2단계 토큰 없이 돌되, 게이트/리밋이 막음).

### 메인넷 파일럿 체크리스트 (실돈 첫 가동 전)
- [ ] testnet 봇 E2E 통과 확인(`npx tsx scripts/verify-testnet-bot-e2e.ts` → 매수·상주스톱·정리 PASS).
- [ ] 메인넷 키 = **출금권한 OFF + IP 화이트리스트** (거래 권한만).
- [ ] `BINANCE_ENV=live` + `LIVE_TRADING_ENABLED=true` + **`LIVE_MAX_NOTIONAL` 소액**(예: 20~50) + `LIVE_SYMBOL_ALLOWLIST` + `LIVE_DAILY_LOSS_LIMIT`.
- [ ] 메인넷 연결 확인: `BINANCE_ENV=live`로 `verify-testnet-connection.ts` 실행(읽기전용, 잔고 확인).
- [ ] 봇 1개·소액·`stop_loss_percent` 설정으로 시작 → `open_dashboard`로 모니터 + 거래소 앱에서 상주 스톱 확인.
- [ ] 며칠 관찰 후 점진 확대. `audit.jsonl` + `testnet-cleanup-orders.ts`(심볼만 바꿔 메인넷 점검)로 고아주문 0 확인.
- [ ] ⚠️ **현물만 라이브 지원**(선물 보호주문은 미지원). **지정가 라이브는 v2**(현재 시장가 체결).

## 3. 라이브 — 한국투자증권(KIS, 한투)
1. KIS Developers(apiportal.koreainvestment.com)에서 앱키/시크릿 + **모의투자** 신청
2. 환경변수:
   ```bash
   KIS_ENV=mock                        # 기본 mock. 실전은 live
   KIS_APPKEY=<appkey>
   KIS_APPSECRET=<appsecret>
   KIS_ACCOUNT=12345678-01             # 계좌번호-상품코드
   ```
3. `create_bot(broker=kis, mode=live, symbol=005930)` 식. mock은 즉시, 실전(live)은 `LIVE_TRADING_ENABLED=true` 필요.

## 4. 라이브 — 키움(Kiwoom)
1. openapi.kiwoom.com에서 앱키/시크릿 + **모의투자** 신청 (KIS와 별개 시스템)
2. 환경변수:
   ```bash
   KIWOOM_ENV=mock                     # 기본 mock
   KIWOOM_APPKEY=<appkey>
   KIWOOM_SECRETKEY=<secretkey>        # 필드명이 secretkey
   ```
3. `create_bot(broker=kiwoom, mode=live, symbol=005930)`.

---

## 안전 요약 (코드에 박힌 게이트 — 우회 불가)
| 게이트 | 동작 |
|---|---|
| 마스터 스위치 | `LIVE_TRADING_ENABLED!=true` → 메인넷 차단(페이퍼 폴백). 기본 OFF |
| env 기본 | 미설정 시 testnet/mock(안전). 메인넷은 명시 `=live`만 |
| 2단계 확인토큰 | `place_order`는 토큰 없이 실행 0 (fail-closed, 5분 TTL, 단일사용, 주문해시 바인딩) |
| 하드리밋 | 노셔널 캡 / 심볼 allowlist / 일일손실 서킷브레이커 (서버측 강제) |
| 상주 보호주문 | 봇 진입 시 거래소에 SL/TP STOP 주문 자동 배치 → **봇이 죽어도 거래소가 손절 보호**. 트레일링 갱신, 청산 시 자동 취소 |
| 실잔고 사이징 | 매수는 가용현금 초과 못 함(잔고초과 거부 예방) |
| 체결 reconcile | 모호한 실패 후 실제 체결여부 조회 → 중복주문 방지 |
| 멱등 | 동일 주문 중복체결 0 |
| 감사로그 | 모든 주문 시도/결과를 `~/.quant-mcp/audit.jsonl`에 기록 |
| 키 위생 | env 런타임만, 로그 마스킹, 출금권한 OFF·IP화이트리스트 권장 |

**정직 포지셔닝**: 이 도구는 리스크 통제 + 표현력 도구이지 알파(수익) 보장이 아닙니다. 실거래는 본인 책임이며 소액부터.
