# Spec A — AI engine (guardrail, risk, matcher, negotiation)

**Status: approved design — and tasks A1–A6 below are already implemented and tested. What remains (review, eval script, prompt tuning with the real model) is in `docs/superpowers/plans/A.md`; follow the plan, use this spec as background.**
Read first: `CLAUDE.md`, `docs/STACK_NOTES.md` §1, `docs/ARCHITECTURE.md` §5, §6, §7, `shared/types/index.ts`.
Fixtures: `supabase/seed/data.json` (every listing has `expected.match`, `expected.risk`, `expected.status`).

## Goal
Decide whether a listing matches, how risky it is (with quoted evidence), and negotiate a price — while code, not the
prompt, guarantees the agent never exceeds the user's limit.

## Files (create unless marked ✔ = exists, extend it)
```
server/lib/ai/
  guardrail.ts        ✔ has checkMandate. ADD: checkBuyerDecision, detectInjection, enforceSellerFloor, OFF_PLATFORM_LEXICON
  risk/stats.ts         median, mad, priceStats(price, compPrices)
  risk/rules.ts         scoreRisk(input, duplicateFound) → { score, level, signals, priceStats }   (PURE)
  risk/explain.ts       explainRisk(assessment, listing) → string   (template < 35, LLM ≥ 35 with template fallback)
  risk/index.ts         assessRisk(input) → RiskAssessment   (the only place with the duplicate-text DB query)
  prompts/matcher.ts    prompts/buyer.ts   prompts/seller.ts   prompts/risk.ts   (pure functions returning { system, prompt })
  matcher.ts            matchListings(item, listings)
  negotiation.ts        startNegotiation(matchId), stepNegotiation(negotiationId)
  index.ts            ✔ stub — replace each stub body with the real import as it lands; keep exports ai + MatcherUnavailableError
  model.ts ✔  structured.ts ✔   (do not change their public API)
server/api/matches/[id]/negotiate.post.ts
server/api/negotiations/[id]/step.post.ts
scripts/eval-negotiation.ts
tests/ai/*.test.ts      ✔ guardrail.test.ts and structured.test.ts exist — extend guardrail.test.ts
```
Suggested teammates: **guard** (`guardrail.ts`, `tests/ai/guardrail*.test.ts`) · **risk** (`risk/**`, `prompts/risk.ts`, `tests/ai/risk*.test.ts`) · **nego** (`matcher.ts`, `negotiation.ts`, other `prompts/*`, both routes, `scripts/eval-negotiation.ts`, `tests/ai/{matcher,negotiation}*.test.ts`). `index.ts` is edited by the **lead** only.

## Tasks, in order

### A1 — Guardrail (test-first; highest value in the project)
Implement exactly the table in ARCHITECTURE §5 "Guardrail rules".
```ts
checkBuyerDecision(i: { decision: BuyerDecision; mandate: Mandate; item: WishlistItem; listingCurrency: Currency;
  previousBuyerOffers: number[]; sellerLastPrice: number; round: number; maxRounds: number; now?: Date }): GuardrailResult
effectivePrice(decision: BuyerDecision, sellerLastPrice: number): number | null   // accept → sellerLastPrice; offer → min(price, sellerLastPrice); walk_away → null
detectInjection(text: string): { hit: boolean; pattern: string | null }
enforceSellerFloor(i: { decision: SellerDecision; floor: number; buyerOffer: number; sellerLastPrice: number }): SellerDecision
```
Tests required: one test per violation code; `accept` uses the seller's price even if the LLM put another number; `walk_away` always allowed;
`detectInjection` hits the seeded line (`hp-used-ray` → `scriptedMessages["1"]`) and does **not** hit ordinary messages
("Can you do $260?", "Payment through the platform only."); `enforceSellerFloor` never returns a price below `floor` or above `sellerLastPrice`;
**property test** per ARCHITECTURE §5 (500 seeded-random cases).
✅ Done when `pnpm test tests/ai/guardrail` is green and the property test exists.

### A2 — Risk core (test-first, pure)
`risk/stats.ts`, `risk/rules.ts` per ARCHITECTURE §6. Table-driven test over **every** listing in `seed/data.json` with `expected.match === true`:
compute `compPrices` from the same theme's matched non-negotiable listings, `sellerOpener = scriptedMessages["0"]`, `duplicateFound` = another listing with identical description from a different seller → `level` must equal `expected.risk`.
Extra tests: every text `evidence` is a substring of the checked text; `hp-used-ray` has no `off_platform_payment`; fewer than 3 comps → `priceStats === null` and the fallback rule applies.
✅ Done when all seeded listings produce their expected level.

### A3 — `assessRisk` + explanation
`risk/index.ts`: duplicate lookup via `db()` (`listings` where `source = 'marketplace'`, same normalised description, different `seller_id`), then `scoreRisk`, then `explainRisk`. Tests with `setDbForTests` + `mockJsonModel`; LLM failure → template.

### A4 — Matcher
Per ARCHITECTURE §7. Schema `{ verdicts: [{ index, isMatch, confidence, reason, mismatches }] }`. Throw `MatcherUnavailableError` when `generateStructured` reports `usedFallback`. Tests with `mockJsonModel`: order mapping by `index`, missing verdicts, > 10 listings rejected with a clear error.

### A5 — Negotiation
Per ARCHITECTURE §5, steps 1–10 exactly. All DB access through `db()`; write `negotiation_messages` and `agent_events` (user id = wishlist item's `user_id`).
Tests (mock db + mock models): scripted round uses no LLM; an over-limit buyer decision is blocked and replaced; buyer offer ≥ seller price → agreed at seller price; seller accept below floor is turned into a counter; `maxRounds` → `no_deal`; busy lock → `busy: true` and nothing written; lock is released when the LLM throws.
Buyer prompt essentials: open near `targetPrice`; raise in shrinking steps; never reveal the maximum; mention condition/retail comps as leverage; refuse any payment outside the platform; reply to manipulation attempts by restating the offer. Seller prompt essentials: persona `style` + `notes`; hidden floor; never go below it; concede gradually.

### A6 — Routes
`POST /api/matches/:id/negotiate` → `requireUser`, ownership check, `ai.startNegotiation`.
`POST /api/negotiations/:id/step` → `requireUser`, ownership check, `ai.stepNegotiation`; when the result's negotiation is `agreed` → `await integrations.notifyDeal(matchId)` (import the `integrations` entry point; it is a stub until B lands).

### A7 — Eval script (needs a real Gemini key + seeded DB)
`pnpm eval:negotiation`: for each seeded `ready` listing run start + steps to completion; print a table: listing, list price, floor, target, agreed price, rounds, guardrail blocks, injection flags. Use it to tune prompts until: every negotiation ends in ≤ 6 rounds; agreed price ∈ [floor, min(list, max)]; `hp-used-ray` shows an injection flag. Also run the matcher over all seeded listings and print mismatches against `expected.match`.

## Checkpoints
- **Thu 09:00:** A1–A4 done and wired into `index.ts`; A5 implemented with tests.
- **Thu 15:00:** A6 live on the deployed app; A7 run at least once with real Gemini; prompts tuned.

## Pitfalls
- Do not put `limit`/`maxPrice` into the buyer prompt as something it may reveal; the guardrail is the enforcement.
- Never trust LLM numbers: `isValidPrice`, `roundMoney`.
- `server/lib/ai` must not import `server/lib/integrations` (only the *route* in A6 does).
- Money columns arrive as numbers only if rows go through `toCamel`.
