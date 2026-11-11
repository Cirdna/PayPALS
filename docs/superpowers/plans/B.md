# Workstream B — Payments & integrations: implementation plan

> **Models:** the lead (orchestrator) runs on **Opus**; every teammate (coder) runs on **Sonnet**.
> **For agentic workers:** execute this plan task by task with `superpowers:executing-plans` and
> `superpowers:test-driven-development`. Do **not** use `subagent-driven-development` (teammates cannot delegate).
> Steps use checkbox (`- [ ]`) syntax — tick them as you go. Read `CLAUDE.md` and `docs/STACK_NOTES.md` first.

**Goal:** find products (Channel3), run the watcher pipeline (scan), alert the user (Telegram) and take payment through
the PayPal Agent Toolkit behind the mandate guard.

**Architecture:** framework-free modules under `server/lib/integrations/` (unit-tested with the in-memory database and
mocked `fetch`), thin routes under `server/api/`. Everything other workstreams need is exported through
`import { integrations } from '~~/server/lib/integrations'`. This workstream may import `~~/server/lib/ai` (already fully implemented).

**Tech stack:** TypeScript, `@channel3/sdk` 4.9, `@paypal/agent-toolkit` 1.11 via `paypal-toolkit.ts`, AI SDK v7, Telegram Bot API over `fetch`, Supabase via `db()`, vitest.

## Ground rules for every task
- Test helpers that already exist — **use them, do not write your own mocks**:
  - `createFakeDb(tables)` + `setDbForTests(fake)` (`tests/helpers/fake-db.ts`) — read its header comment for the supported query subset. **Write production queries inside that subset: one table per query, no embedded joins, no `.or()`.**
  - `seedTables()`, `expectedFor(key)`, `expectedVerdicts(keys)`, `DEMO_USER_ID` (`tests/helpers/seed-fixture.ts`) — the demo data as tables.
  - `mockJsonModel`, `countingJsonModel`, `mockToolCallModel`, `mockFailingModel` + `setModelForTests(kind, model)`.
  - `setRawPayPalToolsForTests(tools)` (see `tests/integrations/paypal-toolkit.test.ts` for the pattern).
  - `fetch`: `vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} }))))`, `vi.unstubAllGlobals()` in `afterEach`.
- DB rows are snake_case. Convert with `toCamel<T>(row)` when you need a typed object; write with snake_case keys.
- `unwrap(await db().from(...)..., 'what')` on every query. Writes return `data: null` unless you chain `.select()`.
- Activity feed: `logEvent({ userId, matchId, type, message, payload })` from `~~/server/lib/events` (never throws).
- After every task: `pnpm test && pnpm typecheck`, then commit only your own files.
- Env for tests: set what you need at the top of the test file, e.g. `process.env.APP_URL = 'https://app.test'`, `process.env.TELEGRAM_BOT_TOKEN = 'test-token'`, `process.env.TELEGRAM_WEBHOOK_SECRET = 'hook-secret'`, `process.env.CHANNEL3_API_KEY = 'test'`, `process.env.PAYPAL_CLIENT_ID = 'test'`, `process.env.PAYPAL_CLIENT_SECRET = 'test'`.

Teammates and their files:
| Teammate | Tasks | Files |
|---|---|---|
| **scan** | B1, B2 | `server/lib/integrations/{channel3,scan}.ts`, `server/api/scan.post.ts`, `scripts/channel3-spike.ts`, `tests/integrations/{channel3,scan}*.test.ts` |
| **comms** | B3 | `server/lib/integrations/{telegram,notify}.ts`, `server/api/telegram/webhook.post.ts`, `tests/integrations/{telegram,notify}*.test.ts` |
| **paypal** | B4 | `server/lib/integrations/checkout.ts`, `server/api/checkout/**`, `server/api/paypal/**`, `scripts/paypal-spike.ts`, `tests/integrations/checkout*.test.ts` |
| **lead** | B0, B5, B6 | `server/lib/integrations/index.ts`, `docs/progress/B.md` |

Dependencies between tasks: B2 calls `notifyDeal` (B3) and B3's Telegram `pay:` button calls `createCheckout` (B4).
Until the other task lands, import through the entry point `integrations` from `./index` (the stubs are there) —
**do not** import a file another teammate has not committed yet.

---

### Task B0 — Spikes with real credentials (human lead + lead session, before the team starts)

**Files:** Create `scripts/paypal-spike.ts`, `scripts/channel3-spike.ts`, `tests/integrations/fixtures/channel3-*.json`. Record results in `docs/progress/B.md`.

- [ ] **Step 1: PayPal.** `scripts/paypal-spike.ts`:
```ts
import { buildCreateOrderInput, callPayPalTool, findApproveUrl } from '~~/server/lib/integrations/paypal-toolkit'

const orderId = process.argv[2]
if (!orderId) {
  const order = await callPayPalTool('create_order', buildCreateOrderInput({ title: 'Spike item', amount: 1, returnUrl: 'https://example.com/return', cancelUrl: 'https://example.com/cancel' }), () => {})
  console.log('RAW create_order result:\n', JSON.stringify(order, null, 2))
  console.log('\nApprove here with the SANDBOX PERSONAL account:\n', findApproveUrl(order))
  console.log('\nThen run:  pnpm spike:paypal <ORDER_ID>')
} else {
  const captured = await callPayPalTool('pay_order', { id: orderId }, () => {})
  console.log('RAW pay_order result:\n', JSON.stringify(captured, null, 2))
}
```
  Run `pnpm spike:paypal`, open the link, approve as the sandbox buyer, run `pnpm spike:paypal <ORDER_ID>`.
