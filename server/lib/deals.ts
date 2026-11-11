import { z } from 'zod'
import type {
  AgentEvent,
  CreateWishlistRequest,
  DealRow,
  Listing,
  Mandate,
  Match,
  MatchDetail,
  MatchStatus,
  Negotiation,
  NegotiationMessage,
  Order,
  Seller,
  WishlistItem,
} from '#shared/types'
import { db, unwrap } from './db'
import { toCamel, toCamelList } from './mappers'
import { toDealRow } from './read-models'

/**
 * Query logic behind the UI routes (wishlist, deals, activity feed). Framework-free and unit-tested.
 * Every query filters by the signed-in user (directly or through the owning wishlist item) because db() bypasses RLS.
 * Never reads listing_secrets or seller_personas.
 */

/** Public seller columns only (no slug / paypal_email). */
const SELLER_COLUMNS = 'id, display_name, account_age_days, rating, rating_count, is_agent'

/** Only these states can be dismissed by the user. */
const SKIPPABLE: MatchStatus[] = ['ready', 'agreed', 'notified', 'no_deal']

function toSeller(row: Record<string, unknown>): Seller {
  const s = toCamel<Seller>(row)
  return { id: s.id, displayName: s.displayName, accountAgeDays: s.accountAgeDays, rating: s.rating ?? null, ratingCount: s.ratingCount, isAgent: s.isAgent }
}

// ───────────────────────── deals ─────────────────────────

export async function listDeals(userId: string, wishlistItemId?: string): Promise<DealRow[]> {
  let q = db().from('wishlist_items').select('*').eq('user_id', userId)
  if (wishlistItemId) q = q.eq('id', wishlistItemId)
  const items = toCamelList<WishlistItem>(unwrap(await q, 'load wishlist'))
  if (items.length === 0) return []

  const matches = toCamelList<Match>(unwrap(
    await db().from('matches').select('*').in('wishlist_item_id', items.map((i) => i.id)).neq('status', 'mismatch').order('updated_at', { ascending: false }),
    'load matches',
  ))
  if (matches.length === 0) return []

  const listings = toCamelList<Listing>(unwrap(
    await db().from('listings').select('*').in('id', [...new Set(matches.map((m) => m.listingId))]),
    'load listings',
  ))
  const sellerIds = [...new Set(listings.map((l) => l.sellerId).filter((x): x is string => !!x))]
  const sellers = sellerIds.length
    ? (unwrap(await db().from('sellers').select(SELLER_COLUMNS).in('id', sellerIds), 'load sellers') as Record<string, unknown>[]).map(toSeller)
    : []

  const itemById = new Map(items.map((i) => [i.id, i]))
  const listingById = new Map(listings.map((l) => [l.id, l]))
  const sellerById = new Map(sellers.map((s) => [s.id, s]))

  const rows: DealRow[] = []
  for (const match of matches) {
    const item = itemById.get(match.wishlistItemId)
    const listing = listingById.get(match.listingId)
    if (!item || !listing) continue
    rows.push(toDealRow({ match, listing, seller: (listing.sellerId && sellerById.get(listing.sellerId)) || null, item }))
  }
  return rows
}

/** null = not found, or not yours (do not leak existence). */
export async function getMatchDetail(userId: string, matchId: string): Promise<MatchDetail | null> {
  const matchRow = unwrap(await db().from('matches').select('*').eq('id', matchId).maybeSingle(), 'load match') as Record<string, unknown> | null
  if (!matchRow) return null
  const match = toCamel<Match>(matchRow)

  const itemRow = unwrap(await db().from('wishlist_items').select('*').eq('id', match.wishlistItemId).maybeSingle(), 'load wishlist item') as Record<string, unknown> | null
  if (!itemRow) return null
  const wishlistItem = toCamel<WishlistItem>(itemRow)
  if (wishlistItem.userId !== userId) return null

  const listingRow = unwrap(await db().from('listings').select('*').eq('id', match.listingId).maybeSingle(), 'load listing') as Record<string, unknown> | null
  if (!listingRow) return null
  const listing = toCamel<Listing>(listingRow)

  let seller: Seller | null = null
  if (listing.sellerId) {
    const sellerRow = unwrap(await db().from('sellers').select(SELLER_COLUMNS).eq('id', listing.sellerId).maybeSingle(), 'load seller') as Record<string, unknown> | null
    seller = sellerRow ? toSeller(sellerRow) : null
  }

  const mandateRow = unwrap(await db().from('mandates').select('*').eq('wishlist_item_id', wishlistItem.id).maybeSingle(), 'load mandate') as Record<string, unknown> | null
  const mandate = mandateRow ? toCamel<Mandate>(mandateRow) : null

  const negotiationRow = unwrap(await db().from('negotiations').select('*').eq('match_id', matchId).maybeSingle(), 'load negotiation') as Record<string, unknown> | null
  let negotiation: Negotiation | null = null
  let messages: NegotiationMessage[] = []
  if (negotiationRow) {
    const n = toCamel<Negotiation>(negotiationRow)
    // Only the fields of the public type: drops locked_until (internal step lock).
    negotiation = { id: n.id, matchId: n.matchId, status: n.status, round: n.round, maxRounds: n.maxRounds, agreedPrice: n.agreedPrice ?? null, createdAt: n.createdAt, updatedAt: n.updatedAt }
    messages = toCamelList<NegotiationMessage>(unwrap(
      await db().from('negotiation_messages').select('*').eq('negotiation_id', n.id).order('created_at', { ascending: true }),
      'load messages',
    ))
  }

  const orderRows = unwrap(
    await db().from('orders').select('*').eq('match_id', matchId).order('created_at', { ascending: false }).limit(1),
    'load order',
  ) as Record<string, unknown>[]
  const order = orderRows.length > 0 ? toCamel<Order>(orderRows[0]!) : null

  return { match, listing, seller, wishlistItem, mandate, negotiation, messages, order }
}

