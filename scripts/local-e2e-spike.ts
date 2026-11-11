/**
 * Workstream B end-to-end check against a REAL local Postgres (local Supabase in Docker), with the model, PayPal,
 * Channel3 and Telegram MOCKED. It exists because the unit tests use an in-memory fake DB that can hide wrong column
 * names, bad query shapes, jsonb handling, unique-violation codes and the SQL claim functions.
 *
 * Run (local Supabase must be up on 127.0.0.1:55321 with supabase/migrations/0001_init.sql applied):
 *
 *   pnpm exec tsx --tsconfig tsconfig.scripts.json --env-file=.env scripts/local-e2e-spike.ts
 *
 * Safety: aborts unless SUPABASE_URL is http://127.0.0.1|localhost:55321. Global fetch is stubbed: api.telegram.org
 * calls are recorded (and answered { ok: true, result: {} }), api-m.sandbox.paypal.com answers ONLY the two webhook
 * verification calls (OAuth token, verify-webhook-signature) with canned bodies, the local Supabase API is passed
 * through, anything else throws. No real model, no PayPal, no Channel3, no Telegram.
 *
 * It loads supabase/seed/data.json into the local DB under two throw-away users (e2e-b-demo@, e2e-b-other@) and the
 * seed's seller slugs, deleting its own rows first, so it is idempotent. It is only B's check, not the official seed.
 * Exit code 1 when any assertion fails.
 */
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk'
import type { Channel3Api } from '@channel3/sdk'
import type { Listing, MatchVerdict } from '#shared/types'
import seed from '~~/supabase/seed/data.json'
import { ai } from '~~/server/lib/ai'
import { setModelForTests } from '~~/server/lib/ai/model'
import { db } from '~~/server/lib/db'
import { env } from '~~/server/lib/env'
import { setChannel3ClientForTests } from '~~/server/lib/integrations/channel3'
import { cancelOrder, captureOrder, CheckoutError, createCheckout } from '~~/server/lib/integrations/checkout'
import { notifyDeal } from '~~/server/lib/integrations/notify'
import { handlePayPalWebhook } from '~~/server/lib/integrations/paypal-webhook'
import { buildCreateOrderInput, setRawPayPalToolsForTests } from '~~/server/lib/integrations/paypal-toolkit'
import { runScan } from '~~/server/lib/integrations/scan'
import { handleUpdate } from '~~/server/lib/integrations/telegram'
import { mockFailingModel, mockToolCallModel } from '../tests/helpers/mock-model'

type Row = Record<string, any>

// ───────────────────────── safety ─────────────────────────

function assertLocalSupabase(): void {
  let u: URL
  try { u = new URL(process.env.SUPABASE_URL ?? '') } catch { throw new Error('SUPABASE_URL is not a valid URL') }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
  if (!local || u.port !== '55321') {
    throw new Error(`ABORT: SUPABASE_URL must point at the local Supabase on port 55321 (host ${u.hostname}, port ${u.port || 'default'}). Nothing was touched.`)
  }
}
assertLocalSupabase()

// placeholders for variables the code reads but this script never uses for real
for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'CHANNEL3_API_KEY', 'CRON_SECRET', 'GOOGLE_GENERATIVE_AI_API_KEY']) {
  process.env[k] ||= 'e2e-placeholder'
}
process.env.APP_URL ||= 'http://localhost:3000'

const telegram: { method: string; body: Row }[] = []
const paypalHttp: string[] = [] // pathnames of the (stubbed) calls to the PayPal sandbox host
let verifyStatus = 'SUCCESS'
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.hostname === 'api-m.sandbox.paypal.com') {
    paypalHttp.push(url.pathname)
    if (url.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'x' }), { status: 200 })
    if (url.pathname === '/v1/notifications/verify-webhook-signature') return new Response(JSON.stringify({ verification_status: verifyStatus }), { status: 200 })
    throw new Error(`e2e: blocked PayPal sandbox request to ${url.pathname}`)
  }
  if (url.hostname === 'api.telegram.org') {
    telegram.push({ method: url.pathname.split('/').pop() ?? '', body: JSON.parse(init?.body ?? '{}') })
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
  }
  if ((url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.port === '55321') return realFetch(input, init)
  throw new Error(`e2e: blocked network request to ${url.origin}`)
}) as typeof fetch

const warnings: string[] = []
console.warn = (...a: unknown[]) => { warnings.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')) }

// ───────────────────────── assertions ─────────────────────────

let passed = 0
const failures: string[] = []
const failLines: string[] = []
const section = (name: string) => console.log(`\n== ${name}`)
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) { passed++; console.log(`  PASS  ${name}`) } else {
    failures.push(name)
    const d = detail === undefined ? '' : ` -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
    failLines.push(`${name}${d}`)
    console.log(`  FAIL  ${name}${d}`)
  }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
/** Swallowed errors in B's code surface as console.warn: any [scan]/[notify]/[telegram]/[checkout]/[events]/[channel3]/[paypal-webhook] line is a finding. */
function noUnexpectedWarnings(label: string, allow: RegExp[] = []): void {
  const bad = warnings.filter((w) => /^\[(scan|notify|telegram|checkout|events|channel3|paypal-webhook)\]/.test(w) && !allow.some((a) => a.test(w)))
  check(`${label}: no swallowed errors logged by B's code`, bad.length === 0, bad)
  warnings.length = 0
}

/** Supabase calls in this script: throw on error so a broken setup is obvious. */
async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const r = await p
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  return r.data as T
}

// ───────────────────────── fixtures: users + demo data ─────────────────────────

const DEMO_EMAIL = 'e2e-b-demo@dealhound.test'
const OTHER_EMAIL = 'e2e-b-other@dealhound.test'
const DEMO_TOKEN = 'e2e-link-token-demo'
const OTHER_TOKEN = 'e2e-link-token-other'
const DEMO_CHAT = 777001
const OTHER_CHAT = 999002
const C3_ID = 'e2e-c3-sonaro-1'

const ids = {
  user: '', other: '',
  wishlist: {} as Record<string, string>,
  listing: {} as Record<string, string>,
}

async function cleanup(): Promise<void> {
  const users = (await db().auth.admin.listUsers({ perPage: 200 })).data.users.filter((u) => u.email === DEMO_EMAIL || u.email === OTHER_EMAIL)
  for (const u of users) { const { error } = await db().auth.admin.deleteUser(u.id); if (error) throw new Error(`delete user: ${error.message}`) }
  // sellers cascade to personas, listings, secrets, matches (and their negotiations/orders)
  await must(db().from('sellers').delete().in('slug', seed.sellers.map((s) => s.slug)).select(), 'delete sellers')
  await must(db().from('listings').delete().eq('source', 'channel3').eq('external_id', C3_ID).select(), 'delete channel3 listing')
  await must(db().from('webhook_events').delete().like('id', 'E2E-%').select(), 'delete e2e webhook events') // event ids are global, a re-run must not see "duplicate"
}

