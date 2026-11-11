# Workstream C — App, data & UI: implementation plan

> **Models:** the lead (orchestrator) runs on **Opus**; every teammate (coder) runs on **Sonnet**.
> **For agentic workers:** execute this plan task by task with `superpowers:executing-plans`. Do **not** use
> `subagent-driven-development` (teammates cannot delegate). Steps use checkbox (`- [ ]`) syntax — tick them as you go.
> Read `CLAUDE.md` and `docs/STACK_NOTES.md` (§4–§6) before the first task.

**Goal:** the data layer and the screens that make the demo land — wishlist, the AG Grid Deals board, the deal page
with risk evidence and a live negotiation transcript, settings — deployed on Vercel.

**Architecture:** Vue pages in `app/` call thin `/api/**` routes (auth → `db()` queries → mapping). The browser reads
through `/api` and subscribes to Supabase Realtime for refresh signals; it never writes to tables directly.

**Tech stack:** Nuxt 4, Vue 3 `<script setup lang="ts">`, Nuxt UI 4, AG Grid 36 (`ag-grid-vue3`), `@nuxtjs/supabase` 2, vitest.

## Ground rules for every task
- **Queries:** `db()` (service role, bypasses RLS) → **always filter by the signed-in user**. One table per query, no embedded joins, no `.or()` (keeps code testable with `createFakeDb`). `unwrap(...)` every result. Rows are snake_case → `toCamel<T>(row)` / `toCamelList<T>(rows)`.
- **Never** select from `listing_secrets` or `seller_personas` in a route that returns data to the browser.
- **Route shape:** `const user = await requireUser(event)` first; unknown or foreign id → `throw createError({ statusCode: 404, statusMessage: 'Not found' })`.
- **Already implemented and tested — use, do not rewrite:** `toDealRow` (`server/lib/read-models.ts`), `resetUserData` (`server/lib/demo.ts`), `logEvent`, `requireUser`, `DealsGrid.client.vue` (working AG Grid base), login/landing pages.
- **Nuxt UI 4 components available:** `UButton UBadge UAlert UCard UFormField UInput UInputNumber UInputTags UTextarea USelect UContainer UHeader UNavigationMenu USkeleton UEmpty UModal UTooltip UIcon UProgress`. Colours: `primary success warning error info neutral`. Toasts: `useToast().add({ title, description, color })`. When a prop errors, read the component's `.vue.d.ts` in `node_modules/@nuxt/ui/dist/runtime/components/` — do not guess from memory of older versions.
- Icons: `i-lucide-<name>` (the Lucide set is installed locally).
- After every task: `pnpm test && pnpm typecheck`, then commit only your own files. For UI tasks also open the page in `pnpm dev` and look at it.
- Shared types: `import type { DealRow, MatchDetail, ... } from '#shared/types'`; money: `formatMoney` from `#shared/utils/money`.

Teammates and their files:
| Teammate | Tasks | Files |
|---|---|---|
| **data** | C1, C2 | `supabase/seed.ts`, `server/api/{me,events}.get.ts`, `server/api/wishlist/**`, `server/api/deals/**`, `server/api/demo/**`, `server/lib/deals.ts`, `tests/app/{deals,wishlist}*.test.ts` |
| **grid** | C3 | `app/pages/deals/index.vue`, `app/components/{DealsGrid.client,RiskBadge,StatusChip,ActivityFeed}.vue`, `app/composables/{useDeals,useRealtime,useBackgroundStepper}.ts`, `app/utils/labels.ts` |
| **pages** | C4, C5 | `app/pages/{wishlist,settings}.vue`, `app/pages/deals/[matchId].vue`, `app/components/{AppHeader,MandateCard,RiskEvidence,NegotiationTranscript}.vue`, `app/composables/{useApi,useNegotiationStepper}.ts`, `app/app.vue`, `app/pages/{index,login}.vue` |
| **lead** | C0, C6, contract files | `docs/progress/C.md`; contract files only when the humans agreed |

`grid` and `pages` both need `RiskBadge`, `StatusChip` and `app/utils/labels.ts`: **grid creates them first (C3 step 1) and commits; pages only imports them.**

---

### Task C0 — Accounts and deployment (human lead; see spec C "H0")

- [ ] Supabase project created; `supabase/migrations/0001_init.sql` run once in the SQL editor (no errors); Email auth enabled with "Confirm email" **off**.
- [ ] `.env` filled; `pnpm dev` → `http://localhost:3000/api/health` shows `supabase: true`.
- [ ] Vercel project imported from GitHub with every variable from `.env.example`; `APP_URL` = the deployed URL; `<APP_URL>/api/health` responds.
- [ ] Supabase keys + deployed URL shared with A and B. Logged in `docs/progress/C.md`.

