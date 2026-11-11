# Spec C — App, data & UI (Nuxt scaffold, Supabase, seed, pages, AG Grid, deploy)

**Status:** approved design — go straight to `writing-plans`. **Owner:** Lead C + agent team. C also merges contract changes.
**Read with:** `CLAUDE.md`, `docs/ARCHITECTURE.md` §1, §5, §6, `shared/types.ts`, `supabase/migrations/0001_init.sql`.

## Goal
Give the team a running skeleton within the first hour, own the data layer, and build the screens that make the demo video land: wishlist, AG Grid Deals board, deal detail with live negotiation, settings.

## You own
```
nuxt.config.ts, package.json, vercel.json, app.config.ts
app/
  pages/index.vue            # landing: one-liner + "Try demo" login
  pages/login.vue
  pages/wishlist.vue         # list + create form (with mandate fields)
  pages/deals/index.vue      # AG Grid Deals board + "Scan now" + activity feed
  pages/deals/[matchId].vue  # risk card, negotiation transcript (realtime), Approve & pay
  pages/settings.vue         # Telegram link button + status
  components/ RiskBadge.vue, RiskEvidence.vue, NegotiationTranscript.vue, ActivityFeed.vue, MandateCard.vue, PriceDelta.vue
  composables/ useDeals.ts, useRealtime.ts, useApi.ts
server/utils/ supabase.ts (useServiceClient), auth.ts (requireUser), mappers.ts (snake↔camel)
server/api/ me.get.ts, events.get.ts, wishlist/**, deals/**
supabase/seed.ts (+ seed data JSON)
tests/app/**
```

## H0 (first 60–90 min — everyone is blocked on this)
1. `pnpm dlx nuxi@latest init dealhound` (Nuxt 4), TypeScript strict. Modules: `@nuxt/ui`, `@nuxtjs/supabase`. Add deps: `ai`, `@ai-sdk/google`, `zod`, `@paypal/agent-toolkit`, `ag-grid-community`, `ag-grid-vue3`, dev: `vitest`, `tsx`.
2. Scripts in package.json: `dev`, `build`, `test`, `typecheck` (`nuxi typecheck`), `lint`, `db:seed` (`tsx supabase/seed.ts`), `eval:negotiation` (`tsx server/lib/ai/eval.ts`).
3. `runtimeConfig` for every var in `.env.example` (public: `supabaseUrl`, `supabaseKey`, `appUrl`, `telegramBotUsername`, `demoMode`).
4. Create Supabase project, run `0001_init.sql`, enable Realtime on the 3 tables, enable Auth email + **anonymous sign-ins** (demo login).
5. Commit `shared/types.ts` as given; `server/utils/*` with `useServiceClient()`, `requireUser(event)`, mappers.
6. Deploy hello-world to Vercel, set env vars, share URL in team chat. Add the URL to `APP_URL`.

## Tasks
1. **Seed** (`supabase/seed.ts`, idempotent upserts): sellers + personas, ~30 marketplace listings with `listing_secrets` per ARCHITECTURE §5, plus a demo user's wishlist (3 items + mandates). Generic product names; `image_url` = local placeholder SVGs. Coordinate scam/injector texts with A (they use them as test fixtures).
2. **Wishlist page** — form: title, search query, specs, max price, target price, min condition, dealbreakers (chips), mandate expiry (days). `POST /api/wishlist` creates item + mandate (service role). Show `MandateCard` ("Agent may spend up to $380 until 25 Nov · approval required").
3. **Deals board** (`ag-grid-vue3`) — rows from `GET /api/deals` (`DealRow`): columns Wishlist, Listing, Source, Seller/Retailer, Condition, List price, Best price, Savings (green), Risk (cell renderer badge + score), Status (chip), Updated. Quick filter box, default sort by savings desc, row click → detail. Row class red tint for `flagged`. "Scan now" button → `POST /api/scan { }` then refresh. Realtime refresh on `matches` changes. This is the AG Grid sponsor showcase — make it look good (theme Quartz, pinned columns, set filter on Risk/Status).
4. **Deal detail** — listing card (image hidden in `DEMO_MODE`), `RiskEvidence` (signals with highlighted evidence quotes + price stats "38% of median of 14 retailers, z = −3.1"), `NegotiationTranscript` (chat bubbles; guardrail messages as red system banners "🛡️ Blocked: seller tried to raise the budget"), live via Realtime + auto-call `POST /api/negotiations/:id/step` every 1.5 s while `active` and the page is open. Buttons: Start negotiation (if `ready` & negotiable), **Approve & pay** (calls `POST /api/checkout`, redirects to `approveUrl`), Skip. Paid state banner on `?paid=1`.
5. **Activity feed** — `ActivityFeed.vue` from `agent_events` (Realtime), shown on Deals board sidebar: "🔍 Scanned 3 items · 🚩 Flagged 'ANC Headphones X5 – $89' · 🤝 Agreed $365 · 💸 Paid".
6. **Settings** — Telegram deep link `https://t.me/<bot>?start=<token>`, linked status.
7. **Endpoints** `me`, `events`, `wishlist/**`, `deals/**` per ARCHITECTURE §6 (never select `listing_secrets`/`seller_personas`).
8. **Landing + demo login** — anonymous sign-in then `POST /api/demo/bootstrap`? Simpler: seed a fixed demo user and show its email/password in README; also offer anonymous sign-in which clones the demo wishlist (stretch).
9. **Deploy & judge readiness** — Vercel env, Supabase prod keys, README demo creds, check logged-out flow on mobile.

## Acceptance
- H0 by 00:30: everyone can `pnpm dev` against the shared Supabase; Vercel URL live.
- Checkpoint 1: seed done, wishlist CRUD, Deals board shows seeded/test matches.
- Checkpoint 2: full flow clickable on the deployed URL; transcript streams live.
- Checkpoint 3: polish — empty states, loading skeletons, mobile-OK, consistent colours (risk: green/amber/red), favicon, title.

## Pitfalls
- `@nuxtjs/supabase` redirects unauthenticated users to `/login` by default — exclude `/`, `/api/checkout/return`, `/api/checkout/cancel` and webhook routes in its `redirectOptions.exclude`.
- AG Grid needs the community modules registered (`ModuleRegistry.registerModules([AllCommunityModule])`) and client-only rendering (`<ClientOnly>`).
- Don't leak server-only columns via `select('*')` joins on listings → select explicit columns.
