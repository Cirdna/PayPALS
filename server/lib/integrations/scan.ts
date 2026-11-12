import type { Listing, ListingDraft, MatchVerdict, RiskAssessment, ScanResponse, Seller, WishlistItem } from '#shared/types'
import { formatMoney, meetsCondition, roundMoney } from '#shared/utils/money'
import { ai, MatcherUnavailableError } from '~~/server/lib/ai'
import { db, unwrap } from '../db'
import { logEvent } from '../events'
import { toCamel, toSnake } from '../mappers'
import { integrations } from './index'

type Row = Record<string, any>

const MATCH_BATCH_SIZE = 10
const MAX_MARKETPLACE_CANDIDATES = 12
const MIN_MATCH_CONFIDENCE = 0.6
const NEGOTIABLE_BUDGET_FACTOR = 1.3
const MAX_NEGOTIATION_STEPS_PER_CRON = 3
const MAX_ITEMS_PER_CRON = 2

/** Log helper: message only, never the whole error object (SDK errors can carry request headers/config). */
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : 'unknown error')

export class ScanError extends Error {
  constructor(public readonly code: 'not_found', message: string) {
    super(message)
    this.name = 'ScanError'
  }
}

// ───────────────────────── keywords (pure) ─────────────────────────

const STOPWORDS = new Set(['with', 'from', 'wireless', 'this', 'that', 'only'])

/** Lowercased words of the query that are ≥ 4 letters, minus stopwords. */
export function queryKeywords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w)))]
}

/** true when the title contains at least one keyword of the query as a whole word. */
export function keywordMatch(query: string, title: string): boolean {
  const words = new Set(title.toLowerCase().split(/[^a-z0-9]+/))
  return queryKeywords(query).some((k) => words.has(k))
}

// ───────────────────────── scan ─────────────────────────

/**
 * ARCHITECTURE §4. Cron (isCron): advance up to 3 active negotiations by one step, then scan the 2 least recently
 * scanned active items. User: scan exactly `wishlistItemId` (must belong to `userId`). Stops when `budgetMs` (45 s) is used up.
 * LLM calls (via `ai`) are strictly sequential.
 */
export async function runScan(opts: { wishlistItemId?: string; userId?: string; isCron: boolean; budgetMs?: number }): Promise<ScanResponse> {
  const deadline = Date.now() + (opts.budgetMs ?? 45_000)
  const out: ScanResponse = { itemsScanned: 0, listingsFetched: 0, matchesCreated: 0, flagged: 0, negotiationsStarted: 0, negotiationsAdvanced: 0, notificationsSent: 0 }
  const overBudget = () => Date.now() >= deadline

  let items: Row[]
  if (opts.isCron) {
    const active = unwrap(
      await db().from('negotiations').select('*').eq('status', 'active').order('updated_at', { ascending: true }).limit(MAX_NEGOTIATION_STEPS_PER_CRON),
      'load active negotiations',
    ) as Row[]
    for (const n of active) {
      if (overBudget()) break
      try {
        const r = await ai.stepNegotiation(n.id)
        if (!r.busy) out.negotiationsAdvanced++
        if (r.negotiation.status === 'agreed' && (await integrations.notifyDeal(r.negotiation.matchId))) out.notificationsSent++
      } catch (e) {
        console.warn('[scan] negotiation step failed:', errMsg(e))
      }
    }
    items = unwrap(
      await db().from('wishlist_items').select('*').eq('status', 'active').order('last_scanned_at', { ascending: true, nullsFirst: true }).limit(MAX_ITEMS_PER_CRON),
      'load items',
    ) as Row[]
  } else {
    if (!opts.wishlistItemId || !opts.userId) throw new ScanError('not_found', 'Wishlist item not found')
    const row = unwrap(
      await db().from('wishlist_items').select('*').eq('id', opts.wishlistItemId).eq('user_id', opts.userId).maybeSingle(),
      'load item',
    ) as Row | null
    if (!row) throw new ScanError('not_found', 'Wishlist item not found')
    items = [row]
  }

  for (const row of items) {
    if (overBudget()) break
    try {
      await scanItem(row, out, overBudget)
    } catch (e) {
      console.warn(`[scan] item ${row.id} failed:`, errMsg(e))
    }
    out.itemsScanned++
  }
  return out
}

interface Matched { listing: Listing; verdict: MatchVerdict }

