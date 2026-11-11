/**
 * Eval for the AI engine (plan A3/A4).  Owner: A.
 *
 *   pnpm eval:negotiation              real Supabase + real Gemini (needs GOOGLE_GENERATIVE_AI_API_KEY in .env)
 *   pnpm eval:negotiation -- --mock    same flow, NO network and no key: mock models, LOCAL Supabase (127.0.0.1:55321) only
 *
 * Part 1: matcher accuracy against `expected.match` in supabase/seed/data.json.
 * Part 2: for every seeded listing with expected.status === 'ready': temporary match -> startNegotiation -> stepNegotiation loop.
 * Ends with a PASS/FAIL checklist for the A4 acceptance bullets; exit code 1 when any item FAILs.
 * Temporary rows (match, negotiation, messages, agent_events) are always deleted in a `finally`.
 */
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModel } from 'ai'
import seed from '../supabase/seed/data.json'
import { db, unwrap } from '~~/server/lib/db'
import { matchListings } from '~~/server/lib/ai/matcher'
import { setModelForTests } from '~~/server/lib/ai/model'
import { startNegotiation, stepNegotiation } from '~~/server/lib/ai/negotiation'
import { toCamel, toCamelList } from '~~/server/lib/mappers'
import type { Listing, Mandate, NegotiationMessage, WishlistItem } from '#shared/types'

type Row = Record<string, any>
type SeedListing = (typeof seed.listings)[number]

const MOCK = process.argv.includes('--mock')
const MOCK_SUPABASE_PORT = '55321'
const PREFERRED_EMAIL = 'e2e-b-demo@dealhound.test'
const MAX_STEPS = 8
const STEP_PAUSE_MS = MOCK ? 150 : 1500
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ───────────────────────── safety checks (before anything touches a database or a model) ─────────────────────────

function refuseToStart(why: string): never {
  console.error(`REFUSING TO START: ${why}`)
  process.exit(2)
}

function safetyChecks(): void {
  const rawUrl = process.env.SUPABASE_URL ?? ''
  if (!rawUrl) refuseToStart('SUPABASE_URL is not set (put it in .env)')
  if (MOCK) {
    let u: URL
    try { u = new URL(rawUrl) } catch { return refuseToStart('SUPABASE_URL is not a valid URL') }
    const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
    if (!local || u.port !== MOCK_SUPABASE_PORT) {
      refuseToStart(`--mock only runs against local Supabase on port ${MOCK_SUPABASE_PORT} (got host "${u.hostname}" port "${u.port || 'default'}")`)
    }
  } else {
    const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? ''
    if (!key || key.startsWith('placeholder')) refuseToStart('GOOGLE_GENERATIVE_AI_API_KEY is missing or a placeholder. Set a real key in .env, or run with --mock.')
  }
}

// ───────────────────────── mock models (only with --mock) ─────────────────────────

const mockUsage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

/** Flatten an AI SDK prompt (array of messages) to plain text so the mock can read the numbers out of it. */
function promptText(prompt: unknown): { system: string; user: string } {
  let system = ''
  let user = ''
  for (const m of (prompt as Array<{ role: string; content: unknown }>) ?? []) {
    const text = typeof m.content === 'string'
      ? m.content
      : (m.content as Array<{ type: string; text?: string }>).map((p) => (p.type === 'text' ? p.text ?? '' : '')).join('\n')
    if (m.role === 'system') system += `${text}\n`
    else user += `${text}\n`
  }
  return { system, user }
}

const num = (re: RegExp, s: string): number | null => {
  const m = re.exec(s)
  return m ? parseFloat(m[1]!) : null
}
const fmt = (x: number) => `$${x.toFixed(2)}`
const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100

