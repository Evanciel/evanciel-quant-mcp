# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