---

### Task C1 — Seed script (`supabase/seed.ts`) — teammate "data"

**Files:** Create `supabase/seed.ts`. Runs with `pnpm db:seed` and `pnpm db:reset-demo` (already defined in `package.json`).

- [ ] **Step 1: Write the script** (complete file — type it in, then adjust only if a call errors against the real database):
```ts
import seed from './seed/data.json'
import { db, unwrap } from '~~/server/lib/db'
import { resetUserData } from '~~/server/lib/demo'
import { env } from '~~/server/lib/env'

type Row = Record<string, any>

async function ensureDemoUser(): Promise<string> {
  const email = env.demoEmail
  const password = env.demoPassword
  const created = await db().auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: seed.demoUser.displayName } })
  let id = created.data?.user?.id
  if (!id) {
    // already registered → find it and make sure the password matches .env
    const list = await db().auth.admin.listUsers({ page: 1, perPage: 1000 })
    const user = list.data?.users.find((u) => u.email === email)
    if (!user) throw new Error(`Could not create or find the demo user: ${created.error?.message}`)
    id = user.id
    await db().auth.admin.updateUserById(id, { password })
  }
  unwrap(await db().from('profiles').upsert({ id, display_name: seed.demoUser.displayName }, { onConflict: 'id' }), 'upsert profile')
  return id
}

async function seedMarketplace(): Promise<void> {
  const sellers = unwrap(await db().from('sellers').upsert(
    seed.sellers.map((s) => ({ slug: s.slug, display_name: s.displayName, account_age_days: s.accountAgeDays, rating: s.rating, rating_count: s.ratingCount, is_agent: true })),
    { onConflict: 'slug' },
  ).select('id, slug'), 'upsert sellers') as Row[]
  const sellerId = new Map(sellers.map((s) => [s.slug, s.id]))

  unwrap(await db().from('seller_personas').upsert(
    seed.sellers.map((s) => ({ seller_id: sellerId.get(s.slug), style: s.persona.style, notes: s.persona.notes })),
    { onConflict: 'seller_id' },
  ), 'upsert personas')

  const listings = unwrap(await db().from('listings').upsert(
    seed.listings.map((l) => ({
      source: 'marketplace', external_id: l.key, title: l.title, description: l.description, price: l.price, currency: 'USD',
      condition: l.condition, seller_id: sellerId.get(l.sellerSlug), negotiable: l.negotiable,
    })),
    { onConflict: 'source,external_id' },
  ).select('id, external_id'), 'upsert listings') as Row[]
  const listingId = new Map(listings.map((l) => [l.external_id, l.id]))

  unwrap(await db().from('listing_secrets').upsert(
    seed.listings.map((l) => ({ listing_id: listingId.get(l.key), floor_price: l.floorPrice, scripted_messages: l.scriptedMessages })),
    { onConflict: 'listing_id' },
  ), 'upsert listing secrets')
  console.log(`Marketplace: ${sellers.length} sellers, ${listings.length} listings`)
}

async function seedWishlist(userId: string): Promise<void> {
  for (const w of seed.wishlist) {
    let item = unwrap(await db().from('wishlist_items').select('id').eq('user_id', userId).eq('title', w.title).maybeSingle(), 'find wishlist item') as Row | null
    if (!item) {
      item = unwrap(await db().from('wishlist_items').insert({
        user_id: userId, title: w.title, query: w.query, specs: w.specs, max_price: w.maxPrice, target_price: w.targetPrice,
        currency: 'USD', min_condition: w.minCondition, dealbreakers: w.dealbreakers,
      }).select('id').single(), 'insert wishlist item') as Row
    }
    const expires = new Date(Date.now() + w.mandateExpiresInDays * 86_400_000).toISOString()
    unwrap(await db().from('mandates').upsert(
      { user_id: userId, wishlist_item_id: item.id, max_amount: w.maxPrice, currency: 'USD', require_human_approval: true, expires_at: expires, revoked_at: null },
      { onConflict: 'wishlist_item_id' },
    ), 'upsert mandate')
  }
  console.log(`Wishlist: ${seed.wishlist.length} items for the demo user`)
}

const userId = await ensureDemoUser()
if (process.argv.includes('--reset')) {
  const { matchesDeleted } = await resetUserData(userId)
  console.log(`Demo reset: ${matchesDeleted} matches removed`)
} else {
  await seedMarketplace()
  await seedWishlist(userId)
  console.log(`Done. Demo login: ${env.demoEmail} / ${env.demoPassword}`)
}
process.exit(0)
```
- [ ] **Step 2:** `pnpm exec tsc -p tsconfig.scripts.json` → no errors in `supabase/seed.ts`.
- [ ] **Step 3:** `pnpm db:seed` twice. Expected both times: `Marketplace: 11 sellers, 21 listings`, `Wishlist: 3 items…`. In the SQL editor: `select count(*) from listings where source = 'marketplace';` → 21; `select count(*) from listing_secrets;` → 21; `select count(*) from wishlist_items;` → 3; `select count(*) from mandates;` → 3.
- [ ] **Step 4:** Sign in at `/login` with "Use the demo account" (set `DEMO_EMAIL` / `DEMO_PASSWORD` in `.env`, restart `pnpm dev`). `pnpm db:reset-demo` prints `Demo reset: 0 matches removed`.
- [ ] **Step 5:** Commit: `git add supabase/seed.ts && git commit -m "feat(data): idempotent seed script with demo reset"`. Tell the lead (A and B are waiting for seeded data).

