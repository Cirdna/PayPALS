import type { WishlistItem } from '#shared/types'
import { generatedExternalId, generateListings, isGeneratedFor } from '~~/server/lib/ai'
import { db, unwrap } from '../db'

type Row = Record<string, any>

export const MIN_SEEDED_MARKETPLACE_MATCHES = 3

/** Small deterministic string hash (djb2) so seller choice is stable per (item, slot). */
function hash(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h
}

/**
 * Returns the generated marketplace rows for this item (existing ones, or newly created), or [] when not needed / not possible.
 * Once per item: existing generated rows are reused and no LLM call is made. Code, not the model, sets every number.
 */
export async function ensureGeneratedListings(item: WishlistItem, marketplace: Row[], seededMatchCount: number, overBudget: () => boolean): Promise<Row[]> {
  const existing = marketplace.filter((r) => isGeneratedFor(String(r.external_id), item.id))
  if (existing.length > 0) return existing
  if (seededMatchCount >= MIN_SEEDED_MARKETPLACE_MATCHES) return []
  if (overBudget()) return []

  const { drafts, usedFallback } = await generateListings(item)

  // seller_personas is server-only: used here to pick sellers by style, never returned to clients
  const personas = unwrap(await db().from('seller_personas').select('seller_id, style'), 'load seller personas') as Row[]
  if (personas.length === 0) {
    console.warn('[scan] no seller personas, cannot generate listings')
    return []
  }
  const byStyle = new Map<string, string[]>()
  for (const p of personas) byStyle.set(p.style, [...(byStyle.get(p.style) ?? []), p.seller_id])
  const pick = (style: string, slot: number): string => {
    const group = byStyle.get(style) ?? byStyle.get('friendly') ?? [personas[0]!.seller_id]
    return group[hash(`${item.id}:${slot}`) % group.length]!
  }

  const rows = unwrap(
    await db().from('listings').upsert(
      drafts.map((d) => ({
        source: 'marketplace',
        external_id: generatedExternalId(item.id, d.slot),
        title: d.title,
        description: d.description,
        price: d.price,
        currency: 'USD',
        condition: d.condition,
        seller_id: pick(d.sellerStyle, d.slot),
        negotiable: d.negotiable,
        url: null,
        image_url: null,
        retailer: null,
      })),
      { onConflict: 'source,external_id' },
    ).select(),
    'upsert generated listings',
  ) as Row[]

  unwrap(
    await db().from('listing_secrets').upsert(
      rows.map((r) => {
        const d = drafts.find((x) => generatedExternalId(item.id, x.slot) === r.external_id)!
        return { listing_id: r.id, floor_price: d.floorPrice, scripted_messages: d.opener ? { '0': d.opener } : {} }
      }),
      { onConflict: 'listing_id' },
    ),
    'upsert generated listing secrets',
  )
  console.info(`[scan] generated ${rows.length} demo listings for "${item.title}"${usedFallback ? ' (template text)' : ''}`)
  return rows
}
