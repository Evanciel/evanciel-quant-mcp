# Contributing to quant-mcp

Thanks for your interest. Issues and PRs are welcome. This project is deliberately
**honest about its scope**: it is a *risk filter and expressiveness layer, not an
alpha source* (see the README's "Honest positioning"). Contributions should preserve
that framing — **no tool or doc advertises expected returns.**

## Ground rules (the invariants)

These hold for every change:

- **backtest ≡ live.** The live runner (`src/runner/runner.ts`) *reuses* the backtest
  engine (`runCompositeBacktest`). Signal evaluation and position sizing are the
  *same pure functions* in backtest, paper, and live. A change that alters one side
  only (a signal that behaves differently live vs. backtest) is a divergence bug — don't.
  (Order *execution* legitimately differs: live sends real market orders, so slippage
  and fees won't match the simulation. That's expected; the *decisions* must not diverge.)
- **Shared money-path primitives.** Every real/protective order — whichever of the
  *two* entry points it comes from — enforces the same safety stack, in order:
  `liveGate` (testnet/mock only unless the mainnet master switch is on) →
  `checkLimits` (notional cap / symbol allowlist / daily-loss circuit) → audit log.
  The two entry points are: (1) **manual** orders via `src/mcp-server/live-handlers.ts`
  (`place_order` / `place_protective`), and (2) **autonomous bot + resting-protective**
  orders via `src/runner/runner.ts` (`fillOrder` → `adapter.placeOrder`, and
  `syncProtective` / `planProtectiveOrders`). The two-step `confirmToken`
  (preview → confirm, hash-bound, single-use) applies **only** to the manual
  live-handlers path; **autonomous bots have no per-order token** — they are
  pre-authorized once at `create_bot(mode:live)` and bounded by the master switch +
  hard limits + idempotency instead. Never re-implement or bypass either path's
  `liveGate` / `checkLimits` / audit. (This mirrors `SECURITY.md`'s "Security model".)
- **Paper-first, mainnet OFF.** No change may flip the default behavior to live.
  Bots are paper unless the user sets exchange keys *and* `LIVE_TRADING_ENABLED`.
- **Core stays pure.** Functions under `src/core/**` have no I/O (no network, no disk).
  Purity is what makes backtest ≡ live hold by construction.
- **Keep the Korean comment style** already used throughout the source.

## Dev setup

```bash
git clone https://github.com/Evanciel/evanciel-quant-mcp.git
cd evanciel-quant-mcp
npm install
```

Requires **Node >= 22** (the build targets `node22`; the repo uses `node:sqlite`,
which is only stable on 22+). An `ExperimentalWarning: SQLite is an experimental
feature` line on stderr during tests is expected and harmless.

## Before you open a PR

Run all three — they must pass:

```bash
npm run typecheck   # tsc --noEmit — must be clean (no errors)
npm test            # vitest run — all tests pass
npm run build       # esbuild single-file bundle → dist/index.js
```

CI runs the same `typecheck → audit → test` on Node 22 for every push/PR.

Add a regression test under `test/` for any bug you fix or feature you add, so the
same regression can't silently come back.

## Adding a new condition type — the 3-file pattern

The strategy tree is one validated schema, and the runner inherits the engine.
A new **condition type** touches exactly three files; the live runner then gets it
for free (this is *how* backtest ≡ live is preserved):

1. `src/core/types/strategy.ts` — add the condition's TypeScript type.
2. `src/core/validation/composite-node.ts` — add its Zod validation (bounds, refinements).
3. `src/core/backtest/engine.ts` — add its evaluation in `evaluateCondition`.

Because `runner.ts` reuses `runCompositeBacktest`, you do **not** write a separate
live code path — and you must not. If you find yourself special-casing a condition
in the runner, stop: that's a divergence.

New MCP tools are registered in `src/mcp-server/index.ts` (one `server.registerTool`
each). If you add or remove a tool, update the tool count in **both** READMEs
(`README.md` / `README.ko.md`) and the stderr banner in `index.ts` — there's a
regression test (`test/release-hygiene.test.ts`) that asserts they stay in sync.

## Style

- TypeScript **strict** (`tsconfig.json` `strict: true`), **ESM** (`"type": "module"`).
- No `any` where a real type is reasonable; prefer explicit return types on exported functions.
- Match the existing Korean inline-comment style.

## Reporting security issues

Please **do not** open a public issue for vulnerabilities — see [SECURITY.md](SECURITY.md).
And never paste exchange API keys into an issue, PR, or the agent chat.
