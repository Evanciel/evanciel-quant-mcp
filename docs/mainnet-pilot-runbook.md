# 메인넷(실돈) 파일럿 런북

> ⚠️ **실돈입니다.** 이 문서는 testnet 검증을 모두 통과한 뒤, **소액 1건**으로 메인넷을 시작하는 절차입니다.
> 핵심 철학은 변하지 않습니다 — 이 도구는 **리스크 통제 + 표현력**이지 알파(수익) 보장이 아닙니다. 잃어도 되는 소액으로만.

전제: testnet 봇 E2E가 PASS여야 합니다(`npx tsx scripts/verify-testnet-bot-e2e.ts` → 매수·상주 SL/TP·정리 PASS).

---

## 0. 한눈에 보는 안전 장치 (코드에 박힘, 우회 불가)

| 장치 | 의미 |
|---|---|
| `BINANCE_ENV` 기본 testnet | 명시적 `=live`가 없으면 절대 메인넷 안 감 |
| `LIVE_TRADING_ENABLED` | `true`가 아니면 메인넷 주문 차단(페이퍼 폴백). 마스터 스위치 |
| `LIVE_MAX_NOTIONAL` | 주문당 최대 USDT. 초과 주문 서버측 거부 |
| `LIVE_SYMBOL_ALLOWLIST` | 허용 종목만 거래 |
| `LIVE_DAILY_LOSS_LIMIT` | 일일 실현손실이 이 값을 넘으면 자동 거래중단(서킷) |
| 상주 SL/TP | 봇 진입 시 거래소에 손절/익절 주문 배치 → **봇이 죽어도 거래소가 손절** |
| 출금권한 OFF(키) | 키가 유출돼도 자금 인출 불가 (가장 중요) |

---

## 1. 거래소 키 발급 (binance.com, 실계정)

1. API Management → Create API.
2. **[출금/Withdraw] 권한 반드시 OFF.** 거래(Spot Trading) 권한만 ON.
3. **IP 접근 제한(Restrict access to trusted IPs only)** → 봇 돌리는 PC/서버의 고정 IP 등록.
4. Key/Secret을 **채팅·메신저에 붙여넣지 말 것.** 아래 방법 중 하나로만 저장.

## 2. 설정 입력 (3가지 중 택1 — 키는 채팅 미경유)

> 💸 **A·B는 "키만 넣으면 바로 매매"** — 실거래(live)를 고르면 **마스터 스위치 + 안전 기본값(주문당 50 USDT·일일손실 서킷 50)을 자동**으로 켜줍니다. 환경변수 5개를 손으로 만질 필요 없음.

**A. CLI 마법사 (추천)** — `npx quant-mcp setup` → binance → **실거래(live) 선택** → 키 입력 → "출금 권한 껐죠?" 확인 → 한도 입력(Enter=기본 50) → 끝. 자동으로 실거래 ON.
**B. 대시보드** — `open_dashboard` → ⚙️ API 키 설정 → 키 입력 → **💸 실거래 모드**에서 한도+출금OFF 체크 → **실거래 켜기**.
**C. `.env.local` 직접 (고급)** — 수동으로 변수 작성(gitignore, `chmod 600`):

```bash
BINANCE_ENV=live
BINANCE_API_KEY=<메인넷 key>
BINANCE_API_SECRET=<메인넷 secret>
LIVE_TRADING_ENABLED=true          # 마스터 스위치
LIVE_MAX_NOTIONAL=20               # 첫 파일럿은 소액(20~50 권장)
LIVE_SYMBOL_ALLOWLIST=BTCUSDT      # 한 종목으로 시작 권장(비우면 전체 허용)
LIVE_DAILY_LOSS_LIMIT=50           # 일일 손실 서킷
```

> 마스터 ON인데 `LIVE_MAX_NOTIONAL`을 안 정했어도 **기본 안전 캡(50 USDT)** 이 자동 적용됩니다(무제한 금지). A/B로 넣은 키·설정은 `~/.quant-mcp/credentials.env`(chmod 600)에 저장되고 서버 기동 시 자동 로드. MCP 설정 env가 이 파일보다 우선(운영 오버라이드).

## 3. 사전점검 (GO/NO-GO — 주문 0건)

```bash
npx tsx scripts/verify-mainnet-readiness.ts
```

검사 항목: `BINANCE_ENV=live` · 마스터 스위치 ON · 키 유효(읽기전용 잔고) · **출금권한 OFF**(최우선) · IP 제한 · 하드리밋(노셔널/allowlist/서킷) 설정 + 동작 자가검증.

- 🟢 **GO** → 4단계로.
- 🔴 **NO-GO** → 표시된 ❌를 모두 해결 후 재실행. (특히 출금권한이 켜져 있으면 즉시 거래소에서 OFF)

## 4. 소액 1건 파일럿

1. 한 종목·소액·`stop_loss_percent` 설정으로 라이브 봇 1개 생성:
   `create_bot(broker=binance, mode=live, symbol=BTCUSDT, capital=<LIVE_MAX_NOTIONAL 이하>)`.
2. `open_dashboard`로 모니터. 진입이 생기면 **거래소 앱에서 상주 SL/TP 주문이 실제로 걸렸는지** 눈으로 확인.
3. `get_balance`/`get_positions`로 실잔고·실포지션 대조.
4. 수동 주문을 테스트하려면 `place_order`는 **2단계**(1차 프리뷰+토큰 → 동일 인자+토큰 2차 실행).

## 5. 관찰 & 점진 확대

- 며칠 운용하며 `~/.quant-mcp/audit.jsonl`(모든 주문 시도/결과) 확인.
- 고아 주문 점검: `scripts/testnet-cleanup-orders.ts`를 메인넷 심볼로 조회(취소는 신중히).
- 일일손실 서킷이 한 번이라도 작동하면 원인 분석 후 재개.
- 문제 없으면 `LIVE_MAX_NOTIONAL`·종목 수를 천천히 확대.

## 긴급 정지

- `LIVE_TRADING_ENABLED`를 지우거나 `false`로 → 즉시 메인넷 주문 차단(페이퍼 폴백). 봇은 평가만 하고 실주문 안 나감.
- 거래소 앱에서 직접 포지션 청산/주문 취소도 항상 가능.

---

## 의도적 미지원(정직 — 반쯤 만든 위험코드 안 넣음)

- **지정가 라이브**(현재 시장가 체결). 미체결 추적 상태머신은 v2.
- **선물 보호주문**(현물만 상주 SL/TP 지원).
- **현물 드리프트 reconcile 자동화**(공유잔고=선물 개념).

이 한계들은 메인넷 파일럿(현물·시장가·상주스톱)에는 영향 없습니다.
