import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setDbForTests } from '~~/server/lib/db'
import { createWishlistItem, deleteWishlistItem, listWishlist, wishlistSchema } from '~~/server/lib/deals'
import { createFakeDb, type FakeDb } from '../helpers/fake-db'
import { DEMO_USER_ID, seedTables } from '../helpers/seed-fixture'

const OTHER_USER_ID = 'other-user'
const DAY = 86_400_000

const valid = { title: 'Mechanical keyboard', query: 'mechanical keyboard', specs: 'tenkeyless', maxPrice: 120, targetPrice: 90, minCondition: 'good' as const }

let fake: FakeDb
beforeEach(() => {
  const tables = seedTables()
  fake = createFakeDb({
    ...tables,
    wishlist_items: [
      ...tables.wishlist_items!,
      { id: 'w-other', user_id: OTHER_USER_ID, title: 'Other wish', query: 'other', specs: '', max_price: 100, target_price: null, currency: 'USD', min_condition: 'good', dealbreakers: [], status: 'active', last_scanned_at: null, created_at: '2026-11-11T00:00:00.000Z' },
    ],
    mandates: [
      ...tables.mandates!,
      { id: 'md-w-other', user_id: OTHER_USER_ID, wishlist_item_id: 'w-other', max_amount: 100, currency: 'USD', require_human_approval: true, expires_at: '2026-11-26T00:00:00.000Z', revoked_at: null, created_at: '2026-11-11T00:00:00.000Z' },
    ],
  })
  setDbForTests(fake)
})
afterEach(() => setDbForTests(null))

describe('createWishlistItem', () => {
  it('inserts the item and a mandate capped at maxPrice, expiring in 14 days by default', async () => {
    const before = Date.now()
    const { item, mandate } = await createWishlistItem(DEMO_USER_ID, wishlistSchema.parse(valid))
    expect(item).toMatchObject({ userId: DEMO_USER_ID, title: 'Mechanical keyboard', maxPrice: 120, targetPrice: 90, minCondition: 'good', status: 'active', currency: 'USD', dealbreakers: [] })
    expect(mandate).toMatchObject({ userId: DEMO_USER_ID, wishlistItemId: item.id, maxAmount: 120, currency: 'USD', requireHumanApproval: true, revokedAt: null })
    const expires = new Date(mandate.expiresAt).getTime()
    expect(expires).toBeGreaterThanOrEqual(before + 14 * DAY - 1000)
    expect(expires).toBeLessThanOrEqual(Date.now() + 14 * DAY + 1000)

    const stored = fake.rows('mandates').find((m) => m.wishlist_item_id === item.id)!
    expect(stored.max_amount).toBe(120)
    expect(stored.require_human_approval).toBe(true)
    expect(fake.rows('wishlist_items').some((w) => w.id === item.id && w.user_id === DEMO_USER_ID)).toBe(true)
  })

  it('honours mandateExpiresInDays', async () => {
    const { mandate } = await createWishlistItem(DEMO_USER_ID, wishlistSchema.parse({ ...valid, mandateExpiresInDays: 3 }))
    const expires = new Date(mandate.expiresAt).getTime()
    expect(expires).toBeGreaterThan(Date.now() + 3 * DAY - 5000)
    expect(expires).toBeLessThan(Date.now() + 3 * DAY + 5000)
  })
})

describe('wishlistSchema', () => {
  it.each([
    ['empty title', { ...valid, title: '   ' }],
    ['empty query', { ...valid, query: '' }],
    ['zero maxPrice', { ...valid, maxPrice: 0 }],
    ['negative maxPrice', { ...valid, maxPrice: -5 }],
    ['targetPrice above maxPrice', { ...valid, targetPrice: 121 }],
    ['unknown minCondition', { ...valid, minCondition: 'mint' }],
  ])('rejects %s', (_name, input) => {
    expect(wishlistSchema.safeParse(input).success).toBe(false)
  })

  it('accepts a null targetPrice and missing dealbreakers, applying defaults', () => {
    const parsed = wishlistSchema.safeParse({ title: 'x', query: 'y', maxPrice: 50, targetPrice: null, minCondition: 'fair' })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.dealbreakers).toEqual([])
      expect(parsed.data.specs).toBe('')
      expect(parsed.data.mandateExpiresInDays).toBe(14)
    }
  })

  it('reports the targetPrice problem on its own path', () => {
    const parsed = wishlistSchema.safeParse({ ...valid, targetPrice: 500 })
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues[0]!.path).toEqual(['targetPrice'])
  })
})

describe('listWishlist', () => {
  it('returns only the user\'s items with their mandates, newest first', async () => {
    const a = await createWishlistItem(DEMO_USER_ID, wishlistSchema.parse({ ...valid, title: 'First added' }))
    const b = await createWishlistItem(DEMO_USER_ID, wishlistSchema.parse({ ...valid, title: 'Second added' }))
    const list = await listWishlist(DEMO_USER_ID)
    expect(list).toHaveLength(5) // 3 seeded + 2 new
    expect(list.every((e) => e.item.userId === DEMO_USER_ID)).toBe(true)
    expect(list.some((e) => e.item.id === 'w-other')).toBe(false)
    expect(list[0]!.item.id).toBe(b.item.id)
    expect(list[1]!.item.id).toBe(a.item.id)
    for (const e of list) expect(e.mandate).toMatchObject({ wishlistItemId: e.item.id })
  })

  it('returns an empty list for a user without items', async () => {
    expect(await listWishlist('nobody')).toEqual([])
  })
})

describe('deleteWishlistItem', () => {
  it('deletes the user\'s own item', async () => {
    expect(await deleteWishlistItem(DEMO_USER_ID, 'wl-keyboard')).toBe(true)
    expect(fake.rows('wishlist_items').some((w) => w.id === 'wl-keyboard')).toBe(false)
    expect(fake.rows('wishlist_items').some((w) => w.id === 'wl-headphones')).toBe(true)
  })

  it('does not delete someone else\'s item', async () => {
    expect(await deleteWishlistItem(DEMO_USER_ID, 'w-other')).toBe(false)
    expect(fake.rows('wishlist_items').some((w) => w.id === 'w-other')).toBe(true)
  })

  it('returns false for an unknown id', async () => {
    expect(await deleteWishlistItem(DEMO_USER_ID, 'nope')).toBe(false)
  })
})
