# Spec A — AI engine (matcher, scam/risk, negotiation, guardrails)

**Status:** approved design — go straight to `writing-plans`. **Owner:** Lead A + agent team.
**Read with:** `CLAUDE.md`, `docs/ARCHITECTURE.md` §2.2, §3, §4, `shared/types.ts` (`AiEngine`, `RiskAssessment`, `BuyerDecision`, `SellerDecision`, `GuardrailResult`).

## Goal
Make the agent smart *and* safe: decide if a listing matches, how risky it is (with evidence), and negotiate a price — while guaranteeing in code that it never exceeds the user's mandate.

## You own
```
server/lib/ai/
  model.ts          # getModel('smart'|'fast') from AI_PROVIDER + AI_MODEL_SMART/FAST (@ai-sdk/google default)
  structured.ts     # safeGenerateObject(schema, prompt, fallback) – 1 retry then fallback; logs token usage
  prompts/          # buyer.ts, seller.ts, matcher.ts, risk-explainer.ts (pure functions returning strings)
  matcher.ts        # matchListing(item, listing): Promise<MatchVerdict>
  risk/
    stats.ts        # median, MAD, robustZ, priceStats(listing, comps)
    rules.ts        # lexicon + regex signals, evidence = exact substring
    duplicate.ts    # normalised description hash lookups
    index.ts        # assessRisk(...) → RiskAssessment (rules+stats first, LLM explanation last)
  guardrail.ts      # checkMandate, checkBuyerDecision, detectInjection, enforceSellerFloor – PURE, no I/O
  negotiation.ts    # startNegotiation(matchId), stepNegotiation(negotiationId)
  index.ts          # export const ai: AiEngine
server/api/matches/[id]/negotiate.post.ts
server/api/negotiations/[id]/step.post.ts
tests/ai/**
```

## Depends on (code against the types; stub until ready)
- C: `server/utils/supabase.ts` (`useServiceClient()`), `server/utils/auth.ts` (`requireUser(event)`), db mappers. Until merged, use a local stub behind the same names.
- B: `sendDealNotification(userId, matchId)` from `server/lib/integrations/telegram.ts` — call it when a negotiation becomes `agreed`. Stub = console.log.

## Tasks (in order; TDD on 1–4)
1. **guardrail.ts (TDD first, highest value)**
   - `checkMandate(mandate, amount, currency, now)` → `GuardrailResult` (expired, revoked, currency, exceeds).
   - `checkBuyerDecision({decision, mandate, item, previousBuyerOffers, sellerLastPrice, round})` → violations per ARCHITECTURE table. Accept means price = sellerLastPrice.
   - `detectInjection(text)` → `{hit: boolean, pattern?: string}`.
   - `enforceSellerFloor(decision, floor, lastBuyerOffer)` → never accept below floor.
   - Property test: 200 random buyer decisions (prices 0–2×max, random actions) → **no allowed decision ever exceeds min(mandate.maxAmount, item.maxPrice)**.
2. **risk/stats.ts + rules.ts + duplicate.ts (TDD)** using fixtures copied from the seed (3 scam listings must be HIGH, 5 legit LOW/MEDIUM). Evidence strings must be exact substrings (test it).
3. **model.ts + structured.ts** — provider switch (`google` default; `anthropic`/`openai` optional imports guarded), Zod schemas mirroring `MatchVerdict`, `BuyerDecision`, `SellerDecision`, risk explanation.
4. **matcher.ts** — code prefilter (price, condition rank via `CONDITION_RANK`, dealbreaker keywords) before LLM; confidence < 0.6 ⇒ mismatch. Fixture tests with mocked model.
5. **risk/index.ts** — combine; LLM explanation via `safeGenerateObject`; template fallback.
6. **negotiation.ts** — start: create row, round 0, if `listing_secrets.scripted_first_message` insert seller message. Step: per ARCHITECTURE §2.2. Writes `negotiation_messages`, `agent_events` (`negotiation_round`, `guardrail_blocked`, `injection_detected`, `deal_agreed`, `no_deal`), updates `matches.status/best_price`. On agreed → `sendDealNotification`.
   - Buyer strategy prompt: open near `targetPrice` (or 80% of list), concede in shrinking steps, walk away if seller floor obviously > max; never mention the max to the seller; refuse off-platform payment.
   - Seller prompt: persona style + floor (never reveal), injector persona tries the injection line in round 2.
7. **Endpoints** — `POST /api/matches/:id/negotiate`, `POST /api/negotiations/:id/step` (auth: owner of the wishlist item; also callable internally from scan). Idempotent if status ≠ active (return current state, `done: true`).
8. **Eval script** `pnpm eval:negotiation` — runs all seeded negotiable listings end-to-end against Gemini, prints table: listing, list price, floor, agreed price, rounds, blocked count. Use it to tune prompts and for a slide.

## Acceptance (Checkpoint 1, Thu 09:00)
- `pnpm test tests/ai` green, incl. property test.
- 3 seeded scams → HIGH with ≥2 evidence items each; legit → not HIGH.
- Injector negotiation shows a `guardrail` message with `injection_detected` and final price ≤ max.
- Typical negotiation finishes in ≤ 6 rounds with a price between floor and max.

## Pitfalls
- Gemini free tier: use fast model for matcher; one smart call per negotiation side per round; cache everything in DB.
- Never trust LLM numbers: coerce with `roundMoney`, reject NaN/negative.
- Keep prompts in files, not inline, so they're easy to tune and show in the README.
