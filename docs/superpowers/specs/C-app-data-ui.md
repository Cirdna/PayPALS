# Spec C — App, data & UI (Supabase, seed, API for the UI, pages, AG Grid, deploy)

**Status: approved design. The step-by-step plan is written: `docs/superpowers/plans/C.md` — execute the plan; this spec is background.**
Read first: `CLAUDE.md`, `docs/STACK_NOTES.md` §4–§6, `docs/ARCHITECTURE.md` §2, §3, §11, §12, `shared/types/index.ts`, `supabase/migrations/0001_init.sql`, `supabase/seed/data.json`.

## Goal
Own the data layer and the screens that make the demo land: wishlist, the AG Grid Deals board, the deal page with
risk evidence and a live negotiation transcript, settings. C also owns deployment and is the only editor of contract files.

## Files (create unless marked ✔ = exists, extend it)
```
app/pages/index.vue ✔  login.vue ✔  confirm.vue ✔  wishlist.vue  settings.vue
app/pages/deals/index.vue ✔   app/pages/deals/[matchId].vue
app/components/DealsGrid.client.vue ✔  RiskBadge.vue  RiskEvidence.vue  NegotiationTranscript.vue  ActivityFeed.vue
               MandateCard.vue  StatusChip.vue  AppHeader.vue
app/composables/useApi.ts  useDeals.ts  useRealtime.ts  useNegotiationStepper.ts
server/api/me.get.ts  events.get.ts
server/api/wishlist/index.get.ts  index.post.ts  [id].delete.ts
server/api/deals/index.get.ts  [matchId].get.ts  [matchId]/skip.post.ts
server/api/demo/reset.post.ts
server/lib/read-models.ts      toDealRow(...), toMatchDetail(...)  (pure mapping, unit-tested)
supabase/seed.ts
tests/app/*.test.ts            ✔ seed-data.test.ts exists
```
Suggested teammates: **data** (`supabase/seed.ts`, all `server/api/**` of C, `server/lib/read-models.ts`, `tests/app/**`) · **grid** (`app/pages/deals/index.vue`, `DealsGrid.client.vue`, `ActivityFeed.vue`, `StatusChip.vue`, `RiskBadge.vue`, `useDeals.ts`, `useRealtime.ts`) · **pages** (`wishlist.vue`, `settings.vue`, `deals/[matchId].vue`, `RiskEvidence.vue`, `NegotiationTranscript.vue`, `MandateCard.vue`, `AppHeader.vue`, `useNegotiationStepper.ts`, `useApi.ts`, `index.vue`, `login.vue`).

## H0 — the human lead does these first (they need accounts and a browser)
1. Push this repo to a **public** GitHub repository (MIT license already present).
2. supabase.com → new project → SQL editor → run `supabase/migrations/0001_init.sql` once. Database → Replication/Realtime: confirm `matches`, `negotiation_messages`, `agent_events` are in the `supabase_realtime` publication (the migration adds them). Authentication → Providers → Email: enable, and turn **off** "Confirm email".
3. Fill `.env` from `.env.example` (URL, publishable key, secret key). Share the Supabase values with A and B.
4. vercel.com → import the GitHub repo (framework preset: Nuxt) → add **every** variable from `.env.example` → deploy → set `APP_URL` to the deployed URL and redeploy → check `<APP_URL>/api/health`. Share the URL.
5. Note: on Vercel's free plan, deployments triggered by another person's commits may be blocked. If that happens, the Vercel account owner merges to `main` (or deploys with `vercel --prod`).

## Tasks

### C1 — Seed script (`supabase/seed.ts`)
Reads `supabase/seed/data.json`, uses `db()`. Idempotent upserts: sellers (on `slug`) + `seller_personas`; listings (`source: 'marketplace'`, `external_id = key`, on `(source, external_id)`) + `listing_secrets` (`floor_price`, `scripted_messages`); demo user via `db().auth.admin.createUser({ email, password, email_confirm: true })` (ignore "already registered", then look the user up); the demo user's wishlist items + mandates (skip if an item with the same title exists). `image_url` stays null.
`--reset` flag: delete all `matches` of the demo user's wishlist items (cascades to negotiations, messages, orders), delete the user's `agent_events`, set items to `status 'active'`, `last_scanned_at null`.
✅ `pnpm db:seed` twice in a row leaves the same row counts; `pnpm db:reset-demo` works.

