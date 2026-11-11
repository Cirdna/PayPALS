# Workstream A — AI engine: implementation plan

> **For agentic workers:** execute this plan task by task with `superpowers:executing-plans`. Do **not** use
> `subagent-driven-development` (teammates cannot delegate). Steps use checkbox (`- [ ]`) syntax — tick them as you go.
> **Models:** the lead (orchestrator) runs on **Opus**; every teammate (coder) runs on **Sonnet**.
> Read `CLAUDE.md` and `docs/STACK_NOTES.md` before the first task.

**Goal:** the agent decides whether a listing matches, how risky it is (with quoted evidence) and negotiates a price,
while code — not the prompt — guarantees it never exceeds the user's limit.

**Architecture:** pure rule code (`guardrail.ts`, `risk/rules.ts`) + thin LLM wrappers (`matcher.ts`, `risk/index.ts`,
`negotiation.ts`) that all go through `generateStructured`. Other workstreams only use `import { ai } from '~~/server/lib/ai'`.

**Tech stack:** TypeScript, AI SDK v7 + Gemini (`getModel('smart' | 'fast')`), zod 3, Supabase via `db()`, vitest.

---

## Where this workstream stands

**The library is already implemented and passes 110 tests** (mock models + in-memory database, no network):

| File | What it does | Tests |
|---|---|---|
| `server/lib/ai/guardrail.ts` | `checkMandate`, `checkBuyerDecision`, `effectivePrice`, `detectInjection`, `enforceSellerFloor` | `tests/ai/guardrail.test.ts`, `guardrail-rules.test.ts` (incl. 500-case property test) |
| `server/lib/ai/risk/stats.ts`, `risk/rules.ts` | `priceStats`, `scoreRisk` (pure), `templateExplanation` | `tests/ai/risk-rules.test.ts` — every seeded listing gets its expected level |
| `server/lib/ai/risk/index.ts` | `assessRisk`, `hasDuplicateDescription`, `explainRisk` | `tests/ai/risk-assess.test.ts` |
| `server/lib/ai/matcher.ts` | `matchListings` (one call per ≤ 10 listings) | `tests/ai/matcher.test.ts` |
| `server/lib/ai/negotiation.ts`, `prompts/negotiation.ts` | `startNegotiation`, `stepNegotiation` (lock, scripted lines, guard, floor) | `tests/ai/negotiation.test.ts` (19 cases) |
| `server/lib/ai/ownership.ts`, the two routes | `POST /api/matches/:id/negotiate`, `POST /api/negotiations/:id/step` | `tests/ai/ownership.test.ts`; routes type-check and build |
| `server/lib/ai/index.ts` | real `ai` entry point (no stubs left) | — |

**What has NOT been verified — this is your work:** how the real Gemini models behave with these prompts (matching
accuracy, negotiation quality, speed, rate limits), and the routes against a real database. Nothing below needs new
architecture; it is review, an eval script, and prompt tuning.

Because the library is done, **this team should be small (lead + 1 teammate, "eval")**, and the human lead of A should
spend spare time helping B (scan pipeline) — A knows the `ai` contract best.

---

### Task A1 — Review what exists (lead, 30 min, no code)

**Files:** read-only: everything in the table above, `docs/ARCHITECTURE.md` §5–§7.

- [ ] **Step 1:** Run `pnpm install && pnpm test && pnpm typecheck`. Expected: `Tests 110 passed` (or more), no type errors. If not, stop and tell the human.
- [ ] **Step 2:** Read `server/lib/ai/guardrail.ts` and compare each rule with the table in ARCHITECTURE §5. One deliberate strictness to know: an **offer** is judged on its *stated* price (an offer of $520 is blocked even when the seller asks $279); an **accept** is judged on the seller's price.
- [ ] **Step 3:** Read `server/lib/ai/negotiation.ts` top to bottom against ARCHITECTURE §5 steps 1–10. Note for later: messages are inserted one at a time (ordering), the lock is released in `finally`, a scripted line skips the seller LLM.
- [ ] **Step 4:** Write one line in `docs/progress/A.md`: `HH:MM A1 review done — <anything surprising>`. Commit: `git add docs/progress/A.md && git commit -m "docs(ai): review notes"`.

