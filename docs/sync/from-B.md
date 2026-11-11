# Workstream B (payments & integrations) — status for the other teams

_Updated: 2026-11-12 04:15 SGT_

Only workstream B edits this file. Keep it short (under 40 lines), no secrets, no keys.
Post it with `scripts/team-sync.sh push`.

## Done

- B1 Channel3 client, B2 scan pipeline (`POST /api/scan`), B3 Telegram + notifyDeal + webhook, B4 checkout (guarded PayPal) — committed on `ws-b-pay`, 178 tests green, typecheck clean.
- Entry point `integrations` now exports the REAL searchProducts / notifyDeal / createCheckout / captureOrder (stubs gone). C can build against it.
- Local Supabase running on this laptop (migration 0001 applied). A 96-assertion script ran the real scan / notify / checkout code against it with mocked LLM, PayPal and Telegram: all pass.
- PayPal webhook (`POST /api/paypal/webhook`) done and tested; security review done (1 HIGH fixed-in-progress: PayPal capture result shape).
- Everything in B that does not need API keys is built. Remaining: security fixes landing now, then B0 spikes + manual checks once keys exist.

## In progress

- Manual checks of scan and checkout: waiting for seed data (C1) and API keys.
- B0 spikes wait for PayPal sandbox + Channel3 keys.

## Blocked / needs help

Write requests as `- to A: <what you need, and which file or endpoint>` (or `to C:`). One request per line.
- to C: we use LOCAL Supabase first (`supabase start`; migration 0001 applies on its own), so no cloud project or shared `.env` is needed yet. Reply here if you are on the cloud project instead.
- to C: please push `supabase/seed.ts` (C1) as soon as it passes; my scan check needs the seeded demo data and I have none loaded.
- to C: your branch is behind `main`: run `git pull origin main` (brings team-sync + settings). The agent cannot run `pnpm install` (settings deny it): the human runs `pnpm install --frozen-lockfile` once in a terminal.
- to C: `server/utils/auth.ts` compares the cron secret with `===`: please use `timingSafeEqual` (hash both sides with sha256 first).
- to C: when the UI renders `listing.url` (Buy at retailer), use `rel="noopener noreferrer"`; B now only stores http/https retailer URLs. `APP_URL` must be a public https URL on Vercel or Telegram refuses the inline buttons.
- to C: `server/lib/events.ts` (`logEvent` catch) still logs the whole error object with `console.warn`; log `e.message` only.
- to C: after a Telegram link the profile's `telegram_link_token` now ROTATES (single use). `/api/me` must read the CURRENT token each time for `telegramStartUrl` (do not cache it), and the demo reset should not depend on a fixed token.
- to C: a wishlist item that is `fulfilled` or `paused` can no longer be paid; the deal page should hide "Approve & pay" for those and show the `checkout_in_progress` / `not_allowed` reasons from `data.code`.
- to C: B's `ws-b-pay` has a script that seeds the local DB from `data.json`; once yours is merged I will run `supabase/seed.ts` on my local Supabase and open your pages against it.

## Contract changes I need

- (none)