- [ ] **Step 2:** Paste **both raw results** into `docs/progress/B.md` under "Decisions", and write down the exact paths for: order id, approve link (`findApproveUrl` returned non-null?), capture status, capture id. Expected (PayPal REST shape): `id`, `links[].rel === 'payer-action'` or `'approve'`, after capture `status === 'COMPLETED'` and `purchase_units[0].payments.captures[0].id`. **If the real shape differs, Task B4 follows what you recorded, not this plan.**
- [ ] **Step 3:** If `callPayPalTool` fails with an error you cannot fix in 30 minutes: implement `server/lib/integrations/paypal-rest.ts` with `createOrderRest(input)` and `captureOrderRest(id)` using the REST calls in `docs/STACK_NOTES.md` §2, returning the raw PayPal JSON, and tell the lead — B4 then calls those behind the same guard (`makeCheckoutGuard(...)('create_order', input)` before the request).
- [ ] **Step 4: Channel3.** `scripts/channel3-spike.ts`: create the client per STACK_NOTES §3, search `"75% hot-swappable wireless mechanical keyboard"` and `"wireless noise cancelling headphones"` with `limit: 10`, write each `page.data` to `tests/integrations/fixtures/channel3-keyboard.json` / `channel3-headphones.json`, and print for each: products returned, products surviving `normaliseProduct`, min/median/max price, and the elapsed milliseconds. Run `pnpm spike:channel3`. Record the numbers. If fewer than 3 products survive for the keyboard query, try `filters: {}` (no availability filter) and record which variant works.
- [ ] **Step 5:** Commit the two scripts, the fixtures and the progress file.

---

### Task B1 — Channel3 client (`channel3.ts`)

**Files:** Create `server/lib/integrations/channel3.ts`, `tests/integrations/channel3.test.ts`.

Interface:
```ts
export interface Channel3Like { products: { search(req: { query: string; limit: number; filters?: object }): Promise<{ data: Channel3Api.Product[] }> } }
export function setChannel3ClientForTests(client: Channel3Like | null): void   // also clears the cache
export function setRetryDelayForTests(ms: number): void                        // default 1000
export async function searchProducts(query: string, opts?: { limit?: number }): Promise<ListingDraft[]>
```
Behaviour: lazy real client `new Channel3({ apiKey: env.channel3ApiKey, currency: 'USD', country: 'US' })`; request `{ query, limit: opts.limit ?? 10, filters: { availability: ['InStock'] } }` (or the variant recorded in B0); map `page.data` through `normaliseProduct`, drop nulls; cache `Map<query|limit, { at, drafts }>` for 10 minutes; on any error wait the retry delay and try once more; if the second attempt fails `console.warn` and return `[]` (**never throw** — scan continues with the marketplace).

- [ ] **Step 1: Write the failing tests** (`tests/integrations/channel3.test.ts`) with a fake client object (`{ products: { search: vi.fn() } }`) and `setRetryDelayForTests(0)`:
  1. returns normalised drafts and drops products without a USD in-stock offer (reuse the product shape from `tests/integrations/channel3-normalise.test.ts`);
  2. passes `query`, `limit` (default 10) and the availability filter to the SDK;
  3. second call with the same query within 10 minutes does not call the SDK again;
  4. first call rejects, second resolves → returns the drafts (SDK called twice);
  5. both calls reject → returns `[]` and does not throw;
  6. a failed result is **not** cached (next call hits the SDK again);
  7. if `tests/integrations/fixtures/channel3-keyboard.json` exists, loading it through a fake client yields ≥ 1 draft with `source: 'channel3'` and `price > 0`.
- [ ] **Step 2:** Run `pnpm test tests/integrations/channel3.test.ts` → FAIL (module not found).
- [ ] **Step 3:** Implement `channel3.ts`. Import `{ Channel3 } from '@channel3/sdk'` (named export) and `type { Channel3Api }`.
- [ ] **Step 4:** Run the tests → PASS. `pnpm typecheck` clean.
- [ ] **Step 5:** Commit: `git add server/lib/integrations/channel3.ts tests/integrations/channel3.test.ts && git commit -m "feat(integrations): channel3 search client with cache and retry"`.

---

### Task B2 — Scan pipeline (`scan.ts`, `POST /api/scan`)

**Files:** Create `server/lib/integrations/scan.ts`, `server/api/scan.post.ts`, `tests/integrations/scan.test.ts`.
Spec: `docs/ARCHITECTURE.md` §4 (numbered steps) — implement it exactly; the notes below fix the details.

Exports:
```ts
export function queryKeywords(query: string): string[]
export function keywordMatch(query: string, title: string): boolean
export class ScanError extends Error { constructor(public readonly code: 'not_found', message: string) }
export async function runScan(opts: { wishlistItemId?: string; userId?: string; isCron: boolean; budgetMs?: number }): Promise<ScanResponse>
```