async function createUser(email: string, name: string): Promise<string> {
  const { data, error } = await db().auth.admin.createUser({ email, password: 'e2e-password-123', email_confirm: true, user_metadata: { name } })
  if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`)
  return data.user.id
}

async function loadSeed(): Promise<void> {
  ids.user = await createUser(DEMO_EMAIL, seed.demoUser.displayName)
  ids.other = await createUser(OTHER_EMAIL, 'Other Buyer')
  await must(db().from('profiles').update({ telegram_link_token: DEMO_TOKEN, telegram_chat_id: null }).eq('id', ids.user).select(), 'demo profile')
  await must(db().from('profiles').update({ telegram_link_token: OTHER_TOKEN, telegram_chat_id: OTHER_CHAT }).eq('id', ids.other).select(), 'other profile')

  const sellers = await must(db().from('sellers').insert(seed.sellers.map((s) => ({
    slug: s.slug, display_name: s.displayName, account_age_days: s.accountAgeDays, rating: s.rating, rating_count: s.ratingCount, is_agent: true,
  }))).select(), 'sellers') as Row[]
  const sellerId = Object.fromEntries(sellers.map((s) => [s.slug, s.id]))
  await must(db().from('seller_personas').insert(seed.sellers.map((s) => ({ seller_id: sellerId[s.slug], style: s.persona.style, notes: s.persona.notes }))).select(), 'personas')

  const listings = await must(db().from('listings').insert(seed.listings.map((l) => ({
    source: 'marketplace', external_id: l.key, title: l.title, description: l.description, price: l.price, currency: 'USD',
    condition: l.condition, seller_id: sellerId[l.sellerSlug], negotiable: l.negotiable,
  }))).select(), 'listings') as Row[]
  for (const l of listings) ids.listing[l.external_id] = l.id
  await must(db().from('listing_secrets').insert(seed.listings.map((l) => ({
    listing_id: ids.listing[l.key], floor_price: l.floorPrice, scripted_messages: l.scriptedMessages,
  }))).select(), 'listing_secrets')

  const items = await must(db().from('wishlist_items').insert(seed.wishlist.map((w) => ({
    user_id: ids.user, title: w.title, query: w.query, specs: w.specs, max_price: w.maxPrice, target_price: w.targetPrice,
    currency: 'USD', min_condition: w.minCondition, dealbreakers: w.dealbreakers, status: 'active',
  }))).select(), 'wishlist_items') as Row[]
  for (const w of seed.wishlist) ids.wishlist[w.key] = items.find((i) => i.title === w.title)!.id
  await must(db().from('mandates').insert(seed.wishlist.map((w) => ({
    user_id: ids.user, wishlist_item_id: ids.wishlist[w.key], max_amount: w.maxPrice, currency: 'USD', require_human_approval: true,
    expires_at: new Date(Date.now() + w.mandateExpiresInDays * 86_400_000).toISOString(),
  }))).select(), 'mandates')
}

// ───────────────────────── mocks ─────────────────────────

const expectedOf = (key: string) => seed.listings.find((l) => l.key === key)?.expected

let matchCalls = 0
function mockAi(): void {
  setModelForTests('smart', mockFailingModel()) // risk explanations + negotiation lines -> deterministic fallbacks
  ai.matchListings = async (_item, listings: Listing[]): Promise<MatchVerdict[]> => {
    matchCalls++
    return listings.map((l) => ({ isMatch: expectedOf(l.externalId)?.match ?? true, confidence: 0.95, reason: 'seed', mismatches: [] }))
  }
  const realStep = ai.stepNegotiation
  ai.stepNegotiation = async (id: string) => { stepCalls.push(id); return realStep(id) }
}
const stepCalls: string[] = []

let c3Price = 349
let c3Enabled = false // scenarios (a), (b) run without retail results, as in the plan; (c) switches them on
const c3Product = (): Channel3Api.Product => ({
  id: C3_ID, title: 'Sonaro WH-700 headphones retail', description: 'Wireless, 30h battery', key_features: ['Active noise cancelling'],
  images: [{ url: 'https://img.test/a.jpg', is_main_image: true }],
  offers: [{ url: 'https://shop-a.test/p', domain: 'shop-a.test', price: { price: c3Price, currency: 'USD' }, availability: 'InStock', condition: 'new' }],
})
function mockChannel3(): void {
  setChannel3ClientForTests({
    products: { search: async (req) => ({ data: c3Enabled && /sonaro/i.test(req.query) ? [c3Product()] : [] }) },
  })
}

let orderSeq = 0
let createCalls = 0
let payCalls = 0
const orderAmounts = new Map<string, number>()
/** What the stubbed pay_order (capture) returns: a correct capture, a different amount, a non-USD capture, or the toolkit's error shape. */
let captureMode: 'ok' | 'wrong_amount' | 'wrong_currency' | 'error' = 'ok'
function mockPayPal(): void {
  const toolkit = new PayPalAgentToolkit({
    clientId: 'test', clientSecret: 'test',
    configuration: { actions: { orders: { create: true, get: true, capture: true } }, context: { sandbox: true } },
  })
  const tools = toolkit.getTools() as unknown as Record<string, { execute: unknown }>
  const execute = async (input: any) => {
    if (Array.isArray(input?.items)) {
      createCalls++
      await new Promise((r) => setTimeout(r, 40)) // widen the window so concurrent createCheckout calls really overlap
      const id = `E2EORDER${String(++orderSeq).padStart(9, '0')}`
      orderAmounts.set(id, input.items[0].itemTotal)
      return JSON.stringify({ id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] })
    }
    payCalls++
    if (captureMode === 'error') return JSON.stringify({ error: { message: 'e2e simulated PayPal failure', type: 'paypal_error' } })
    const paid = (orderAmounts.get(input.id) ?? 0) + (captureMode === 'wrong_amount' ? 1 : 0)
    const currency = captureMode === 'wrong_currency' ? 'EUR' : 'USD'
    // toolkit shape: { status: 'success', response: <PayPal order JSON> }
    return JSON.stringify({ status: 'success', response: { id: input.id, status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: `CAPTURE${input.id}`, status: 'COMPLETED', amount: { currency_code: currency, value: paid.toFixed(2) } }] } }] } })
  }
  for (const t of Object.values(tools)) t.execute = execute
  setRawPayPalToolsForTests(tools as never)
}

// ───────────────────────── helpers ─────────────────────────

const matchRows = async (itemKey = 'wl-headphones') => await must(db().from('matches').select('*').eq('wishlist_item_id', ids.wishlist[itemKey]!), 'matches') as Row[]
const matchOf = async (listingKey: string, itemKey = 'wl-headphones') => (await matchRows(itemKey)).find((m) => m.listing_id === ids.listing[listingKey])!
const matchById = async (id: string) => await must(db().from('matches').select('*').eq('id', id).single(), 'match') as Row
const ordersOf = async (matchId: string) => await must(db().from('orders').select('*').eq('match_id', matchId).order('created_at', { ascending: true }), 'orders') as Row[]
const eventsOf = async (type: string, matchId?: string) => {
  const rows = await must(db().from('agent_events').select('*').eq('user_id', ids.user).eq('type', type), 'events') as Row[]
  return matchId ? rows.filter((r) => r.match_id === matchId) : rows
}
const tgCalls = (method: string) => telegram.filter((t) => t.method === method)
const HP = 'wl-headphones'
const setItemActive = async (key = HP) => { await must(db().from('wishlist_items').update({ status: 'active' }).eq('id', ids.wishlist[key]!).select(), 'activate item') }
const itemStatus = async (key = HP) => ((await must(db().from('wishlist_items').select('status').eq('id', ids.wishlist[key]!).single(), 'item')) as Row).status as string
const setMandate = async (maxAmount: number, key = HP) => { await must(db().from('mandates').update({ max_amount: maxAmount }).eq('wishlist_item_id', ids.wishlist[key]!).select(), 'set mandate') }
const scanItem = (key: string) => runScan({ wishlistItemId: ids.wishlist[key], userId: ids.user, isCron: false })

// ───────────────────────── scenarios ─────────────────────────

async function scenarioA(): Promise<void> {
  section('(a) runScan headphones: statuses and counts')
  const res = await scanItem('wl-headphones')
  const rows = await matchRows()
  const hp = seed.listings.filter((l) => l.key.startsWith('hp-'))
  let allOk = true
  for (const l of hp) {
    const m = rows.find((r) => r.listing_id === ids.listing[l.key])
    const want = l.key === 'hp-used-ray' ? 'negotiating' : l.expected.status
    if (m?.status !== want) { allOk = false; check(`status of ${l.key}`, false, `expected ${want}, got ${m?.status}`) }
  }
  check(`all ${hp.length} hp-* match statuses equal the seed's expected.status (cheapest ready -> negotiating)`, allOk)
  eq('match rows for headphones', rows.length, 12)
  eq('no rows for hh-* listings', rows.filter((r) => [...seed.listings.filter((l) => l.key.startsWith('hh-'))].some((l) => ids.listing[l.key] === r.listing_id)).length, 0)
  eq('ScanResponse', res, { itemsScanned: 1, listingsFetched: 0, matchesCreated: 12, flagged: 2, negotiationsStarted: 1, negotiationsAdvanced: 0, notificationsSent: 0 })

  const flagged = rows.filter((r) => r.status === 'flagged')
  check('flagged rows carry risk.level high with >= 2 signals (jsonb round trip)', flagged.length === 2 && flagged.every((r) => r.risk?.level === 'high' && r.risk.signals.length >= 2),
    flagged.map((r) => r.risk))
  const over = rows.filter((r) => r.status === 'over_budget')
  check('over_budget rows have best_price = list price (numeric -> number)', over.length === 4 && over.every((r) => {
    const l = seed.listings.find((x) => ids.listing[x.key] === r.listing_id)!
    return Number(r.best_price) === l.price
  }), over.map((r) => [r.listing_id, r.best_price]))
  const mism = rows.filter((r) => r.status === 'mismatch')
  check('mismatch rows have a verdict jsonb', mism.length === 2 && mism.every((r) => r.verdict && r.verdict.isMatch === false), mism.map((r) => r.verdict))
  check('ready/agreed/negotiating rows keep verdict and risk jsonb', rows.filter((r) => ['negotiating', 'ready'].includes(r.status)).every((r) => r.verdict?.isMatch === true && r.risk?.level === 'low'))

  const negs = await must(db().from('negotiations').select('*'), 'negotiations') as Row[]
  const ray = await matchOf('hp-used-ray')
  eq('exactly one negotiation, for hp-used-ray', negs.map((n) => n.match_id), [ray.id])
  const msgs = await must(db().from('negotiation_messages').select('*').eq('negotiation_id', negs[0]!.id), 'messages') as Row[]
  check('one seller opener message (round 0)', msgs.length === 1 && msgs[0]!.role === 'seller' && msgs[0]!.round === 0 && Number(msgs[0]!.price) === 279, msgs)

  const item = await must(db().from('wishlist_items').select('last_scanned_at').eq('id', ids.wishlist['wl-headphones']!).single(), 'item') as Row
  check('wishlist_items.last_scanned_at is set (timestamptz)', typeof item.last_scanned_at === 'string' && !Number.isNaN(Date.parse(item.last_scanned_at)), item)
  const types = (await must(db().from('agent_events').select('type').eq('user_id', ids.user), 'events') as Row[]).map((e) => e.type)
  check('agent_events has scan_started, scan_finished and two risk_flagged', types.includes('scan_started') && types.includes('scan_finished') && types.filter((t) => t === 'risk_flagged').length === 2, types)
  noUnexpectedWarnings('(a)')
}

