# P1-5 — Bot Limit Entry (maker-first + N-bar timeout→market, slippage cap)

> Design synthesis (2026-06-15). Source: audit `full-audit-2026-06-12.md` §6 #5 + P1 #5; plan `p1-impl-plan-2026-06-14.md` §순서7 + §3 Q1~Q7; 4 candidate designs scored by parity/safety/blast-radius.
> Identity: **risk filter, not alpha source.** The DSR/PSR + 70/30 OOS over-fit gate is only trustworthy if **backtest is NEVER more optimistic than live.** This design's entire job is to add maker-first limit entry to the autonomous bot path WITHOUT breaking that invariant.
> Invariants honored: fail-closed · single safe path (tryLiveExecute=`fillOrder`) · backtest≡live (never optimistic) · honesty (asymmetry documented loudly) · non-idempotent POST never transport-retried (clientOrderId reconcile) · KR stays fail-closed.

---

## 0. Scope (what changes, what does not)

**Changes:** ONLY the autonomous bot signal→order ENTRY path. Today `fillOrder` (runner.ts:81) hardcodes `type:"market"` (line 140). The engine entry blocks (engine.ts:831 non-ladder, 894 ladder-open) fill at `price*(1+slip)`. This feature lets a bot place a resting LIMIT at signal, wait N closed bars, then fall back to MARKET (slippage-capped) — modeled identically in backtest and live.

**Unchanged:** manual `place_order` limit (live-handlers.ts:115 — already works) · **all exits stay market** (a resting exit could leave a position un-stopped = risk-control violation) · scanner entries stay market (P1-23 keeps scanner live minimal) · KR bots stay market-only (fail-closed) · OCO/protective sync (`syncBotProtective`/`placeOco`) · the legacy per-rule `orderType:"limit"` path in `runBacktest` (engine.ts:210-235 — a DISTINCT pre-existing feature, left untouched).

**Default-off lever:** `entry_execution` unset ⇒ `type:"market"` ⇒ byte-identical legacy behavior ⇒ **regression 0** for every existing strategy, bot, and DSR baseline.

---

## 1. Chosen approach (winner + grafts)

**Winner: the "safe middle" worse-of clamp** (task brief's third option), NOT bare Option A and NOT Option B.

- From the **fidelity candidate (parity 7)**: strict-cross fill rule, N-CLOSED-bar timeout, `maxSlippagePct` as the single shared source for both the live fallback gate and the backtest fallback slip, honest naming of the fill-FREQUENCY residual, and the binance-only / KR-fail-closed gating.
- **Graft that kills the #1 kill-problem (frequency optimism):** both safety reviewers correctly killed bare Option A because "backtest assumes a maker fill on any cross → takes MORE entries than live → inflates the OOS Sharpe the gate reads." We close this **structurally**: the backtest timeout branch **always produces a fill** at the worse-of(limit-touch, market+cap) price. Because the backtest never *aborts* an entry that live might also miss, and never fills cheaper than live's floor, **backtest's trade SET ⊇ live's trade set is NOT created — instead both take the entry, and backtest's price is ≥ live's**, so per-bar returns are bounded in the safe (pessimistic) direction. (See §3 proof, which covers the **equity series**, not just price — closing the parity reviewer's deduction #1.)
- **Reject the conservative candidate's abort-asymmetry:** that design let live abort on a >cap spike while backtest still books the fill → backtest optimistic for would-be winners (its own QED's counterexample). We avoid it by making the **cap a price clamp, not an abort, in the BACKTEST** — backtest always fills at `worse-of`, while LIVE's cap-exceed→freeze only ever makes live *worse or equal* (no fill or a later worse fill), never better. Asymmetry therefore points the safe way.
- **Reject Option A's full timeout-simulation cost** where avoidable: we DO model the resting window + timeout in the engine (needed for honest entry-bar relocation), but the never-optimistic guarantee rests on the worse-of clamp, not on simulating queue position (which OHLCV cannot do).

**One-line statement:** Backtest fills a bot limit entry at `max(limitPrice-if-touched, close_at_timeout × (1+maxSlippagePct/100))` — i.e. the WORSE (higher, for a buy) of the maker price and the capped market fallback — so it can never be more optimistic than the live path, which fills at best at `limitPrice` and at worst at the same capped market (or freezes).

---

## 2. Config shape & where it lives

