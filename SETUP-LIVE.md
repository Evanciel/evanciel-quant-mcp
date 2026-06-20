# 라이브 거래 셋업 가이드 (BYOK)

> **핵심 안전 원칙**: 키를 넣으면 **testnet/mock은 즉시 거래(가짜돈)**, **메인넷(실돈)은 추가로 마스터 스위치**가 필요합니다. **수동 주문**(place_order/place_protective)은 거기에 **주문별 2단계 확인**까지 거치고, **자율 봇**은 `create_bot(mode:live)` 시 한 번 사전승인 후 게이트+하드리밋+멱등으로 통제됩니다(주문별 토큰은 없음). 아무 설정도 안 하면 **전부 페이퍼**(가짜돈)로 안전하게 작동합니다.

**키를 채팅(에이전트 대화)에 절대 붙여넣지 마세요** — 프롬프트 인젝션·로그에 남을 위험. 키는 본인 컴퓨터에만 저장되고 화면엔 마스킹(앞2…뒤4)으로만 보입니다.

`live_status` 툴로 현재 무엇이 설정됐는지 언제든 확인할 수 있습니다(키는 노출 안 됨).

---

## 🔑 키를 어디에 넣나요? (3가지 방법 — 아무거나)

> 모두 같은 파일(`~/.quant-mcp/credentials.env`, 소유자 전용 `chmod 600`, gitignore)에 저장됩니다. 한 번 넣으면 됩니다.

> 💸 **키만 넣으면 바로 매매:** 아래 A·B는 실거래(live)를 고르면 **마스터 스위치 + 안전 기본값(주문당 100 USDT·일일손실 서킷 50 USDT; 한투/키움 KRW는 주문당 150,000·일일손실 75,000)을 자동으로 켜줍니다.** 환경변수 5개를 따로 만질 필요 없이, 출금 권한만 끄면 바로 실매매 준비 끝. **첫 파일럿은 `LIVE_MAX_NOTIONAL`을 20~50으로 직접 더 낮추길 권장**(메인넷 런북 참고).

**방법 A. CLI 설정 마법사 (제일 쉬움 — 일반인 추천)**
```bash
npx quant-mcp setup
```
브로커 → **연습(testnet)/실거래(live) 선택** → 키 입력(화면 `*` 마스킹). 실거래를 고르면 "출금 권한 껐죠?" 확인 후 **마스터 ON + 안전 기본값**까지 자동. 끝나면 "자비스에게 '실거래 봇 돌려줘'라고 하면 바로 실매매"라고 안내합니다. MCP 서버 재시작 시 자동 로드.

**방법 B. 대시보드 폼 (브라우저에서)**
`open_dashboard` → 우측 상단 **⚙️ API 키 설정** → 브로커 칸에 키 입력(저장 즉시 적용) → 맨 아래 **💸 실거래 모드**에서 한도 정하고 "출금 권한 껐습니다" 체크 후 **실거래 켜기** 토글. 끄기(긴급 페이퍼 전환)도 버튼 하나. 127.0.0.1 전용 + 최초 접속 시 토큰을 HttpOnly 쿠키로 교환(이후 주소창·페이지에 토큰 미노출) + Host/Origin 검증, **실거래 켜기는 미리보기→확정 2단계**(끄기는 원클릭), 저장한 키는 **다시 읽어올 수 없습니다**(마스킹만).

**방법 C. 환경변수 직접 (고급/서버 운영)**
`.env` 파일(gitignore + `chmod 600`) 또는 시크릿 매니저(1Password `op run`, Infisical, Doppler) 경유. MCP 클라이언트 설정의 `env`로도 가능하며, 이 값은 credentials.env보다 **우선**합니다(운영 오버라이드). 변수명은 아래 각 브로커 절 참고.