async function scenarioB(): Promise<void> {
  section('(b) second runScan is idempotent')
  const before = matchCalls
  const rowsBefore = await matchRows()
  const res = await scanItem('wl-headphones')
  const rowsAfter = await matchRows()
  eq('no new match rows', rowsAfter.length, rowsBefore.length)
  eq('matchesCreated / negotiationsStarted / notificationsSent are 0', [res.matchesCreated, res.negotiationsStarted, res.notificationsSent], [0, 0, 0])
  eq('matcher not called again (no new candidates)', matchCalls, before)
  eq('still exactly one negotiation', ((await must(db().from('negotiations').select('id'), 'negotiations')) as Row[]).length, 1)
  const dup = await db().from('matches').insert({ wishlist_item_id: ids.wishlist['wl-headphones'], listing_id: ids.listing['hp-store-sonaro'], status: 'mismatch' })
  check('unique (wishlist_item_id, listing_id) violation comes back with error.code 23505', dup.error?.code === '23505', dup.error)
  noUnexpectedWarnings('(b)')
}

async function scenarioC(): Promise<void> {
  section('(c) Channel3 listing upserted twice without duplicates')
  c3Enabled = true
  c3Price = 349
  mockChannel3() // fresh client: clears the 10-minute search cache
  const r1 = await scanItem('wl-headphones')
  const l1 = await must(db().from('listings').select('*').eq('source', 'channel3').eq('external_id', C3_ID), 'c3 listing') as Row[]
  eq('one channel3 listing after the first scan', l1.length, 1)
  check('channel3 columns mapped (url, image_url, retailer, negotiable=false, seller_id null, price number)',
    l1[0]?.url === 'https://shop-a.test/p' && l1[0]?.image_url === 'https://img.test/a.jpg' && l1[0]?.retailer === 'shop-a.test' && l1[0]?.negotiable === false && l1[0]?.seller_id === null && Number(l1[0]?.price) === 349 && l1[0]?.condition === 'new', l1[0])
  eq('first scan: 1 listing fetched, 1 match created', [r1.listingsFetched, r1.matchesCreated], [1, 1])
  const m = (await matchRows()).find((r) => r.listing_id === l1[0]?.id)
  eq('channel3 match status over_budget (349 > 300)', m?.status, 'over_budget')

  setChannel3ClientForTests(null)
  c3Price = 339.5
  mockChannel3() // clears the 10-minute cache so the second scan really upserts again
  const r2 = await scanItem('wl-headphones')
  const l2 = await must(db().from('listings').select('*').eq('source', 'channel3').eq('external_id', C3_ID), 'c3 listing') as Row[]
  eq('still one channel3 listing after the second upsert', l2.length, 1)
  check('same row id, price updated to 339.5', l2[0]?.id === l1[0]?.id && Number(l2[0]?.price) === 339.5, l2[0])
  eq('second scan: listing fetched again, no new match', [r2.listingsFetched, r2.matchesCreated], [1, 0])
  eq('match rows for headphones now 13', (await matchRows()).length, 13)
  noUnexpectedWarnings('(c)')
}