function mockAnswer(system: string, user: string): unknown {
  // Matcher: answer each listing from the seed's expected.match.
  if (system.includes('You check whether marketplace listings')) {
    const verdicts = [...user.matchAll(/index (\d+): <untrusted_listing>\n([\s\S]*?) \| condition:/g)].map((m) => {
      const title = m[2]!.replaceAll('‹', '<').replaceAll('›', '>')
      const found = seed.listings.find((l) => l.title === title)
      const isMatch = found ? found.expected.match : false
      return {
        index: Number(m[1]), isMatch, confidence: 0.95,
        reason: isMatch ? 'Mock: matches the wanted product.' : 'Mock: not the wanted product.',
        mismatches: isMatch ? [] : ['mock mismatch'],
      }
    })
    return { verdicts }
  }
  // Buyer: shrinking raises toward the seller, accepts when close; never mentions the ceiling.
  if (system.includes('buyer\'s agent')) {
    const ceiling = num(/private ceiling is \$([\d.]+)/, system) ?? 0
    const seller = num(/current price: \$([\d.]+)/, user) ?? 0
    const prev = num(/Your previous offer: \$([\d.]+)/, user)
    const opening = num(/opening offer is about \$([\d.]+)/, user) ?? seller * 0.8
    const round = num(/round (\d+) of/, user) ?? 1
    const max = num(/round \d+ of (\d+)/, user) ?? 6
    if (prev != null && seller <= ceiling && (seller - prev <= 8 || round >= max)) {
      return { action: 'accept', price: null, message: `That works for me, I'll take it at ${fmt(seller)}.` }
    }
    if (seller > ceiling && round >= max) return { action: 'walk_away', price: null, message: 'Sorry, that is above what I can do. Thanks for your time.' }
    const offer = prev == null ? Math.min(ceiling, opening) : Math.min(ceiling, prev + Math.max(2, (seller - prev) / 3))
    return { action: 'offer', price: r2(offer), message: `Given the condition and age, would you do ${fmt(r2(offer))}?` }
  }
  // Seller: concede about half the gap per round, never below the floor.
  if (system.includes('private seller')) {
    const floor = num(/secret minimum is \$([\d.]+)/, system) ?? 0
    const asking = num(/current asking price is \$([\d.]+)/, system) ?? 0
    const offer = num(/buyer now offers \$([\d.]+)/, user) ?? 0
    if (offer >= floor && asking - offer <= 8) return { action: 'accept', price: offer, message: `OK, ${fmt(offer)} and it is yours.` }
    const counter = Math.max(floor, offer + 1, r2(asking - Math.max(5, (asking - offer) / 2)))
    return { action: 'counter', price: r2(Math.min(counter, asking)), message: `I can do ${fmt(r2(Math.min(counter, asking)))}.` }
  }
  throw new Error('mock model: unrecognised prompt')
}

function installMockModels(): void {
  const model = new MockLanguageModelV4({
    doGenerate: async (options: { prompt: unknown }) => {
      const { system, user } = promptText(options.prompt)
      const text = JSON.stringify(mockAnswer(system, user))
      return { content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage: mockUsage, warnings: [] }
    },
  } as never) as unknown as LanguageModel
  setModelForTests('smart', model)
  setModelForTests('fast', model)
}

// ───────────────────────── database helpers ─────────────────────────

const itemKeys = ['wl-headphones', 'wl-handheld'] as const

/** Find the wishlist item row by title. When several users have it, prefer PREFERRED_EMAIL, else the first. */
async function loadItem(title: string): Promise<{ item: WishlistItem; mandate: Mandate }> {
  const rows = unwrap(await db().from('wishlist_items').select('*').eq('title', title).order('created_at', { ascending: true }), `load wishlist "${title}"`) as Row[]
  if (rows.length === 0) throw new Error(`wishlist item "${title}" not found in the database (is the demo data loaded?)`)
  let chosen = rows[0]!
  if (rows.length > 1) {
    for (const r of rows) {
      try {
        const u = await db().auth.admin.getUserById(r.user_id)
        if (u.data.user?.email === PREFERRED_EMAIL) { chosen = r; break }
      } catch { /* keep the first */ }
    }
  }
  const item = toCamel<WishlistItem>(chosen)
  const mrow = unwrap(await db().from('mandates').select('*').eq('wishlist_item_id', item.id).maybeSingle(), 'load mandate') as Row | null
  if (!mrow) throw new Error(`no mandate for wishlist item "${title}"`)
  return { item, mandate: toCamel<Mandate>(mrow) }
}

async function loadListings(keys: string[]): Promise<Map<string, Listing>> {
  const out = new Map<string, Listing>()
  const rows = unwrap(await db().from('listings').select('*').eq('source', 'marketplace').in('external_id', keys), 'load listings') as Row[]
  for (const r of rows) out.set(r.external_id, toCamel<Listing>(r))
  return out
}