- [ ] **Step 1: `keywordMatch` — tests first.** In `tests/integrations/scan.test.ts`:
```ts
import seed from '~~/supabase/seed/data.json'
describe('keywordMatch', () => {
  it('extracts keywords', () => {
    expect(queryKeywords('Sonaro WH-700 noise cancelling headphones')).toEqual(['sonaro', 'noise', 'cancelling', 'headphones'])
    expect(queryKeywords('75% hot-swappable wireless mechanical keyboard')).toEqual(['swappable', 'mechanical', 'keyboard'])
  })
  for (const w of seed.wishlist) {
    it(`${w.key}: matches exactly its own theme's seeded listings`, () => {
      for (const l of seed.listings) expect(keywordMatch(w.query, l.title), `${w.key} vs ${l.key}`).toBe(l.theme === w.key)
    })
  }
})
```
  Run → FAIL. Then implement (this exact code passes those tests):
```ts
const STOPWORDS = new Set(['with', 'from', 'wireless', 'this', 'that', 'only'])
export function queryKeywords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w)))]
}
export function keywordMatch(query: string, title: string): boolean {
  const words = new Set(title.toLowerCase().split(/[^a-z0-9]+/))
  return queryKeywords(query).some((k) => words.has(k))
}
```
  Run → PASS. Commit.

- [ ] **Step 2: `runScan` — write the scenario tests first.** Setup used by all of them:
```ts
const fake = createFakeDb(seedTables()); setDbForTests(fake)
setChannel3ClientForTests({ products: { search: vi.fn(async () => ({ data: [] })) } })   // no retail results
setModelForTests('smart', mockFailingModel())                                             // risk explanations → template
// Matcher answers exactly what the seed expects, whatever batch it is given:
//   the prompt lists listings as "index N: <untrusted_listing>TITLE | ...", so build the answer from the batch you know.
```
  The matcher is called with batches in the order scan builds them. To keep the test independent of batch order, mock at the module boundary instead of the model: `vi.spyOn(ai, 'matchListings').mockImplementation(async (_item, listings) => listings.map((l) => ({ isMatch: expectedFor(l.externalId).match, confidence: 0.95, reason: 'seed', mismatches: [] })))` (import `ai` from `~~/server/lib/ai`; `scan.ts` must call `ai.matchListings(...)` through that object, not a destructured import, so the spy works). Also `vi.spyOn(integrations, 'notifyDeal').mockResolvedValue(true)` (import `integrations` from `~~/server/lib/integrations`; call it as `integrations.notifyDeal(...)` in `scan.ts`).
  Scenarios (one `it` each; all call `runScan({ wishlistItemId: 'wl-headphones', userId: DEMO_USER_ID, isCron: false })` unless stated):
  1. **Statuses match the seed:** for every `hp-*` listing, the `matches` row has `status === expectedFor(key).status` — except the cheapest ready one (`hp-used-ray`), which is `negotiating`. No rows for `hh-*` listings.
  2. `ScanResponse`: `itemsScanned 1`, `matchesCreated 12`, `flagged 2`, `negotiationsStarted 1`, `notificationsSent 0`.
  3. Flagged rows carry `risk.level === 'high'` and at least 2 signals; `over_budget` rows have `best_price` = list price; `mismatch` rows have a verdict.
  4. Exactly one negotiation exists, for `hp-used-ray`, with one seller opener message.
  5. **Idempotent:** a second `runScan` creates no new `matches` rows, starts no second negotiation, and `ai.matchListings` is not called again (no new candidates).
  6. `wishlist_items.last_scanned_at` is set; `agent_events` contains `scan_started`, `scan_finished`, two `risk_flagged`.
  7. **Ownership:** `runScan({ wishlistItemId: 'wl-headphones', userId: 'someone-else', isCron: false })` rejects with `ScanError` code `not_found` and writes nothing.
  8. **Cron picks the 2 least recently scanned:** set `last_scanned_at` on `wl-headphones` to yesterday, leave the other two null → `runScan({ isCron: true })` scans `wl-handheld` and `wl-keyboard` only.
  9. **Cron advances negotiations first:** insert an active negotiation; spy `ai.stepNegotiation` → resolves `{ negotiation: { status: 'agreed', matchId: 'mX', … }, newMessages: [], done: true, busy: false }` → `integrations.notifyDeal` called with `'mX'`; `negotiationsAdvanced 1`.
  10. **Matcher down:** `ai.matchListings` rejects with `new MatcherUnavailableError()` → no `matches` rows are inserted for that item, scan resolves normally.
  11. **Fixed price within budget:** add a marketplace listing `{ id: 'hp-store-sale', external_id: 'hp-store-sale', seller_id: 'soundhouse', title: 'Sonaro WH-700 headphones sale', price: 289, negotiable: false, condition: 'new' }` with an expected-match verdict → its match is `agreed`, `best_price 289`, and `integrations.notifyDeal` is called once with that match id.
  12. **Notify only when better:** as 11, but a match with `notified_at` set and `best_price 280` already exists for the item → `notifyDeal` not called.
  13. **Negotiable prefilter:** a negotiable matching listing priced 400 (> 300 × 1.3) → `mismatch` with reason mentioning the budget; one with condition `fair` when the item wants `good` → `mismatch`.
  14. **Channel3 results are stored:** fake client returns one product (shape from `channel3-normalise.test.ts`, price 299.5) → a `listings` row with `source 'channel3'` exists and its match is `agreed` (≤ 300) with `risk.level` not `high`.
  15. **Budget:** `runScan({ ..., budgetMs: 0 })` returns without calling `ai.matchListings`.
  Run → FAIL.

- [ ] **Step 3: Implement `runScan`.** Outline (follow it literally):
```ts
export async function runScan(opts): Promise<ScanResponse> {
  const deadline = Date.now() + (opts.budgetMs ?? 45_000)
  const out: ScanResponse = { itemsScanned: 0, listingsFetched: 0, matchesCreated: 0, flagged: 0, negotiationsStarted: 0, negotiationsAdvanced: 0, notificationsSent: 0 }
  const overBudget = () => Date.now() >= deadline

  let items: Row[]
  if (opts.isCron) {
    // (a) advance up to 3 active negotiations by ONE step each
    const active = unwrap(await db().from('negotiations').select('*').eq('status', 'active').order('updated_at', { ascending: true }).limit(3), 'load active negotiations') as Row[]
    for (const n of active) {
      if (overBudget()) break
      try {
        const r = await ai.stepNegotiation(n.id)
        if (!r.busy) out.negotiationsAdvanced++
        if (r.negotiation.status === 'agreed' && await integrations.notifyDeal(r.negotiation.matchId)) out.notificationsSent++
      } catch (e) { console.warn('[scan] step failed', e) }
    }
    // (b) the 2 least recently scanned active items
    items = unwrap(await db().from('wishlist_items').select('*').eq('status', 'active').order('last_scanned_at', { ascending: true, nullsFirst: true }).limit(2), 'load items') as Row[]
  } else {
    const row = unwrap(await db().from('wishlist_items').select('*').eq('id', opts.wishlistItemId).eq('user_id', opts.userId).maybeSingle(), 'load item') as Row | null
    if (!row) throw new ScanError('not_found', 'Wishlist item not found')
    items = [row]
  }
  for (const row of items) {
    if (overBudget()) break
    try { await scanItem(row, out, overBudget) } catch (e) { console.warn(`[scan] item ${row.id} failed`, e) }
    out.itemsScanned++
  }
  return out
}
```
  `scanItem(row, out, overBudget)` — in this order:
  1. `item = toCamel<WishlistItem>(row)`; update `last_scanned_at` to `new Date().toISOString()`; `logEvent scan_started` (`🔍 Scanning for "<title>"`).
  2. `drafts = await integrations.searchProducts(item.query, { limit: 10 })`; if any: `upsert(drafts.map((d) => ({ ...toSnake(d), fetched_at: now })), { onConflict: 'source,external_id' }).select()` → `channel3Rows`. `out.listingsFetched += drafts.length`.
  3. `marketRows` = all `listings` with `source = 'marketplace'`, filtered by `keywordMatch(item.query, r.title)`, sorted by price ascending, first 12.
  4. `known` = set of `listing_id` from `matches` for this item. `candidates = [...channel3Rows, ...marketRows].filter((r) => !known.has(r.id))`. If empty → skip to step 8.
  5. Match in batches of `MATCH_BATCH_SIZE` (10): before each batch `if (overBudget()) break`; `verdicts = await ai.matchListings(item, batch.map(toCamel<Listing>))`; `catch (e) { if (e instanceof MatcherUnavailableError) break; throw e }`. Non-matches → insert `{ wishlist_item_id, listing_id, status: 'mismatch', verdict }`, `out.matchesCreated++`. Matches → push `{ listing, verdict }` to `matched`.
  6. `compPrices` = prices of fixed-price listings that matched this item **before** (matches of this item with status ≠ `mismatch` → their listings where `negotiable = false`) **plus** the fixed-price entries in `matched`.
  7. Process `matched` with fixed-price entries first (`[...matched].sort((a, b) => Number(a.listing.negotiable) - Number(b.listing.negotiable))`). For each (stop if `overBudget()`):
     - fixed-price and `price > item.maxPrice` → insert `over_budget` (`best_price: price`, verdict) — no risk call.
     - negotiable and (`price > item.maxPrice * 1.3` or `!meetsCondition(listing.condition, item.minCondition)`) → insert `mismatch` with `verdict: { ...verdict, isMatch: false, reason: 'Above your budget range' | 'Condition below your minimum' }`.
     - otherwise: `seller` = `sellers` row by `listing.sellerId` (→ `toCamel<Seller>`, or `null`), `sellerOpener` = `listing_secrets.scripted_messages['0'] ?? null` (marketplace only) → `risk = await ai.assessRisk({ listing, seller, compPrices, maxPrice: item.maxPrice, sellerOpener })` → status: `risk.level === 'high'` → `flagged`; fixed-price → `agreed`; negotiable → `ready`. Insert `{ status, verdict, risk, best_price: listing.price }`. Events: `risk_flagged` (`🚩 Flagged "<title>" — <first signal detail>`) or `listing_matched` (`✅ Found "<title>" at $X`).
     - every insert: `out.matchesCreated++`, `out.flagged++` when flagged; ignore a unique-violation error (`error.code === '23505'`), throw on any other.
  8. Auto-negotiate: if no match of this item is `negotiating` → among its `ready` matches with `risk.level === 'low'` take the lowest `best_price` → `await ai.startNegotiation(id)`; `out.negotiationsStarted++`.
  9. Notify: among this item's `agreed` matches take the lowest `best_price`; `previousBest` = min `best_price` over this item's matches with `notified_at` not null (`.not('notified_at', 'is', null)`); if there is no previous or `best.best_price < previousBest` → `if (await integrations.notifyDeal(best.id)) out.notificationsSent++`.
  10. `logEvent scan_finished` with the counts in `payload`.
- [ ] **Step 4:** Run `pnpm test tests/integrations/scan.test.ts` until all 15 scenarios + keyword tests PASS. `pnpm typecheck` clean. Commit.

- [ ] **Step 5: Route** `server/api/scan.post.ts` (complete file):
```ts
import { runScan, ScanError } from '~~/server/lib/integrations/scan'
import type { ScanRequest } from '#shared/types'

