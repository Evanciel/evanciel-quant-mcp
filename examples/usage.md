# Using quant-mcp from an agent

Once the server is connected (see README → "Use with any MCP client"), your agent has 8 tools.
All data is **Binance public** (no keys, no account). Honest framing: these are **risk-filter + analysis**
tools, **not an alpha source** — most backtests will (correctly) look unimpressive, and the factory tool
rejects most candidates by design.

Below: what to say to the agent, the underlying tool call, and a representative response shape.

A strategy "tree" is the input for validate/backtest. Minimal leaf example:

```json
{
  "id": "leaf", "type": "leaf", "name": "RSI",
  "strategy": {
    "id": "s", "userId": "u", "name": "RSI", "description": "", "symbol": "BTCUSDT",
    "rules": [
      { "id": "b", "action": "buy",  "conditions": [{ "id": "c1", "indicator": "rsi", "params": { "period": 14 }, "operator": "lt", "value": 35 }], "quantityPercent": 100 },
      { "id": "s", "action": "sell", "conditions": [{ "id": "c2", "indicator": "rsi", "params": { "period": 14 }, "operator": "gt", "value": 65 }], "quantityPercent": 100 }
    ],
    "isActive": true, "createdAt": "2025-01-01", "updatedAt": "2025-01-01"
  }
}
```

---

## 1. validate_strategy — gate every tree first
> "Validate this strategy tree."

```jsonc
// → { "ok": true, "valid": true, "error": null }
```

## 2. backtest — run + walk-forward OOS + PSR
> "Backtest this RSI strategy on BTCUSDT 1d over 300 bars."

`backtest` `{ tree, symbol: "BTCUSDT", interval: "1d", days: 300 }`
```jsonc
// → {
//   ok: true, symbol, interval, bars: 300,
//   stats: { totalReturnPercent: -22.8, maxDrawdownPercent: 38.4, winRate: 33.3, totalTrades: 7, profitFactor: 0.44, sharpeRatio: -0.70 },
//   oos:  { split: 0.7, testPsr: 0.21, robust: false, ... },
//   verdict: { profitable: false, oosRobust: false, oosPsr: 0.21 }
// }   ← honest: a naive RSI strat is rejected by the OOS gate. That's the point.
```

## 3. backtest_short — sell=open short, buy=cover
> "Backtest the short side with a 5% stop and 3% trailing."

`backtest_short` `{ tree, symbol, interval, days, risk: { stopLossPercent: 5, trailingStopPercent: 3 } }`
```jsonc
// → { ok: true, side: "short", stats: {...}, verdict: { profitable: ... } }
```

## 4. detect_regime — trend / range / high_vol
> "What regime is ETHUSDT in on the 4h?"

`detect_regime` `{ symbol: "ETHUSDT", interval: "4h", days: 200 }`
```jsonc
// → { ok: true, label: "trend_down", adx: 70.1, efficiencyRatio: ..., atrPct: ..., direction: "down", ... }
```

## 5. derivatives_signal — funding / OI / long-short (futures)
> "Show BTC perp funding and OI signal."

`derivatives_signal` `{ symbol: "BTCUSDT", period: "1h", lookback: 24 }`
```jsonc
// → { ok: true, fundingApr: 0.0025, fundingExtreme: false, oiRegime: {...}, topTraderTilt: ..., takerFlow: ...,
//     fetched: { funding: true, oi: true, ... } }   // fapi geo-blockable → fields may be null + noted
```

## 6. suggest_position_size — vol-target / ATR / Kelly
> "Size a BTCUSDT position for 100k equity targeting 20% annual vol."

`suggest_position_size` `{ symbol: "BTCUSDT", equity: 100000, method: "vol_target", targetVolAnnual: 0.2 }`
```jsonc
// → { ok: true, price: 62848, atr: ..., realizedVolAnnual: 0.44, notional: 45385, fractionOfEquity: ..., method: "vol_target" }
```

## 7. portfolio_risk — heat / MDD circuit (you supply positions)
> "Given these positions and equity, am I over my risk budget?"

`portfolio_risk` `{ positions: [{ symbol: "BTCUSDT", riskFraction: 0.05 }, { symbol: "ETHUSDT", riskFraction: 0.04 }], equity: 95000, peakEquity: 100000 }`
```jsonc
// → { ok: true, heat: 0.09, effectiveRisk: ..., ddPct: 0.05, state: "...", allowNewEntry: true, sizeMultiplier: 1, reasons: [...] }
```
> Note: v1 has **no account access** — you pass positions in. (Fetching *your live* positions is v2, bring-your-own-keys.)

## 8. strategy_factory — bulk OOS + Deflated Sharpe survivor filter
> "Screen these 5 candidate strategies; keep only DSR-survivors."

`strategy_factory` `{ candidates: [{ id, tree }, ...], symbol: "BTCUSDT", interval: "1d", days: 300, minDsr: 0.95 }`
```jsonc
// → { ok: true, total: 5, evaluated: 5, survivorCount: 0, survivors: [], rows: [...],
//     note: "다중검정 보정 ... 대부분 기각이 정상(알파 생성기 아님)" }   ← most candidates rejected = correct behavior
```

---

### What this is NOT
- ❌ It does **not** show your real portfolio/positions (no login, no DB). That live dashboard is a separate app.
- ❌ It does **not** place trades. v1 is analysis/backtest only.
- ✅ It **is** a portable quant engine any MCP agent can call for backtesting, risk sizing, regime, and false-discovery filtering on public market data.