**방법 D. 프로젝트 `.env.local` (로컬 dev)**
프로젝트 루트의 `.env.local`(gitignore)에 `KEY=VALUE`로 넣으면 MCP 서버·데몬이 기동 시 자동 로드합니다(non-override — MCP env·credentials.env가 우선). 별칭 키도 인식(예: 토스 `TOSS_API_KEY`=`TOSS_CLIENT_ID`). 프로젝트 루트에서 실행할 때만 적용됩니다.

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
   LIVE_DAILY_LOSS_LIMIT_USDT=50      # (권장) Binance 일일 실현손실 한도(달러)
   # LIVE_DAILY_LOSS_LIMIT=100        # (하위호환) 통화 무관 단일값 — 분리값 미설정 시 통화별로 각각 적용
   ```

   **일일손실 서킷 통화 분리(audit P1-6):** 키움/KIS(KRW)와 Binance(USDT)를 같이 돌리면 손실이 통화별로
   따로 집계됩니다. 우선순위는 **분리값(`LIVE_DAILY_LOSS_LIMIT_USDT`/`_KRW`) > 단일값(`LIVE_DAILY_LOSS_LIMIT`)
   > 통화 기본값(USDT 50 / KRW 75,000)**. 기존에 단일값만 쓰던 설정은 그대로 동작하되 이제 통화별로 각각
   적용됩니다(미설정 시 기본값으로 자동 무해화 — 마이그레이션 불필요).

   **감사 무결성(audit P1-24):** 감사로그 기록이 계속 실패하면 `live_status.auditStatus` / 대시보드
   `/api/audit-health`에 실패 카운트가 뜹니다. 감사 무결성이 절대적이면 `AUDIT_FAILURE_HALT=true`
   (임계 `AUDIT_FAILURE_HALT_MAX`, 기본 10)로 누적 실패 시 주문을 차단하세요. 손실 조회가 실패하면
   서킷은 fail-closed(차단)로 동작합니다 — 조회 실패가 손실을 숨기지 않습니다.

3. **수동 주문(`place_order`)은 2단계**: 1차 호출=프리뷰+`confirmToken` 반환 → 검토 → 동일 인자 + `confirmToken`으로 2차 호출해야 실제 주문(5분 TTL, 단일사용). 토큰 없이는 **절대 실행 안 됨(fail-closed)**.
4. **자율 봇(`create_bot mode=live`)**은 사전승인 모델: 마스터 스위치 + 하드리밋 + 멱등으로 통제(봇은 2단계 토큰 없이 돌되, 게이트/리밋이 막음).

### 메인넷 파일럿 체크리스트 (실돈 첫 가동 전)

> 📖 **상세 절차는 [`docs/mainnet-pilot-runbook.md`](docs/mainnet-pilot-runbook.md)** (단계별 런북 + 긴급정지).

- [ ] testnet 봇 E2E 통과 확인(`npx tsx scripts/verify-testnet-bot-e2e.ts` → 매수·상주스톱·정리 PASS).
- [ ] 메인넷 키 = **출금권한 OFF + IP 화이트리스트** (거래 권한만).
- [ ] `BINANCE_ENV=live` + `LIVE_TRADING_ENABLED=true` + **`LIVE_MAX_NOTIONAL` 소액**(예: 20~50) + `LIVE_SYMBOL_ALLOWLIST` + `LIVE_DAILY_LOSS_LIMIT`.
- [ ] **사전점검(GO/NO-GO, 주문 0건)**: `npx tsx scripts/verify-mainnet-readiness.ts` → 🟢 GO 확인. env=live·마스터·키유효·**출금권한 OFF**·하드리밋을 한 번에 검사하고, 하드리밋이 실제로 막는지 자가검증.
- [ ] 봇 1개·소액·`stop_loss_percent` 설정으로 시작 → `open_dashboard`로 모니터 + 거래소 앱에서 상주 스톱 확인.
- [ ] 며칠 관찰 후 점진 확대. `audit.jsonl` + `testnet-cleanup-orders.ts`(심볼만 바꿔 메인넷 점검)로 고아주문 0 확인.
- [ ] ⚠️ **현물만 라이브 지원**(선물 보호주문은 미지원). 봇 진입은 기본 시장가, **지정가 진입(Binance 전용)은 아래 참조**.

### 봇 지정가 진입(audit P1-5, Binance 전용)
복합전략에 `entry_execution`을 주면 봇 진입을 maker-first **지정가**로 낸다(미설정=시장가, 기존 동작). 슬리피지 통제용 — 알파 아님.
```jsonc
entry_execution: {
  type: "limit",          // 미설정/"market"=시장가(레거시)
  limitOffsetPct: -0.1,   // 매수 지정가 = 현재가×(1+offset/100), maker는 ≤0. clamp -5..0(기본 0)
  timeoutBars: 3,         // N 닫힌봉 미체결 시 시장가 폴백. clamp 1..50(기본 3)
  maxSlippagePct: 0.5     // 폴백 시장가 슬리피지 캡(%). 초과 시 freeze(주문 안 냄, 잔량 드롭). clamp 0..5(기본 0.5)
}
```
- **동작**: 신호 봉에 지정가 배치 → 체결되면 개시 / `timeoutBars` 닫힌봉 내 미체결이면 취소 후 **캡 이내**에서 시장가 폴백(캡 초과면 진입 포기). 크래시 후 재시작해도 `cid`로 같은 주문을 추적(중복 주문 방지).
- **정직(체결 빈도)**: 백테스트는 봉이 지정가를 통과하면 maker 체결을 가정하나, 라이브는 호가 큐 위치로 체결을 **놓칠 수 있다**(라이브가 더 적게 진입 = 보수적). 진입가 자체는 백테 ≥ 라이브(절대 더 낙관 아님, 증명: `docs/02-design/p1-5-limit-entry-design.md`).
- **재검증 필수**: 지정가 봇은 `backtest({ entryExecution })`로 OOS/DSR을 **다시 검증**하라(시장가 베이스라인 무효). 시장가 봇은 영향 0.
- **KR 미지원**: KIS/키움은 미체결 체결확인 미배선이라 지정가 진입 라이브 거절(fail-closed). 시장가로 운용.

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

---

## 메인넷 실거래 전 알아둘 현 한계 (정직)

Binance **testnet** 머니패스는 검증됐고 기본은 페이퍼·메인넷 OFF입니다. 다만 **실돈**을 굴리기 전엔 아직 커버 안 되는 부분을 정확히 알아야 합니다. 아래 항목들은 페이퍼 기본·testnet 검증된 현물 경로엔 영향이 없습니다:

- **한국 브로커(KIS/키움)는 거래소 상주 손절이 없고 체결확인이 약합니다.** 거래소 상주 SL/TP는 Binance 전용 — KR은 라이브 주문은 나가도 거래소 상주손절이 없어 **봇 다운 시 포지션 무방비**. KR 체결 보고는 *미체결(pending)* 을 체결처럼 노출할 수 있어 장부 드리프트 가능. 상세 = [`docs/kr-broker-gap-analysis.md`](docs/kr-broker-gap-analysis.md)(상주손절 공백, 체결 사이클 미확정).
- **보호주문은 현물 Binance OCO만.** *수동* `place_protective`만 현물 롱에 실제 OCO(한쪽 체결 시 다른쪽 자동취소)를 겁니다. **자율 봇은 OCO가 아니라 독립 상주주문 2개(STOP + 익절)** 를 `syncProtective`/`planProtectiveOrders`로 배치합니다(둘은 다른 메커니즘). 선물·타브로커는 아직 상주 보호주문이 없습니다. (OCO 응답 파서는 강화 완료 — `orderListId`가 비양수/부재이거나 `orderReports`가 정확히 2 leg가 아니면 throw하여 유령 OCO가 성공으로 둔갑하지 못합니다.)
- **자율 봇은 주문별 확인토큰이 없습니다.** 수동 주문만 fail-closed 2단계 토큰으로 보호되고, `mode:live` 봇은 `create_bot` 시 한 번 사전승인 후 마스터 스위치 + 하드리밋 + 멱등으로 통제됩니다(위 안전 요약 표 참고). 이는 의도된 설계지 주문별 승인이 아닙니다.

이 한계들은 숨기지 않고 추적 중입니다 — 프로젝트의 가치(공유 backtest≡live 코드 구조 + 리스크 통제)는 그대로입니다. 실돈은 testnet 검증 후, 소액으로, 마스터 스위치·하드리밋을 켜고만.