async function scanItem(row: Row, out: ScanResponse, overBudget: () => boolean): Promise<void> {
  const item = toCamel<WishlistItem>(row)
  const before = { ...out }
  const now = new Date().toISOString()

  // 1. mark scanned
  unwrap(await db().from('wishlist_items').update({ last_scanned_at: now }).eq('id', item.id), 'update last_scanned_at')
  await logEvent({ userId: item.userId, type: 'scan_started', message: `🔍 Scanning for "${item.title}"` })

  // 2. Channel3 (errors are swallowed inside searchProducts; guard anyway)
  let channel3Rows: Row[] = []
  let drafts: ListingDraft[] = []
  try {
    drafts = await integrations.searchProducts(item.query, { limit: 10 })
  } catch (e) {
    console.warn('[scan] channel3 search failed, continuing with marketplace only:', errMsg(e))
  }
  if (drafts.length > 0) {
    channel3Rows = unwrap(
      await db().from('listings').upsert(drafts.map((d) => ({ ...toSnake(d), fetched_at: now })), { onConflict: 'source,external_id' }).select(),
      'upsert channel3 listings',
    ) as Row[]
    out.listingsFetched += drafts.length
  }

  // 3. marketplace candidates
  const marketplace = unwrap(await db().from('listings').select('*').eq('source', 'marketplace'), 'load marketplace listings') as Row[]
  const marketRows = marketplace
    .filter((r) => keywordMatch(item.query, r.title))
    .sort((a, b) => Number(a.price) - Number(b.price))
    .slice(0, MAX_MARKETPLACE_CANDIDATES)

  // 4. drop pairs that already have a match row (the LLM cache)
  const existing = unwrap(await db().from('matches').select('*').eq('wishlist_item_id', item.id), 'load matches') as Row[]
  const known = new Set(existing.map((m) => m.listing_id))
  const candidates = [...channel3Rows, ...marketRows].filter((r) => !known.has(r.id))

  if (candidates.length > 0) await processCandidates(item, candidates, existing, out, overBudget)

  // 8. auto-negotiate one low-risk ready match, unless one is already running
  await autoNegotiate(item, out)

  // 9. notify the best agreed deal if it beats everything already notified
  await notifyBest(item, out)

  const delta = Object.fromEntries((Object.keys(out) as (keyof ScanResponse)[]).map((k) => [k, out[k] - before[k]]))
  await logEvent({
    userId: item.userId,
    type: 'scan_finished',
    message: `✅ Scan finished for "${item.title}": ${delta.matchesCreated} new, ${delta.flagged} flagged`,
    payload: delta,
  })
}

async function processCandidates(item: WishlistItem, candidates: Row[], existing: Row[], out: ScanResponse, overBudget: () => boolean): Promise<void> {
  // 5. match in batches (sequential LLM calls)
  const matched: Matched[] = []
  for (let i = 0; i < candidates.length; i += MATCH_BATCH_SIZE) {
    if (overBudget()) break
    const batch = candidates.slice(i, i + MATCH_BATCH_SIZE).map((r) => toCamel<Listing>(r))
    let verdicts: MatchVerdict[]
    try {
      verdicts = await ai.matchListings(item, batch)
    } catch (e) {
      if (e instanceof MatcherUnavailableError) break // retried on the next scan: no rows for this batch
      throw e
    }
    for (const [idx, listing] of batch.entries()) {
      const verdict = verdicts[idx] ?? { isMatch: false, confidence: 0, reason: 'no verdict', mismatches: [] }
      if (verdict.isMatch && verdict.confidence >= MIN_MATCH_CONFIDENCE) matched.push({ listing, verdict })
      else if (await insertMatch({ wishlist_item_id: item.id, listing_id: listing.id, status: 'mismatch', verdict })) out.matchesCreated++
    }
  }

  // 6. price comps: fixed-price listings that matched this item before + in this batch
  const previousIds = existing.filter((m) => m.status !== 'mismatch').map((m) => m.listing_id)
  const previousListings = previousIds.length
    ? (unwrap(await db().from('listings').select('*').in('id', previousIds), 'load comp listings') as Row[])
    : []
  const compPrices = [
    ...previousListings.filter((l) => l.negotiable === false).map((l) => Number(l.price)),
    ...matched.filter((m) => !m.listing.negotiable).map((m) => m.listing.price),
  ]

  // 7. fixed-price first, so comps exist before used listings are scored
  const ordered = [...matched].sort((a, b) => Number(a.listing.negotiable) - Number(b.listing.negotiable))
  for (const { listing, verdict } of ordered) {
    if (overBudget()) break
    let created: boolean
    if (!listing.negotiable && listing.price > item.maxPrice) {
      created = await insertMatch({ wishlist_item_id: item.id, listing_id: listing.id, status: 'over_budget', verdict, best_price: listing.price })
    } else if (listing.negotiable && listing.price > roundMoney(item.maxPrice * NEGOTIABLE_BUDGET_FACTOR)) {
      created = await insertMatch({ wishlist_item_id: item.id, listing_id: listing.id, status: 'mismatch', verdict: { ...verdict, isMatch: false, reason: 'Above your budget range' } })
    } else if (listing.negotiable && !meetsCondition(listing.condition, item.minCondition)) {
      created = await insertMatch({ wishlist_item_id: item.id, listing_id: listing.id, status: 'mismatch', verdict: { ...verdict, isMatch: false, reason: 'Condition below your minimum' } })
    } else {
      const risk = await riskFor(item, listing, compPrices)
      const flagged = risk.level === 'high'
      const status = flagged ? 'flagged' : listing.negotiable ? 'ready' : 'agreed'
      created = await insertMatch({ wishlist_item_id: item.id, listing_id: listing.id, status, verdict, risk, best_price: listing.price })
      if (created && flagged) out.flagged++
      if (created) {
        const matchId = await matchIdFor(item.id, listing.id)
        await logEvent(
          flagged
            ? { userId: item.userId, matchId, type: 'risk_flagged', message: `🚩 Flagged "${listing.title}": ${risk.signals[0]?.detail ?? risk.explanation}` }
            : { userId: item.userId, matchId, type: 'listing_matched', message: `✅ Found "${listing.title}" at ${formatMoney(listing.price)}` },
        )
      }
    }
    if (created) out.matchesCreated++
  }
}

