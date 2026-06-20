# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 2026-06-21 토스 US 완성도 (금액주문 + 세션 게이팅)

토스 어댑터 US 후속 2건 + MCP 키 로딩 보강. Tests → 600.

### Added
- **US 금액기반 시장가 주문**(`orderAmount`, 토스 US MARKET 전용, **수동 한정**): `OrderRequest.orderAmount` + 어댑터 amount-based 본문 + `live-handlers.placeOrder` 금액경로(notional=orderAmount, USD, 2단계 토큰 해시 바인딩, 하드블록 경유) + `place_order` MCP 스키마 + `/api/order`(수량 또는 금액 택일). 봇 러너는 수량기반 사이징 유지.
- **US 세션 게이팅**: `isMarketOpen`/`sessionKey` 심볼 인식 — 토스 US 심볼=US 정규장(09:30~16:00 ET, EDT/EST DST 반영). KR(kis/키움/토스 KR)·binance 동작 보존.

### Fixed
- **MCP 서버가 `.env.local`을 로드**(`loadEnvLocalFile`, non-override): 종전엔 데몬만 .env.local을 읽어, `.env.local`에만 키를 둔 경우 **MCP 경유(에이전트) 라이브 호출 시 브로커 키 누락**. 이제 MCP 서버도 동일 소스를 읽어 토스 등 모든 브로커가 MCP에서 인식됨(별칭 키 포함).

### Notes
- 금액주문은 KR/지정가 fail-closed(스펙상 US MARKET 전용). 대시보드 금액 입력 UI는 후속(미검증 템플릿 JS).

## [Unreleased] — 2026-06-20 토스증권(Toss) 브로커 추가

quant-mcp 4번째 브로커. PDCA(plan→design→do→check 100%→report) + 다단계 적대검증(울트라코드). 라이브 읽기 E2E 8/8. Tests → 585.

### Added
- **토스증권 Open API 어댑터** (`src/brokers/toss.ts`, KR+US): OAuth2 client_credentials, 시세·계좌·보유·주문·취소·미체결, 캔들(1m/1d, `before` 커서 페이지네이션). 멀티브로커 배선(`toss`) + 대시보드 통합(드롭다운·차트·통화 표시).
- **읽기 전용 라이브 E2E** (`scripts/verify-toss-e2e.ts`) — 토큰→/accounts→KR/US 시세→캔들→잔고→보유→미체결.
- `quoteCurrencyFor(broker, symbol)` — 주문 통화 판정 단일 진실원(KRW/USDT/USD); 일일손실 서킷에 toss 포함(coarse `IN`, fail-safe over-count). 키 별칭 허용(`TOSS_API_KEY`↔`TOSS_CLIENT_ID`).

### Fixed (real-money safety)
- **토스 라이브-쓰기 하드블록**: 토스는 모의 호스트가 없어 placeOrder/cancelOrder는 `env=live`(+주문은 `LIVE_TRADING_ENABLED`)일 때만 — `checkLimits` 마스터-OFF 단락으로 "페이퍼인데 실호스트 무캡 도달"하던 구멍 봉쇄.
- 적대검증 4건: 러너 캔들 디스패치 toss 누락(시그널봇 영구 hold) / US LIMIT 소수수량 거부(스펙 `^\d+$`) / 대시보드 정규식 esbuild cook(`\d`→`d`) / 교차통화 affordability(KRW÷USD).

### Notes
- 주문 쓰기 기본 페이퍼(`LIVE_TRADING_ENABLED` OFF). `getOrderByClientId` 미구현으로 KR 포지션-reconcile 라우팅 보존. OCO/거래소 상주 보호주문 미지원(fail-closed). 단일 주문경로(`placeOrder`)·no-retry-on-POST 불변식 유지.

## [Unreleased] — 2026-06-12 full-audit upgrade (Sprints 1–6)

Driven by the adversarially-verified full audit (`docs/03-analysis/full-audit-2026-06-12.md`).
All four P0s and 17 of 24 P1s resolved. Tests 364 → 448.

### Fixed (real-money safety)
- **KIS KRX tick alignment** (P0-4): limit prices now rounded via shared `krx-tick.ts` — removes predictable RC4003 rejections.
- **KR protective-order silent mutation** (P0-3): KIS/Kiwoom now explicitly *reject* stop/take-profit order types instead of silently sending them as plain limits; runner skips exchange-resident protective sync for KR with a one-time honest warning; dashboard discloses the gap.
- **Boot position seed** (P0-1): on restart (even with the live gate OFF) a one-shot read-only reconcile restores exchange truth — guarded by the bot's own live-trade ledger so manual holdings are never adopted.
- **Resident stop orders were silently failing** (latent bug found via testnet): non-market order ACK responses lack `status`, tripping the fail-closed parser — all orders now request `newOrderRespType=RESULT`. Verified by a 5-step testnet moneypath (buy → reconcile → resident stop accepted → cancel → close).
- **Partial fills** (P1-1): executed-vs-intended quantity split (`executedQty`/`origQty`); ledger records actual fills; partial-then-EXPIRED no longer masquerades as `rejected`.
- **Ladder average-price parity** (P1-11): scale-in/pyramid averaging now uses the slippage-adjusted executed price, so engine state ≡ recorded trades ≡ live `derivePosition`.