---

### Task C2 — API for the UI — teammate "data"

**Files:** Create `server/lib/deals.ts`, `server/api/me.get.ts`, `server/api/events.get.ts`, `server/api/wishlist/index.get.ts`, `server/api/wishlist/index.post.ts`, `server/api/wishlist/[id].delete.ts`, `server/api/deals/index.get.ts`, `server/api/deals/[matchId].get.ts`, `server/api/deals/[matchId]/skip.post.ts`, `server/api/demo/reset.post.ts`, `tests/app/deals.test.ts`, `tests/app/wishlist.test.ts`.
Contract: `docs/ARCHITECTURE.md` §11.

Put the query logic in `server/lib/deals.ts` (framework-free, testable); routes only do auth + call + error mapping.
```ts
// server/lib/deals.ts
export async function listDeals(userId: string, wishlistItemId?: string): Promise<DealRow[]>
export async function getMatchDetail(userId: string, matchId: string): Promise<MatchDetail | null>   // null = not found or not yours
export async function skipMatch(userId: string, matchId: string): Promise<boolean>                    // false = not found / not yours / not skippable
export async function listWishlist(userId: string): Promise<{ item: WishlistItem; mandate: Mandate | null }[]>
export async function createWishlistItem(userId: string, input: CreateWishlistRequest): Promise<{ item: WishlistItem; mandate: Mandate }>
export async function deleteWishlistItem(userId: string, id: string): Promise<boolean>
export const wishlistSchema: z.ZodType<CreateWishlistRequest>
```

