# Workstream C (app, data & UI) — status for the other teams

_Updated: 2026-11-12 17:20 SGT_

Only workstream C edits this file. Keep it short (under 40 lines), no secrets, no keys.
Post it with `scripts/team-sync.sh push`.

## Done

- C1 `supabase/seed.ts`, C2 API (`server/lib/deals.ts` + wishlist/deals/events/me/demo routes), C3 Deals board (AG Grid, dark mode, activity feed, Scan now, background stepper), C4 deal page, C5 wishlist/settings/app shell/landing — all on `ws-c-app`, merged with current `main`. `pnpm test` 155 passed, typecheck and build clean.
- Visual pass in a real browser engine with mocked API data: landing, login, board, deal page (agreed + flagged), wishlist, settings at desktop and 390px. Layout fixes made from it.
- Security review of C's routes/lib/pages: no high-confidence findings.
- Answers to your requests:
  - to A: `POST /api/deals/:id/skip` now sets the match's `active` negotiation to `no_deal`; ARCHITECTURE §5 wording updated (fallback concession + blocked first-round restatement).
  - to B: cron secret check is constant-time (`server/lib/secure-compare.ts`); `logEvent` logs `e.message` only; "Buy at retailer" has `rel="noopener noreferrer"`; "Approve & pay" is hidden when the wishlist item is paused/fulfilled (with a note) and `checkout_in_progress` / `not_allowed` / `not_payable` / `exceeds_mandate` / `mandate_expired` get plain-language toasts; `/api/me` reads the current Telegram token on every call.
  - to B: `supabase/seed.ts` is on `ws-c-app` (idempotent, `pnpm db:seed`; `--reset` for the demo reset). Local Supabase is fine for now, we have no cloud project yet.
- A's integration check ran C's seed, routes and pages' data path on a scratch merge: thank you.

## In progress

- Nothing in C needs more code until real keys exist.

## Blocked / needs help

Write requests as `- to A: <what you need, and which file or endpoint>` (or `to B:`). One request per line.
- Waiting on the human lead: C0 (cloud Supabase project + migration, Vercel deploy with env vars) and the real keys. Then: seed, signed-in browser pass, Realtime check, README TODOs, 2 rehearsals.

## Contract changes I need

- `.env.example` was never committed although every doc refers to it. Added on `ws-c-app` with variable NAMES only (no values). Needs the leads' OK before it goes to `main`.
- `docs/ARCHITECTURE.md` §5: two wording changes (see above), requested by A.
