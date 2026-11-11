import type { DealRow, Listing, Match, Seller, WishlistItem } from '#shared/types'
import { roundMoney } from '#shared/utils/money'

/** One row of the Deals board. Pure mapping — keep it free of I/O. */
export function toDealRow(i: { match: Match; listing: Listing; seller: Seller | null; item: WishlistItem }): DealRow {
  const { match, listing, seller, item } = i
  const bestPrice = match.bestPrice ?? listing.price
  return {
    matchId: match.id,
    wishlistItemId: item.id,
    wishlistTitle: item.title,
    listingTitle: listing.title,
    source: listing.source,
    sellerOrRetailer: seller?.displayName ?? listing.retailer ?? '',
    condition: listing.condition,
    listPrice: listing.price,
    bestPrice,
    savings: roundMoney(listing.price - bestPrice),
    savingsVsMax: roundMoney(item.maxPrice - bestPrice),
    currency: listing.currency,
    riskLevel: match.risk?.level ?? null,
    riskScore: match.risk?.score ?? null,
    status: match.status,
    payable: listing.source === 'marketplace',
    url: listing.url,
    updatedAt: match.updatedAt,
  }
}
