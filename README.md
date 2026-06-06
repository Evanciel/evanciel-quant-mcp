<div align="center">

# quant-mcp

**A composable backtesting, risk, and paper-trading engine for AI agents — over the Model Context Protocol.**

Let any MCP agent (Claude, Cursor, …) design a trading strategy as a validated JSON tree, backtest it with out-of-sample rigor, run it as a 24/7 paper bot, and watch it on a live dashboard — all from natural language.

[![CI](https://github.com/Evanciel/evanciel-quant-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Evanciel/evanciel-quant-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-stdio-blue.svg)](https://modelcontextprotocol.io)
[![tests](https://img.shields.io/badge/tests-95%20passing-brightgreen.svg)](test)
[![keys](https://img.shields.io/badge/data-keyless%20(Binance%20public)-orange.svg)](src/data/binance-public.ts)

</div>

---

## ⚠️ Honest positioning: a risk filter, not an alpha source

quant-mcp does **not** claim to find alpha. Deep research on this kind of retail infra concluded directional alpha ≈ 0 (243 out-of-sample optimizations → robust alpha of 0; overfitting confirmed). What it gives you that is *genuinely* valuable:

- 🛡️ **Risk control** — position sizing (EWMA vol-target / ATR / fractional Kelly), MDD circuit breakers, portfolio heat, exchange-resting stop/trailing math.
- 🔬 **False-discovery filtering** — Deflated / Probabilistic Sharpe (DSR/PSR), walk-forward OOS gating. *The factory rejects most candidates by design — that's correct, not a bug.*
- 🧩 **Expressiveness** — a composable strategy tree (indicators × regime × session × pairs × multi-timeframe × calendar events × screeners) with **one validated schema** and **backtest ≡ live parity** (the same pure functions drive backtest, paper, and live).

No tool advertises expected returns. Ever.

---

## Table of Contents

- [Quick start](#quick-start)
- [What can an agent build?](#what-can-an-agent-build)
- [Tool reference (22 tools)](#tool-reference-22-tools)
- [Strategy expressiveness](#strategy-expressiveness)
- [Bots & live dashboard](#bots--live-dashboard)
- [Risk & execution layer](#risk--execution-layer)
- [Architecture](#architecture)
- [Roadmap](#roadmap)
- [Safety](#safety)
- [Contributing](#contributing)
- [License](#license)

---

## Quick start

quant-mcp is a stdio MCP server — **any MCP-compatible agent** (Claude Desktop, Claude Code, Cursor, Continue, …) can use its 22 tools. No API keys needed (data is Binance's public REST).

### From source (works today)

```bash
git clone https://github.com/Evanciel/evanciel-quant-mcp.git
cd evanciel-quant-mcp
npm install
npm test        # 95/95 — confirms the server boots + tools work
```

Register it with your MCP client (replace `ABSOLUTE_PATH`):

```json
{
  "mcpServers": {
    "quant-mcp": {
      "command": "npx",
      "args": ["-y", "tsx", "ABSOLUTE_PATH/evanciel-quant-mcp/src/mcp-server/index.ts"]
    }
  }
}
```

- **Claude Code (CLI):** `claude mcp add quant-mcp -- npx -y tsx ABSOLUTE_PATH/evanciel-quant-mcp/src/mcp-server/index.ts`
- **Claude Desktop:** `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) · `%APPDATA%\Claude\claude_desktop_config.json` (Windows)
- **Cursor:** `.cursor/mcp.json`

The server announces `quant-mcp server ready (stdio) — 22 tools` on stderr.

### Via npm (after publish)

```json
{ "mcpServers": { "quant-mcp": { "command": "npx", "args": ["-y", "quant-mcp"] } } }
```

> See [`examples/usage.md`](examples/usage.md) for ready-to-paste prompts and [`examples/mcp-config.json`](examples/mcp-config.json) for a full config.

---

## What can an agent build?

Talk to your agent in plain language — it assembles the strategy tree, validates it, backtests it, and (optionally) deploys a paper bot:

> *"Build an ETH strategy that only buys in an uptrend regime when RSI is oversold, but stays flat for 6 hours around FOMC. Backtest it on 1h data and tell me if it survives the out-of-sample gate. If it does, run it as a paper bot and open the dashboard."*

> *"Screen BTC, ETH, SOL, BNB for the top 2 by 1-hour momentum every morning at 9am KST, and momentum-trade them."*

> *"Suggest position sizes for a 3-coin basket using inverse-volatility weighting."*

All of the above is expressible **today**, backtested with OOS+DSR, and runnable as paper bots.

---

## Tool reference (22 tools)

Every tool maps 1:1 to a verified pure function and carries the *"risk filter, not alpha source"* disclaimer.

### 📊 Analysis & backtest (8)

| Tool | What it does |
|---|---|
| `validate_strategy` | Validate a composite strategy tree (recursion / weighted / time / scanner bounds). Upstream gate for everything. |
| `backtest` | Backtest + walk-forward 70/30 OOS + PSR (overfit detection). |
| `backtest_short` | Short backtest (sell = open, buy = cover); same signal eval as long → backtest≡live. |
| `detect_regime` | ADX / Kaufman ER / ATR% → trend_up / trend_down / range / high_vol. |
| `derivatives_signal` | Funding (annualized) / OI quadrant / long-short tilt / taker flow (Binance fapi). |
| `suggest_position_size` | EWMA vol-target / ATR / fractional Kelly sizing. |
| `portfolio_risk` | Heat / MDD circuit breaker / correlation adjust (pure, no account). |
| `strategy_factory` | Bulk OOS + Deflated Sharpe survivor filter. Most candidates rejected by design. |

### 🔎 Screening, portfolio & events (3)

| Tool | What it does |
|---|---|
| `scan_universe` | Cross-sectional ranking of a symbol list by gapPct / roc / relVolume / rangePct → top N. |
| `allocate_portfolio` | Capital allocation across symbols: equal / inverse-vol (risk-parity diagonal) / vol-target. |
| `list_events` | Built-in scheduled-event calendars (FOMC) for `event` conditions. |

### 🤖 Strategies, bots & dashboard (7)

| Tool | What it does |
|---|---|
| `save_strategy` | Validate + persist a composite strategy (or a scanner) to the local store. |
| `create_bot` | Create a paper bot from a saved strategy. |
| `start_bot` / `stop_bot` | Run / stop a bot (evaluated every interval, reusing the backtest engine → backtest≡live). |
| `list_bots` / `get_bot_status` | List bots / inspect positions + recent fills + logs. |
| `open_dashboard` | Launch the local (127.0.0.1) real-time HTML dashboard. |

### 🔐 Live trading — bring-your-own-keys (4)

| Tool | What it does |
|---|---|
| `live_status` | Which broker / env (testnet/mock/live) is configured + master switch + hard limits (no key exposure). |
| `get_positions` / `get_balance` | Read your real exchange positions / balance (read-only, BYOK). |
| `place_order` | Real order — **fail-CLOSED 2-step confirmation token** + server-side hard limits (notional cap / symbol allowlist / daily-loss circuit). Mainnet requires `LIVE_TRADING_ENABLED=true`. |

> **Default is paper.** Live trading is off unless you set keys *and* the master switch. Mainnet is gated behind testnet validation.

---

## Strategy expressiveness

A strategy is a **composable JSON tree**. Four node types:

| Node | Meaning |
|---|---|
| `leaf` | A rule-based strategy (indicator conditions → buy/sell). |
| `condition` | `IF <condition> THEN <node> ELSE <node>` — gate any sub-strategy. |
| `composite` | Combine children by `priority` or `weighted`. |
| `scanner` | Screen a universe → rank → pick top N → apply a sub-strategy (with optional wall-clock schedule). |

…and seven **condition types** (all backtest≡live):

| Condition | Expresses |
|---|---|
| `indicator` | 21 indicators (RSI, MACD, SMA/EMA, Bollinger, ADX, …) — add `timeframe` for **multi-timeframe** ("1h trend + 5m entry"). |
| `time` | month / quarter / dayOfWeek / **hour** / **minute** (with `tz`) — time-of-day strategies. |
| `regime` | Market regime ∈ {trend_up, trend_down, range, high_vol} — regime gating. |
| `anchor` | Price vs session anchor (dayOpen / prevClose / sessionHigh-Low / VWAP) × multiplier — gap-and-go / ORB. |
| `spread` | Pair vs another symbol: ratio / diffPct / z-score — pairs / stat-arb. |
| `event` | Within ±N hours of a scheduled event (**FOMC calendar** or inline `times` you supply — earnings, etc.). |
| `performance` | Recent returnPercent / drawdown / winRate gating. |

…plus rich **position management** on any strategy: `stopLoss`, `takeProfit`, **TP ladder** (partial take-profit), **scale-in** (averaging down), **pyramid** (adding to winners), **trailing stop**, and **short / futures** (testnet-validated).

<details>
<summary><b>Example tree</b> — uptrend-only RSI dip-buy, 1h-confirmed, avoids FOMC, with a TP ladder</summary>

```jsonc
{
  "id": "root", "type": "condition", "name": "Avoid FOMC",
  "condition": { "type": "event", "calendar": "FOMC", "hoursBefore": 6, "hoursAfter": 6 },
  "thenNode": { "id": "flat", "type": "leaf", "name": "stay flat", "strategy": { /* no-op */ } },
  "elseNode": {
    "id": "regime", "type": "condition", "name": "Uptrend only",
    "condition": { "type": "regime", "in": ["trend_up"] },
    "thenNode": {
      "id": "mtf", "type": "condition", "name": "1h trend filter",
      "condition": { "type": "indicator", "indicator": "sma", "params": { "period": 50 }, "operator": "gt", "value": 0, "timeframe": "1h" },
      "thenNode": { "id": "leaf", "type": "leaf", "name": "RSI dip", "strategy": {
        "symbol": "ETHUSDT",
        "rules": [{ "action": "buy", "conditions": [{ "indicator": "rsi", "params": { "period": 14 }, "operator": "lt", "value": 35 }], "quantityPercent": 100 }]
      } }
    }
  }
}
```
Deploy with `save_strategy({ tree, stopLossPercent: 5, tpLadder: [{pct:5,sellPct:50},{pct:10,sellPct:50},{pct:15,sellPct:100}] })`.

</details>

---

## Bots & live dashboard

`save_strategy` → `create_bot` → `start_bot` runs a bot that re-evaluates on each closed bar using the **same backtest engine** (so live mirrors backtest, including ladder partial fills). State lives in a local `node:sqlite` store — no account, no cloud.

`open_dashboard` serves a real-time HTML dashboard at `127.0.0.1` (random per-launch token, read-only, Binance public WS for live unrealized PnL). It's built for **non-experts**: plain-language strategy summaries ("only buys in an uptrend when oversold"), 🟢 winning / 🔴 losing / ⚪ idle pills, realized vs unrealized PnL, and multi-symbol scanner positions — with a "details" toggle for the raw strategy DSL.

---

## Risk & execution layer

- **Sizing & portfolio:** `suggest_position_size`, `portfolio_risk`, `allocate_portfolio` — vol-targeting, ATR, Kelly, heat, MDD circuit breakers, correlation adjustment.
- **False-discovery gates:** walk-forward OOS, PSR/DSR (deflated Sharpe), `strategy_factory`.
- **Execution core (key-free, tested):** exchange-resting stop / take-profit / trailing planning (`planProtectiveOrders`), position-drift reconciliation vs the exchange, balance-based sizing, and fill-status classification — so a stop is protected even if the bot process is down. (Live wiring is testnet-gated; see `docs/p0-execution-layer.md`.)

---

## Architecture

```
src/core/         portable, side-effect-free quant engine
  backtest/         indicators, engine, metrics, regime, deflated-sharpe, short-engine
  strategy/         spread-symbols, mtf (multi-timeframe)
  scanner/          rank (cross-sectional screening)
  calendar/         scheduled-event calendars (FOMC)
  position/         ladder (TP/scale-in/pyramid), short
  risk/             sizing, portfolio, allocation
  execution/        protective orders, reconcile (P0 — key-free)
  validation/       one Zod schema for the whole strategy tree
  types/            strategy types
src/data/         binance-public.ts — keyless Binance REST (klines pagination + fapi)
src/store/        node:sqlite local store (bots, strategies, trades, logs)
src/runner/       paper/live bot runner (reuses the backtest engine → backtest≡live)
src/dashboard/    127.0.0.1 real-time HTML dashboard
src/brokers/      multi-broker adapters (Binance + 한국투자/KIS + 키움) + safety gates
src/mcp-server/   stdio MCP server + 22 tools
```

**Design principle:** the live runner *reuses* `runCompositeBacktest`, so adding a condition type means editing exactly three files (types + validation + engine) and live inherits it — backtest ≡ live by construction.

---

## Roadmap

- ✅ Portable core + keyless Binance data
- ✅ MCP server + 22 tools (analysis, screening, portfolio, events, bots, live BYOK)
- ✅ Strategy expressiveness: indicator/time/regime/anchor/spread/MTF/event conditions + scanner nodes
- ✅ Position management: SL/TP, TP ladder, scale-in, pyramid, trailing, short/futures
- ✅ Paper bot runner + real-time dashboard
- ✅ P0 execution core (resting stops / reconcile / balance sizing) — key-free, tested
- ⏳ Live execution wiring + money-path E2E (testnet-gated)
- ⏳ Non-crypto data (equities/FX), order-book/microstructure, options

---

## Safety

- **Keyless by default** — analysis tools read only *public* market data; they never see your account and never trade.
- **Paper-first** — bots are paper unless you set exchange keys *and* the master switch (`LIVE_TRADING_ENABLED`).
- **Server-side hard limits** — notional cap, symbol allowlist, daily-loss circuit breaker (LLM cannot bypass).
- **2-step order confirmation** — `place_order` is fail-closed: preview returns a token; execution requires the same args + token.
- **Dashboard** — binds to `127.0.0.1` only, random per-launch token, read-only, no secrets transmitted.

See [`SETUP-LIVE.md`](SETUP-LIVE.md) before enabling live trading.

---

## Contributing

Issues and PRs welcome. Conventions:

```bash
npm run typecheck   # tsc --noEmit (must be clean)
npm test            # vitest (95/95)
npm run build       # esbuild single-file bundle → dist/
```

New condition types follow the **3-file pattern** (`types/strategy.ts` + `validation/composite-node.ts` + `backtest/engine.ts`); the runner inherits them automatically. Keep core functions **pure** (no I/O) so backtest ≡ live holds.

---

## License

[MIT](LICENSE) © Evanciel

> The portable core was extracted from a parent project and verified by an adversarial multi-agent portability + correctness review. **Not financial advice — for research and education.**