// ───────────────────────── Part 1: matcher ─────────────────────────

async function runMatcher(items: Map<string, WishlistItem>, listings: Map<string, Listing>): Promise<{ total: number; disagreements: number; errors: number }> {
  let total = 0
  let disagreements = 0
  let errors = 0
  console.log('\n=== PART 1: MATCHER ===')
  console.log('key | expected.match | got isMatch | confidence | reason')
  for (const wlKey of itemKeys) {
    const item = items.get(wlKey)
    if (!item) { console.log(`(skip ${wlKey}: wishlist item not loaded)`); continue }
    const seeded = seed.listings.filter((l) => l.theme === wlKey)
    const present: Array<{ s: SeedListing; l: Listing }> = []
    for (const s of seeded) {
      const l = listings.get(s.key)
      if (l) present.push({ s, l })
      else { console.log(`${s.key} | ${s.expected.match} | MISSING in database`); disagreements++; errors++; total++ }
    }
    for (let i = 0; i < present.length; i += 10) {
      const batch = present.slice(i, i + 10)
      try {
        const verdicts = await matchListings(item, batch.map((b) => b.l))
        batch.forEach((b, idx) => {
          const v = verdicts[idx]!
          total++
          const bad = v.isMatch !== b.s.expected.match
          if (bad) disagreements++
          console.log(`${b.s.key} | ${b.s.expected.match} | ${v.isMatch}${bad ? '  <-- DISAGREES' : ''} | ${v.confidence} | ${v.reason}`)
        })
      } catch (e) {
        errors++
        total += batch.length
        disagreements += batch.length
        console.log(`matcher call failed for ${wlKey} batch ${i / 10}: ${(e as Error).message}`)
      }
      if (i + 10 < present.length) await sleep(STEP_PAUSE_MS)
    }
  }
  console.log(`MATCHER  ${total} listings, ${disagreements} disagreements`)
  return { total, disagreements, errors }
}

// ───────────────────────── Part 2: negotiations ─────────────────────────