### Added (operations & control)
- **24/7 headless daemon** (`npm run daemon`) + `Dockerfile` + unauthenticated `/healthz` — bots no longer die with the MCP client (P0-2). Container-restart scenario not yet exercised (local Docker engine was offline).
- **Telegram remote control** (`/status` `/halt` `/forceexit` `/resume`) with mandatory chat-id allowlist and 6-digit single-use confirm codes (P1-14); crash alerts + optional heartbeat (P1-15).
- **Global kill switch** `LIVE_TRADING_HALT` + `emergencyStopAll` (stop all bots, optionally market-close live positions through the existing safe order path) (P1-17).
- **Order observability**: MCP tools `get_open_orders` / `get_order_status` (25 → 27 tools), dashboard trade-history + open-orders panel with cancel, manual limit-order fill tracking with alerts (P1-16/18/19/20).
- **Common retry layer** for 429/5xx/timeouts with Retry-After support — GET-only; order POSTs are never transport-retried (idempotency stays with clientOrderId reconcile) (P1-3).
- **SQLite hardening**: WAL, atomic trade+position transactions, daily `VACUUM INTO` backups (P1-21); duplicate live bots per symbol+broker blocked at start and auto-halted at runtime (P1-8).
- **Backtest `gapHandling: "worst"`** option — stop-loss judged on bar low, filled at min(open, stop level) (P1-12); `weighted` trees refused for live bots until capital-split execution exists (P1-13).
- **Manual-order UX**: free-form symbol order modal, quote/balance/holdings lookup, 25/50/Max presets, oversell guard, one-click close-all per bot card.

### Added — P1 follow-ups (2026-06-14, audit-driven)
- **Per-currency daily-loss circuit** (P1-6): USDT vs KRW tracked independently (a KRW loss no longer trips the USDT circuit). Priority: split env > single env > per-currency default.
- **Audit fail-closed + halt** (P1-24): the daily-loss query now returns negative infinity on error (was `0`, fail-open) so a query failure can never hide a loss; `AUDIT_FAILURE_HALT` blocks live orders on repeated audit-write failures; `live_status.auditStatus` + dashboard `/api/audit-health`.
- **Scanner partial-fill fix + live reject** (P1-23): scanner bots now record executed (not intended) quantity on partial fills; `mode:live` scanner bots are rejected (symbol-map reconcile unimplemented) instead of silently falling back to paper.
- **Candle retry + integrity** (P1-22): `fetchKlines` retries on 429/5xx/timeout; `validateCandleContiguity` rejects interval mismatch / missing bars before evaluation (crypto strict, KR median — weekend-gap safe); KIS candle path fails closed instead of a silent empty hold.
- **Unknown-result forced reconcile** (P1-2): repeated ambiguous order results trigger a forced `getPositions` reconcile (bypassing the Binance skip-guard) to converge with exchange truth; conservative (adopt-only, no clear).

### Deferred (honest)
- **Live limit-order entry** (P1-5): deferred — no pending-order state machine or backtest timeout model yet; shipping it would break backtest≡live parity.
- **KR fill reconcile** (P1-10): endpoints/tr_ids confirmed (KIS `inquire-psbl-rvsecncl` TTTC0084R, Kiwoom `ka10075`) but response field names are undocumented; implementation waits for mock-server E2E (project rule: no unverified KR response parsing).

### Known gaps (honest)
- KIS mock-server E2E script ready but **not run** (awaiting KIS sandbox keys).
- Docker restart scenario unverified locally; ladder-path `gapHandling`, KR open-order query, scanner-bot live reconcile, and symbol autocomplete remain follow-ups.

## [0.1.0] — unreleased

First open-source (MIT) release. The portable quant core was extracted from a parent
project and verified by an adversarial multi-agent portability + correctness review.

**Honest positioning:** quant-mcp is a *risk filter and expressiveness layer, not an
alpha source*. Deep research on this class of retail infra concluded directional
alpha ≈ 0 (243 out-of-sample optimizations → robust alpha of 0). No tool advertises
expected returns.

### Added

- **Portable, side-effect-free quant core** (`src/core`): indicators, backtest engine,
  metrics, regime detection, deflated/probabilistic Sharpe, short engine.
- **Keyless data layer** — Binance public REST (klines pagination + `fapi`); no API
  keys required for analysis or backtesting.
- **MCP stdio server** with 25 tools across analysis, screening, portfolio, events,
  bots, and live (bring-your-own-keys) categories. Every tool maps 1:1 to a verified
  pure function and carries the "risk filter, not alpha source" disclaimer.