async function scenarioD(): Promise<void> {
  section('(d) cron runScan picks the 2 least recently scanned items')
  const yesterday = new Date(Date.now() - 86_400_000).toISOString()
  await must(db().from('wishlist_items').update({ last_scanned_at: yesterday }).eq('id', ids.wishlist['wl-headphones']!).select(), 'set yesterday')
  const startedAt = Date.now() - 1000
  stepCalls.length = 0
  const res = await runScan({ isCron: true })
  const items = await must(db().from('wishlist_items').select('*').eq('user_id', ids.user), 'items') as Row[]
  const at = (k: string) => items.find((i) => i.id === ids.wishlist[k])!.last_scanned_at as string | null
  check('handheld and keyboard were scanned just now', [at('wl-handheld'), at('wl-keyboard')].every((t) => t && Date.parse(t) >= startedAt), [at('wl-handheld'), at('wl-keyboard')])
  eq('headphones last_scanned_at untouched (still yesterday)', Date.parse(at('wl-headphones')!), Date.parse(yesterday))
  eq('itemsScanned', res.itemsScanned, 2)

  const hh = await matchRows('wl-handheld')
  let ok = true
  for (const l of seed.listings.filter((x) => x.key.startsWith('hh-'))) {
    const m = hh.find((r) => r.listing_id === ids.listing[l.key])
    const want = l.key === 'hh-used-techdad' ? 'negotiating' : l.expected.status
    if (m?.status !== want) { ok = false; check(`handheld status of ${l.key}`, false, `expected ${want}, got ${m?.status}`) }
  }
  check('handheld statuses equal the seed (cheapest ready hh-used-techdad -> negotiating)', ok)
  eq('handheld match rows', hh.length, 9)
  eq('keyboard (no listings, no retail results): no matches', (await matchRows('wl-keyboard')).length, 0)
  eq('negotiationsStarted', res.negotiationsStarted, 1)

  const ray = await matchOf('hp-used-ray')
  const neg = (await must(db().from('negotiations').select('*').eq('match_id', ray.id), 'negotiation')) as Row[]
  eq('cron advanced the active hp negotiation once via the real claim_negotiation rpc', [stepCalls.length, res.negotiationsAdvanced, neg[0]?.round], [1, 1, 1])
  check('step lock released (locked_until null)', neg[0]?.locked_until === null, neg[0])
  const msgs = (await must(db().from('negotiation_messages').select('*').eq('negotiation_id', neg[0]!.id), 'messages')) as Row[]
  check('round 1 produced buyer + seller messages in the table', msgs.some((m) => m.role === 'buyer' && m.round === 1) && msgs.some((m) => m.role === 'seller' && m.round === 1), msgs.map((m) => [m.role, m.round]))
  noUnexpectedWarnings('(d)')
}

async function scenarioE(): Promise<void> {
  section('(e) notifyDeal: atomic claim, one Telegram message')
  await must(db().from('profiles').update({ telegram_chat_id: DEMO_CHAT }).eq('id', ids.user).select(), 'link chat')
  const techdad = await matchOf('hp-used-techdad')
  await must(db().from('matches').update({ status: 'agreed', best_price: 268 }).eq('id', techdad.id).select(), 'set agreed')
  telegram.length = 0

  const first = await notifyDeal(techdad.id)
  const second = await notifyDeal(techdad.id)
  eq('first notifyDeal true, second false', [first, second], [true, false])
  const after = await matchById(techdad.id)
  check('match status notified, notified_at set', after.status === 'notified' && !!after.notified_at, after)
  const sent = tgCalls('sendMessage')
  eq('one Telegram sendMessage recorded', sent.length, 1)
  eq('sendMessage chat_id is the (bigint) chat id as a number', sent[0]?.body.chat_id, DEMO_CHAT)
  check('message has Approve & pay (pay:<matchId>) and Skip buttons', JSON.stringify(sent[0]?.body.reply_markup).includes(`pay:${techdad.id}`) && JSON.stringify(sent[0]?.body.reply_markup).includes(`skip:${techdad.id}`), sent[0]?.body.reply_markup)
  eq('one deal_notified event', (await eventsOf('deal_notified', techdad.id)).length, 1)

  // concurrent claim on another agreed match: exactly one winner
  const gf = await matchOf('hp-used-gadgetflip')
  await must(db().from('matches').update({ status: 'agreed', best_price: 265 }).eq('id', gf.id).select(), 'set agreed')
  telegram.length = 0
  const results = await Promise.all([notifyDeal(gf.id), notifyDeal(gf.id), notifyDeal(gf.id)])
  eq('3 concurrent notifyDeal: exactly one true', results.filter(Boolean).length, 1)
  eq('and exactly one Telegram message', tgCalls('sendMessage').length, 1)

  // scan -> notifyBest -> notifyDeal with the real claim: a cheaper agreed deal is announced
  const mei = await matchOf('hp-used-mei')
  await must(db().from('matches').update({ status: 'agreed', best_price: 250 }).eq('id', mei.id).select(), 'set agreed')
  telegram.length = 0
  const res = await scanItem('wl-headphones')
  eq('scan notifies the cheaper agreed deal (notificationsSent 1)', res.notificationsSent, 1)
  eq('mei match is now notified', (await matchById(mei.id)).status, 'notified')
  eq('one Telegram message from the scan', tgCalls('sendMessage').length, 1)
  noUnexpectedWarnings('(e)')
}

