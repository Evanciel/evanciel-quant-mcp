# quant-mcp

> Open-source, MIT-licensed quant MCP server. A composable backtesting + risk engine exposed over the Model Context Protocol.

## ⚠️ Honest positioning: risk filter, not alpha source

This server does **not** claim to find alpha. The parent project's deep research concluded that retail directional alpha on this kind of infra is ≈ 0 (243 out-of-sample optimizations → robust alpha of 0; overfitting confirmed). What quant-mcp gives you that is genuinely valuable:

- **Risk control** — position sizing (EWMA vol-target / ATR / fractional Kelly), MDD circuit breakers, portfolio heat, stop/trailing/liquidation math.
- **False-discovery filtering** — Deflated / Probabilistic Sharpe (DSR/PSR), walk-forward OOS gating. *The factory tool rejects most candidates by design — that is correct, not a bug.*
- **Expressiveness** — a composable strategy tree (indicators × conditions × weighted/time/regime nodes) with one validated schema, and **backtest ≡ live parity** (the same pure functions drive both).

No tool advertises expected returns.

## Status

- **v1 (this scaffold)**: analysis / backtest only. Binance **public** data (no API keys). No DB, no account, no trading.
- **v2 (roadmap)**: live execution, bring-your-own-keys, multi-broker (Binance + 한국투자 + 키움). See `docs`.

## Provenance

The portable core was extracted from [stock-autotrade] and verified by an adversarial multi-agent portability review (40 modules analyzed → the pure side-effect-free quant core copied as-is, alias-rewritten only). Full design + extraction plan lives in the parent repo at `docs/02-design/quant-mcp-v1-design.md`.

## Layout

```
src/core/        portable quant engine (indicators, backtest, position, risk, signals, validation)
src/data/        binance-public.ts — keyless Binance REST (klines pagination + fapi derivatives)
src/mcp-server/  MCP server + tools   (PR #3-4 — TODO)
src/brokers/     v2 broker port scaffold (PR #5 — TODO)
```

## Build

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
```

## Use with any MCP client

quant-mcp is a stdio MCP server, so **any MCP-compatible agent** (Claude Desktop, Cursor, Claude Code, Continue, etc.) can use its 8 tools.

**1. Get it running locally**
```bash
git clone https://github.com/Evanciel/evanciel-quant-mcp.git
cd evanciel-quant-mcp
npm install          # installs the MCP SDK, zod, tsx
npm test             # optional: confirms the server boots + tools work (14/14)
```

**2. Register the server** — add to your client's MCP config (see [`examples/mcp-config.json`](examples/mcp-config.json)). Replace `ABSOLUTE_PATH` with your clone location:
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
- **Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) / `%APPDATA%\Claude\claude_desktop_config.json` (Windows)
- **Cursor**: `.cursor/mcp.json`
- **Claude Code (CLI)**: `claude mcp add quant-mcp -- npx -y tsx ABSOLUTE_PATH/evanciel-quant-mcp/src/mcp-server/index.ts`

**3. Verify** — the server announces `quant-mcp server ready (stdio) — 8 tools` on stderr, and your client should list 8 tools (`validate_strategy`, `backtest`, …).

**4. Use it** — see [`examples/usage.md`](examples/usage.md) for example prompts + tool inputs/outputs. e.g. *"Backtest this RSI strategy on BTCUSDT 1d, and tell me if it survives the out-of-sample gate."*

> ⚠️ **Scope reminder**: these tools analyze **public** market data — they do **not** see your account/positions and do **not** trade. (Reading *your* live portfolio = v2, bring-your-own-keys; not built yet.)

## v1 tool surface (implemented ✅)

8 stdio MCP tools, each mapping 1:1 to a verified pure engine function. Every description carries the "risk filter, not alpha source" disclaimer.

| Tool | What it does |
|---|---|
| `validate_strategy` | Validate a composite strategy tree (recursion/weighted/time bounds). Upstream gate for all tools. |
| `backtest` | Backtest + walk-forward 70/30 OOS + PSR (overfit detection). |
| `backtest_short` | Short backtest (sell=open, buy=cover); same signal eval as long → backtest≡live. |
| `detect_regime` | ADX / Kaufman ER / ATR% → trend/range/high_vol. |
| `derivatives_signal` | fapi funding (annualized) / OI quadrant / long-short tilt / taker flow. |
| `suggest_position_size` | EWMA vol-target / ATR / fractional Kelly. |
| `portfolio_risk` | Heat / MDD circuit breaker / correlation adjust (pure, no account). |
| `strategy_factory` | Bulk OOS + Deflated Sharpe survivor filter. Most candidates rejected by design. |

Run the server: `npm run dev` (stdio). Live data smoke (real Binance): `npx tsx scripts/live-smoke.ts`.

### Status
- ✅ PR #1-2: portable core + Binance public data layer
- ✅ PR #3-4: MCP server (stdio) + 8 tools + protocol round-trip test
- ✅ PR #5: broker port scaffold (v2 contract) + CI
- Verified: `tsc --noEmit` clean, `vitest` 14/14 (incl. MCP protocol round-trip), live Binance E2E pass.
- v2 (roadmap): live execution, bring-your-own-keys, Binance + 한국투자(KIS) + 키움 adapters. Note: Kiwoom needs a dedicated adapter (not KIS-compatible).

[stock-autotrade]: ../stock-autotrade