/** false = not found / not yours / not skippable. */
export async function skipMatch(userId: string, matchId: string): Promise<boolean> {
  const matchRow = unwrap(await db().from('matches').select('*').eq('id', matchId).maybeSingle(), 'load match') as Record<string, unknown> | null
  if (!matchRow) return false
  const match = toCamel<Match>(matchRow)
  const itemRow = unwrap(await db().from('wishlist_items').select('*').eq('id', match.wishlistItemId).maybeSingle(), 'load wishlist item') as Record<string, unknown> | null
  if (!itemRow || toCamel<WishlistItem>(itemRow).userId !== userId) return false
  if (!SKIPPABLE.includes(match.status)) return false
  unwrap(await db().from('matches').update({ status: 'skipped' }).eq('id', matchId), 'skip match')
  return true
}

// ───────────────────────── wishlist ─────────────────────────

export const wishlistSchema = z.object({
  title: z.string().trim().min(1).max(200),
  query: z.string().trim().min(1).max(200),
  specs: z.string().max(1000).default(''),
  maxPrice: z.number().positive().max(100000),
  targetPrice: z.number().positive().nullable().optional(),
  minCondition: z.enum(['new', 'like_new', 'good', 'fair']),
  dealbreakers: z.array(z.string().max(100)).max(20).default([]),
  mandateExpiresInDays: z.number().int().min(1).max(90).default(14),
}).refine((v) => v.targetPrice == null || v.targetPrice <= v.maxPrice, {
  message: 'Target price must not exceed the maximum price',
  path: ['targetPrice'],
})

export async function listWishlist(userId: string): Promise<{ item: WishlistItem; mandate: Mandate | null }[]> {
  const items = toCamelList<WishlistItem>(unwrap(
    await db().from('wishlist_items').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
    'load wishlist',
  ))
  if (items.length === 0) return []
  const mandates = toCamelList<Mandate>(unwrap(
    await db().from('mandates').select('*').in('wishlist_item_id', items.map((i) => i.id)),
    'load mandates',
  ))
  const mandateByItem = new Map(mandates.map((m) => [m.wishlistItemId, m]))
  return items.map((item) => ({ item, mandate: mandateByItem.get(item.id) ?? null }))
}

export async function createWishlistItem(userId: string, input: CreateWishlistRequest): Promise<{ item: WishlistItem; mandate: Mandate }> {
  const itemRow = unwrap(await db().from('wishlist_items').insert({
    user_id: userId,
    title: input.title,
    query: input.query,
    specs: input.specs,
    max_price: input.maxPrice,
    target_price: input.targetPrice ?? null,
    currency: 'USD',
    min_condition: input.minCondition,
    dealbreakers: input.dealbreakers ?? [],
    status: 'active',
  }).select('*').single(), 'insert wishlist item') as Record<string, unknown>
  const item = toCamel<WishlistItem>(itemRow)

  const days = input.mandateExpiresInDays ?? 14
  try {
    const mandateRow = unwrap(await db().from('mandates').insert({
      user_id: userId,
      wishlist_item_id: item.id,
      max_amount: input.maxPrice, // the mandate ceiling equals the wishlist ceiling
      currency: 'USD',
      require_human_approval: true,
      expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
    }).select('*').single(), 'insert mandate') as Record<string, unknown>
    return { item, mandate: toCamel<Mandate>(mandateRow) }
  } catch (err) {
    // Do not leave an item without a mandate behind: the negotiation engine requires one.
    await db().from('wishlist_items').delete().eq('id', item.id).eq('user_id', userId)
    throw err
  }
}

/** false = not found / not yours. The database cascades to mandates, matches, negotiations and orders. */
export async function deleteWishlistItem(userId: string, id: string): Promise<boolean> {
  const row = unwrap(await db().from('wishlist_items').select('id').eq('id', id).eq('user_id', userId).maybeSingle(), 'find wishlist item') as Record<string, unknown> | null
  if (!row) return false
  unwrap(await db().from('wishlist_items').delete().eq('id', id).eq('user_id', userId), 'delete wishlist item')
  return true
}

// ───────────────────────── activity feed ─────────────────────────

export async function listEvents(userId: string, limit = 50): Promise<AgentEvent[]> {
  const capped = Math.min(Math.max(Math.floor(limit) || 50, 1), 200)
  return toCamelList<AgentEvent>(unwrap(
    await db().from('agent_events').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(capped),
    'load events',
  ))
}