async function scenarioF(): Promise<void> {
  section('(f) createCheckout / captureOrder / cancelOrder')
  const mei = await matchOf('hp-used-mei')
  const meiListing = seed.listings.find((l) => l.key === 'hp-used-mei')!
  setModelForTests('fast', mockToolCallModel('create_order', buildCreateOrderInput({
    title: meiListing.title, amount: 250, returnUrl: `${env.appUrl}/api/checkout/return`, cancelUrl: `${env.appUrl}/api/checkout/cancel`,
  })))
  telegram.length = 0
  const c0 = createCalls
  const co = await createCheckout(mei.id, ids.user)
  eq('PayPal create_order called once (agentic path)', createCalls - c0, 1)
  check('response has paypalOrderId and sandbox approveUrl', co.paypalOrderId.startsWith('E2EORDER') && co.approveUrl.includes('sandbox.paypal.com'), co)
  const orders = await ordersOf(mei.id)
  check('orders row created (jsonb/numeric/uuid columns accepted)', orders.length === 1 && orders[0]!.status === 'created' && Number(orders[0]!.amount) === 250 && orders[0]!.user_id === ids.user && orders[0]!.paypal_order_id === co.paypalOrderId && orders[0]!.approve_url === co.approveUrl && orders[0]!.id === co.orderId, orders)
  eq('match -> checkout_pending', (await matchById(mei.id)).status, 'checkout_pending')
  eq('order_created event', (await eventsOf('order_created', mei.id)).length, 1)

  const again = await createCheckout(mei.id, ids.user)
  check('second createCheckout is idempotent (same order, no PayPal call, still one row)', again.orderId === co.orderId && again.paypalOrderId === co.paypalOrderId && createCalls - c0 === 1 && (await ordersOf(mei.id)).length === 1, again)

  const p0 = payCalls
  const done = await captureOrder(co.paypalOrderId)
  check('captureOrder completes the order with capture_id', done.status === 'completed' && done.captureId === `CAPTURE${co.paypalOrderId}`, done)
  const mAfter = await matchById(mei.id)
  eq('match -> purchased', mAfter.status, 'purchased')
  const wl = await must(db().from('wishlist_items').select('status').eq('id', ids.wishlist['wl-headphones']!).single(), 'wl') as Row
  eq('wishlist item -> fulfilled', wl.status, 'fulfilled')
  eq('order_captured event', (await eventsOf('order_captured', mei.id)).length, 1)
  check('Telegram receipt sent to the linked chat', tgCalls('sendMessage').some((t) => t.body.chat_id === DEMO_CHAT && String(t.body.text).includes('Paid')), tgCalls('sendMessage').map((t) => t.body.text))
  const again2 = await captureOrder(co.paypalOrderId)
  check('second captureOrder is idempotent (no PayPal call)', again2.status === 'completed' && payCalls - p0 === 1, again2)
  // the first captured purchase fulfilled the item; checkout refuses non-active items, so later scenarios reactivate it
  await setItemActive()

  // cancel path on another match (deterministic fallback: model fails)
  setModelForTests('fast', mockFailingModel())
  const gf = await matchOf('hp-used-gadgetflip')
  const c1 = await createCheckout(gf.id, ids.user)
  eq('gadgetflip match -> checkout_pending (direct-call fallback)', (await matchById(gf.id)).status, 'checkout_pending')
  const cancelled = await cancelOrder(c1.paypalOrderId)
  eq('cancelOrder returns the match id', cancelled?.matchId, gf.id)
  eq('order -> cancelled', (await ordersOf(gf.id))[0]?.status, 'cancelled')
  eq('match back to notified', (await matchById(gf.id)).status, 'notified')
  eq('cancelOrder of an unknown order -> null', await cancelOrder('NOSUCHORDER000000000'), null)
  const c2 = await createCheckout(gf.id, ids.user)
  const gfOrders = await ordersOf(gf.id)
  check('a new checkout after the cancel creates a fresh order', c2.paypalOrderId !== c1.paypalOrderId && gfOrders.length === 2 && gfOrders[1]!.status === 'created', gfOrders.map((o) => [o.paypal_order_id, o.status]))
  noUnexpectedWarnings('(f)', [/^\[checkout\] agent path failed, using direct call: mock model failure/]) // expected: the cancel-path checkout runs with a failing model
}

async function scenarioG(): Promise<void> {
  section('(g) mandate lowered below the price blocks checkout, PayPal untouched')
  const techdad = await matchOf('hp-used-techdad')
  eq('precondition: techdad match is notified at 268', [techdad.status, Number(techdad.best_price)], ['notified', 268])
  await setItemActive()
  await must(db().from('mandates').update({ max_amount: 200 }).eq('wishlist_item_id', ids.wishlist['wl-headphones']!).select(), 'lower mandate')
  const c0 = createCalls
  const err = await createCheckout(techdad.id, ids.user).catch((e) => e)
  check('rejects with CheckoutError exceeds_mandate (409)', err instanceof CheckoutError && err.code === 'exceeds_mandate' && err.statusCode === 409, String(err?.code ?? err))
  eq('PayPal create_order not called', createCalls - c0, 0)
  eq('no order row', (await ordersOf(techdad.id)).length, 0)
  eq('match status unchanged', (await matchById(techdad.id)).status, 'notified')
  eq('guardrail_blocked event logged', (await eventsOf('guardrail_blocked', techdad.id)).length, 1)
  await setMandate(300) // restore the seed's mandate for the scenarios below
  noUnexpectedWarnings('(g)')
}

async function scenarioH(): Promise<void> {
  section('(h) Telegram handleUpdate')
  await must(db().from('profiles').update({ telegram_chat_id: null }).eq('id', ids.user).select(), 'unlink')
  const profileOf = async (id: string) => await must(db().from('profiles').select('*').eq('id', id).single(), 'profile') as Row
  const priv = (id: number) => ({ id, type: 'private' })
  const privCb = (cqId: string, data: string, chat: number) => ({ callback_query: { id: cqId, data, from: { id: chat }, message: { chat: priv(chat) } } })

  telegram.length = 0
  await handleUpdate({ message: { text: '/start wrong-token', chat: priv(555111), from: { id: 555111 } } })
  eq('/start with an unknown token links nothing', (await profileOf(ids.user)).telegram_chat_id, null)
  check('and answers with the "open Settings" hint', tgCalls('sendMessage').length === 1 && String(tgCalls('sendMessage')[0]!.body.text).includes('Settings'))

  // a link token pasted into a group chat must not link anything (and must not be consumed)
  telegram.length = 0
  await handleUpdate({ message: { text: `/start ${DEMO_TOKEN}`, chat: { id: -100123456, type: 'group' }, from: { id: DEMO_CHAT } } })
  const afterGroup = await profileOf(ids.user)
  check('/start <valid token> from a group chat links nothing and keeps the token', afterGroup.telegram_chat_id === null && afterGroup.telegram_link_token === DEMO_TOKEN, afterGroup)
  check('group chat is told to use a private chat', tgCalls('sendMessage').length === 1 && String(tgCalls('sendMessage')[0]!.body.text).includes('private'), tgCalls('sendMessage').map((t) => t.body))

  telegram.length = 0
  await handleUpdate({ message: { text: `/start ${DEMO_TOKEN}`, chat: priv(DEMO_CHAT), from: { id: DEMO_CHAT } } })
  const linked = await profileOf(ids.user)
  eq('/start <token> in a private chat links the chat (bigint column, number round trip)', linked.telegram_chat_id, DEMO_CHAT)
  check('confirmation sent to that chat', tgCalls('sendMessage').length === 1 && tgCalls('sendMessage')[0]!.body.chat_id === DEMO_CHAT)
  check('link token rotated: new 24-hex value, different from the old one', typeof linked.telegram_link_token === 'string' && /^[0-9a-f]{24}$/.test(linked.telegram_link_token) && linked.telegram_link_token !== DEMO_TOKEN, linked.telegram_link_token)
  eq("the other user's chat link is untouched", (await profileOf(ids.other)).telegram_chat_id, OTHER_CHAT)

  // replaying the old token from another private chat links nothing
  telegram.length = 0
  await handleUpdate({ message: { text: `/start ${DEMO_TOKEN}`, chat: priv(424242), from: { id: 424242 } } })
  const afterReplay = await profileOf(ids.user)
  check('replaying the old token from another chat changes nothing (chat id and token as before)', afterReplay.telegram_chat_id === DEMO_CHAT && afterReplay.telegram_link_token === linked.telegram_link_token, afterReplay)
  check('and the replay gets the "open Settings" hint', tgCalls('sendMessage').length === 1 && String(tgCalls('sendMessage')[0]!.body.text).includes('Settings'))

  const techdad = await matchOf('hp-used-techdad')
  const o0 = (await ordersOf(techdad.id)).length
  const c0 = createCalls
  telegram.length = 0
  await handleUpdate(privCb('cq1', `skip:${techdad.id}`, OTHER_CHAT))
  eq('skip from a foreign (linked to another user) chat changes nothing', (await matchById(techdad.id)).status, 'notified')
  check('answered "Deal not found"', tgCalls('answerCallbackQuery').length === 1 && String(tgCalls('answerCallbackQuery')[0]!.body.text).includes('not found'), tgCalls('answerCallbackQuery').map((t) => t.body))
  await handleUpdate(privCb('cq2', `skip:${techdad.id}`, 123456789))
  eq('skip from an unlinked chat changes nothing', (await matchById(techdad.id)).status, 'notified')
  await handleUpdate(privCb('cq3', `pay:${techdad.id}`, OTHER_CHAT))
  check('pay from a foreign chat creates no order and calls no PayPal', (await ordersOf(techdad.id)).length === o0 && createCalls === c0)

  // callbacks from a group chat, or where the pressing user is not the chat, are refused before any lookup
  telegram.length = 0
  await handleUpdate({ callback_query: { id: 'cq-g1', data: `skip:${techdad.id}`, from: { id: DEMO_CHAT }, message: { chat: { id: DEMO_CHAT, type: 'group' } } } })
  await handleUpdate({ callback_query: { id: 'cq-g2', data: `pay:${techdad.id}`, from: { id: DEMO_CHAT }, message: { chat: { id: DEMO_CHAT, type: 'supergroup' } } } })
  await handleUpdate({ callback_query: { id: 'cq-g3', data: `skip:${techdad.id}`, from: { id: 31337 }, message: { chat: priv(DEMO_CHAT) } } })
  eq('group / supergroup / from-id-mismatch callbacks from the OWNER chat id change nothing', (await matchById(techdad.id)).status, 'notified')
  check('they create no order and call no PayPal', (await ordersOf(techdad.id)).length === o0 && createCalls === c0)
  check('each is answered with the private-chat hint', tgCalls('answerCallbackQuery').length === 3 && tgCalls('answerCallbackQuery').every((t) => String(t.body.text).includes('private chat')), tgCalls('answerCallbackQuery').map((t) => t.body))

  telegram.length = 0
  await handleUpdate(privCb('cq4', `skip:${techdad.id}`, DEMO_CHAT))
  eq('skip from the owner (private) chat marks the match skipped', (await matchById(techdad.id)).status, 'skipped')

  // pay: from the owner chat for the match that has an open order -> returns the approve link
  telegram.length = 0
  const gf = await matchOf('hp-used-gadgetflip')
  const open = (await ordersOf(gf.id)).find((o) => o.status === 'created')!
  await handleUpdate(privCb('cq5', `pay:${gf.id}`, DEMO_CHAT))
  check('pay from the owner chat answers with the PayPal approve link', JSON.stringify(tgCalls('sendMessage').at(-1)?.body.reply_markup ?? '').includes(open?.approve_url ?? 'no-open-order'), tgCalls('sendMessage').map((t) => t.body))
  noUnexpectedWarnings('(h)')
}


