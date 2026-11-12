import type { Channel3Api } from '@channel3/sdk'
import type { ListingDraft } from '#shared/types'
import { APP_CURRENCY, isValidPrice, roundMoney } from '#shared/utils/money'

/** Channel3 data is untrusted: only http(s) URLs may reach the UI / Telegram links. */
export function safeUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null
  try {
    const url = new URL(u)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * Pure: one Channel3 product → one ListingDraft (cheapest in-stock USD offer), or null when it has none.
 * Verified against @channel3/sdk 4.9.0 types:
 *   import { Channel3 } from '@channel3/sdk'                       // named export (NOT default, NOT Channel3Client)
 *   const client = new Channel3({ apiKey, currency: 'USD', country: 'US' })
 *   const page = await client.products.search({ query, limit: 10, filters: { availability: ['InStock'] } })
 *   page.data        // Product[]   (NOT page.products)
 */
export function normaliseProduct(p: Channel3Api.Product): ListingDraft | null {
  const offers = (p.offers ?? []).filter(
    (o) => o.availability === 'InStock' && o.price?.currency === APP_CURRENCY && isValidPrice(o.price?.price) && safeUrl(o.url) !== null,
  )
  if (offers.length === 0) return null
  const offer = offers.reduce((best, o) => (o.price.price < best.price.price ? o : best))
  const image = (p.images ?? []).find((i) => i.is_main_image) ?? (p.images ?? [])[0]
  const features = (p.key_features ?? []).slice(0, 6).join('; ')
  return {
    source: 'channel3',
    externalId: p.id,
    title: p.title,
    description: [p.description ?? '', features].filter(Boolean).join('\n').slice(0, 1500),
    price: roundMoney(offer.price.price),
    currency: APP_CURRENCY,
    condition: offer.condition === 'used' ? 'good' : 'new',
    url: safeUrl(offer.url),
    imageUrl: safeUrl(image?.url),
    retailer: offer.domain,
    negotiable: false,
  }
}