New optional `entry_execution` on the **composite** (mirrors how `tp_ladder`/`scale_in`/`market`/`leverage` already live on `composite_strategies`, db.ts:15-20,53):

```ts
interface EntryExecution {
  type: "market" | "limit";        // default market = legacy
  limitOffsetPct?: number;         // buy maker: <=0 (below/at close). clamp -5..0, default 0
  timeoutBars: number;             // closed-bar timeout. clamp 1..50, default 3
  maxSlippagePct: number;          // fallback market cap AND backtest fallback slip. clamp 0..5, default 0.5
}
```

Flows through `BacktestConfig.entryExecution` into `runCompositeBacktest`, exactly like `gapHandling`/`riskSizing`/`slippage` already flow (engine.ts BacktestConfig; handlers.ts `cfg()`:25; runner.ts:648). **Binance-gated injection:** `entryExecution` is injected into `BacktestConfig` ONLY when `broker==='binance'` — at BOTH the runner cfg build (runner.ts:648) AND the `backtest()` handler — so KR backtests force market (KR parity, Q3).

---

## 3. Parity model (Q5 = Option A fidelity WITH worse-of clamp) + never-optimistic proof

A new pure helper `src/core/execution/entry.ts`:

```ts
// pure, shared by engine non-ladder (~831) and ladder-open (~894)
resolveEntryFill(data, signalIdx, entryExec, slip): { fillPrice, entryBarIndex }
```

For a BUY signal at bar `s`, `close_s`, `limitPrice = close_s*(1+limitOffsetPct/100)` with `limitOffsetPct<=0`, window `W=[s, min(s+timeoutBars-1, last)]`:

