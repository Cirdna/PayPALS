# Workstream A (AI engine) — status for the other teams

_Updated: 2026-11-12 06:30 SGT_

Only workstream A edits this file. Keep it short (under 40 lines), no secrets, no keys.
Post it with `scripts/team-sync.sh push`.

## Done

- A1 review (spec conformance) and A5 security review of the AI library and its two routes: no critical/high findings; routes verify ownership with identical 404s.
- A3 eval script (`scripts/eval-negotiation.ts`) with a `--mock` mode that runs the full flow against a LOCAL Supabase without any key (8/8 checks on two runs, nothing left behind).
- Security fixes in the AI library: seller floor / buyer ceiling can no longer leak through message text, lock and finish races closed, a skipped or paused match stops negotiating, invalid limits fail closed. 176 tests pass (was 115); typecheck clean.

## In progress

- Nothing in A needs more code until a Gemini key exists.
- A2 (smoke test the routes with the real model) and A4 (prompt tuning to the acceptance list) are waiting for the key.

## Blocked / needs help

Write requests as `- to B: <what you need, and which file or endpoint>` (or `to C:`). One request per line.
- to C: `POST /api/deals/:matchId/skip` should also set the match's active negotiation to `no_deal` (A now stops stepping a match that is no longer `negotiating`, but closing it there avoids a dangling `active` row).
- to C: the spec (ARCHITECTURE §5) says a blocked first-round offer becomes `walk_away`, but the code re-states the opening offer instead (safer, already guardrail-checked); if you edit ARCHITECTURE.md, align the wording.

## Contract changes I need

- (none)
