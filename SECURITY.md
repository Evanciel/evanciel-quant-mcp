# Security Policy

## Supported versions

quant-mcp is at an early `0.1.x`. Security fixes land on the latest `0.1.x` release;
there is no separate LTS line yet.

| Version | Supported |
|---|---|
| 0.1.x | ✅ |
| < 0.1 | ❌ |

## Reporting a vulnerability

**Please report security issues privately — do not open a public GitHub issue.**

Preferred channel: open a **GitHub Security Advisory** (Security → *Report a
vulnerability*) on the repository
(<https://github.com/Evanciel/evanciel-quant-mcp/security/advisories/new>).
If you cannot use that, contact the maintainer privately through the repository's
GitHub profile rather than a public issue.

Please include:

- a description of the issue and its impact,
- steps to reproduce (a minimal repro or PoC if possible),
- affected version / commit,
- any suggested remediation.

We aim to acknowledge a report within a few days and to keep you updated as we
investigate and ship a fix. Coordinated disclosure is appreciated — give us a
reasonable window to release a patch before any public write-up.

## Never put secrets in a report (or in the agent chat)

Exchange API keys are **secrets**. Do not paste them into an issue, a PR, an
advisory, or the AI agent conversation. The project stores keys with the CLI
wizard (`npx quant-mcp setup`), the dashboard's ⚙️ settings form, or env vars;
they live in `~/.quant-mcp/credentials.env` (`chmod 600`, gitignored), are shown
**masked only**, and can't be read back. If a key is ever exposed (in a log, a
screenshot, or a chat), **revoke and reissue it** on the exchange immediately.

## Security model (what the project already enforces)

These are design guarantees, not promises about your funds:

- **Keyless by default** — analysis tools read only *public* market data; they never
  see your account and never trade.
- **Paper-first, mainnet OFF** — bots are paper unless you set keys *and* the master
  switch `LIVE_TRADING_ENABLED`. Mainnet is gated behind testnet validation.
- **Single money-path** — every real/protective order goes through one handler that
  always enforces `liveGate` (testnet/mock only unless master-on) → server-side hard
  limits (notional cap / symbol allowlist / daily-loss circuit) → audit log. On top of
  that, **manual** orders (`place_order` / `place_protective`) require a fail-closed
  **two-step confirm token** (preview → confirm, hash-bound, single-use). **Autonomous
  bots have no per-order token** — they are pre-authorized once at `create_bot(mode:live)`;
  what bounds them is the gate, the hard limits, and idempotency, not a token per order.
  The LLM cannot bypass the gate or the limits.
- **Dashboard** binds to `127.0.0.1` only; a one-time bootstrap token is exchanged
  for an HttpOnly session cookie (the token isn't exposed in the page or URL
  afterwards), with Host + Origin checks and a self-hosted chart library (no
  third-party scripts).
- **Webhook SSRF gate** — event-alert webhooks are HTTPS-only with an exact
  Slack/Discord host allowlist, no IP literals / userinfo / non-443 ports, and
  `redirect: 'error'`.
- **Mainnet pre-flight** — `npx tsx scripts/verify-mainnet-readiness.ts` runs a
  read-only GO/NO-GO check (withdrawal-permission OFF, IP restriction, hard-limit
  self-test) and places **zero orders**.

## Known limitations before mainnet (be honest about these)

The Binance **testnet** money-path is verified, and the defaults are paper / mainnet-OFF.
But before trading **real funds** you should understand what is *not* yet covered. None of
these affect the paper default or the testnet-verified spot flow:

- **Korean brokers (KIS / 키움) have no exchange-resting stop, and fill confirmation is
  weak.** Resting SL/TP at the exchange is Binance-only; a KR live order can be sent, but
  there is no exchange-side stop, so a bot crash leaves the position unprotected. KR fill
  reporting can also surface a *pending* order as if it had filled (ledger drift possible).
  See [`docs/kr-broker-gap-analysis.md`](docs/kr-broker-gap-analysis.md) (resting-stop gap,
  fill-cycle not yet confirmed).
- **Protective orders are spot-Binance OCO only.** The *manual* `place_protective` tool
  places a real OCO (one-cancels-the-other) on a spot long. **Autonomous bots do not use
  OCO** — they place two independent resting orders (a STOP and a take-profit) via
  `syncProtective` / `planProtectiveOrders`. Futures and non-Binance brokers have no resting
  protective orders yet. (The OCO acknowledgement parser is also being hardened separately so
  a missing `orderListId` / empty `orderReports` can never read back as a successful order.)
- **Autonomous bots have no per-order confirm token.** Manual orders are guarded by the
  fail-closed two-step token; a `mode:live` bot is pre-authorized once at `create_bot` and is
  bounded by the master switch + hard limits + idempotency instead (see the Security model
  above). That is a deliberate design, not a per-order approval.

These are tracked, not hidden — the project's value (the shared backtest≡live code structure
and the risk controls) stands regardless. Trade real funds only after testnet validation, in
small size, with the master switch and hard limits set.

> Not financial advice — for research and education. You are responsible for any
> keys you add and any live trading you enable.
