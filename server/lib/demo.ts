import { db, unwrap } from './db'
import { isGeneratedFor } from '~~/server/lib/ai'

/**
 * Puts a user's data back to "nothing scanned yet": removes their matches (the real database cascades to
 * negotiations, messages and orders) and their activity feed, and reactivates their wishlist items.
 * Used by `pnpm db:reset-demo` and POST /api/demo/reset.
 */
export async function resetUserData(userId: string): Promise<{ matchesDeleted: number }> {
  const items = unwrap(await db().from('wishlist_items').select('id').eq('user_id', userId), 'load wishlist items') as { id: string }[]
  const itemIds = items.map((i) => i.id)
  let matchesDeleted = 0
  if (itemIds.length > 0) {
    const matches = unwrap(await db().from('matches').select('id').in('wishlist_item_id', itemIds), 'load matches') as { id: string }[]
    const matchIds = matches.map((m) => m.id)
    matchesDeleted = matchIds.length
    if (matchIds.length > 0) {
      // Explicit deletes keep this correct even where cascades are not available (unit tests).
      const negotiations = unwrap(await db().from('negotiations').select('id').in('match_id', matchIds), 'load negotiations') as { id: string }[]
      if (negotiations.length > 0) unwrap(await db().from('negotiation_messages').delete().in('negotiation_id', negotiations.map((n) => n.id)), 'delete messages')
      unwrap(await db().from('negotiations').delete().in('match_id', matchIds), 'delete negotiations')
      unwrap(await db().from('orders').delete().in('match_id', matchIds), 'delete orders')
      unwrap(await db().from('matches').delete().in('id', matchIds), 'delete matches')
    }
    // Generated listings are per item; remove them (after matches) so the next scan regenerates them.
    const marketplace = unwrap(await db().from('listings').select('id, external_id').eq('source', 'marketplace'), 'load marketplace listings') as { id: string; external_id: string | null }[]
    const generatedIds = marketplace.filter((l) => l.external_id && itemIds.some((id) => isGeneratedFor(l.external_id as string, id))).map((l) => l.id)
    if (generatedIds.length > 0) {
      unwrap(await db().from('listing_secrets').delete().in('listing_id', generatedIds), 'delete generated listing secrets')
      unwrap(await db().from('listings').delete().in('id', generatedIds), 'delete generated listings')
    }
    unwrap(await db().from('wishlist_items').update({ status: 'active', last_scanned_at: null }).eq('user_id', userId), 'reset wishlist items')
  }
  unwrap(await db().from('agent_events').delete().eq('user_id', userId), 'delete events')
  return { matchesDeleted }
}