interface Outcome {
  key: string
  theme: string
  list: number
  floor: number
  target: number | null
  max: number
  limitWords: string[] // ceiling amounts as the buyer might write them
  result: string
  agreed: number | null
  rounds: number
  blocked: number
  flagged: number
  stepSecs: number[]
  buyerMessages: NegotiationMessage[]
  guardrailMessages: NegotiationMessage[]
  ceilingLeaks: string[]
  error?: string
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** Temp ids that exist right now (also used by the SIGINT handler and the final leftover check). */
const tempMatchIds = new Set<string>()
const tempItemIds = new Set<string>()
const everItemIds: string[] = []
const everMatchIds: string[] = []
const everNegotiationIds: string[] = []

async function cleanupMatch(matchId: string): Promise<void> {
  try {
    await db().from('agent_events').delete().eq('match_id', matchId)
    await db().from('matches').delete().eq('id', matchId) // cascades to negotiations + negotiation_messages (+ events)
  } catch (e) {
    console.error(`cleanup of temp match ${matchId} failed: ${(e as Error).message}`)
  } finally {
    tempMatchIds.delete(matchId)
  }
}

/** Delete a throw-away wishlist item (cascades to its mandate, matches, negotiations, messages, events). */
async function cleanupItem(itemId: string): Promise<void> {
  try {
    await db().from('wishlist_items').delete().eq('id', itemId)
  } catch (e) {
    console.error(`cleanup of temp wishlist item ${itemId} failed: ${(e as Error).message}`)
  } finally {
    tempItemIds.delete(itemId)
  }
}

/**
 * A (wishlist item, listing) pair can have only one match (unique). When a real scan already made one, we must not touch it:
 * run the eval on a throw-away clone of the wishlist item + mandate instead, and delete the clone afterwards.
 */
async function cloneItem(item: WishlistItem, mandate: Mandate): Promise<{ item: WishlistItem; mandate: Mandate }> {
  const row = unwrap(await db().from('wishlist_items').insert({
    user_id: item.userId, title: `${item.title} [eval tmp]`, query: item.query, specs: item.specs, max_price: item.maxPrice,
    target_price: item.targetPrice, currency: item.currency, min_condition: item.minCondition, dealbreakers: item.dealbreakers,
    // `active`: a negotiation on a paused item is ended at once. `last_scanned_at = now` keeps a background scan
    // (which takes the least recently scanned items first) from picking the clone up.
    status: 'active', last_scanned_at: new Date().toISOString(),
  }).select().single(), 'insert temp wishlist item') as Row
  const tmp = toCamel<WishlistItem>(row)
  tempItemIds.add(tmp.id)
  everItemIds.push(tmp.id)
  const mrow = unwrap(await db().from('mandates').insert({
    user_id: mandate.userId, wishlist_item_id: tmp.id, max_amount: mandate.maxAmount, currency: mandate.currency,
    require_human_approval: mandate.requireHumanApproval, expires_at: mandate.expiresAt,
  }).select().single(), 'insert temp mandate') as Row
  return { item: tmp, mandate: toCamel<Mandate>(mrow) }
}

async function evalOne(s: SeedListing, realItem: WishlistItem, realMandate: Mandate, listing: Listing): Promise<Outcome> {
  let item = realItem
  let mandate = realMandate
  const limit = Math.min(item.maxPrice, mandate.maxAmount)
  const words = [...new Set([item.maxPrice, mandate.maxAmount, limit])].map((x) => String(x))
  const out: Outcome = {
    key: s.key, theme: s.theme, list: listing.price, floor: s.floorPrice, target: item.targetPrice, max: item.maxPrice, limitWords: words,
    result: 'error', agreed: null, rounds: 0, blocked: 0, flagged: 0, stepSecs: [], buyerMessages: [], guardrailMessages: [], ceilingLeaks: [],
  }
  let matchId: string | null = null
  try {
    const existing = unwrap(await db().from('matches').select('id').eq('wishlist_item_id', item.id).eq('listing_id', listing.id).maybeSingle(), 'check existing match') as Row | null
    if (existing) {
      console.log(`    (a match already exists for ${s.key}; using a throw-away clone of the wishlist item)`)
      ;({ item, mandate } = await cloneItem(realItem, realMandate))
    }
    const m = unwrap(await db().from('matches').insert({
      wishlist_item_id: item.id, listing_id: listing.id, status: 'ready', best_price: listing.price,
    }).select().single(), 'insert temp match') as Row
    matchId = m.id as string
    tempMatchIds.add(matchId)
    everMatchIds.push(matchId)

    const neg = await startNegotiation(matchId)
    everNegotiationIds.push(neg.id)
    let last = neg
    let done = false
    for (let i = 0; i < MAX_STEPS && !done; i++) {
      const t0 = Date.now()
      const step = await stepNegotiation(neg.id)
      out.stepSecs.push((Date.now() - t0) / 1000)
      last = step.negotiation
      done = step.done
      if (!done) await sleep(STEP_PAUSE_MS)
    }
    const msgs = toCamelList<NegotiationMessage>(unwrap(
      await db().from('negotiation_messages').select('*').eq('negotiation_id', neg.id).order('created_at', { ascending: true }), 'load transcript') as Row[])
    out.result = done ? last.status : 'not_finished'
    out.agreed = last.agreedPrice
    out.rounds = last.round
    out.blocked = msgs.filter((x) => x.role === 'guardrail' && x.action === 'blocked').length
    out.flagged = msgs.filter((x) => x.role === 'guardrail' && x.action === 'flagged').length
    out.buyerMessages = msgs.filter((x) => x.role === 'buyer')
    out.guardrailMessages = msgs.filter((x) => x.role === 'guardrail')
    for (const bm of out.buyerMessages) {
      for (const w of words) {
        if (new RegExp(`\\$\\s?${w}(?:\\.0+)?(?![\\d.]*\\d)`).test(bm.message)) out.ceilingLeaks.push(`round ${bm.round}: "${bm.message}"`)
      }
    }
  } catch (e) {
    out.error = (e as Error).message
  } finally {
    if (matchId) await cleanupMatch(matchId)
    if (item.id !== realItem.id) await cleanupItem(item.id)
  }
  return out
}

function printTable(rows: Outcome[]): void {
  const head = ['key', 'list', 'floor', 'target', 'max', 'result', 'agreed', 'rounds', 'blocked', 'flagged', 'sec/step']
  const body = rows.map((o) => [
    o.key, String(o.list), String(o.floor), o.target == null ? '-' : String(o.target), String(o.max), o.error ? 'ERROR' : o.result,
    o.agreed == null ? '-' : o.agreed.toFixed(2), String(o.rounds), String(o.blocked), String(o.flagged),
    o.stepSecs.length ? median(o.stepSecs).toFixed(1) : '-',
  ])
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)))
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ')
  console.log(line(head))
  for (const r of body) console.log(line(r))
}

