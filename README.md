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

## v1 tool surface (planned, PR #3-4)

`validate_strategy`, `backtest`, `backtest_short`, `detect_regime`, `derivatives_signal`, `suggest_position_size`, `portfolio_risk`, `strategy_factory` — each maps 1:1 to a verified pure engine function. Every description carries the "risk filter, not alpha source" disclaimer.

[stock-autotrade]: ../stock-autotrade
