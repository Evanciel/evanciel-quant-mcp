---
feature: toss-broker
phase: check
date: 2026-06-19
matchRate: 100
---

# toss-broker — PDCA Check (Gap Analysis)

> **Check 후 갱신(2026-06-19)**: 최초 98%의 유일한 Partial(DSGN-8-L1 #10 no-coerce-to-binance 전용 테스트 부재)을 `test/toss-wiring.test.ts`로 해소 → **100%**. (러너 5개 cast 가드 + schemas enum이 'toss'를 포함하는지 소스 단언.)

I have all the requirement context I need. The Plan defines FR-01..FR-17 plus Non-Functional and Success Criteria; the Design defines the §8.2 L1 test plan (11 cases). The 24 audited items map cleanly onto these. Writing the Check analysis now.

# PDCA Check — toss-broker Completeness Audit

## Verdict

**Ship-ready (code-complete).** Every functional requirement (FR-01..FR-17), the live-write hard-block hardening (강화②), the per-currency safety routing (강화①), all five Success-Criteria gates (tsc 0, 578 tests, read-only E2E, paper-default, no-clientId), and 10 of the 11 Design §8.2 L1 test scenarios are implemented with concrete file:line evidence. Computed match rate is **98% (Met 23 / Partial 1 / NotMet 0)**, comfortably clearing the 90% Check gate. The single Partial is a *test-coverage* gap, not a code gap: the "no-coerce-to-binance" behavior (Design §8.2 Case #10) is correctly implemented at all five runner cast sites but lacks a dedicated unit test asserting it. Nothing blocks shipping the code; the only true outstanding work is live E2E + dashboard manual order verification, which is gated on real Toss API keys (external blocker, not a code deficiency).

## Match Rate

**98% — Met 23 · Partial 1 · NotMet 0 (24 items). Gate = 90% → PASS.**

## Per-requirement results

### Group: Adapter data/read methods

| FR | Status | Evidence (file:line) | Gap |
|----|--------|----------------------|-----|
| FR-01 OAuth2 token issue + cache (~24h, 5min skew), secret non-exposure | Met | `src/brokers/toss.ts:99-129` getToken (client_credentials, cache, expires_in→~24h/1h fallback); `:39,:95-97` TOKEN_SKEW_MS + isTokenExpired; `:121,:74-76` secret never logged; `:164` 401 invalidation; wiring `src/brokers/safety.ts:57-64` | — |
| FR-02 getBalance → AccountBalance (KRW) | Met | `src/brokers/toss.ts:250-268` Promise.all holdings + buying-power, fail-closed on malformed, returns totalAsset/cashBalance/currency=KRW | — |
| FR-03 getPositions → Position[] (no-abs pnl), KR+US | Met | `src/brokers/toss.ts:271-295` fail-closed on non-array, qty===0 skip, full field map; no-abs via `toNum` `:42-47` (no Math.abs) | — |
| FR-04 getPrice → MarketPrice(lastPrice), decimal parse | Met | `src/brokers/toss.ts:180-198` fetch + symbol match w/ arr[0] fallback, fail-closed on empty, decimal lastPrice via toNum | — |
| FR-05 getCandles 1m/1d only, pagination, KST | Met | `src/brokers/toss.ts:204-245` interval throw-guard, nextBefore pagination (CANDLE_PAGE_MAX=200 + maxPages), de-dup/sort/slice; preserves server offset (KR +09:00 / US) per `:202,:233` | — |

### Group: Order methods

| FR | Status | Evidence (file:line) | Gap |
|----|--------|----------------------|-----|
| FR-06 placeOrder market/limit, KR tick/US, protective fail-closed | Met | `src/brokers/toss.ts:303-349` POST /orders; type-guard throw `:304-306`; KR floor/US raw `:314,:319`; roundToKrxTick `:323`; hard-block `:307` | — |
| FR-07 Response reliability (orderId absent → throw, status=pending) | Met | `src/brokers/toss.ts:329-334` orderId absent/empty → throw; status pending `:343` | — |
| FR-08 cancelOrder (POST cancel, 4xx → false) | Met | `src/brokers/toss.ts:352-366` POST cancel, 4xx regex → false `:360-363`, 5xx/network re-throw `:364`, hard-block `:353` | — |
| FR-09 getOpenOrders (status=OPEN, remain qty, fail-closed) | Met | `src/brokers/toss.ts:376-408` GET ?status=OPEN; remaining = max(0,orig−filled) `:398`; fail-closed throw on missing array `:382`, catch re-throws `:404-406` | — |
| FR-10 getOrderById (status mapping) | Met | `src/brokers/toss.ts:411-437` FILLED/REJECTED/else-pending `:420`; not-found → null `:414,:434`; price/qty fields `:426-429` | — |
| FR-11 normalizeQuantity (KR floor / US fractional) | Met | `src/brokers/toss.ts:442-445` isKrSymbol floor vs fractional; single source `krx-tick.ts:31` | — |
| LIVE-BLOCK live-write hard-block (강화②) | Met | `src/brokers/toss.ts:83-93` assertWriteAllowed (env!=live throw; master throw); placeOrder `:307` (master req), cancelOrder `:353` (env only); closes `safety.ts:116-119` bypass | — |

### Group: Wiring + currency + safety

| FR | Status | Evidence (file:line) | Gap |
|----|--------|----------------------|-----|
| FR-12 멀티브로커 배선 9곳 원자적 toss 등록 | Met | All sites carry "toss": `credentials.ts:14`, `types.ts:6`, `index.ts:8,:19,:27`, `safety.ts:14,:57-64`, `schemas.ts:148,:176`, `runner.ts:98,:226,:459,:731,:1145`, `bot-handlers.ts:95`. tsc 0 + 578 tests confirm graph integrity | — |
| FR-13 quoteCurrency 심볼/통화 단위 확장 + 통화별 cap/circuit (dailyRealizedLoss IN-widen, 강화①) | Met | `safety.ts:25-30` quoteCurrencyFor (toss→KRW/USD by symbol); wired `live-handlers.ts:127,:215`, `runner.ts:109`; checkLimits per-ccy `safety.ts:115-143` + USD default `:101-105`; dual-bucket `safety.ts:296,:298` | — |
| FR-14 자격증명 등록 (BROKER_FIELDS.toss) + env=live default | Met | `credentials.ts:36-41` 4 fields; auto form loop `credentials.ts:155`; loadCredentials default env=live `safety.ts:60` (vs kis/kiwoom mock), null on missing `:63` | — |
| FR-16 에러분류: envelope + [http:N] marker, 429/5xx GET-only retry, POST no-retry | Met | `toss.ts:166-167` markers + error.code (request never retries); GET via withRetry `:174-176` + `base.ts:26-39`; order POSTs bare request `:327,:355`; 4xx→false/404→null; 401 invalidation `:164` | — |

### Group: Dashboard + tests + success criteria

| FR | Status | Evidence (file:line) | Gap |
|----|--------|----------------------|-----|
| FR-15 Dashboard: toss chart source, manual-order panel, holdings/open-orders | Met | `server.ts:1189,:1635,:1678` dropdowns; label `:1797,:1772,:279`; candle source `:508-512,:566,:576-580`; ccyOf symbol-aware `:1238,:518,:587`; single sink /api/order `:896,:912,:1723`; panels `:987,:608` | — |
| FR-17 Unit tests + read-only E2E script | Met | `test/toss-adapter.test.ts` (30 tests pass); `scripts/verify-toss-e2e.ts:34,:51,:65-71,:78-80`, 0 placeOrder/cancelOrder (grep). Note: design cites `tests/` but actual dir is `test/` — file exists | — |
| SC-tsc0 §4 tsc 0 | Met | `npm run typecheck` clean, 0 errors | — |
| SC-578tests §4 578 tests no-regression | Met | `npx vitest run` → 60 files / 578 passed (matches plan target; 465 baseline + new cases) | — |
| SC-e2e §4 read-only live E2E exists | Met | `scripts/verify-toss-e2e.ts:34→80` token→accounts→prices→candles→holdings→orders OPEN; order POST never called (`:7,:84` + grep) | — |
| SC-paper §4 paper-default (gate OFF → no real order) | Met | `test/toss-adapter.test.ts:104-119` (mock throw / master-unset throw / master-on accepted); adapter enforces env=live && LIVE_TRADING_ENABLED=true; manual path only via placeOrder `server.ts:912` | — |
| SC-noClientId §4 getOrderByClientId undefined | Met | `test/toss-adapter.test.ts:243-247` toBeUndefined; adapter `toss.ts:447-448` intentional non-impl, ties to `runner.ts:351` reconcile | — |
| DSGN-8-L1 Design §8.2 L1 scenarios (11 cases) | Partial | 10/11 cases have explicit tests: Case1 `test/toss-adapter.test.ts:78-80`, Case2 `:84-96`, Case3 `:122-148`, Case4 `:141-143`, Case5 `:145-147`, Case6 `:48-65`, Case7 `test/safety.test.ts:240-247`, Case8 `:243-247`, Case9 `:103-119`, Case11 `:97-100,:175-178,:233-239` | **Case #10 ("no-coerce-to-binance") has no dedicated unit test.** Behavior is correct (`runner.ts:98,:226,:459,:731,:1145` all include "toss" in the includes() cast guard) but unasserted |

## Remaining gaps and recommended action

**1. DSGN-8-L1 — Partial (test coverage, not behavior).**
Design §8.2 Case #10 ("no-coerce-to-binance": a `broker:"toss"` bot must never be silently downgraded to `"binance"` at any of the five runner cast sites) is the only L1 scenario without a dedicated assertion. The underlying behavior is verified correct — all five cast guards (`src/runner/runner.ts:98, :226, :459, :731, :1145`) include `"toss"` in their `includes()` allowlist, and tsc + the 578-test suite pass — but no test *directly* fails if a future edit drops `"toss"` from one of those literals. This is the highest-leverage silent-fail vector in the design (a missing entry routes a Toss bot to a *different exchange's* live order path), so it warrants a regression lock.

- **Recommended action (ACT phase):** add one focused unit test asserting that, for each of the five cast sites' guard input, `broker:"toss"` resolves to `"toss"` (never falls through to the `"binance"` default). Small (~10-20 LOC), no production code change, closes the audit to 100%. Low priority for shipping, but prevents the exact regression the design called out.

**No NotMet items.** No requirement lacks code evidence.

## External blocker (not a code gap)

Two Definition-of-Done items remain *operationally* unverified strictly because **real Toss API keys are not yet provisioned** — Toss has no mock/sandbox host (the central RISK in both Plan and Design), so these cannot be exercised in CI:

- **Live read-only E2E run** — the script (`scripts/verify-toss-e2e.ts`) exists, is wired correctly, and is statically confirmed read-only (0 order POSTs), but the actual token→accounts→prices→candles→holdings→orders round-trip against the live host is pending keys.
- **Dashboard manual-order check + small live order (`GET /orders/{id}` reconcile)** — the paper-default safety path is unit-tested and the manual order routes only through the single `placeOrder` sink; the real-key small-amount live confirmation is pending keys.

These are explicitly in-scope-but-external per Plan §5 / Design Context Anchor (모의서버 부재) and do **not** count against code completeness. Recommended: run both the moment BYOK Toss credentials are available, before enabling `LIVE_TRADING_ENABLED` for any Toss bot.

---

Source documents: `E:\AI코딩프로젝트\클로드코드\quant-mcp\docs\01-plan\features\toss-broker.plan.md`, `E:\AI코딩프로젝트\클로드코드\quant-mcp\docs\02-design\features\toss-broker.design.md`.