// POST /api/scan → ScanResponse. Cron: Authorization: Bearer CRON_SECRET, body {}. User: body { wishlistItemId }.
export default defineEventHandler(async (event) => {
  const body = ((await readBody(event).catch(() => null)) ?? {}) as ScanRequest
  if (isCronRequest(event)) return runScan({ isCron: true })
  const user = await requireUser(event)
  if (!body.wishlistItemId) throw createError({ statusCode: 400, statusMessage: 'wishlistItemId is required' })
  try {
    return await runScan({ wishlistItemId: body.wishlistItemId, userId: user.id, isCron: false })
  } catch (e) {
    if (e instanceof ScanError) throw createError({ statusCode: 404, statusMessage: e.message })
    throw e
  }
})
```
- [ ] **Step 6:** Manual check (needs seeded real DB, keys): sign in as the demo user at `localhost:3000`, then in the browser console: `await (await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wishlistItemId: '<id of the headphones item>' }) })).json()` → compare the `matches` table with `expected.status` in the seed. Cron check: `curl -s -X POST localhost:3000/api/scan -H "Authorization: Bearer $CRON_SECRET" -H 'Content-Type: application/json' -d '{}'`. Record in progress. Commit.

---

### Task B3 — Notifications (`telegram.ts`, `notify.ts`, Telegram webhook)

**Files:** Create `server/lib/integrations/telegram.ts`, `server/lib/integrations/notify.ts`, `server/api/telegram/webhook.post.ts`, `tests/integrations/telegram.test.ts`, `tests/integrations/notify.test.ts`.
Spec: `docs/ARCHITECTURE.md` §8 and §10, `docs/STACK_NOTES.md` §7.

Exports:
```ts
// telegram.ts
export const escapeHtml = (s: string): string            // & < >  →  &amp; &lt; &gt;
export async function tg(method: string, body: object): Promise<any>   // POST https://api.telegram.org/bot<token>/<method>; throws on HTTP error or { ok: false }
export function dealMessage(i: { listing: Listing; item: WishlistItem; match: Match }): { text: string; reply_markup: { inline_keyboard: object[][] } }
export function receiptMessage(i: { listing: Listing; amount: number }): string
export async function handleUpdate(update: any): Promise<void>         // never throws
// notify.ts
export async function notifyDeal(matchId: string): Promise<boolean>
```

- [ ] **Step 1: Tests first — `tests/integrations/telegram.test.ts`:**
  1. `escapeHtml('<b>&')` → `'&lt;b&gt;&amp;'`.
  2. `tg('sendMessage', { chat_id: 1 })` posts JSON to `https://api.telegram.org/bottest-token/sendMessage`; rejects when the response is `{ ok: false, description: 'x' }`.
  3. `dealMessage` for a marketplace listing: text contains the escaped title, the list price, the best price, the saving and the risk level; keyboard has `callback_data: 'pay:<matchId>'`, `'skip:<matchId>'` and a URL button to `https://app.test/deals/<matchId>`.
  4. `dealMessage` for a channel3 listing: first button is a URL button to `listing.url` labelled "🛒 Buy at retailer"; no `pay:` button.
  5. A title containing `<script>` is escaped in the text.
  6. `handleUpdate` `/start demo-link-token` (profiles row from `seedTables()`) → `profiles.telegram_chat_id` set to the chat id; a confirmation `sendMessage` is sent.
  7. `/start wrong-token` → no profile changed; a help message is sent.
  8. Callback `skip:<matchId>` from the linked chat → match `skipped`; `answerCallbackQuery` called.
  9. Callback `skip:<matchId>` from a chat that does not own the match → nothing changes.
  10. Callback `pay:<matchId>` → `integrations.createCheckout` (spy, resolves `{ orderId, paypalOrderId, approveUrl: 'https://paypal.test/approve' }`) called with `(matchId, userId)`; a message with a URL button to the approve URL is sent.
  11. Callback `pay:` when `createCheckout` rejects → a message with the error text is sent; no throw.
  12. `handleUpdate({})` and `handleUpdate(null)` resolve without calling fetch.