- [ ] **Step 1: Tests first** (`tests/app/deals.test.ts`, with `createFakeDb({ ...seedTables(), matches: [...] })`, `setDbForTests`). Fixture matches for the demo user: `m-ready` (hp-used-mei, `ready`, best 295), `m-agreed` (hp-used-ray, `agreed`, best 262, risk low), `m-flag` (hp-scam-bargain, `flagged`, risk high), `m-over` (hp-store-sonaro, `over_budget`), `m-mis` (hp-mismatch-wh500, `mismatch`), plus a second user `other-user` with their own wishlist item `w-other` and match `m-other`.
  1. `listDeals(DEMO_USER_ID)` returns 4 rows (no `mismatch`, none of the other user's); the `m-agreed` row has `savings 17`, `payable true`, `sellerOrRetailer 'retro_ray'`, `wishlistTitle 'Sonaro WH-700 headphones'`.
  2. `listDeals(DEMO_USER_ID, 'wl-handheld')` → `[]`; `listDeals('nobody')` → `[]`.
  3. `getMatchDetail(DEMO_USER_ID, 'm-agreed')` → has `match`, `listing`, `seller` (public fields only: `id, displayName, accountAgeDays, rating, ratingCount, isAgent`), `wishlistItem`, `mandate`, `negotiation: null`, `messages: []`, `order: null`.
  4. With a negotiation + 3 messages inserted → `negotiation` set and `messages` in `created_at` order.
  5. With an order row → `order` is the newest order of that match.
  6. `getMatchDetail(DEMO_USER_ID, 'm-other')` → `null`; unknown id → `null`.
  7. The JSON of any `getMatchDetail` result does not contain the strings `floor` or `scripted` (`expect(JSON.stringify(detail)).not.toMatch(/floor|scripted/i)`).
  8. `skipMatch` on `m-ready` → `true`, status `skipped`; on `m-flag` → `false` (only `ready | agreed | notified | no_deal` can be skipped); on `m-other` → `false`.
  `tests/app/wishlist.test.ts`:
  9. `createWishlistItem` inserts the item and a mandate with `max_amount === maxPrice`, `expires_at` ≈ now + `mandateExpiresInDays` (default 14) days, `require_human_approval true`.
  10. `wishlistSchema` rejects: empty title, empty query, `maxPrice ≤ 0`, `targetPrice > maxPrice`, unknown `minCondition`; accepts `targetPrice: null` and missing `dealbreakers`.
  11. `listWishlist` returns only the user's items, each with its mandate, newest first.
  12. `deleteWishlistItem` removes the user's item (→ `true`); someone else's id → `false`, nothing deleted.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement `server/lib/deals.ts`.** Query recipe for `listDeals` (same pattern everywhere — collect ids, then one `.in()` query per table):
```ts
let q = db().from('wishlist_items').select('*').eq('user_id', userId)
if (wishlistItemId) q = q.eq('id', wishlistItemId)
const items = toCamelList<WishlistItem>(unwrap(await q, 'load wishlist'))
if (items.length === 0) return []
const matches = toCamelList<Match>(unwrap(await db().from('matches').select('*').in('wishlist_item_id', items.map((i) => i.id)).neq('status', 'mismatch').order('updated_at', { ascending: false }), 'load matches'))
if (matches.length === 0) return []
const listings = toCamelList<Listing>(unwrap(await db().from('listings').select('*').in('id', [...new Set(matches.map((m) => m.listingId))]), 'load listings'))
const sellerIds = [...new Set(listings.map((l) => l.sellerId).filter((x): x is string => !!x))]
const sellers = sellerIds.length ? toCamelList<Seller & { slug?: string; paypalEmail?: string }>(unwrap(await db().from('sellers').select('id, display_name, account_age_days, rating, rating_count, is_agent').in('id', sellerIds), 'load sellers')) : []
// then Map lookups + toDealRow({ match, listing, seller: … ?? null, item })
```
  `getMatchDetail`: match by id → its wishlist item → `item.userId !== userId` → `null`; then listing, seller (explicit public columns as above), mandate (`.eq('wishlist_item_id', item.id).maybeSingle()`), negotiation (`.eq('match_id', matchId).maybeSingle()`), messages (`.eq('negotiation_id', n.id).order('created_at', { ascending: true })`), newest order (`.eq('match_id', matchId).order('created_at', { ascending: false }).limit(1)`). The `Negotiation` you return must contain only the fields of the type (drop `locked_until`).
  `wishlistSchema` (zod 3): `title`, `query` `z.string().trim().min(1).max(200)`; `specs` `z.string().max(1000).default('')`; `maxPrice` `z.number().positive().max(100000)`; `targetPrice` `z.number().positive().nullable().optional()`; `minCondition` `z.enum(['new','like_new','good','fair'])`; `dealbreakers` `z.array(z.string().max(100)).max(20).default([])`; `mandateExpiresInDays` `z.number().int().min(1).max(90).default(14)`; plus `.refine((v) => v.targetPrice == null || v.targetPrice <= v.maxPrice, { message: 'Target price must not exceed the maximum price', path: ['targetPrice'] })`.
- [ ] **Step 4:** Tests PASS, typecheck clean. Commit.
- [ ] **Step 5: Routes** — each is ~10 lines. Example (complete):
```ts
// server/api/deals/[matchId].get.ts
import { getMatchDetail } from '~~/server/lib/deals'
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const detail = await getMatchDetail(user.id, getRouterParam(event, 'matchId') ?? '')
  if (!detail) throw createError({ statusCode: 404, statusMessage: 'Deal not found' })
  return detail
})
```
  Others: `deals/index.get.ts` → `listDeals(user.id, getQuery(event).wishlistItemId as string | undefined)`; `deals/[matchId]/skip.post.ts` → `skipMatch` (404 when `false`), `setResponseStatus(event, 204)`, return `null`; `wishlist/index.get.ts`; `wishlist/index.post.ts` → `wishlistSchema.safeParse(await readBody(event))` (400 with the first issue message on failure) → `createWishlistItem`; `wishlist/[id].delete.ts`; `events.get.ts` → `agent_events` `.eq('user_id', user.id).order('created_at', { ascending: false }).limit(Math.min(Number(getQuery(event).limit) || 50, 200))` → `toCamelList<AgentEvent>`; `demo/reset.post.ts` → `if (user.email !== env.demoEmail) throw createError({ statusCode: 403, statusMessage: 'Only the demo account can be reset' })` → `resetUserData(user.id)` → 204;
  `me.get.ts` →
```ts
import { db, unwrap } from '~~/server/lib/db'
import { env } from '~~/server/lib/env'
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const profile = unwrap(await db().from('profiles').select('display_name, telegram_chat_id, telegram_link_token').eq('id', user.id).maybeSingle(), 'load profile') as Record<string, any> | null
  const bot = env.telegramBotUsername
  return {
    id: user.id,
    email: user.email,
    displayName: profile?.display_name ?? user.email ?? 'You',
    telegramLinked: !!profile?.telegram_chat_id,
    telegramStartUrl: bot && profile?.telegram_link_token ? `https://t.me/${bot}?start=${profile.telegram_link_token}` : null,
    isDemo: user.email === env.demoEmail,
  }
})
```
- [ ] **Step 6:** `pnpm typecheck && pnpm build`. Manual: signed in as demo, open `/api/me`, `/api/wishlist`, `/api/deals`, `/api/events` in the browser → JSON, no errors; signed out → 401. Commit: `feat(api): wishlist, deals, events, me, demo reset`.

---

### Task C3 — Deals board — teammate "grid"

**Files:** Create `app/utils/labels.ts`, `app/components/RiskBadge.vue`, `app/components/StatusChip.vue`, `app/components/ActivityFeed.vue`, `app/composables/useDeals.ts`, `app/composables/useRealtime.ts`, `app/composables/useBackgroundStepper.ts`. Modify `app/components/DealsGrid.client.vue`, `app/pages/deals/index.vue`.

- [ ] **Step 1: Shared labels and badges (commit these first — "pages" imports them).**
```ts
// app/utils/labels.ts  (auto-imported)
import type { AgentEventType, MatchStatus, RiskLevel } from '#shared/types'
type Color = 'primary' | 'success' | 'warning' | 'error' | 'info' | 'neutral'
export const STATUS_LABEL: Record<MatchStatus, { label: string; color: Color; icon: string }> = {
  mismatch: { label: 'Not a match', color: 'neutral', icon: 'i-lucide-x' },
  over_budget: { label: 'Over budget', color: 'neutral', icon: 'i-lucide-trending-up' },
  flagged: { label: 'Flagged', color: 'error', icon: 'i-lucide-flag' },
  ready: { label: 'Ready to negotiate', color: 'info', icon: 'i-lucide-message-circle' },
  negotiating: { label: 'Negotiating…', color: 'primary', icon: 'i-lucide-messages-square' },
  agreed: { label: 'Deal agreed', color: 'success', icon: 'i-lucide-handshake' },
  no_deal: { label: 'No deal', color: 'neutral', icon: 'i-lucide-ban' },
  notified: { label: 'Awaiting your approval', color: 'success', icon: 'i-lucide-bell-ring' },
  checkout_pending: { label: 'Paying…', color: 'warning', icon: 'i-lucide-credit-card' },
  purchased: { label: 'Purchased', color: 'success', icon: 'i-lucide-circle-check' },
  skipped: { label: 'Skipped', color: 'neutral', icon: 'i-lucide-skip-forward' },
}
export const RISK_LABEL: Record<RiskLevel, { label: string; color: Color }> = {
  low: { label: 'Low risk', color: 'success' }, medium: { label: 'Medium risk', color: 'warning' }, high: { label: 'High risk', color: 'error' },
}
export const EVENT_ICON: Partial<Record<AgentEventType, string>> = {
  scan_started: 'i-lucide-search', scan_finished: 'i-lucide-search-check', listing_matched: 'i-lucide-check', risk_flagged: 'i-lucide-flag',
  negotiation_started: 'i-lucide-messages-square', negotiation_round: 'i-lucide-message-circle', guardrail_blocked: 'i-lucide-shield-alert',
  injection_detected: 'i-lucide-shield-alert', deal_agreed: 'i-lucide-handshake', no_deal: 'i-lucide-ban', deal_notified: 'i-lucide-bell-ring',
  order_created: 'i-lucide-receipt', order_captured: 'i-lucide-circle-check', order_failed: 'i-lucide-circle-x',
}
```
  `RiskBadge.vue`: props `level: RiskLevel | null`, `score?: number | null` → `<UBadge :color variant="subtle">` "Low risk · 10"; renders nothing when `level` is null. `StatusChip.vue`: prop `status: MatchStatus` → `<UBadge :color :icon variant="subtle">label</UBadge>`.
  `pnpm typecheck`, commit, **tell the lead these three files are available.**

- [ ] **Step 2: `useRealtime.ts`** (complete):
```ts
/** Calls `onChange` whenever a row of `table` that the signed-in user may read changes. Cleans up on unmount. */
export function useRealtime(table: 'matches' | 'negotiation_messages' | 'agent_events', onChange: () => void, filter?: string) {
  const client = useSupabaseClient()
  let channel: ReturnType<typeof client.channel> | null = null
  onMounted(() => {
    channel = client
      .channel(`rt-${table}-${filter ?? 'all'}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) }, () => onChange())
      .subscribe()
  })
  onUnmounted(() => { if (channel) client.removeChannel(channel) })
}
```
- [ ] **Step 3: `useDeals.ts`:** `const { data: rows, refresh, status } = useFetch<DealRow[]>('/api/deals', { default: () => [], server: false })`; a 500 ms debounced `refresh` wired to `useRealtime('matches', …)`; `scanning` ref + `scanAll()` which loads `/api/wishlist`, then **sequentially** for each item with `status === 'active'` sets `progress = 'Scanning 2 / 3…'` and `await $fetch('/api/scan', { method: 'POST', body: { wishlistItemId } })` (catch per item → toast, continue), then `refresh()`. Return `{ rows, refresh, status, scanning, progress, scanAll }`.
- [ ] **Step 4: `useBackgroundStepper.ts`** — keeps negotiations moving while the user looks at the board (there may be no cron):
```ts
/** While mounted: every 2.5 s take the first row that is `negotiating` and advance it by one round. Sequential, never overlapping. */
export function useBackgroundStepper(rows: Ref<DealRow[]>) {
  let stopped = false
  const ids = new Map<string, string>() // matchId → negotiationId
  async function loop() {
    while (!stopped) {
      const row = document.visibilityState === 'visible' ? rows.value.find((r) => r.status === 'negotiating') : undefined
      if (row) {
        try {
          if (!ids.has(row.matchId)) ids.set(row.matchId, (await $fetch<{ id: string }>(`/api/matches/${row.matchId}/negotiate`, { method: 'POST' })).id)
          await $fetch(`/api/negotiations/${ids.get(row.matchId)}/step`, { method: 'POST' })
        } catch { /* the deal page shows errors; the board just retries */ }
      }
      await new Promise((r) => setTimeout(r, 2500))
    }
  }
  onMounted(loop)
  onUnmounted(() => { stopped = true })
}
```
  (`POST /api/matches/:id/negotiate` is idempotent and returns the existing negotiation for a `negotiating` match.)
- [ ] **Step 5: Grid.** Extend `DealsGrid.client.vue` — keep `ModuleRegistry.registerModules([AllCommunityModule])`, `:theme="themeQuartz"` and the `.client.vue` suffix:
  - columns: Wishlist (pinned left), Listing (flex 2), Source ("Marketplace" / "Retail"), Seller / retailer, Condition, List price, Best price, Savings, vs. limit (`savingsVsMax`), Risk, Status, Updated (relative time);
  - Risk and Status use Vue cell renderers: `cellRenderer: RiskBadgeCell` where `const RiskBadgeCell = defineComponent({ props: ['params'], setup: (p) => () => h(RiskBadge, { level: p.params.data.riskLevel, score: p.params.data.riskScore }) })` (same pattern for `StatusChip`); import `RiskBadge` / `StatusChip` explicitly inside the grid component;
  - `rowClassRules: { 'deal-flagged': (p) => p.data?.status === 'flagged', 'deal-muted': (p) => ['over_budget', 'skipped', 'no_deal'].includes(p.data?.status) }` with matching CSS (red tint / 60 % opacity) in a `<style>` block (not scoped — AG Grid rows are outside the component scope);
  - savings cell green when > 0 (`cellClass`), money via `formatMoney`;
  - `quickFilterText` prop bound to a search input on the page; `defaultColDef: { sortable: true, resizable: true, filter: true }`; default sort: status priority is not needed — keep `savings` descending;
  - `domLayout: 'autoHeight'` is fine up to ~50 rows; `getRowId` stays `matchId` so Realtime refreshes update rows in place.
- [ ] **Step 6: Page `app/pages/deals/index.vue`:** title + subtitle; toolbar: search input, "Scan now" `UButton` (`:loading="scanning"`, label shows `progress` while scanning); left: `<DealsGrid>` in `<ClientOnly>` with a `USkeleton` fallback; right (lg screens) `ActivityFeed`; empty state (`UEmpty` or a simple card) when there are no rows: "No deals yet — press Scan now". Call `useBackgroundStepper(rows)`.
  `ActivityFeed.vue`: `useFetch<AgentEvent[]>('/api/events?limit=30', { server: false, default: () => [] })`, refresh (debounced) on `useRealtime('agent_events', …)`; list newest first with `EVENT_ICON`, the message and a relative time; `guardrail_blocked` / `injection_detected` / `risk_flagged` lines in the error colour.
- [ ] **Step 7:** `pnpm typecheck`. In `pnpm dev`: with seeded data and a few matches (ask B for a scan, or insert rows by SQL) the board shows rows, flagged rows are tinted, clicking a row navigates to `/deals/<id>`, "Scan now" shows progress. Commit: `feat(ui): deals board with AG Grid, activity feed, scan and background stepper`.

---

### Task C4 — Deal page — teammate "pages"

**Files:** Create `app/pages/deals/[matchId].vue`, `app/components/RiskEvidence.vue`, `app/components/NegotiationTranscript.vue`, `app/composables/useNegotiationStepper.ts`, `app/composables/useApi.ts`.
Behaviour: `docs/ARCHITECTURE.md` §12.

- [ ] **Step 1: `useApi.ts`:** `export async function api<T>(url: string, opts?: Parameters<typeof $fetch>[1]): Promise<T | null>` — wraps `$fetch`, on error shows `useToast().add({ title: 'Something went wrong', description: e?.data?.statusMessage ?? e?.statusMessage ?? e?.message, color: 'error' })` and returns `null`.
- [ ] **Step 2: `useNegotiationStepper.ts`** (complete):
```ts
import type { NegotiationStepResponse } from '#shared/types'

/** Drives a negotiation one round at a time while the page is open. Sequential: waits for each response before the next call. */
export function useNegotiationStepper(negotiationId: Ref<string | null>, isActive: Ref<boolean>, onStep: (r: NegotiationStepResponse) => void) {
  const running = ref(false)
  const error = ref<string | null>(null)
  let stopped = false
  let failures = 0
  async function loop() {
    if (running.value) return
    running.value = true
    while (!stopped && negotiationId.value && isActive.value && failures < 3) {
      if (document.visibilityState === 'visible') {
        try {
          const r = await $fetch<NegotiationStepResponse>(`/api/negotiations/${negotiationId.value}/step`, { method: 'POST' })
          failures = 0
          error.value = null
          onStep(r)
          if (r.done) break
        } catch (e: any) {
          failures++
          error.value = e?.data?.statusMessage ?? e?.message ?? 'Step failed'
        }
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
    running.value = false
  }
  watch([negotiationId, isActive], () => { if (negotiationId.value && isActive.value) { failures = 0; loop() } }, { immediate: true })
  onUnmounted(() => { stopped = true })
  return { running, error, retry: () => { failures = 0; loop() } }
}
```
- [ ] **Step 3: `RiskEvidence.vue`** — props `risk: RiskAssessment | null`, `listPrice: number`. Shows: `RiskBadge`, the `explanation`, the price-stats line when `priceStats` exists (`"{pct}% of the median of {compsCount} retail offers ({formatMoney(median)})"`, pct = `Math.round(pctOfMedian * 100)`), then one row per signal: weight chip (`+35`), `detail`, and when `evidence` is set a quoted block `“{evidence}”` with a highlighted background. `risk === null` → "Not assessed". No `v-html` anywhere (evidence is seller text).
- [ ] **Step 4: `NegotiationTranscript.vue`** — props `messages: NegotiationMessage[]`, `running: boolean`. Buyer messages right-aligned (label "Your agent"), seller left-aligned (label "Seller"), each with the price chip when `price != null` and the action (`offer`, `counter`, `accept`…). `role === 'guardrail'` → full-width `UAlert` with `color="error"`, `icon="i-lucide-shield-alert"`, title = `action === 'blocked' ? 'Blocked by guardrail' : 'Manipulation attempt detected'`, description = `message`. A "typing…" row while `running`. Auto-scroll to the bottom when `messages.length` changes (`nextTick` + `scrollIntoView`). Plain text interpolation only — never `v-html`.
- [ ] **Step 5: Page `deals/[matchId].vue`:**
  - `const { data: detail, refresh } = await useFetch<MatchDetail>(() => \`/api/deals/${route.params.matchId}\`, { server: false })`; 404 → "Deal not found" with a link back.
  - Refresh (debounced 300 ms) on `useRealtime('matches', …, \`id=eq.${matchId}\`)` and on `useRealtime('negotiation_messages', …)`; also call `refresh()` in the stepper's `onStep`.
  - Layout: header (listing title, `StatusChip`, seller / retailer, condition); price card (list price → best price, savings, "$X under your limit", `MandateCard`); `RiskEvidence`; `NegotiationTranscript` when a negotiation exists; action bar.
  - Stepper: `useNegotiationStepper(computed(() => detail.value?.negotiation?.id ?? null), computed(() => detail.value?.negotiation?.status === 'active'), () => refresh())`; show `error` with a Retry button.
  - Actions by state (exactly): `ready` → **Negotiate** (`POST /api/matches/:id/negotiate`, then `refresh()`); `agreed | notified` and marketplace → **Approve & pay with PayPal** (`POST /api/checkout` with `{ matchId }` → `window.location.href = approveUrl`; button shows a loading state); `checkout_pending` and `order?.approveUrl` → **Continue to PayPal**; `agreed | notified` and channel3 → **Buy at retailer** (`:to="listing.url" target="_blank"`); `ready | agreed | notified | no_deal` → **Skip** (`POST /api/deals/:id/skip` → back to `/deals`); `flagged` → no buy/negotiate buttons, an alert "DealHound will not negotiate or pay for flagged listings."
  - Query banners: `?paid=1` → success `UAlert` "Payment captured — it's yours."; `?cancelled=1` → info; `?failed=1` → error "PayPal did not complete the payment. You were not charged."
  - Image: when `useRuntimeConfig().public.demoMode` or no `imageUrl` → a placeholder box with `i-lucide-package`.
- [ ] **Step 6:** `pnpm typecheck`. Manual with a seeded `ready` match for `hp-used-ray` (SQL in plan A, task A2): open the page, press Negotiate, watch rounds arrive; the scripted seller line appears in round 1 and the red "Manipulation attempt detected" banner in round 2; after `agreed` the pay button appears. Commit: `feat(ui): deal page with risk evidence, live negotiation and checkout`.

---

### Task C5 — Wishlist, settings, app shell — teammate "pages"

**Files:** Create `app/pages/wishlist.vue`, `app/pages/settings.vue`, `app/components/AppHeader.vue`, `app/components/MandateCard.vue`. Modify `app/app.vue`, `app/pages/index.vue`, `app/pages/login.vue`.

- [ ] **Step 1: `MandateCard.vue`** — props `mandate: Mandate | null`: "🛡️ Agent may spend up to **{formatMoney(maxAmount)}** · valid until {date} · your approval is required for every payment". Expired or revoked → warning colour and "Mandate expired".
- [ ] **Step 2: `AppHeader.vue`** — brand "DealHound 🐕", links Deals / Wishlist / Settings (only when signed in), right side: user email + "Sign out" (`await useSupabaseClient().auth.signOut(); navigateTo('/')`). Use it in `app/app.vue` above `<NuxtPage />` inside `<UApp>`.
- [ ] **Step 3: `wishlist.vue`** — list from `/api/wishlist` (title, query, specs, max / target price, condition, status, `MandateCard`, Delete button with confirm); create form (`UFormField` + inputs): title, search query, specs (`UTextarea`), max price, target price (optional), minimum condition (`USelect` with `[{ label: 'New', value: 'new' }, { label: 'Like new', value: 'like_new' }, { label: 'Good', value: 'good' }, { label: 'Fair', value: 'fair' }]`), dealbreakers (comma-separated text → array), mandate validity in days (default 14). Submit → `POST /api/wishlist` → toast → refresh. Client-side: disable submit until title, query and max price are set; show the server's 400 message in a toast.
- [ ] **Step 4: `settings.vue`** — from `/api/me`: Telegram card ("Linked ✅" or a **Link Telegram** button opening `telegramStartUrl` in a new tab, plus "Refresh status"); when `telegramStartUrl` is null show "Telegram is not configured on this deployment". Demo card (only `isDemo`): **Reset demo data** → confirm → `POST /api/demo/reset` → toast → `navigateTo('/deals')`.
- [ ] **Step 5: Landing + login polish** — landing: one-sentence pitch, three short feature points (scam check with evidence · negotiation inside a hard limit · you approve in PayPal), "Try the demo" button → `/login`. Login: keep the working logic; tidy the layout.
- [ ] **Step 6:** `pnpm typecheck && pnpm build`. Click through every page signed in and signed out. Commit.

---

### Task C6 — Polish and judge-readiness (lead + all, after Checkpoint 2)

- [ ] Loading skeletons and empty states on every page; page `<title>`s via `useHead`; favicon in `public/`.
- [ ] Deal page looks right at phone width (the video shows Telegram → PayPal on a phone).
- [ ] Consistent colours: risk low/medium/high = success/warning/error everywhere.
- [ ] README: live URL, demo login, PayPal sandbox buyer login filled in; license visible in the GitHub "About" panel.
- [ ] Rehearse twice on the deployed URL: Settings → Reset demo data → Deals → Scan now → open the negotiating deal → approve & pay → back with `?paid=1`.
- [ ] `/security-review` on `server/api/{wishlist,deals,demo}/**`, `server/lib/{deals,demo}.ts`.

---

## Checkpoints
- **Thu 09:00:** C0, C1, C2 done; board renders rows.
- **Thu 15:00:** C3, C4, C5 done; the full flow is clickable on the deployed URL.
- **Thu 21:00:** C6 done; demo reset rehearsed twice.
