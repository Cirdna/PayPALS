# Progress — workstream A

Only the **lead** of workstream A writes here (teammates report to the lead). One line per finished task or decision,
newest at the bottom: `HH:MM what — done | blocked: why`. Humans read this at every checkpoint; a fresh session
resumes from this file plus the plan in docs/superpowers/plans/.

## Decisions
- 06:30 The B lead (Opus session) also leads A on branch `ws-a-ai` (cut from `main`) because A had no session of its own. No API keys exist yet: everything that needs Gemini (A2 smoke test, A4 prompt tuning) waits; the rest is done without keys.
- 06:30 Buyer-prompt wording and the wording of the ceiling in `prompts/negotiation.ts` are NOT changed yet; that is A4 tuning with the real model. The leaks are closed in code instead (message scrubbing, see the 06:25 line).

## Log
- 06:15 A1 review: baseline `pnpm test` 115 passed, `pnpm typecheck` clean. Read-only reviewer compared guardrail/negotiation/risk/matcher with ARCHITECTURE §5–§7: every money-protecting rule conforms (all guardrail codes, accept judged at the seller price, property test, floor clamp, lock released in `finally`, scripted lines skip the LLM). Deviations are wording/strictness only: a blocked first-round offer is restated instead of `walk_away`; an offer above the seller price is blocked instead of agreed at the seller price (stricter than the spec, safe); shared off-platform lexicon is broader than the spec; matcher applies the 0.6 confidence itself.
- 06:20 A3 eval script done (ee8356c, `scripts/eval-negotiation.ts`): real mode needs a Gemini key and refuses to start without one; `--mock` mode runs the whole flow (matcher check, 7 negotiations, A4 acceptance checklist, cleanup proof) against the LOCAL Postgres with mock models: all checks pass and no rows are left behind. Mock results say nothing about Gemini.
- 06:25 A5 security review (read-only): 0 critical/high. MEDIUM: seller floor and buyer ceiling can leak through LLM message text; a round that outlives its 45 s lock can be replayed and the late finisher can overwrite a finished negotiation; a skipped/paused match keeps negotiating and can end `agreed` + notified; risk explanation prompt has the raw listing title. LOW: NaN/invalid values compare fail-open, malformed ids give 500 not 404, whole error logged in the step route. Routes: ownership and identical 404s confirmed. Fixes in progress (test-first, by the `fix` teammate).
- 06:25 For C: the `skip` route (`POST /api/deals/:matchId/skip`) should also set the match's active negotiation to `no_deal` (A now stops stepping a match that is no longer `negotiating`, but closing it there avoids a dangling `active` row).
