import { db, unwrap } from '../db'

type Row = Record<string, any>

/** The user id that owns a match (through its wishlist item), or null when the match does not exist. */
export async function ownerOfMatch(matchId: string): Promise<string | null> {
  const match = unwrap(await db().from('matches').select('id, wishlist_item_id').eq('id', matchId).maybeSingle(), 'load match') as Row | null
  if (!match) return null
  const item = unwrap(await db().from('wishlist_items').select('id, user_id').eq('id', match.wishlist_item_id).maybeSingle(), 'load wishlist item') as Row | null
  return item?.user_id ?? null
}

/** The user id that owns a negotiation, or null when it does not exist. */
export async function ownerOfNegotiation(negotiationId: string): Promise<string | null> {
  const neg = unwrap(await db().from('negotiations').select('id, match_id').eq('id', negotiationId).maybeSingle(), 'load negotiation') as Row | null
  return neg ? ownerOfMatch(neg.match_id) : null
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Route ids must look like a UUID before they reach the database; anything else gets the same 404 as an unknown id. */
export const isUuid = (id: string): boolean => UUID_SHAPE.test(id)
