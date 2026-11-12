# Workstream A (AI engine) — status for the other teams

_Updated: 2026-11-12 19:15 SGT_

Only workstream A edits this file. Keep it short (under 40 lines), no secrets, no keys.
Post it with `scripts/team-sync.sh push`.

## Done

- A1 review (spec conformance) and A5 security review of the AI library and its two routes: no critical/high findings; routes verify ownership with identical 404s.
- A3 eval script (`scripts/eval-negotiation.ts`) with a `--mock` mode that runs the full flow against a LOCAL Supabase without any key (8/8 checks on two runs, nothing left behind).
- Security fixes in the AI library: seller floor / buyer ceiling can no longer leak through message text, lock and finish races closed, a skipped or paused match stops negotiating, invalid limits fail closed. 176 tests pass (was 115); typecheck clean.

- INTEGRATION CHECK (scratch merge of ws-a-ai + ws-b-pay + ws-c-app on a clean main, local Supabase): no merge conflicts; `pnpm test` 334 passed (1 skipped); typecheck, scripts tsc clean; C's `pnpm db:seed` works and is idempotent (11 sellers, 21 listings, 3 items); A's mock eval 8/8 on C's seed data (matcher 0 disagreements of 21).
- Over real HTTP with a real login: /api/me, wishlist, deals, deal detail, events, skip, demo reset all work; B's scan + A's matcher/risk/negotiation write rows that C's deals board reads (17 visible of 21 matches, mismatch hidden); no floor/persona/scripted text in any response; every other-user id gives the same 404; the injection line from retro_ray is flagged; checkout refuses ready/over_budget/flagged and a $310 match against the $300 mandate; PayPal failure gives a clean 502, match stays `agreed`, no order. Nothing needed from B or C.

- Real Gemini (free-tier key) run: matcher 21/21 correct; negotiation quality good where the model ran. Free-tier quota is the blocker (flash-latest daily limit hit; flash-lite per-minute limit hit by eval bursts). A now fails over on a 429 with a 60 s cooldown instead of retrying. A4 (3 clean eval runs) needs billing on the Google AI Studio project.

## In progress

- Nothing. A is complete: A4 passed 3 consecutive real-model runs on Groq (all checks, 0 fallbacks, matcher 0/21 wrong, median step about 2 s).

## Blocked / needs help

Write requests as `- to B: <what you need, and which file or endpoint>` (or `to C:`). One request per line.
- to C: `POST /api/deals/:matchId/skip` should also set the match's active negotiation to `no_deal` (A now stops stepping a match that is no longer `negotiating`, but closing it there avoids a dangling `active` row).
- to C: the spec (ARCHITECTURE §5) says a blocked first-round offer becomes `walk_away`, but the code re-states the opening offer instead (safer, already guardrail-checked); if you edit ARCHITECTURE.md, align the wording.

- DONE (approved by the human lead): with the model down, the buyer now concedes toward its limit instead of re-offering the same price (round 1 opening offer; then +1/3 of the gap, at least $2, never above the limit; accepts the seller price only when within the limit and close, or in the final round). The guardrail still checks it. Seeded headphones case with a dead model: agreed at $264 in 4 rounds. 182 tests pass.
- to C: ARCHITECTURE §5 (line ~105) still says "Fallback when the LLM fails: re-offer the previous buyer offer"; please change it to: "Fallback when the LLM fails: concede deterministically (opening offer in round 1, then +1/3 of the gap, at least $2, never above the limit; accept the seller price if within the limit and close or in the final round)." A blocked move is still restated at the previous valid offer.

- LLM PROVIDER IS NOW GROQ (human lead's decision). Every laptop: `git pull`, then `pnpm install --frozen-lockfile` (adds `@ai-sdk/groq`), and put `GROQ_API_KEY` in `.env`. Optional: `AI_PROVIDER=google` switches back to Gemini; `AI_MODEL_SMART` / `AI_MODEL_FAST` override the ids (defaults gpt-oss-20b / gpt-oss-120b).
- to C: A edited `server/lib/env.ts` (your file, with the human lead's OK) to add `aiProvider` + `groqApiKey` and the Groq default model ids; `package.json` / `pnpm-lock.yaml` gained `@ai-sdk/groq`. Please keep these when you merge.
- to C: add `GROQ_API_KEY` and `AI_PROVIDER` to `.env.example`, and in `server/api/health.get.ts` report the LLM as configured when `GROQ_API_KEY` is set (it only checks the Gemini key today). STACK_NOTES should say the provider is Groq via `@ai-sdk/groq`.

## Contract changes I need

- (none)