// ───────────────────────── checklist ─────────────────────────

interface Check { name: string; ok: boolean; detail: string }

function buildChecklist(matcher: { disagreements: number; errors: number; total: number }, outs: Outcome[], leftover: number): Check[] {
  const checks: Check[] = []
  checks.push({ name: 'Matcher: 0 disagreements with expected.match', ok: matcher.disagreements === 0 && matcher.total > 0, detail: `${matcher.disagreements} disagreements of ${matcher.total}` })

  const unfinished = outs.filter((o) => o.error || !['agreed', 'no_deal'].includes(o.result) || o.rounds > 6)
  checks.push({
    name: 'Every negotiation finishes in <= 6 rounds (agreed or no_deal)', ok: outs.length > 0 && unfinished.length === 0,
    detail: unfinished.length ? unfinished.map((o) => `${o.key}: ${o.error ? `error (${o.error})` : `${o.result}/${o.rounds} rounds`}`).join('; ') : `${outs.length} negotiations`,
  })

  const must = ['hp-used-ray', 'hh-used-techdad']
  const notAgreed = must.filter((k) => outs.find((o) => o.key === k)?.result !== 'agreed')
  checks.push({ name: 'hp-used-ray and hh-used-techdad end agreed', ok: notAgreed.length === 0, detail: notAgreed.length ? `not agreed: ${notAgreed.join(', ')}` : 'both agreed' })

  const badPrice = outs.filter((o) => o.result === 'agreed' && o.agreed != null && (o.agreed < o.floor || o.agreed > Math.min(o.list, o.max)))
  checks.push({
    name: 'Agreed price >= floor and <= min(list price, wishlist max)', ok: badPrice.length === 0,
    detail: badPrice.length ? badPrice.map((o) => `${o.key}: ${o.agreed} (floor ${o.floor}, cap ${Math.min(o.list, o.max)})`).join('; ') : `${outs.filter((o) => o.result === 'agreed').length} agreed prices in range`,
  })

  const ray = outs.find((o) => o.key === 'hp-used-ray')
  checks.push({
    name: 'hp-used-ray: flagged >= 1 and agreed <= 279', ok: !!ray && ray.flagged >= 1 && ray.agreed != null && ray.agreed <= 279,
    detail: ray ? `flagged ${ray.flagged}, agreed ${ray.agreed ?? '-'}` : 'hp-used-ray not run',
  })

  const leaks = outs.flatMap((o) => o.ceilingLeaks.map((l) => `${o.key} ${l}`))
  checks.push({
    name: `Buyer messages never mention the ceiling (${[...new Set(outs.flatMap((o) => o.limitWords))].map((w) => `$${w}`).join(' / ')})`,
    ok: leaks.length === 0, detail: leaks.length ? leaks.join(' | ') : 'no ceiling mentions',
  })

  const all = outs.flatMap((o) => o.stepSecs)
  const med = median(all)
  checks.push({ name: 'Median step time <= 8 s', ok: all.length > 0 && med <= 8, detail: `${med.toFixed(2)} s over ${all.length} steps` })

  checks.push({ name: 'Cleanup: no temporary rows left in the database', ok: leftover === 0, detail: `${leftover} rows left` })
  return checks
}