async function scenarioI(): Promise<void> {
  section('(i) two concurrent scans of the same item race on the unique pair (23505 handling)')
  const itemId = ids.wishlist['wl-handheld']!
  await must(db().from('matches').delete().eq('wishlist_item_id', itemId).select(), 'reset handheld matches') // negotiations cascade
  const [r1, r2] = await Promise.all([scanItem('wl-handheld'), scanItem('wl-handheld')])
  const rows = await matchRows('wl-handheld')
  eq('exactly 9 match rows despite the race (unique pair held)', rows.length, 9)
  eq('matchesCreated across both scans adds up to 9 (the loser of each insert is not counted)', r1.matchesCreated + r2.matchesCreated, 9)
  const negs = await must(db().from('negotiations').select('*').in('match_id', rows.map((r) => r.id)), 'negotiations') as Row[]
  eq('at most one negotiation for the item', negs.length <= 1, true)
  const rowStatuses = rows.map((r) => r.status)
  check('no match stuck in a wrong state: <= 1 negotiating', rowStatuses.filter((x) => x === 'negotiating').length <= 1, rowStatuses)
  noUnexpectedWarnings('(i)')
}

// ───────────────────────── checkout / webhook scenarios (j)-(n) ─────────────────────────

/** Put a headphones match into a payable state: item active, seed mandate, match `notified` at `price`. */
async function prepMatch(listingKey: string, price: number, o: { activate?: boolean; mandate?: number } = {}): Promise<Row> {
  if (o.activate !== false) await setItemActive()
  await setMandate(o.mandate ?? 300)
  const m = await matchOf(listingKey)
  await must(db().from('matches').update({ status: 'notified', best_price: price }).eq('id', m.id).select(), 'prep match')
  return m
}
const titleOf = (key: string) => seed.listings.find((l) => l.key === key)!.title
const createInput = (key: string, amount: number) => buildCreateOrderInput({ title: titleOf(key), amount, returnUrl: `${env.appUrl}/api/checkout/return`, cancelUrl: `${env.appUrl}/api/checkout/cancel` })
const orderRow = async (paypalOrderId: string) => (await must(db().from('orders').select('*').eq('paypal_order_id', paypalOrderId), 'order') as Row[])[0]!
const webhookRows = async (id: string) => await must(db().from('webhook_events').select('*').eq('id', id), 'webhook_events') as Row[]
const FALLBACK_WARN = /^\[checkout\] agent path failed, using direct call: mock model failure/ // expected whenever a checkout runs with the failing model

async function scenarioJ(): Promise<void> {
  section('(j) three concurrent createCheckout on one match: atomic claim, one PayPal order')
  const m = await prepMatch('hp-used-techdad', 268)
  setModelForTests('fast', mockToolCallModel('create_order', createInput('hp-used-techdad', 268)))
  const c0 = createCalls
  const results = await Promise.allSettled([createCheckout(m.id, ids.user), createCheckout(m.id, ids.user), createCheckout(m.id, ids.user)])
  const orders = await ordersOf(m.id)
  eq('exactly one orders row', orders.length, 1)
  eq('PayPal create_order stub called once', createCalls - c0, 1)
  const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createCheckout>>> => r.status === 'fulfilled')
  const bad = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  check('at least one caller got the order, and every winner got the one real order', ok.length >= 1 && ok.every((r) => r.value.paypalOrderId === orders[0]?.paypal_order_id), results.map((r) => (r.status === 'fulfilled' ? r.value.paypalOrderId : String(r.reason?.code ?? r.reason))))
  check('every loser failed with CheckoutError checkout_in_progress', bad.every((r) => r.reason instanceof CheckoutError && r.reason.code === 'checkout_in_progress' && r.reason.statusCode === 409), bad.map((r) => String(r.reason?.code ?? r.reason)))
  eq('match -> checkout_pending (claim held)', (await matchById(m.id)).status, 'checkout_pending')
  eq('one order_created event', (await eventsOf('order_created', m.id)).length, 1)
  noUnexpectedWarnings('(j)')

  section('(j2) an open order older than 2 hours is cancelled and replaced')
  setModelForTests('fast', mockFailingModel())
  const sm = await prepMatch('hp-store-sonaro', 280)
  const first = await createCheckout(sm.id, ids.user)
  await must(db().from('orders').update({ created_at: new Date(Date.now() - 3 * 3_600_000).toISOString() }).eq('paypal_order_id', first.paypalOrderId).select(), 'age order')
  const second = await createCheckout(sm.id, ids.user)
  const rows = await ordersOf(sm.id)
  check('new order with a different PayPal id', second.paypalOrderId !== first.paypalOrderId && second.orderId !== first.orderId, [first.paypalOrderId, second.paypalOrderId])
  eq('statuses [stale, fresh] = [cancelled, created]', rows.map((r) => r.status), ['cancelled', 'created'])
  eq('match -> checkout_pending again', (await matchById(sm.id)).status, 'checkout_pending')
  noUnexpectedWarnings('(j2)', [FALLBACK_WARN])
}

