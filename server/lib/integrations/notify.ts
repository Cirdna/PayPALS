import type { Listing, Match, WishlistItem } from '#shared/types'
import { formatMoney } from '#shared/utils/money'
import { db, unwrap } from '../db'
import { logEvent } from '../events'
import { toCamel } from '../mappers'
import { dealMessage, tg } from './telegram'

type Row = Record<string, any>

/**
 * Tell the user about an agreed deal. Atomic: only the caller that wins the claim (agreed → notified) proceeds.
 * Telegram problems are logged, never thrown: the deal stays `notified` and visible in the app.
 */
export async function notifyDeal(matchId: string): Promise<boolean> {
  const claimed = unwrap(await db().rpc('claim_deal_notification', { p_match_id: matchId }), 'claim notification') as Row[]
  if (!claimed || claimed.length === 0) return false
  const match = toCamel<Match>(claimed[0]!)
  const listing = toCamel<Listing>(unwrap(await db().from('listings').select('*').eq('id', match.listingId).single(), 'load listing') as Row)
  const item = toCamel<WishlistItem>(unwrap(await db().from('wishlist_items').select('*').eq('id', match.wishlistItemId).single(), 'load item') as Row)
  const profile = unwrap(await db().from('profiles').select('*').eq('id', item.userId).maybeSingle(), 'load profile') as Row | null

  await logEvent({
    userId: item.userId,
    matchId,
    type: 'deal_notified',
    message: `📣 Deal ready: "${listing.title}" at ${formatMoney(match.bestPrice ?? listing.price)}`,
  })

  if (profile?.telegram_chat_id) {
    try {
      await tg('sendMessage', { chat_id: profile.telegram_chat_id, parse_mode: 'HTML', ...dealMessage({ listing, item, match }) })
    } catch (e) {
      console.warn('[notify] telegram failed:', e instanceof Error ? e.message : 'unknown error')
    }
  }
  return true
}
