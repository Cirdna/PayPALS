import seed from './seed/data.json'
import { db, unwrap } from '~~/server/lib/db'
import { resetUserData } from '~~/server/lib/demo'
import { env } from '~~/server/lib/env'

type Row = Record<string, any>

async function ensureDemoUser(): Promise<string> {
  const email = env.demoEmail
  const password = env.demoPassword
  const created = await db().auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: seed.demoUser.displayName } })
  let id = created.data?.user?.id
  if (!id) {
    // already registered → find it and make sure the password matches .env
    const list = await db().auth.admin.listUsers({ page: 1, perPage: 1000 })
    const user = list.data?.users.find((u) => u.email === email)
    if (!user) throw new Error(`Could not create or find the demo user: ${created.error?.message}`)
    id = user.id
    await db().auth.admin.updateUserById(id, { password })
  }
  unwrap(await db().from('profiles').upsert({ id, display_name: seed.demoUser.displayName }, { onConflict: 'id' }), 'upsert profile')
  return id
}

async function seedMarketplace(): Promise<void> {
  const sellers = unwrap(await db().from('sellers').upsert(
    seed.sellers.map((s) => ({ slug: s.slug, display_name: s.displayName, account_age_days: s.accountAgeDays, rating: s.rating, rating_count: s.ratingCount, is_agent: true })),
    { onConflict: 'slug' },
  ).select('id, slug'), 'upsert sellers') as Row[]
  const sellerId = new Map(sellers.map((s) => [s.slug, s.id]))

  unwrap(await db().from('seller_personas').upsert(
    seed.sellers.map((s) => ({ seller_id: sellerId.get(s.slug), style: s.persona.style, notes: s.persona.notes })),
    { onConflict: 'seller_id' },
  ), 'upsert personas')

  const listings = unwrap(await db().from('listings').upsert(
    seed.listings.map((l) => ({
      source: 'marketplace', external_id: l.key, title: l.title, description: l.description, price: l.price, currency: 'USD',
      condition: l.condition, seller_id: sellerId.get(l.sellerSlug), negotiable: l.negotiable,
    })),
    { onConflict: 'source,external_id' },
  ).select('id, external_id'), 'upsert listings') as Row[]
  const listingId = new Map(listings.map((l) => [l.external_id, l.id]))

  unwrap(await db().from('listing_secrets').upsert(
    seed.listings.map((l) => ({ listing_id: listingId.get(l.key), floor_price: l.floorPrice, scripted_messages: l.scriptedMessages })),
    { onConflict: 'listing_id' },
  ), 'upsert listing secrets')
  console.log(`Marketplace: ${sellers.length} sellers, ${listings.length} listings`)
}

async function seedWishlist(userId: string): Promise<void> {
  for (const w of seed.wishlist) {
    let item = unwrap(await db().from('wishlist_items').select('id').eq('user_id', userId).eq('title', w.title).maybeSingle(), 'find wishlist item') as Row | null
    if (!item) {
      item = unwrap(await db().from('wishlist_items').insert({
        user_id: userId, title: w.title, query: w.query, specs: w.specs, max_price: w.maxPrice, target_price: w.targetPrice,
        currency: 'USD', min_condition: w.minCondition, dealbreakers: w.dealbreakers,
      }).select('id').single(), 'insert wishlist item') as Row
    }
    const expires = new Date(Date.now() + w.mandateExpiresInDays * 86_400_000).toISOString()
    unwrap(await db().from('mandates').upsert(
      { user_id: userId, wishlist_item_id: item.id, max_amount: w.maxPrice, currency: 'USD', require_human_approval: true, expires_at: expires, revoked_at: null },
      { onConflict: 'wishlist_item_id' },
    ), 'upsert mandate')
  }
  console.log(`Wishlist: ${seed.wishlist.length} items for the demo user`)
}

const userId = await ensureDemoUser()
if (process.argv.includes('--reset')) {
  const { matchesDeleted } = await resetUserData(userId)
  console.log(`Demo reset: ${matchesDeleted} matches removed`)
} else {
  await seedMarketplace()
  await seedWishlist(userId)
  console.log(`Done. Demo login: ${env.demoEmail} / ${env.demoPassword}`)
}
process.exit(0)