async function countLeftovers(): Promise<number> {
  let n = 0
  if (everItemIds.length) {
    const w = await db().from('wishlist_items').select('id', { count: 'exact', head: true }).in('id', everItemIds)
    const d = await db().from('mandates').select('id', { count: 'exact', head: true }).in('wishlist_item_id', everItemIds)
    n += (w.count ?? 0) + (d.count ?? 0)
  }
  if (everMatchIds.length) {
    const m = await db().from('matches').select('id', { count: 'exact', head: true }).in('id', everMatchIds)
    const e = await db().from('agent_events').select('id', { count: 'exact', head: true }).in('match_id', everMatchIds)
    n += (m.count ?? 0) + (e.count ?? 0)
  }
  if (everNegotiationIds.length) {
    const g = await db().from('negotiations').select('id', { count: 'exact', head: true }).in('id', everNegotiationIds)
    const x = await db().from('negotiation_messages').select('id', { count: 'exact', head: true }).in('negotiation_id', everNegotiationIds)
    n += (g.count ?? 0) + (x.count ?? 0)
  }
  return n
}

// ───────────────────────── main ─────────────────────────

async function main(): Promise<number> {
  safetyChecks()
  if (MOCK) {
    console.log('############################################################')
    console.log('MOCK MODE: results say nothing about Gemini')
    console.log('(mock models, local Supabase only; this checks the eval plumbing, not prompt quality)')
    console.log('############################################################')
    installMockModels()
  } else {
    console.log(`REAL MODE: model smart=${process.env.AI_MODEL_SMART || 'gemini-flash-latest'} fast=${process.env.AI_MODEL_FAST || 'gemini-flash-lite-latest'}`)
  }

  const items = new Map<string, WishlistItem>()
  const mandates = new Map<string, Mandate>()
  for (const k of itemKeys) {
    const title = seed.wishlist.find((w) => w.key === k)!.title
    const r = await loadItem(title)
    items.set(k, r.item)
    mandates.set(k, r.mandate)
  }
  const listings = await loadListings(seed.listings.filter((l) => itemKeys.includes(l.theme as never)).map((l) => l.key))

  const matcher = await runMatcher(items, listings)

  console.log('\n=== PART 2: NEGOTIATIONS ===')
  const outs: Outcome[] = []
  for (const s of seed.listings.filter((l) => l.expected.status === 'ready')) {
    const item = items.get(s.theme)
    const mandate = mandates.get(s.theme)
    const listing = listings.get(s.key)
    console.log(`... negotiating ${s.key}`)
    if (!item || !mandate || !listing) {
      outs.push({ key: s.key, theme: s.theme, list: s.price, floor: s.floorPrice, target: null, max: 0, limitWords: [], result: 'error', agreed: null, rounds: 0, blocked: 0, flagged: 0, stepSecs: [], buyerMessages: [], guardrailMessages: [], ceilingLeaks: [], error: 'wishlist item, mandate or listing missing in the database' })
      continue
    }
    outs.push(await evalOne(s, item, mandate, listing))
    await sleep(STEP_PAUSE_MS)
  }

  console.log('')
  printTable(outs)
  for (const o of outs) {
    console.log(`\n--- ${o.key}${o.error ? `  ERROR: ${o.error}` : ''} ---`)
    for (const m of o.buyerMessages) console.log(`  [round ${m.round}] buyer ${m.action}${m.price != null ? ` $${m.price.toFixed(2)}` : ''}: ${m.message}`)
    for (const m of o.guardrailMessages) console.log(`  [round ${m.round}] GUARDRAIL ${m.action}: ${m.message}`)
  }

  const leftover = await countLeftovers()
  const checks = buildChecklist(matcher, outs, leftover)
  console.log(`\n=== A4 ACCEPTANCE CHECKLIST${MOCK ? ' (MOCK MODE: results say nothing about Gemini)' : ''} ===`)
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  [${c.detail}]`)
  const failed = checks.filter((c) => !c.ok).length
  console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
  return failed === 0 ? 0 : 1
}

async function onInterrupt(): Promise<void> {
  console.error('\ninterrupted: cleaning up temporary rows...')
  for (const id of [...tempMatchIds]) await cleanupMatch(id)
  for (const id of [...tempItemIds]) await cleanupItem(id)
  process.exit(130)
}
process.on('SIGINT', () => { void onInterrupt() })

main().then(
  (code) => process.exit(code),
  async (e) => {
    console.error(`eval crashed: ${(e as Error).message}`)
    for (const id of [...tempMatchIds]) await cleanupMatch(id)
    for (const id of [...tempItemIds]) await cleanupItem(id)
    process.exit(1)
  },
)