async function scenarioK(): Promise<void> {
  section('(k) PayPal webhook: verification, event claim in webhook_events, retry after a failed capture')
  const saved = { id: process.env.PAYPAL_WEBHOOK_ID, base: process.env.PAYPAL_API_BASE }
  const headers = {
    'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-E2E',
    'paypal-transmission-id': 'e2e-tx', 'paypal-transmission-sig': 'e2e-sig', 'paypal-transmission-time': '2026-11-12T00:00:00Z',
  }
  const approved = (eventId: string, orderId: string) => JSON.stringify({ id: eventId, event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: orderId, status: 'APPROVED' } })
  try {
    process.env.PAYPAL_WEBHOOK_ID = 'e2e-webhook-id'
    process.env.PAYPAL_API_BASE = 'https://api-m.sandbox.paypal.com'
    setModelForTests('fast', mockFailingModel())

    // guards before anything is verified
    paypalHttp.length = 0
    const techdad = await matchOf('hp-used-techdad')
    const tdOrder = (await ordersOf(techdad.id))[0]!
    delete process.env.PAYPAL_WEBHOOK_ID
    eq('no PAYPAL_WEBHOOK_ID -> ignored, PayPal never contacted', [await handlePayPalWebhook(headers, approved('E2E-WH-APPROVED', tdOrder.paypal_order_id)), paypalHttp.length], ['ignored', 0])
    process.env.PAYPAL_WEBHOOK_ID = 'e2e-webhook-id'
    process.env.PAYPAL_API_BASE = 'https://api-m.paypal.com'
    eq('non-sandbox PAYPAL_API_BASE host -> ignored, PayPal never contacted', [await handlePayPalWebhook(headers, approved('E2E-WH-APPROVED', tdOrder.paypal_order_id)), paypalHttp.length], ['ignored', 0])
    process.env.PAYPAL_API_BASE = 'https://api-m.sandbox.paypal.com'
    eq('no webhook_events row left behind by the ignored deliveries', (await webhookRows('E2E-WH-APPROVED')).length, 0)

    // APPROVED delivered twice
    const p0 = payCalls
    paypalHttp.length = 0
    const body = approved('E2E-WH-APPROVED', tdOrder.paypal_order_id)
    const first = await handlePayPalWebhook(headers, body)
    eq('verification used the OAuth token call then verify-webhook-signature', paypalHttp, ['/v1/oauth2/token', '/v1/notifications/verify-webhook-signature'])
    const second = await handlePayPalWebhook(headers, body)
    eq('first delivery captured, second delivery duplicate', [first, second], ['captured', 'duplicate'])
    eq('PayPal capture (pay_order) ran exactly once', payCalls - p0, 1)
    const tdAfter = await orderRow(tdOrder.paypal_order_id)
    check('order completed with capture_id', tdAfter.status === 'completed' && tdAfter.capture_id === `CAPTURE${tdOrder.paypal_order_id}`, tdAfter)
    eq('match -> purchased', (await matchById(techdad.id)).status, 'purchased')
    eq('exactly one webhook_events row for the event id', (await webhookRows('E2E-WH-APPROVED')).map((r) => [r.id, r.type]), [['E2E-WH-APPROVED', 'CHECKOUT.ORDER.APPROVED']])
    eq('one order_captured event', (await eventsOf('order_captured', techdad.id)).length, 1)

    // capture fails: the event claim is released, the retry of the SAME event id captures
    const gf = await matchOf('hp-used-gadgetflip')
    const gfOrder = (await ordersOf(gf.id)).find((o) => o.status === 'created')!
    check('precondition: gadgetflip has an open order and is checkout_pending', !!gfOrder && gf.status === 'checkout_pending', [gfOrder?.status, gf.status])
    const gfBody = approved('E2E-WH-FAIL', gfOrder.paypal_order_id)
    captureMode = 'error'
    const failed = await handlePayPalWebhook(headers, gfBody)
    eq("capture failure -> outcome 'error'", failed, 'error')
    eq('the webhook_events claim row was released again', (await webhookRows('E2E-WH-FAIL')).length, 0)
    eq('order marked failed, match not purchased', [(await orderRow(gfOrder.paypal_order_id)).status, (await matchById(gf.id)).status], ['failed', 'checkout_pending'])
    captureMode = 'ok'
    const retry = await handlePayPalWebhook(headers, gfBody)
    eq('retry of the same event id -> captured', retry, 'captured')
    eq('order completed and match purchased after the retry', [(await orderRow(gfOrder.paypal_order_id)).status, (await matchById(gf.id)).status], ['completed', 'purchased'])
    eq('claim row present again (processed)', (await webhookRows('E2E-WH-FAIL')).length, 1)

    // bad signature: nothing captured, nothing claimed
    const sm = await matchOf('hp-store-sonaro') // (j2) left it checkout_pending with an open order
    const smOrder = (await ordersOf(sm.id)).find((o) => o.status === 'created')!
    check('precondition: sonaro match has an open order', !!smOrder)
    const p1 = payCalls
    verifyStatus = 'FAILURE'
    const bad = await handlePayPalWebhook(headers, approved('E2E-WH-BAD', smOrder.paypal_order_id))
    verifyStatus = 'SUCCESS'
    eq('bad signature (verify says FAILURE) -> ignored', bad, 'ignored')
    eq('PayPal capture not called', payCalls - p1, 0)
    eq('order still created, match not purchased', [(await orderRow(smOrder.paypal_order_id)).status, (await matchById(sm.id)).status], ['created', 'checkout_pending'])
    eq('no webhook_events row for the unverified event', (await webhookRows('E2E-WH-BAD')).length, 0)
    check('only e2e stub hosts were contacted for PayPal (sandbox host)', paypalHttp.every((x) => x.startsWith('/v1/')), paypalHttp)
  } finally {
    if (saved.id === undefined) delete process.env.PAYPAL_WEBHOOK_ID; else process.env.PAYPAL_WEBHOOK_ID = saved.id
    if (saved.base === undefined) delete process.env.PAYPAL_API_BASE; else process.env.PAYPAL_API_BASE = saved.base
    verifyStatus = 'SUCCESS'
    captureMode = 'ok'
  }
  const expected = warnings.filter((w) => w.startsWith('[paypal-webhook]'))
  check('expected webhook warnings were logged as short messages (no raw bodies / secrets)', expected.length >= 4 && expected.every((w) => w.length < 160 && !/e2e-placeholder|e2e-sig|access_token/.test(w)), expected)
  noUnexpectedWarnings('(k)', [/^\[paypal-webhook\]/, FALLBACK_WARN])
}