async function riskFor(item: WishlistItem, listing: Listing, compPrices: number[]): Promise<RiskAssessment> {
  let seller: Seller | null = null
  let sellerOpener: string | null = null
  if (listing.sellerId) {
    const sellerRow = unwrap(await db().from('sellers').select('*').eq('id', listing.sellerId).maybeSingle(), 'load seller') as Row | null
    seller = sellerRow ? toCamel<Seller>(sellerRow) : null
  }
  if (listing.source === 'marketplace') {
    const secret = unwrap(await db().from('listing_secrets').select('scripted_messages').eq('listing_id', listing.id).maybeSingle(), 'load listing secret') as Row | null
    sellerOpener = (secret?.scripted_messages as Record<string, string> | undefined)?.['0'] ?? null
  }
  return ai.assessRisk({ listing, seller, compPrices, maxPrice: item.maxPrice, sellerOpener })
}

/** Inserts one match row. Returns false on a unique violation (pair already scored), throws on any other error. */
async function insertMatch(row: Row): Promise<boolean> {
  const { error } = await db().from('matches').insert(row)
  if (!error) return true
  if (error.code === '23505') return false
  throw new Error(`Supabase insert match failed: ${error.message}`)
}

async function matchIdFor(wishlistItemId: string, listingId: string): Promise<string | null> {
  const rows = unwrap(await db().from('matches').select('id').eq('wishlist_item_id', wishlistItemId).eq('listing_id', listingId), 'load match id') as Row[]
  return rows[0]?.id ?? null
}

async function autoNegotiate(item: WishlistItem, out: ScanResponse): Promise<void> {
  const matches = unwrap(await db().from('matches').select('*').eq('wishlist_item_id', item.id), 'load matches') as Row[]
  if (matches.some((m) => m.status === 'negotiating')) return
  const next = matches
    .filter((m) => m.status === 'ready' && m.risk?.level === 'low')
    .sort((a, b) => Number(a.best_price) - Number(b.best_price))[0]
  if (!next) return
  try {
    await ai.startNegotiation(next.id)
    out.negotiationsStarted++
  } catch (e) {
    console.warn('[scan] startNegotiation failed:', errMsg(e))
  }
}

async function notifyBest(item: WishlistItem, out: ScanResponse): Promise<void> {
  const matches = unwrap(await db().from('matches').select('*').eq('wishlist_item_id', item.id), 'load matches') as Row[]
  const best = matches.filter((m) => m.status === 'agreed' && m.best_price != null).sort((a, b) => Number(a.best_price) - Number(b.best_price))[0]
  if (!best) return
  const notifiedPrices = matches.filter((m) => m.notified_at != null && m.best_price != null).map((m) => Number(m.best_price))
  const previousBest = notifiedPrices.length ? Math.min(...notifiedPrices) : null
  if (previousBest !== null && !(Number(best.best_price) < previousBest)) return
  try {
    if (await integrations.notifyDeal(best.id)) out.notificationsSent++
  } catch (e) {
    console.warn('[scan] notifyDeal failed:', errMsg(e))
  }
}