- **Strategy expressiveness** — one validated JSON tree (Zod) with `leaf`,
  `condition`, `composite`, and `scanner` node types, plus condition types:
  `indicator` (21 indicators, with optional `timeframe` for **multi-timeframe**),
  `time` (incl. hour/minute time-of-day), `regime`, `anchor` (session VWAP / open /
  prev-close), `spread` (pairs / stat-arb), `event` (FOMC calendar or inline times),
  and `performance`.
- **Position management** — `stopLoss`, `takeProfit`, **TP ladder** (partial
  take-profit), **scale-in** (averaging down), **pyramid** (adding to winners),
  **trailing stop**, and **short / futures** (testnet-validated).
- **False-discovery filtering** — 70/30 hold-out OOS gating, PSR/DSR (deflated
  Sharpe), and a `strategy_factory` that bulk-screens candidates and rejects most by
  design.
- **Risk sizing** — EWMA vol-target / ATR / fractional Kelly position sizing, MDD
  circuit breakers, portfolio heat, correlation adjustment, and capital allocation
  (`suggest_position_size`, `portfolio_risk`, `allocate_portfolio`). Live order
  quantity is wired to volatility targeting (backtest ≡ live).
- **Paper bot runner** (`src/runner`) that re-evaluates each closed bar by *reusing*
  the backtest engine — so live mirrors backtest by construction — with a local
  `node:sqlite` store for bots, strategies, trades, and logs.
- **Real-time HTML dashboard** (`127.0.0.1`): plain-language strategy summaries,
  win/loss/idle pills, realized vs. unrealized PnL, and multi-symbol scanner
  positions. Includes TradingView-grade charting on a self-hosted
  `lightweight-charts` (1m–1M timeframes, 18 toggleable indicators with editable
  parameters, separate oscillator panes, persisted drawing tools, live ticking, and
  a KST-unified time axis).
- **Manual trading & protective (OCO) orders** from the dashboard — market/limit
  buy/sell and drag-to-set TP/SL that places a real Binance-spot OCO
  (one-cancels-the-other), routed through the same safety pipeline. MCP tools
  `place_protective` / `get_protective` / `cancel_protective` expose the resting-OCO
  money-path.
- **Exchange account sync (read-only)** — real balance, holdings, and resting OCO
  orders next to a paper-vs-exchange drift badge; keys never returned to the browser.
- **Event alerts** — in-dashboard SSE feed plus Slack/Discord webhook fan-out, with a
  strict SSRF gate (HTTPS-only, exact host allowlist, no redirects) and per-event
  debounce.
- **P0 execution core (key-free, tested)** — exchange-resting stop / take-profit /
  trailing planning (`planProtectiveOrders`), position-drift reconciliation vs. the
  exchange, balance-based sizing, and fill-status classification, so a stop is
  protected even if the bot process is down. Live wiring is testnet-gated
  (`docs/p0-execution-layer.md`).
- **Live money-path verified on Binance testnet** (entry → resting SL/TP → cancel →
  close) with a read-only mainnet GO/NO-GO pre-flight
  (`scripts/verify-mainnet-readiness.ts`, **zero orders**).
- **Multi-broker adapters** — Binance + 한국투자증권/KIS + 키움 — behind shared safety
  gates.

### Security

- Fail-closed **two-step confirm token** on *manual* orders (`place_order` /
  `place_protective`: preview → confirm, hash-bound, single-use, short TTL).
  Autonomous bots have **no per-order token** — they are pre-approved at
  `create_bot(mode:live)` and bounded by the master switch + server-side hard limits
  (notional cap, symbol allowlist, daily-loss circuit) + idempotency. The LLM cannot
  bypass the gate or the limits.
- Keys stored masked in `~/.quant-mcp/credentials.env` (`chmod 600`, gitignored),
  never echoed, never returned to the browser; never to be pasted into chat.
- Dashboard binds to `127.0.0.1` only; one-time bootstrap token → HttpOnly session
  cookie, Host + Origin checks, self-hosted chart library (no third-party scripts),
  two-step preview→confirm to enable live mode.
- Hardened after adversarial review: fixed a stored-XSS sink, a credentials
  newline-injection vector, and a scanner candidate-id collision; webhook SSRF gate;
  silent-live-failure-recorded-as-paper fix; normalize-then-cap order sizing.
- Hardened after an independent cross-model (Codex) review: the OCO acknowledgement
  parser now requires a positive `orderListId` **and exactly two legs** (a single order
  can no longer masquerade as a ghost OCO); `audit()` is fail-loud (stderr + failure
  counter) instead of silently swallowing write errors; the daily-loss circuit's
  day-boundary moved to KST (env-overridable, range-clamped so a bad offset can't
  fail-open the circuit).

### Notes

- **Default is paper; mainnet is OFF** unless you set keys *and* the master switch
  `LIVE_TRADING_ENABLED`. Mainnet stays gated behind testnet validation.
- Not financial advice — for research and education.

[0.1.0]: https://github.com/Evanciel/evanciel-quant-mcp/releases/tag/v0.1.0
