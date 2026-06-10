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
  enforces `liveGate` (testnet/mock only unless master-on) → server-side hard limits
  (notional cap / symbol allowlist / daily-loss circuit) → a fail-closed **two-step
  confirm token** (preview → confirm, hash-bound, single-use) → audit log. The LLM
  cannot bypass these.
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

> Not financial advice — for research and education. You are responsible for any
> keys you add and any live trading you enable.
