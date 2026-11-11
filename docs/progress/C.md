# Progress — workstream C

Only the **lead** of workstream C writes here (teammates report to the lead). One line per finished task or decision,
newest at the bottom: `HH:MM what — done | blocked: why`. Humans read this at every checkpoint; a fresh session
resumes from this file plus the plan in docs/superpowers/plans/.

## Decisions
- Branch `ws-c-app` created from `main` by the lead (human told the lead to start). No commits to `main`.
- No agent-team tool in this session: teammates `data`, `grid`, `pages` are Sonnet subagents reporting to the lead. They do not commit; the lead commits after verification.
- `pnpm install` is denied for agents, so teammates write code and tests but cannot run them until the human installs dependencies.
- Plan C wins over spec C: query logic goes in `server/lib/deals.ts` (not `toMatchDetail` in `read-models.ts`).
- B's branch `ws-b-pay` has a team-sync mechanism (`docs/sync/from-*.md`, `scripts/team-sync.sh`) and loosens git permissions. Not adopted on C yet: waiting on the human.

## Log
- Lead session started on `ws-c-app`; read CLAUDE.md, STACK_NOTES, ARCHITECTURE, plan and spec C — done.
- Spawned `data` (C1, C2) and `grid` (C3) on Sonnet — running. `pages` (C5, then C4) starts after `grid` finishes C3 step 1.
- `data` wrote C1 (`supabase/seed.ts`) and C2 (`server/lib/deals.ts`, 9 routes, `tests/app/{deals,wishlist}.test.ts`) — written, lead-reviewed by reading (user filter on every query, no secrets tables, cascades confirmed in migration); NOT executed, not committed.
- `grid` wrote C3 (labels, RiskBadge, StatusChip, composables, grid, activity feed, board page) — written, NOT executed, not reviewed in detail, not committed. Uncertain: Nuxt UI v4 props and AG Grid 36 type names.
- `pages` wrote C5 and C4. Lead fixed one typing error in `app/composables/useApi.ts` (Nuxt typed `$fetch` too deep for a generic wrapper) and one banner text.
- Verified after `pnpm install`: `pnpm test` 142 passed (was 115), `pnpm typecheck` clean, `tsc -p tsconfig.scripts.json` clean, `pnpm build` complete. C1, C2, C3, C4, C5 committed on `ws-c-app` (5 commits). NOT yet exercised in a browser or against a real database.
- blocked: no `.env`, C0 (Supabase + Vercel) not confirmed. So: `pnpm db:seed` never run, no page opened in a browser, nothing checked against real Supabase/Realtime.
- open request from B: "to C: tell me when the Supabase project is migrated and seeded, and where the shared `.env` values are."
- Smoke test with placeholder env (no real keys): `/` and `/login` 200; `/wishlist`, `/settings`, `/deals`, `/deals/:id` redirect to `/login`; every C API route (GET and POST) returns 401 when signed out; landing renders title and "Try the demo".
- C6 partial: favicon, site description, `/deals` page title, `tests/app/labels.test.ts` (8 tests). `.env.example` did not exist in the repo (contract file, referenced by every doc): created with variable NAMES only — needs the other leads' OK before it goes to `main`.
- Security review of C's routes/lib/pages: no high-confidence findings. Ownership checked on every `:id` route, secrets tables never read, `locked_until`/seller `slug`/`paypal_email` stripped, no `v-html`, demo reset limited to the demo email. Note (by design, pre-existing): `DEMO_PASSWORD` is in `runtimeConfig.public` so the login page can offer one-click demo sign-in — use a password that is only for the demo account.
- Waiting for keys: seed against real Supabase, authenticated browser pass of every page, Realtime check, mobile pass of the deal page, README `TODO`s (URL, demo login, PayPal sandbox buyer), Vercel deploy, two full rehearsals.
