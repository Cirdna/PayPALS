import seed from '~~/supabase/seed/data.json'

type Row = Record<string, any>

/**
 * The demo data (supabase/seed/data.json) as fake-db tables, snake_case like the real database.
 * Ids are the readable keys: seller id = slug, listing id = key, wishlist id = key, mandate id = `md-<key>`, user id = 'demo-user'.
 *
 *   const fake = createFakeDb(seedTables())
 *   setDbForTests(fake)
 *
 * `expectedFor(listingId)` returns the listing's expected { match, risk, status } for assertions.
 */
export const DEMO_USER_ID = 'demo-user'

export function seedTables(): Record<string, Row[]> {
  return {
    profiles: [{ id: DEMO_USER_ID, display_name: seed.demoUser.displayName, telegram_chat_id: null, telegram_link_token: 'demo-link-token' }],
    sellers: seed.sellers.map((s) => ({ id: s.slug, slug: s.slug, display_name: s.displayName, account_age_days: s.accountAgeDays, rating: s.rating, rating_count: s.ratingCount, is_agent: true, paypal_email: null })),
    seller_personas: seed.sellers.map((s) => ({ seller_id: s.slug, style: s.persona.style, notes: s.persona.notes })),
    listings: seed.listings.map((l) => ({
      id: l.key, source: 'marketplace', external_id: l.key, title: l.title, description: l.description, price: l.price, currency: 'USD',
      condition: l.condition, url: null, image_url: null, retailer: null, seller_id: l.sellerSlug, negotiable: l.negotiable, fetched_at: '2026-11-12T00:00:00.000Z',
    })),
    listing_secrets: seed.listings.map((l) => ({ listing_id: l.key, floor_price: l.floorPrice, scripted_messages: l.scriptedMessages })),
    wishlist_items: seed.wishlist.map((w) => ({
      id: w.key, user_id: DEMO_USER_ID, title: w.title, query: w.query, specs: w.specs, max_price: w.maxPrice, target_price: w.targetPrice,
      currency: 'USD', min_condition: w.minCondition, dealbreakers: w.dealbreakers, status: 'active', last_scanned_at: null, created_at: '2026-11-11T00:00:00.000Z',
    })),
    mandates: seed.wishlist.map((w) => ({
      id: `md-${w.key}`, user_id: DEMO_USER_ID, wishlist_item_id: w.key, max_amount: w.maxPrice, currency: 'USD', require_human_approval: true,
      expires_at: '2026-11-26T00:00:00.000Z', revoked_at: null, created_at: '2026-11-11T00:00:00.000Z',
    })),
  }
}

export function expectedFor(listingId: string): { match: boolean; risk: string | null; status: string } {
  const l = seed.listings.find((x) => x.key === listingId)
  if (!l) throw new Error(`No seeded listing with key ${listingId}`)
  return l.expected
}

/** Matcher model response that answers exactly as the seed data expects, for the listings in the order they are passed. */
export function expectedVerdicts(listingIds: string[]): { verdicts: { index: number; isMatch: boolean; confidence: number; reason: string; mismatches: string[] }[] } {
  return { verdicts: listingIds.map((id, index) => ({ index, isMatch: expectedFor(id).match, confidence: 0.95, reason: expectedFor(id).match ? 'matches the wanted product' : 'different product', mismatches: [] })) }
}