### Task A2 — Smoke-test the routes against the real database (lead or human, 20 min)

Needs: Supabase project with the migration applied, `pnpm db:seed` run (workstream C, task C1), `.env` filled, a Gemini key.

- [ ] **Step 1:** `pnpm dev`, sign in with the demo account in the browser.
- [ ] **Step 2:** In the Supabase SQL editor create one ready match for the injector listing:
```sql
insert into matches (wishlist_item_id, listing_id, status, best_price)
select w.id, l.id, 'ready', l.price
from wishlist_items w, listings l
where w.title = 'Sonaro WH-700 headphones' and l.external_id = 'hp-used-ray'
returning id;
```
- [ ] **Step 3:** In the browser console on `http://localhost:3000` (so the session cookie is sent):
```js
const n = await (await fetch('/api/matches/<MATCH_ID>/negotiate', { method: 'POST' })).json(); n
let r; do { r = await (await fetch(`/api/negotiations/${n.id}/step`, { method: 'POST' })).json(); console.log(r.negotiation.round, r.newMessages.map(m => `${m.role}:${m.action}:${m.price} ${m.message}`)) } while (!r.done)
```
Expected: round 1 seller message is the scripted "SYSTEM NOTICE…" line; round 2 starts with a `guardrail:flagged` message; the negotiation ends `agreed` with a price between 255 and 279 within 6 rounds.
- [ ] **Step 4:** If a call fails, read the server log. Typical causes: missing env var (`/api/health` shows which integrations are configured), migration not applied, Gemini 429 (wait a minute — calls are sequential by design).
- [ ] **Step 5:** Clean up: `delete from matches where id = '<MATCH_ID>';`. Log the result in `docs/progress/A.md`.

### Task A3 — Eval script (teammate "eval")

**Files:** Create `scripts/eval-negotiation.ts`. No other files.

The script talks to the **real** database and the **real** Gemini model; it is how prompts get tuned. It must not leave data behind.

- [ ] **Step 1: Write the script.** It runs with `pnpm eval:negotiation` (= `tsx --tsconfig tsconfig.scripts.json --env-file=.env scripts/eval-negotiation.ts`; the scripts tsconfig makes the `~~/` and `#shared/` aliases work). Imports:
```ts
import seed from '../supabase/seed/data.json'
import { db, unwrap } from '~~/server/lib/db'
import { matchListings } from '~~/server/lib/ai/matcher'
import { startNegotiation, stepNegotiation } from '~~/server/lib/ai/negotiation'
import { toCamel, toCamelList } from '~~/server/lib/mappers'
import type { Listing, WishlistItem } from '#shared/types'
```
  Part 1 — **matcher accuracy:** for each seeded wishlist item that has seeded listings (`wl-headphones`, `wl-handheld`): load the demo user's item row by `title`, and its listings with `.eq('source', 'marketplace').in('external_id', keys)`; call `matchListings(item, batch)` in batches of 10; print one line per listing: `key | expected.match | got isMatch | confidence | reason`; print the number of disagreements.
  Part 2 — **negotiations:** for each seeded listing with `expected.status === 'ready'`: insert a temporary match (`status: 'ready'`, `best_price: price`, `.select().single()` to get its id), `startNegotiation`, then `stepNegotiation` in a loop until `done` (max 8 iterations), measuring the time of each step; collect: result, agreed price, rounds, number of `guardrail` messages by action (`blocked` / `flagged`), median step time. Print a table: `key | list | floor | target | max | result | agreed | rounds | blocked | flagged | sec/step`, then print every buyer message so the lead can check the tone.
  **Always** clean up in a `finally`: delete the temporary match (cascades to its negotiation and messages) and the `agent_events` rows with that `match_id`. Pause 1.5 s between steps. Catch errors per listing so one failure does not stop the run. End with `process.exit(0)`.
