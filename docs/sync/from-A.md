# Workstream A (AI engine) — status for the other teams

_Updated: 2026-11-12 08:15 SGT_

Only workstream A edits this file. Keep it short (under 40 lines), no secrets, no keys.
Post it with `scripts/team-sync.sh push`.

## Done

- A1 review (spec conformance) and A5 security review of the AI library and its two routes: no critical/high findings; routes verify ownership with identical 404s.
- A3 eval script (`scripts/eval-negotiation.ts`) with a `--mock` mode that runs the full flow against a LOCAL Supabase without any key (8/8 checks on two runs, nothing left behind).
- Security fixes in the AI library: seller floor / buyer ceiling can no longer leak through message text, lock and finish races closed, a skipped or paused match stops negotiating, invalid limits fail closed. 176 tests pass (was 115); typecheck clean.

- INTEGRATION CHECK (scratch merge of ws-a-ai + ws-b-pay + ws-c-app on a clean main, local Supabase): no merge conflicts; `pnpm test` 334 passed (1 skipped); typecheck, scripts tsc clean; C's `pnpm db:seed` works and is idempotent (11 sellers, 21 listings, 3 items); A's mock eval 8/8 on C's seed data (matcher 0 disagreements of 21).
- Over real HTTP with a real login: /api/me, wishlist, deals, deal detail, events, skip, demo reset all work; B's scan + A's matcher/risk/negotiation write rows that C's deals board reads (17 visible of 21 matches, mismatch hidden); no floor/persona/scripted text in any response; every other-user id gives the same 404; the injection line from retro_ray is flagged; checkout refuses ready/over_budget/flagged and a $310 match against the $300 mandate; PayPal failure gives a clean 502, match stays `agreed`, no order. Nothing needed from B or C.

## In progress

- Nothing in A needs more code until a Gemini key exists.
- A2 (smoke test the routes with the real model) and A4 (prompt tuning to the acceptance list) are waiting for the key.

## Blocked / needs help

Write requests as `- to B: <what you need, and which file or endpoint>` (or `to C:`). One request per line.
- to C: `POST /api/deals/:matchId/skip` should also set the match's active negotiation to `no_deal` (A now stops stepping a match that is no longer `negotiating`, but closing it there avoids a dangling `active` row).
- to C: the spec (ARCHITECTURE §5) says a blocked first-round offer becomes `walk_away`, but the code re-states the opening offer instead (safer, already guardrail-checked); if you edit ARCHITECTURE.md, align the wording.

- FYI all (decision for the humans): with the model down, A's buyer fallback re-offers the same price every round (ARCHITECTURE §5 says so), so nothing reaches `agreed`. A Gemini outage or quota error during the demo would make every negotiation end `no_deal`. A small spec change (the fallback concedes toward the ceiling) would fix it; A will do it only if the leads agree.

## Contract changes I need

- (none)