async function scenarioL(): Promise<void> {
  section('(l) a capture that does not match the order is rejected; a later correct capture works')
  setModelForTests('fast', mockFailingModel())
  const m = await prepMatch('hp-store-soundhouse', 270)
  const co = await createCheckout(m.id, ids.user)
  const p0 = payCalls
  for (const mode of ['wrong_amount', 'wrong_currency', 'error'] as const) {
    captureMode = mode
    const err = await captureOrder(co.paypalOrderId).catch((e) => e)
    check(`capture mode ${mode}: CheckoutError capture_failed`, err instanceof CheckoutError && err.code === 'capture_failed', String(err?.code ?? err))
    eq(`capture mode ${mode}: order failed`, (await orderRow(co.paypalOrderId)).status, 'failed')
    check(`capture mode ${mode}: match not purchased, item not fulfilled`, (await matchById(m.id)).status === 'checkout_pending' && (await itemStatus()) === 'active', [(await matchById(m.id)).status, await itemStatus()])
  }
  eq('PayPal capture was attempted 3 times', payCalls - p0, 3)
  eq('3 order_failed events, no order_captured event', [(await eventsOf('order_failed', m.id)).length, (await eventsOf('order_captured', m.id)).length], [3, 0])
  captureMode = 'ok'
  const done = await captureOrder(co.paypalOrderId)
  check('a failed order can be retried: correct capture completes it', done.status === 'completed' && done.captureId === `CAPTURE${co.paypalOrderId}`, done)
  eq('match -> purchased, item -> fulfilled only now', [(await matchById(m.id)).status, await itemStatus()], ['purchased', 'fulfilled'])
  noUnexpectedWarnings('(l)', [FALLBACK_WARN])
}

async function scenarioM(): Promise<void> {
  section('(m) fulfilled item / purchased match / max price: no payment')
  eq('precondition: item is fulfilled (by the capture in (l))', await itemStatus(), 'fulfilled')
  const em = await prepMatch('hp-store-electromart', 280, { activate: false })
  const c0 = createCalls
  const err = await createCheckout(em.id, ids.user).catch((e) => e)
  check('createCheckout on a fulfilled item -> CheckoutError not_allowed', err instanceof CheckoutError && err.code === 'not_allowed' && err.statusCode === 409, String(err?.code ?? err))
  eq('no order row, PayPal untouched, match still notified', [(await ordersOf(em.id)).length, createCalls - c0, (await matchById(em.id)).status], [0, 0, 'notified'])

  // captureOrder refuses when the match is already purchased
  const mei = await matchOf('hp-used-mei')
  eq('precondition: mei match purchased', (await matchById(mei.id)).status, 'purchased')
  await must(db().from('orders').insert({ match_id: mei.id, user_id: ids.user, paypal_order_id: 'E2EALREADYPAID0000001', amount: 250, currency: 'USD', status: 'created', approve_url: 'https://www.sandbox.paypal.com/checkoutnow?token=E2EALREADYPAID0000001' }).select(), 'dup order')
  const p0 = payCalls
  const err2 = await captureOrder('E2EALREADYPAID0000001').catch((e) => e)
  check('captureOrder on a purchased match -> CheckoutError already_purchased', err2 instanceof CheckoutError && err2.code === 'already_purchased', String(err2?.code ?? err2))
  eq('PayPal capture not called, order untouched', [payCalls - p0, (await orderRow('E2EALREADYPAID0000001')).status], [0, 'created'])
  await must(db().from('orders').delete().eq('paypal_order_id', 'E2EALREADYPAID0000001').select(), 'remove dup order')

  // price above the item's max_price, with a mandate that would allow it
  const pg = await prepMatch('hp-store-playgrid', 320, { mandate: 400 })
  const err3 = await createCheckout(pg.id, ids.user).catch((e) => e)
  check('price 320 > max_price 300 -> CheckoutError exceeds_max_price', err3 instanceof CheckoutError && err3.code === 'exceeds_max_price', String(err3?.code ?? err3))
  eq('no order row, PayPal untouched, match still notified', [(await ordersOf(pg.id)).length, createCalls - c0, (await matchById(pg.id)).status], [0, 0, 'notified'])
  eq('guardrail_blocked event logged for it', (await eventsOf('guardrail_blocked', pg.id)).length, 1)
  await setMandate(300)
  noUnexpectedWarnings('(m)')
}

async function scenarioN(): Promise<void> {
  section('(n) webhook_events accepts the code\'s insert shape and rejects a duplicate id')
  const first = await db().from('webhook_events').insert({ id: 'E2E-SQL-1', type: 'CHECKOUT.ORDER.APPROVED' })
  check('insert { id, type } succeeds', !first.error, first.error)
  const dup = await db().from('webhook_events').insert({ id: 'E2E-SQL-1', type: 'CHECKOUT.ORDER.APPROVED' })
  check('inserting the same id again fails with error.code 23505', dup.error?.code === '23505', dup.error)
  const rows = await webhookRows('E2E-SQL-1')
  check('one row, received_at defaulted', rows.length === 1 && !Number.isNaN(Date.parse(rows[0]!.received_at)), rows)
  const noType = await db().from('webhook_events').insert({ id: 'E2E-SQL-2' })
  check('a row without type is rejected (not null, 23502)', noType.error?.code === '23502', noType.error)
  const del = await db().from('webhook_events').delete().eq('id', 'E2E-SQL-1')
  check('the claim can be deleted again (the release path)', !del.error && (await webhookRows('E2E-SQL-1')).length === 0, del.error)
}

// ───────────────────────── main ─────────────────────────

async function main(): Promise<void> {
  console.log(`Local e2e spike against ${new URL(process.env.SUPABASE_URL!).origin}`)
  section('setup: cleanup + load demo data')
  await cleanup()
  await loadSeed()
  eq('profile auto-created by the handle_new_user trigger', ((await must(db().from('profiles').select('id').in('id', [ids.user, ids.other]), 'profiles')) as Row[]).length, 2)
  eq('seeded listings / wishlist items', [Object.keys(ids.listing).length, Object.keys(ids.wishlist).length], [seed.listings.length, 3])
  mockAi(); mockChannel3(); mockPayPal()

  for (const s of [scenarioA, scenarioB, scenarioC, scenarioD, scenarioE, scenarioF, scenarioG, scenarioH, scenarioI, scenarioJ, scenarioK, scenarioL, scenarioM, scenarioN]) {
    try { await s() } catch (e) { check(`${s.name} completed without throwing`, false, e instanceof Error ? e.stack ?? e.message : String(e)) }
  }

  const rest = warnings.filter((w) => !w.startsWith('[ai]'))
  if (rest.length) console.log(`\nOther warnings captured (${rest.length}):\n  ${rest.join('\n  ')}`)
  console.log(`\n== SUMMARY: ${passed} passed, ${failures.length} failed`)
  for (const f of failLines) console.log(`  FAIL  ${f}`)
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.stack : e); failures.push('fatal') })
  .finally(() => { process.exit(failures.length ? 1 : 0) })