### C2 — API for the UI
All routes per ARCHITECTURE §11 with `requireUser` and the ownership pattern. `POST /api/wishlist` validates with zod (title/query non-empty, `0 < targetPrice ≤ maxPrice`), creates the item and its mandate (`max_amount = max_price`, `expires_at = now + mandateExpiresInDays`).
`GET /api/deals`: matches joined with listings, sellers, wishlist items for this user, status ≠ `mismatch` → `toDealRow` (`sellerOrRetailer = seller.displayName ?? listing.retailer ?? ''`, `bestPrice = match.bestPrice ?? listing.price`, `payable = listing.source === 'marketplace'`).
`GET /api/deals/:matchId` → `MatchDetail` (explicit column lists; never `listing_secrets` / `seller_personas`).
`POST /api/demo/reset` → only when `user.email === env.demoEmail`; same effect as `--reset`.
Unit tests for `read-models.ts`.

### C3 — Deals board (the AG Grid showcase)
Extend `DealsGrid.client.vue`: cell renderers for Risk (`RiskBadge`: green/amber/red + score) and Status (`StatusChip`), savings in green, `flagged` rows red-tinted, `over_budget` rows muted, quick-filter text box, set/text filters on Risk, Status, Source, pinned first column, row click → `/deals/:matchId`.
Page: header with "Scan now" (sequential `POST /api/scan` per active wishlist item with a progress label "Scanning 2 / 3…"), `ActivityFeed` sidebar (Realtime on `agent_events`, newest first, icon per type), auto-refresh rows on Realtime `matches` changes (debounced 500 ms).

### C4 — Deal page
Per ARCHITECTURE §12. `RiskEvidence`: level badge, score, each signal with its `detail` and the quoted `evidence` highlighted, price stats line ("26 % of the median of 4 retail offers ($346.75)"). `NegotiationTranscript`: buyer bubbles right, seller left, `guardrail` messages as full-width red banners with a shield icon and the violation detail; auto-scroll. `useNegotiationStepper`: sequential loop while status is `active` and `document.visibilityState === 'visible'`; stops on `done`; on `busy` waits and retries; surfaces errors with a toast and stops after 3 consecutive failures.
Buttons by state exactly as in §12. `?paid=1` → success banner; `?cancelled=1` / `?failed=1` → info/error banner.

### C5 — Wishlist + settings + shell
`wishlist.vue`: list with `MandateCard` ("Agent may spend up to $300 until 26 Nov · your approval required"), create form (title, search query, specs, max price, target price, minimum condition, dealbreakers as comma-separated text, mandate days), delete. `settings.vue`: Telegram link button (`telegramStartUrl` from `/api/me`), linked status, "Reset demo data" (demo account only). `AppHeader`: nav (Deals, Wishlist, Settings), sign out.

### C6 — Polish (after Checkpoint 2)
Empty states, loading skeletons, consistent colours, page titles, favicon, mobile-friendly deal page (the video shows a phone for the Telegram → PayPal step), landing page copy.

## Checkpoints
- **Thu 09:00:** H0 done; C1 + C2 done; board shows rows (insert a few matches by SQL or run the scan against the stubs).
- **Thu 15:00:** full flow clickable on the deployed URL; transcript streams live.
- **Thu 21:00:** polish done; demo reset rehearsed.

## Pitfalls
- Nuxt UI v4 component names/props differ from v2/v3 examples — check the component's types in `node_modules/@nuxt/ui` when a prop errors; `pnpm typecheck` catches template mistakes.
- AG Grid: keep the `.client.vue` suffix and the module registration; no CSS theme imports.
- Never call Supabase tables directly from the browser for writes; reads for Realtime refresh only.
- You are the only editor of `shared/**`, the migration, `seed/data.json`, `.env.example`. A change there = tell all three human leads first, then a tiny commit straight to `main`.