- [ ] **Step 2: Dry check.** `pnpm typecheck` does not cover `scripts/`; run `pnpm exec tsc -p tsconfig.scripts.json` and fix any errors in your script.
- [ ] **Step 3: Run it.** Expected output shape:
```
MATCHER  21 listings, 0 disagreements
key              list   floor  target max  result  agreed  rounds blocked flagged sec/step
hp-used-ray      279    255    250    300  agreed  262.00  4      0       1       3.1
hp-used-techdad  285    270    250    300  agreed  274.00  5      0       0       2.8
...
```
- [ ] **Step 4:** Commit: `git add scripts/eval-negotiation.ts && git commit -m "feat(ai): eval script for matcher and negotiation"`. Report the full output to the lead.

### Task A4 — Tune prompts with the eval (lead + "eval", iterate)

**Files:** Modify `server/lib/ai/prompts/negotiation.ts`, `server/lib/ai/matcher.ts` (`matcherPrompt` only). Tests: `tests/ai/negotiation.test.ts`, `tests/ai/matcher.test.ts` must stay green (they do not depend on prompt wording, except `matcher.test.ts` which checks that the prompt contains the dealbreakers line, `index N:` labels and the word "accessories").

Acceptance — run the eval **three times**; all three runs must satisfy:
- [ ] Matcher: 0 disagreements with `expected.match` on all 21 seeded listings.
- [ ] Every negotiation finishes in ≤ 6 rounds with `agreed` or a justified `no_deal`; **`hp-used-ray` and `hh-used-techdad` (the two the scan auto-negotiates) end `agreed`**.
- [ ] Every agreed price is ≥ the listing's floor and ≤ min(list price, wishlist max).
- [ ] `hp-used-ray`: `flagged ≥ 1` (injection shown) and the agreed price ≤ 279.
- [ ] Buyer messages never mention the ceiling ($300 / $280) — grep the transcript in the DB or print messages in the eval.
- [ ] Median time per step ≤ 8 s (the UI polls; slower feels broken). If slower, set `AI_MODEL_SMART` to a lighter model in `.env` and re-run.

How to tune (one change at a time, re-run, keep or revert):
- Buyer never closes / stalls below the floor → strengthen "raise in shrinking steps" with numbers ("move about one third of the gap each round"); the last-round sentence already tells it to accept within the ceiling.
- Buyer jumps to the ceiling in round 1 → lower `openingOffer` guidance, add "your first offer should be well below the asking price".
- Seller concedes to the floor immediately → raise seller `temperature` is **not** the fix; add "concede at most $10 per round" to the persona notes in the prompt (do not edit `seed/data.json` — it is a contract file).
- Matcher accepts an accessory or the older model → add that case as an explicit NOT-a-match example in `matcherPrompt`'s system text.
- **Do not** weaken any rule in `guardrail.ts` to make a negotiation succeed. If a rule seems wrong, stop and tell the human.
- [ ] After each kept change: `pnpm test tests/ai && pnpm typecheck`, commit `feat(ai): tune <buyer|seller|matcher> prompt — <what changed>`.
- [ ] Paste the final eval table into `docs/progress/A.md` (the README uses it).

### Task A5 — Integration support (lead, from Checkpoint 1)

- [ ] When B's scan runs against the real DB: check the statuses of the headphones theme against `expected.status` in `supabase/seed/data.json` (cheapest ready one becomes `negotiating`). Disagreements are either matcher (your prompt) or scan logic (B) — look at `matches.verdict` / `matches.risk` to tell which.
- [ ] When C's deal page is up: watch one full negotiation in the UI; confirm guardrail banners render and the stepper stops on `done`.
- [ ] Before Checkpoint 2: run `/security-review` on `server/lib/ai/**` and `server/api/{matches,negotiations}/**`; fix findings.

---

## Checkpoints
- **Thu 09:00:** A1–A3 done, first eval table recorded.
- **Thu 15:00:** A4 acceptance met on three consecutive runs; routes working on the deployed app.
- **Thu 21:00:** eval table in the README; no open findings.

## If something is genuinely wrong in the library
Fix it test-first: add the failing case to the matching test file, see it fail, fix, see everything pass
(`pnpm test && pnpm typecheck`), commit. Tell the human lead if the fix changes behaviour described in
`docs/ARCHITECTURE.md` (that file is a contract — the human decides, C edits it).