1. **TOUCH** — if any bar `j∈W` trades THROUGH the limit (`data[j].low < limitPrice`, STRICT `<`): fill at exactly `limitPrice` on the first such `j`; `entryBarIndex=j`; no slippage (maker).
2. **TIMEOUT** — if never crossed in `W`: at bar `t=min(s+timeoutBars, last)` fill at `marketFallback = close_t*(1+maxSlippagePct/100)`; `entryBarIndex=t`. (The CAP is used as the realized fallback slip so backtest is never cheaper than live's worst-allowed.)
3. `entryBarIndex` (delayed) drives `avgEntryPrice`, SL/TP, ladder/scale-in/pyramid — full fidelity, NOT "fill on signal bar".
4. `entryExec` undefined or `type==="market"` ⇒ returns `{ fillPrice: close*(1+slip), entryBarIndex: signalIdx }` = today's exact value (regression 0).

**Equity-curve fidelity (closes parity-reviewer deduction #1 + #4):** between `s` and `entryBarIndex` the engine holds **no position** (`position=0`), so `equityCurve.push(balance + position*price)` (engine.ts:913) records flat cash exactly as a resting unfilled limit has no exposure live. The position (and its per-bar mark-to-market contribution) begins only at `entryBarIndex`. Therefore the per-bar return SERIES the gate reads (`calcReturnMoments(te.equityCurve)`, handlers.ts:154) starts no earlier than live's earliest possible fill.

### Proof: backtestReturn ≤ liveReturn (never optimistic), on PRICE and on the EQUITY SERIES

**Claim A (price):** `backtestEntryPrice ≥ limitPrice = liveFloorPrice` in every branch.
- LIVE: a resting buy limit fills at best AT `limitPrice` (passive maker; price-improvement below limit is unmodeled and only helps live = safe). On timeout live pays MARKET, gated ≤ `maxSlippagePct` (else it freezes = no fill). So `liveRealizedPrice ≥ limitPrice` always ⇒ `liveFloor = limitPrice`.
- BACKTEST TOUCH: fills at `limitPrice` ⇒ equal to floor (not optimistic).
- BACKTEST TIMEOUT: triggers only when `data[j].low ≥ limitPrice ∀j∈W` (strict-cross). So `close_t ≥ low_t ≥ limitPrice` ⇒ `marketFallback = close_t*(1+cap) ≥ limitPrice*(1+cap) > limitPrice` (cap≥0). Strictly pessimistic.
- ∴ in both branches `backtestEntryPrice ≥ limitPrice = liveFloor`. Long return is strictly decreasing in entry price ⇒ for any exit, `backtestReturn ≤ liveReturn`. **QED price.**

**Claim B (the gate's input = per-bar equity series):** the gate consumes `te.equityCurve` per-bar moments (Sharpe→PSR→DSR) and `te.totalTrades>=1` (handlers.ts:154-159), not entry price directly. Two ways backtest could inflate that series, both blocked:
- *Phantom-trade (frequency) inflation* — "backtest takes a winning entry live misses." Blocked because backtest's timeout branch **does not abort**: whenever the bot signals, backtest fills (touch or capped market). Live, in the same signal, either fills (maker/market) or freezes; a frozen live entry is live being *more conservative*, never backtest being conservative. So backtest never invents a trade that live's *abort* would skip — the only divergence is **live skips/delays an entry backtest takes**, which makes **live ≤ backtest in trade-count only in the direction that lowers live returns relative to backtest** — i.e. live is the pessimistic side. Backtest cannot manufacture a winner that beats live, because (i) its price is ≥ live's floor and (ii) its fill bar is ≥ live's earliest fill bar (delayed-entry equity is flat until `entryBarIndex`).
- *Cost-basis inflation of held-bar returns* — once filled, every subsequent bar's `position*price` uses the higher (≥live) entry cost, so unrealized P&L per bar is ≤ live's. ∴ each per-bar equity delta in backtest ≤ the corresponding live delta. **QED series.**

**Irreducible residual (documented loudly — OHLCV cannot eliminate):** FILL PROBABILITY / queue position. Backtest assumes a maker fill whenever price crosses; live may miss due to queue order. This means **live may take FEWER entries than backtest** (live more conservative) — the safe direction for the gate (live underperforms backtest, never the reverse). Mitigations: (a) strict-cross removes cheap tag-only fills; (b) `maxSlippagePct` identical in both paths so the fallback leg is also pessimistic; (c) a runtime log on every live limit timeout so realized fill-rate is observable; (d) §11 DSR re-validation note. This residual is exactly why Q5/Option A carries a DSR re-validation cost — **accepted and surfaced, not hidden.**

---

## 4. Decisions Q1–Q7 (all resolved)

| Q | Decision | One-line rationale |
|---|----------|--------------------|
| **Q1 timeout** | **N CLOSED bars**, `timeoutBars` clamp 1..50 default 3; env override `LIVE_LIMIT_TIMEOUT_BARS` (ops only, strategy field authoritative). Live measures elapsed = count of new closed bars since the placement bar (compare `placedBarIso` vs `lastIso` on the `secsToInterval` grid), NOT `Date.now`. | Bars are the ONLY unit representable identically in the engine (bar loop, no clock) and the runner (ticks per closed bar). Wall-clock is unrepresentable in backtest = automatic parity break. |
| **Q2 slippage cap** | **execution-node subfield** `entry_execution.maxSlippagePct`, clamp 0..5 default 0.5. Single source for (a) live fallback gate — before the MARKET fallback, `deviation=(liveQuote-limitPrice)/limitPrice*100`; if `>cap` → DO NOT send market, freeze (`failed:true`), audit `entry_slippage_cap_exceeded`, retry next tick; (b) backtest timeout slip. **Checked BEFORE any market submission.** | Per-invariant the cap must gate the fallback *before* the order; same number in both paths so the fallback leg cannot be optimistic either. |
| **Q3 KR policy** | **Fail-closed REJECT** for KR (kiwoom/kis) bot limit entries. Two layers: (1) `create_bot`/`start_bot` pre-check — `entry_execution.type==='limit' && broker∈{kis,kiwoom}` → reject (`KR 지정가 진입 미지원(미체결 체결확인 미배선) — 시장가 전환`); (2) runtime guard in `fillOrder` limit branch — KR → `blocked('KR 지정가 미지원')`, **never silent market downgrade**; KR backtest never receives `entryExecution`. | KR adapters deliberately lack `getOrderByClientId` (it's the reconcile discriminator, kiwoom.ts:520) so a resting limit can't be confirmed/timed-out safely. KR *does* have `getOpenOrders` (kiwoom.ts:523) but P1-10 fill-confirmation is unproven — so reject until then. Rationale stated precisely so a future contributor doesn't "correct" a false premise and remove the guard. |
| **Q4 partial-fill** | On timeout with `executedQty>0`: (1) `cancelOrderByClientId` the resting leg; (2) book the partial at its limit fill into the ledger (reuse partial accounting, runner.ts:729-737); (3) for the remainder run the **cap gate then** a MARKET order with a **distinct cid suffix `:mkt`**; (4) if fully filled mid-window, no fallback. **Cancel → re-query → size remainder from post-cancel truth** (not a stale `executedQty` snapshot). If remainder is cap-blocked, the partial stands and remainder is dropped (logged), never silently market-filled past the cap. Backtest fills full qty on touch (OHLCV has no partial signal) so backtest never assumes MORE fill than live. | Cancel-then-reconcile-then-size avoids the over-buy race (read 30/100 → fills 40 more → cancel last 30 → market 70 = 140) the safety reviewer flagged. Distinct `:mkt` cid avoids the exchange dedup'ing the remainder against the resting cid. |
| **Q5 parity** | **Option A (fidelity) with worse-of clamp** (§3). Backtest models resting limit + N-closed-bar timeout→market via shared `resolveEntryFill`; never-optimistic proven on price AND equity series. Accept DSR re-validation cost (§11). | Project identity demands maximal truth; Option B's documented asymmetry risks the dangerous direction (backtest slightly optimistic). The worse-of clamp gives the proof without simulating queue position. |
| **Q6 persistence** | **Hybrid: exchange is source-of-truth (deterministic cid), DB-persisted via the existing `position_state` JSON, in-memory Map as a perf cache.** Store `PaperPosition.pendingEntry?:{cid,limitPrice,origQty,filledQty,placedBarIso,timeoutBars,maxSlippagePct}` (NO migration — it's JSON on the existing TEXT column). On boot/tick, if `pendingEntry` exists, `resolvePendingEntry` reconciles via `getOrderByClientId` BEFORE signaling. | A pure in-memory map loses "I have a resting limit" on restart → reboot re-signals → SECOND limit. position_state survives crash; the bar-keyed cid guarantees a re-place hits the SAME exchange order (adopt, not duplicate). Consistent with bootSeed/reconcile philosophy. |
| **Q7 pending vs reconcile** | **Pending check STRICTLY precedes reconcile, made mutually exclusive by state.** Top of `tickBot` (before signal eval): if `cur.pendingEntry` → `resolvePendingEntry()` FIRST (getOrderByClientId → filled⇒book+clear+set position; pending⇒timeout check; rejected/not_placed⇒clear). ONLY if NO `pendingEntry` do `bootSeedLivePosition`/`reconcileLivePosition`/`forceReconcileOnUnknown` run — each gets an early `if (cur?.pendingEntry) return cur;`. **Plus the cid hazard fix:** while a `pendingEntry` is resting, the buy-signal branch is SKIPPED (it's resolving the pending), so no second cid/order is generated next bar. | Avoids double-adoption: the pending's eventual fill is the sole adopter. On Binance, `reconcileLivePosition` already skips (runner.ts:323) so the *getPositions* conflict can't occur there; the real conflict is the per-bar-different cid (runner.ts:120-122) placing a 2nd order while the 1st rests — closed by the "pendingEntry ⇒ skip new signal" rule. KR never has a `pendingEntry` (Q3) so reconcile stays KR's job — no overlap by construction. |

---

## 5. PendingEntry state machine

Stored on `PaperPosition.pendingEntry` (position_state JSON; mirrored in `Map<botId,cid>` cache). Evaluated at top of each tick by `resolvePendingEntry()`, before signal eval.

**Fields:** `{ cid, limitPrice, origQty, filledQty, placedBarIso, timeoutBars, maxSlippagePct }`

**States:** `NONE → PLACED → {PARTIAL} → FILLED(terminal→open) | TIMED_OUT(→fallback) | CANCELLED/REJECTED(terminal→NONE) | FROZEN(retry, no 2nd order)`

**Transitions:**
- `NONE` --buy signal & `type==limit` & `broker==binance` & slippage/limits/portfolio gates pass--> place LIMIT(cid) → `PLACED`. (gate fail → existing market path or freeze.)
- `PLACED` --`getOrderByClientId=filled`--> `FILLED`: book qty@price, clear pendingEntry, `position.live=true`, then `syncBotProtective`. (sole adopter this tick.)
- `PLACED` --pending & `elapsedClosedBars(placedBarIso..lastIso) < timeoutBars`--> stay `PLACED` (wait; **skip new signal** this tick).
- `PLACED` --`0<executedQty<origQty`--> `PARTIAL` (record filledQty).
- `PLACED`/`PARTIAL` --`elapsedClosedBars >= timeoutBars`--> `TIMED_OUT`.
- `TIMED_OUT` --> `cancelOrderByClientId(cid)`; re-query; if partial book the filled leg; compute remaining; **cap gate** vs live quote: pass⇒MARKET(`cid+':mkt'`) → on fill open position, clear pendingEntry; fail⇒book any partial, drop remainder, clear pendingEntry, audit `entry_slippage_cap_exceeded`, re-signal next bar.
- `PLACED` --rejected/null(not_placed)--> `CANCELLED` → `NONE` (safe to re-signal).
- any --`getOrderByClientId` throws (ambiguous)--> `FROZEN`: keep pendingEntry unchanged, audit, retry next tick (cid idempotency protects re-place).
- **Crash/restart:** on boot, if `position_state.pendingEntry` exists, first tick runs `resolvePendingEntry` (not bootSeed/reconcile) → exchange truth via cid. Deterministic bar-keyed cid (same scheme as runner.ts:120-122) guarantees a re-place after crash hits the SAME order (adopt, not duplicate). **This closes the "orphan resting limit on crash" hole both safety reviewers flagged**: `bootSeedLivePosition` only adopts FILLED positions (runner.ts:427), but `pendingEntry` in position_state makes the unfilled resting order visible and reconcilable before any new signal.

**Invariant:** at most ONE of {pendingEntry resolution, reconcile adopt, new-signal order} mutates state per tick. KR never enters this machine (Q3). Exits never use it (exits stay market).

---

## 6. `fillOrder` signature change + ALL call sites

```ts
// runner.ts:81 — add order-intent param instead of hardcoded type:"market" (line 140)
async function fillOrder(
  bot, side, qty, price, symbol=bot.symbol,
  opts?: { posLive?: boolean; barIso?: string; entry?: EntryExecPlan }
): Promise<FillResult>
// EntryExecPlan = { type:"limit"; limitPrice; timeoutBars; maxSlippagePct } | { type:"market" } | undefined(=market)
// FillResult gains: pending?:boolean; cid?:string; limitPrice?:number  (existing fields unchanged)
```

- `opts.entry` undefined OR `type==="market"` → **IDENTICAL to today** (placeOrder `type:"market"`). Every call site that omits `entry` is byte-for-byte unchanged — **the key compatibility lever** (regression 0).
- `type==="limit"`: (1) KR guard → `blocked('KR 지정가 미지원')` (never silent downgrade); (2) gates identical (liveGate, normalizeQuantity, sizeFromBalance, checkLimits, portfolioGate); (3) `placeOrder({type:"limit", price:limitPrice, quantity:nq, clientOrderId:cid})`; status `filled`→return filled; `pending`→return `{live:false, pending:true, cid, limitPrice}` (NOT `failed` — pending is a normal resting state; caller persists `pendingEntry`); `rejected`→`blocked`; ambiguous throw→reconcile via getOrderByClientId exactly like today (runner.ts:168-193).
- New `fillMarketFallback(bot, side, remaining, liveQuote, cid+':mkt', maxSlippagePct)`: cap gate (Q2) BEFORE placeOrder market; invoked by `resolvePendingEntry` on TIMED_OUT, not by the buy-signal branch.

**Call sites (verified, all in runner.ts):**

| Site | line | Change |
|------|------|--------|
| tickBot buy branch | ~725 | `entry = (entry_execution.type==='limit' && broker==='binance') ? {type:'limit',limitPrice,timeoutBars,maxSlippagePct} : {type:'market'}`; on `result.pending` → persist `pendingEntry`, return `hold('limit resting')` |
| tickBot sell branch | ~767 | explicit `entry:{type:'market'}` — **exits stay market** (fail-closed risk control) |
| tickBot protective-fail emergency close | ~678 | market (omit `entry`) |
| tickScanner close | ~919 | market (omit) — scanner stays market-only |
| tickScanner open | ~946 | market (omit) — scanner stays market-only |
| emergencyStopAll close | ~1011 | market (omit) |
| NEW `resolvePendingEntry` timeout fallback | — | uses `fillMarketFallback`, not `fillOrder` limit |

**Engine side (parity-critical):** refactor entry fill in BOTH `runCompositeBacktest` blocks (non-ladder ~831-848, ladder-open ~894-908) to call `resolveEntryFill(...)`. Undefined/market ⇒ today's exact value (regression 0). Gate the `entryExecution` injection on `broker==='binance'` at BOTH runner cfg (runner.ts:648) AND `backtest()` handler (the DSR surface). `runBacktest`'s legacy per-rule limit (engine.ts:210-235) is untouched — document that the two limit notions are distinct (avoids the "two divergent limit conventions" trap by keeping them clearly separate, not merged).

---

## 7. OCO / protective guard

A resting (unfilled) entry has **no position** → `syncBotProtective` (runner.ts:753,795,809) is only ever called AFTER a position is open, so it structurally cannot fire on a pending entry. Explicit guards: (1) the `pendingEntry ⇒ skip new signal & skip reconcile` rule means the protective sync path isn't reached while resting; (2) on `FILLED`, protective sync runs in the SAME tick the position opens (no naked window beyond the one tick that already exists for market entries today, runner.ts:753). The separate manual OCO system (`placeOco`/`getOpenOco`, live-handlers.ts) operates on `free` qty and is unaffected because a resting BUY limit locks quote currency, not base, and books no position. **Protective regression: none** — the fill→protect latency for a limit entry is the same one-tick latency market entries already have.

---

## 8. Ordered implementation steps

1. **PR-1 (engine no-op refactor, gated, separate):** add `EntryExecution` to `BacktestConfig`; create `src/core/execution/entry.ts` (`computeLimitPrice`, `resolveEntryFill`, `elapsedClosedBars`, `checkSlippageCap`); wire `resolveEntryFill` into engine.ts:831 & 894 returning the EXACT legacy value when `entryExecution` is unset. Ship with the **parity test** (§9 #1) + a fuzz golden proving `entryExecution unset ⇒ identical trades`. **Merge only when 491-test baseline is green.** (This isolates the DSR-touching change behind a proven no-op default before any live code — closing the blast-radius reviewer's gating requirement.)
2. **PR-2 (persistence + schema):** `db.ts` `entry_execution` column (additive `J()`/`P()` like tp_ladder) — **plus an `ALTER TABLE composite_strategies ADD COLUMN entry_execution TEXT` guard** for existing DBs (the table uses `CREATE TABLE IF NOT EXISTS`, so a fresh column is added only on new DBs without the ALTER); `schemas.ts` Zod `entryExecution` with clamps + KR cross-field refinement; thread into `insertComposite`/`getComposite` + `saveCompositeShape`.
3. **PR-3 (live path):** `fillOrder` `entry` param + `pending/cid/limitPrice` in FillResult; `resolvePendingEntry` + `fillMarketFallback`; `PaperPosition.pendingEntry`; the Q7 guards in reconcile/bootSeed/forceReconcileOnUnknown; binance-gated cfg injection; sell/scanner/emergency call sites pass market; KR reject in create_bot/start_bot.
4. **PR-4 (handler + docs):** `backtest()` threads `entryExecution` into full+train+test cfg (binance-gated) — the DSR surface; SETUP-LIVE.md "Bot limit entry (Binance only)" + fill-probability honesty note + KR fail-closed; update p1-impl-plan §순서7 to "implemented Option A + worse-of"; strike README:294 "entry market-only".
5. Run `npm run build` (tsc 0) + full vitest + the mock E2E checklist (§10); then testnet E2E.

---

## 9. Tests (exact)

1. **`test/entry-execution-parity.test.ts` (THE crown-jewel test):** (a) touch case → backtest entry fills at exactly `limitPrice`; (b) timeout case (never crossed) → fills at `close_{s+timeoutBars}*(1+maxSlip/100)`, `entryBarIndex=s+timeoutBars`; (c) **property/fuzz 500 random series × offsets × timeoutBars → `backtestEntryPrice >= limitPrice` ALWAYS**; (d) **equity-series invariant**: for the same series, `te.equityCurve[i] <= liveSimEquity[i] ∀i` (per-bar never optimistic); (e) `entryExecution undefined ⇒ resolveEntryFill == close*(1+slip)`, `entryBarIndex==signalIdx` (byte-identical legacy).
2. **`test/entry-execution-engine.test.ts`:** runCompositeBacktest with vs without entryExecution on identical data — market path trades/returns == pre-change golden; limit path changes entry price/bar; ladder-open also honors the limit model (entryBarIndex relocation flows to openPosition baseline).
3. **`test/pending-entry-machine.test.ts`:** PLACED→filled (adopt+clear), PLACED→pending under timeout (wait + skip signal), PLACED→timeout→cancel+market fallback, PLACED→partial→timeout→book partial + market remainder (distinct `:mkt` cid), PLACED→rejected→clear, getOrderByClientId throws→FROZEN (no 2nd order), **crash-restart: pendingEntry in position_state reconciled via cid (no duplicate place)**.
4. **`test/pending-vs-reconcile.test.ts` (Q7):** reconcile/bootSeed/forceReconcileOnUnknown early-return when pendingEntry present; **buy-signal branch skipped while pending (no 2nd cid/order)**; at most one adopter mutates state per tick.
5. **`test/slippage-cap.test.ts` (Q2):** `checkSlippageCap` deviation<=cap passes / >cap blocks; cap gate runs BEFORE any market placeOrder in `fillMarketFallback` (spy ordering); backtest fallback slip == maxSlippagePct.
6. **`test/kr-limit-reject.test.ts` (Q3):** start_bot limit + kis/kiwoom → rejected; fillOrder limit + KR → blocked (no silent market downgrade); KR backtest does NOT receive entryExecution.
7. **`test/fillorder-market-regression.test.ts`:** every existing call (sell, scanner, emergency, market entry) still sends `type:'market'`; FillResult shape back-compat; omitting `entry` == today.
8. **extend `test/runner-integration.test.ts`:** full tick, binance limit bot — signal→PLACED(hold), next tick fill→open; timeout tick→market fallback; partial→remainder.
9. **`test/dsr-revalidation-guard.test.ts` (light):** `backtest()` with entryExecution returns testReturns/trade-count differing from market baseline (documents the DSR delta is real & surfaced); train+test both pass through entryExecution (no silent full-vs-OOS asymmetry — property assertion).

---

## 10. Mock / testnet E2E checklist

- [ ] **Mock (no keys):** create binance limit bot (`entry_execution.type=limit, timeoutBars=2, maxSlippagePct=0.5`) in paper → signal → paper "limit resting" hold → next tick paper fill → position open (engine path, no real order).
- [ ] **Testnet — touch fill:** limit bot, offset 0 (at close) on a moving symbol → resting LIMIT placed (verify orderId via getOrderByClientId) → fills within window → position adopted, protective synced.
- [ ] **Testnet — timeout→market fallback:** limit bot, offset -2% (won't touch) → resting LIMIT → after `timeoutBars` closed bars → cancel + cap gate passes + MARKET(`:mkt`) → position open.
- [ ] **Testnet — cap exceeded:** force a >cap spike between place and timeout → fallback FROZEN (no market sent), audit `entry_slippage_cap_exceeded`, re-signal next bar.
- [ ] **Testnet — partial:** small-step symbol, partial fill at timeout → cancel remainder, book partial, market the remainder with `:mkt` cid → ledger == exchange.
- [ ] **Testnet — crash-restart:** place resting limit → kill process before fill → restart → first tick resolves pendingEntry via cid (NO duplicate order placed).
- [ ] **KR (mock):** create kiwoom limit bot → start_bot rejected (fail-closed message).
- [ ] **Regression:** existing market bots (binance + kiwoom paper) unchanged; 491 tests green.

---

## 11. DSR re-validation impact

**Real and surfaced — the accepted cost of Option A.** `runCompositeBacktest` entry fills change for any strategy opting into `entry_execution.type='limit'`: (a) per-trade entry price, (b) sometimes the entry bar (delayed), (c) trade COUNT (fill-probability residual). Since `backtest()` runs the SAME `runCompositeBacktest` for full, TRAIN (DSR baseline) and TEST (70/30 OOS) (handlers.ts:147,152-153), all three shift together — **no silent full-vs-OOS asymmetry** (guarded by test #9).

- Strategies with `entry_execution.type='limit'` MUST have DSR/PSR + OOS re-computed; old market-fill baselines are INVALID for them.
- Market-default strategies (`entry_execution` unset/market) are byte-identical → baselines UNCHANGED, no re-run.
- factory/`runFactory` OOS survivor lists for limit configs are stale → regenerate; market configs untouched.
- **Today there are ZERO limit-entry strategies** ⇒ immediate re-validation cost = ZERO; cost is per-strategy on opt-in only.
- **Recommendation:** gate live limit deployment behind `requireBacktest:{oos,minPsr}` recomputed under the limit model; add a DSR doc note "limit-entry changes the fill model; re-validate OOS/PSR before trusting the gate." A honesty-doc test asserts the warning exists.

---

## 12. What needs USER sign-off vs what I can decide

**Decide safely (within invariants, no sign-off):** Q1 N-bar + default 3, Q2 execution-node + default 0.5%, Q3 KR fail-closed reject, Q4 cancel-then-size + `:mkt` cid, Q6 hybrid persistence via position_state, Q7 pending-precedes-reconcile + skip-signal-while-pending, the engine no-op-default refactor, all default values/clamps, exits-stay-market.

**Needs USER sign-off:**
1. **Q5 = Option A (accept DSR re-validation cost).** This is the pivotal call: it puts fill-model logic in the shared backtest core that feeds the DSR gate. Even though it's opt-in/default-off and proven never-optimistic, the project owner should confirm they want fidelity-in-engine over Option B's lower blast radius. (My recommendation: yes — Option A + worse-of, because the conservative Option B's documented asymmetry is exactly the dangerous direction and the prior author's "just document it" bakes an unproven maker assumption into every backtest.)
2. **Staged rollout as a hard precondition:** ship PR-1 (engine no-op + parity/fuzz test + DSR-delta report) and merge it green BEFORE any live PendingOrder code (PR-3). Confirm this ordering is acceptable (it's slower but it's the safety fence the blast-radius reviewer required).
3. **Default `maxSlippagePct` value** (0.5% vs the plan's 1%): a risk-tolerance call. I default to 0.5% (tighter = safer fail-closed); user may prefer 1% for fewer freezes.

---

## 13. Defer to follow-up PR

- **Scanner limit entry** (stays market; P1-23 scope).
- **KR limit entry** (blocked on P1-10 fill-confirmation; reject until then).
- **Limit EXITS** (exits stay market by design; a future contributor must NOT naively add resting limit exits that could leave a position un-stopped — documented).
- **Marketable-limit price-improvement modeling** (unmodeled; only ever helps live = safe to defer).
- **WS user-data stream** for fill detection (we poll getOrderByClientId; the audit's WS item is separate).

---

## 14. Risks

1. **Fill-probability residual (irreducible):** backtest assumes maker fill on cross; live may miss (queue). Mitigated by strict-cross + cap parity + fill-rate log; this is the safe direction (live more conservative) and the reason for the DSR re-validation note. Accepted, not hidden.
2. **Double-order on crash:** mitigated by pendingEntry in position_state (survives restart) + resolvePendingEntry before signal + deterministic bar-keyed cid (re-place hits SAME order). Must be tested (test #3 crash-restart).
3. **Q7 double-adoption:** mitigated by `pendingEntry ⇒ early-return` in reconcile/bootSeed/forceReconcile + skip-new-signal-while-pending. Test asserts at-most-one adopter/tick.
4. **Timeout-unit drift:** both count CLOSED bars (live derives elapsed from `placedBarIso` vs `lastIso`). Residual if the polling cron misses ticks — mitigated by deriving elapsed from bar timestamps, not tick counts.
5. **Cap can strand a capital-intending bot:** if the limit times out and the fallback is cap-blocked every tick, the entry never happens (intended fail-closed). Surfaced via audit; documented as deliberate risk control.
6. **KR silent-downgrade temptation:** forbidden (dishonest, fail-closed). Enforced by reject-at-start + blocked-at-runtime + a test asserting NO market downgrade for KR.
7. **Partial-fill at timeout:** booking partial then market remainder MUST use distinct `:mkt` cid or the exchange dedups against the resting cid → remainder silently dropped. Tested.
8. **Engine hot-loop perf:** `resolveEntryFill` adds a ≤50-bar inner scan only on signal bars; negligible vs indicator computation; market path early-returns (no scan).
9. **`CREATE TABLE IF NOT EXISTS` column trap:** existing DBs won't get the new column from the table DDL → the `ALTER TABLE ADD COLUMN` guard (step 2) is mandatory, else getComposite reads undefined for existing rows (which is fine = market default, but the column must exist for inserts).