- [ ] **Step 2: Tests first — `tests/integrations/notify.test.ts`** (match `m1`: `status 'agreed'`, `best_price 262`, listing `hp-used-ray`, wishlist `wl-headphones`, from `seedTables()`):
  1. linked user (`telegram_chat_id: 555`) → returns `true`; match is `notified` with `notified_at`; exactly one `sendMessage` to chat 555; a `deal_notified` event exists.
  2. second call → returns `false`; no further `sendMessage`.
  3. user without Telegram → returns `true`; match `notified`; **no** fetch call.
  4. match not `agreed` (e.g. `ready`) → `false`, nothing changes.
  5. Telegram API failure (fetch rejects) → still returns `true`, match stays `notified` (the app shows it).
- [ ] **Step 3:** Run both → FAIL.
- [ ] **Step 4: Implement `telegram.ts`.** Details:
  - `tg`: `const res = await fetch(\`https://api.telegram.org/bot${env.telegramBotToken}/${method}\`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })`; `const json = await res.json()`; throw `new Error(json.description ?? res.statusText)` unless `res.ok && json.ok`.
  - `dealMessage` text (HTML, every interpolated string through `escapeHtml`, prices with `formatMoney`):
```
🎯 <b>Deal found: {item.title}</b>
{listing.title}
Listed {listPrice} → <b>{bestPrice}</b>  (you save {listPrice − bestPrice}; {maxPrice − bestPrice} under your limit)
Risk: {LOW|MEDIUM} — {match.risk.explanation, first 200 chars}
```
    (omit the "you save" part when the saving is 0). Keyboard rows: marketplace → `[[{ text: '✅ Approve & pay', callback_data: 'pay:ID' }], [{ text: '🔎 View', url: APP/deals/ID }, { text: '🙅 Skip', callback_data: 'skip:ID' }]]`; channel3 → `[[{ text: '🛒 Buy at retailer', url: listing.url }], [{ text: '🔎 View', url }, { text: '🙅 Skip', callback_data }]]`.
  - `handleUpdate`: wrap everything in `try/catch` (log, never throw). Message branch: `update.message?.text` starting with `/start` → token = second word → `profiles` by `telegram_link_token` → update `telegram_chat_id = update.message.chat.id` → reply "✅ Linked. I'll message you here when I find a deal." / otherwise reply "Open Settings in the app and tap “Link Telegram”." Callback branch: `update.callback_query` → `chatId = callback_query.message.chat.id` → profile by `telegram_chat_id` (none → `answerCallbackQuery` "Please link your account first") → parse `action:matchId` → verify the match belongs to that user (match → wishlist item → `user_id`) → `skip`: update match `status 'skipped'`, answer "Skipped"; `pay`: `answerCallbackQuery` "Creating your PayPal order…", `const c = await integrations.createCheckout(matchId, userId)`, then `sendMessage` "Approve the payment in PayPal:" with `[[{ text: '💳 Pay with PayPal', url: c.approveUrl }]]`; on error `sendMessage` `Couldn't start checkout: {message}`.
  - Get checkout through the entry point with a **dynamic import inside the `pay` branch**: `const { integrations } = await import('./index')`, then `integrations.createCheckout(matchId, userId)`. (A static import would create an import cycle index → notify → telegram → index; the dynamic import avoids it, the test spy on `integrations.createCheckout` still works, and you do not depend on B4's file.)
- [ ] **Step 5: Implement `notify.ts`:**
```ts
export async function notifyDeal(matchId: string): Promise<boolean> {
  const claimed = unwrap(await db().rpc('claim_deal_notification', { p_match_id: matchId }), 'claim notification') as Row[]
  if (claimed.length === 0) return false
  const match = toCamel<Match>(claimed[0]!)
  const listing = toCamel<Listing>(unwrap(await db().from('listings').select('*').eq('id', match.listingId).single(), 'load listing'))
  const item = toCamel<WishlistItem>(unwrap(await db().from('wishlist_items').select('*').eq('id', match.wishlistItemId).single(), 'load item'))
  const profile = unwrap(await db().from('profiles').select('*').eq('id', item.userId).maybeSingle(), 'load profile') as Row | null
  await logEvent({ userId: item.userId, matchId, type: 'deal_notified', message: `📣 Deal ready: "${listing.title}" at ${formatMoney(match.bestPrice ?? listing.price)}` })
  if (profile?.telegram_chat_id) {
    try { await tg('sendMessage', { chat_id: profile.telegram_chat_id, parse_mode: 'HTML', ...dealMessage({ listing, item, match }) }) }
    catch (e) { console.warn('[notify] telegram failed:', e) }
  }
  return true
}
```
- [ ] **Step 6: Route** `server/api/telegram/webhook.post.ts` (complete file):
```ts
import { handleUpdate } from '~~/server/lib/integrations/telegram'

// POST /api/telegram/webhook. Always answers 200 so Telegram does not retry.
export default defineEventHandler(async (event) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!secret || getHeader(event, 'x-telegram-bot-api-secret-token') !== secret) return { ok: true }
  await handleUpdate(await readBody(event).catch(() => null))
  return { ok: true }
})
```
- [ ] **Step 7:** Tests PASS, typecheck clean, commit. After the first deploy the human registers the webhook (command in the spec, B3) and tests `/start` from the Settings link.

---

### Task B4 — Checkout (`checkout.ts`, checkout routes)

**Files:** Create `server/lib/integrations/checkout.ts`, `server/api/checkout/index.post.ts`, `server/api/checkout/return.get.ts`, `server/api/checkout/cancel.get.ts`, `tests/integrations/checkout.test.ts`.
Spec: `docs/ARCHITECTURE.md` §9. **Read the raw results recorded in `docs/progress/B.md` (Task B0) first** — they define `orderIdOf` / `captureOf` below.

Exports:
```ts
export class CheckoutError extends Error { constructor(public readonly code: string, message: string, public readonly statusCode = 409) }
export async function createCheckout(matchId: string, userId: string): Promise<CheckoutCreateResponse>
export async function captureOrder(paypalOrderId: string): Promise<Order>
export async function cancelOrder(paypalOrderId: string): Promise<{ matchId: string } | null>
```

- [ ] **Step 1: Tests first** (`tests/integrations/checkout.test.ts`). Setup: `createFakeDb({ ...seedTables(), matches: [{ id: 'm1', wishlist_item_id: 'wl-headphones', listing_id: 'hp-used-ray', status: 'notified', best_price: 262, risk: { level: 'low', score: 0, signals: [], priceStats: null, explanation: '' } }] })`; PayPal tools replaced as in `paypal-toolkit.test.ts` with an `execute` spy that returns, depending on the tool input, a create result `{ id: 'ORDER1234567890ABC', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1234567890ABC' }] }` or a capture result `{ id: 'ORDER1234567890ABC', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAPTURE123' }] } }] }` (as JSON strings); `process.env.APP_URL = 'https://app.test'`.
  1. **Agentic path:** `setModelForTests('fast', mockToolCallModel('create_order', buildCreateOrderInput({ title: 'Sonaro WH-700 black, like new, with case', amount: 262, returnUrl: 'https://app.test/api/checkout/return', cancelUrl: 'https://app.test/api/checkout/cancel' })))` → `createCheckout('m1', DEMO_USER_ID)` returns `{ paypalOrderId: 'ORDER1234567890ABC', approveUrl: 'https://www.sandbox.paypal.com/...' }`; `orders` row `created`, amount 262; match `checkout_pending`; event `order_created`; PayPal `execute` called once.
  2. **Model produces no tool call** (`mockFailingModel()`) → direct fallback still creates the order (execute called once).
  3. **Model inflates the amount** (tool call with amount 520) → the guard blocks it and the code falls back to the **correct** direct call: order created for 262 (assert the `execute` spy's argument has `itemTotal: 262`), never 520.
  4. **Mandate too low:** set the mandate's `max_amount` to 200 → rejects `CheckoutError` with code `exceeds_mandate`; `execute` never called; no `orders` row; event `guardrail_blocked`.
  5. **Not payable:** a channel3 listing → `CheckoutError` code `not_payable`. Flagged match / risk high → code `not_allowed`. Match of another user → `CheckoutError` code `not_found`, statusCode 404.
  6. **Idempotent create:** second `createCheckout` returns the same order (execute not called again).
  7. **Capture:** `captureOrder('ORDER1234567890ABC')` → order `completed` with `capture_id 'CAPTURE123'`; match `purchased`; wishlist item `fulfilled`; event `order_captured`; returns the camelCase `Order`.
  8. **Capture is idempotent:** second call returns the completed order without calling `execute`.
  9. **Capture not completed** (`status: 'PAYER_ACTION_REQUIRED'` or execute throws) → order `failed`, match stays `checkout_pending`, event `order_failed`, rejects `CheckoutError` code `capture_failed`.
  10. `captureOrder('UNKNOWN')` → `CheckoutError` code `not_found`, 404.
  11. `cancelOrder` → order `cancelled`, match back to `notified`, returns `{ matchId: 'm1' }`; unknown id → `null`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Key parts:
```ts
const orderIdOf = (r: any): string | null => (typeof r?.id === 'string' ? r.id : null)                       // adjust to B0 findings
const captureOf = (r: any) => ({ status: r?.status as string | undefined, captureId: r?.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? null })
const isGuardError = (e: unknown): e is PayPalGuardError => e instanceof PayPalGuardError || (e as Error)?.name === 'PayPalGuardError'

// inside createCheckout, after the checks in ARCHITECTURE §9 steps 1–2:
const amount = roundMoney(match.bestPrice ?? listing.price)
const mandateCheck = (a: number) => ai.checkMandate(mandate, a, 'USD')
const pre = mandateCheck(amount)                      // fail fast with a clear code before any PayPal/LLM call
if (!pre.allowed) { await logEvent({ …type: 'guardrail_blocked'… }); throw new CheckoutError(pre.violations[0]!.code, pre.violations[0]!.detail) }
const guard = makeCheckoutGuard({ expectedAmount: amount, mandateCheck })
const input = buildCreateOrderInput({ title: listing.title, amount, returnUrl: `${env.appUrl}/api/checkout/return`, cancelUrl: `${env.appUrl}/api/checkout/cancel` })

let result: unknown = null
try {                                                 // agentic path: the model calls the guarded PayPal tool
  const r = await generateText({
    model: getModel('fast'), tools: guardedPayPalTools(guard), toolChoice: 'required', stopWhen: stepCountIs(1),
    prompt: `Create the PayPal order for this purchase. Call the create_order tool with exactly this JSON input and nothing else:\n${JSON.stringify(input)}`,
  })
  const part = r.steps.flatMap((s) => s.content).find((p) => p.type === 'tool-result' && p.toolName === 'create_order')
  if (part && 'output' in part) result = part.output
} catch (e) { console.warn('[checkout] agent path failed, using direct call:', e) }
if (!orderIdOf(result)) result = await callPayPalTool('create_order', input, guard)   // deterministic fallback, same guard
const paypalOrderId = orderIdOf(result); const approveUrl = findApproveUrl(result)
if (!paypalOrderId || !approveUrl) throw new CheckoutError('paypal_error', 'PayPal did not return an order id and approval link', 502)
```
  Notes: a model-inflated tool call becomes a `tool-error` part (not a throw) and no `tool-result` → the fallback runs with the correct `input` (scenario 3). `callPayPalTool` can still throw `PayPalGuardError` → map it with `isGuardError` to `CheckoutError(code of first violation)`. Then insert the `orders` row (`.select().single()`), set match `checkout_pending`, `logEvent order_created` (`🧾 PayPal order created for $X`), return.
  `captureOrder`: order row by `paypal_order_id` (none → 404); `completed` → return it; `callPayPalTool('pay_order', { id }, () => {})` inside `try`; `captureOf(result).status === 'COMPLETED'` → update order (`status 'completed'`, `capture_id`), match `purchased`, wishlist item `fulfilled`, `logEvent order_captured` (`💸 Paid $X for "<title>"`), Telegram receipt if the profile has a chat id (`tg('sendMessage', …)` in `try/catch`); anything else → order `failed`, `logEvent order_failed`, throw `CheckoutError('capture_failed', …)`.
- [ ] **Step 4:** Tests PASS; typecheck clean; commit.
- [ ] **Step 5: Routes** (complete files):
```ts
// server/api/checkout/index.post.ts
import { CheckoutError, createCheckout } from '~~/server/lib/integrations/checkout'
import type { CheckoutCreateRequest } from '#shared/types'
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = (await readBody(event)) as CheckoutCreateRequest
  if (!body?.matchId) throw createError({ statusCode: 400, statusMessage: 'matchId is required' })
  try { return await createCheckout(body.matchId, user.id) }
  catch (e) {
    if (e instanceof CheckoutError) throw createError({ statusCode: e.statusCode, statusMessage: e.message, data: { code: e.code } })
    throw e
  }
})
```
```ts
// server/api/checkout/return.get.ts — opened by PayPal's redirect: NO requireUser here.
import { db } from '~~/server/lib/db'
import { captureOrder } from '~~/server/lib/integrations/checkout'
export default defineEventHandler(async (event) => {
  const token = String(getQuery(event).token ?? '')
  const { data: order } = await db().from('orders').select('match_id').eq('paypal_order_id', token).maybeSingle()
  if (!order) return sendRedirect(event, '/deals?failed=1')
  try { await captureOrder(token); return sendRedirect(event, `/deals/${order.match_id}?paid=1`) }
  catch (e) { console.warn('[checkout] capture failed:', e); return sendRedirect(event, `/deals/${order.match_id}?failed=1`) }
})
```
```ts
// server/api/checkout/cancel.get.ts
import { cancelOrder } from '~~/server/lib/integrations/checkout'
export default defineEventHandler(async (event) => {
  const res = await cancelOrder(String(getQuery(event).token ?? ''))
  return sendRedirect(event, res ? `/deals/${res.matchId}?cancelled=1` : '/deals')
})
```
- [ ] **Step 6:** Manual end-to-end on localhost with real sandbox keys (set `APP_URL=http://localhost:3000`): create an `agreed` match by SQL for `hp-used-ray` with `best_price 262`, call `POST /api/checkout` from the browser console, open `approveUrl`, approve with the sandbox buyer, land on `/deals/<id>?paid=1`, check the order is `completed` and the payment shows in the sandbox dashboard. Record in progress. Commit.

---

### Task B5 — Wire the entry point (lead)

**Files:** Modify `server/lib/integrations/index.ts`.

- [ ] **Step 1:** Replace the stub bodies as tasks land (keep the exact shape):
```ts
import type { Integrations } from '#shared/types'
import { searchProducts } from './channel3'
import { captureOrder, createCheckout } from './checkout'
import { notifyDeal } from './notify'

export const integrations: Integrations = { searchProducts, notifyDeal, createCheckout, captureOrder }
```
  While only some tasks have landed, keep the stub for the missing ones.
- [ ] **Step 2:** `pnpm test && pnpm typecheck && pnpm build`. Commit: `feat(integrations): wire real implementations`.
- [ ] **Step 3:** Run `/security-review` on `server/api/{scan,checkout,paypal,telegram}/**` and `server/lib/integrations/**`; fix findings test-first. Things it must confirm: scan requires cron secret or session; checkout verifies match ownership; return/cancel only act on a known `paypal_order_id`; the Telegram webhook checks the secret header; no secret is logged.

### Task B6 — Stretch (only after Checkpoint 2)

- [ ] **Cron:** in `supabase/cron.sql` replace `<CRON_SECRET>` and `<APP_URL>`, run it in the Supabase SQL editor, then `select * from cron.job_run_details order by start_time desc limit 5;` and check a negotiation advances with no browser open.
- [ ] **PayPal webhook** `server/api/paypal/webhook.post.ts` per ARCHITECTURE §9 (raw body, `verify-webhook-signature`, dedupe on `webhook_events`, `CHECKOUT.ORDER.APPROVED` → `captureOrder`). Always 200.
- [ ] **Pay the seller directly** (`payee.email_address`) — only via the REST path; skip unless everything else is finished.

---

## Checkpoints
- **Thu 09:00:** B0 recorded; B1, B2, B3 done with tests; scan verified locally against the seeded database.
- **Thu 15:00:** B4, B5 done; on the deployed URL: scan → Telegram message → Approve & pay → sandbox approval → captured → receipt.
- **Thu 21:00:** security review clean; stretch items only if green.
