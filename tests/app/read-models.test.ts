import { afterEach, describe, expect, it } from 'vitest'
import type { Listing, Match, Seller, WishlistItem } from '#shared/types'
import { resetUserData } from '~~/server/lib/demo'
import { setDbForTests } from '~~/server/lib/db'
import { toDealRow } from '~~/server/lib/read-models'
import { createFakeDb } from '../helpers/fake-db'
import { DEMO_USER_ID, seedTables } from '../helpers/seed-fixture'

afterEach(() => setDbForTests(null))

const item: WishlistItem = { id: 'w1', userId: 'u1', title: 'Sonaro WH-700 headphones', query: 'q', specs: '', maxPrice: 300, targetPrice: 250, currency: 'USD', minCondition: 'good', dealbreakers: [], status: 'active', lastScannedAt: null, createdAt: '' }
const listing: Listing = { id: 'l1', source: 'marketplace', externalId: 'k', title: 'Sonaro WH-700 black', description: '', price: 279, currency: 'USD', condition: 'like_new', url: null, imageUrl: null, retailer: null, sellerId: 's1', negotiable: true, fetchedAt: '' }
const seller: Seller = { id: 's1', displayName: 'retro_ray', accountAgeDays: 610, rating: 4.6, ratingCount: 41, isAgent: true }
const match = (over: Partial<Match> = {}): Match => ({ id: 'm1', wishlistItemId: 'w1', listingId: 'l1', status: 'agreed', verdict: null, risk: { score: 10, level: 'low', signals: [], priceStats: null, explanation: '' }, bestPrice: 262, notifiedAt: null, createdAt: '', updatedAt: '2026-11-12T01:00:00Z', ...over })

describe('toDealRow', () => {
  it('maps a negotiated marketplace deal', () => {
    expect(toDealRow({ match: match(), listing, seller, item })).toEqual({
      matchId: 'm1', wishlistItemId: 'w1', wishlistTitle: 'Sonaro WH-700 headphones', listingTitle: 'Sonaro WH-700 black', source: 'marketplace',
      sellerOrRetailer: 'retro_ray', condition: 'like_new', listPrice: 279, bestPrice: 262, savings: 17, savingsVsMax: 38, currency: 'USD',
      riskLevel: 'low', riskScore: 10, status: 'agreed', payable: true, url: null, updatedAt: '2026-11-12T01:00:00Z',
    })
  })
  it('retail offers are not payable, use the retailer name, and can be over budget', () => {
    const row = toDealRow({ match: match({ status: 'over_budget', bestPrice: null, risk: null }), listing: { ...listing, source: 'channel3', price: 349, retailer: 'shop.test', url: 'https://shop.test/p', sellerId: null }, seller: null, item })
    expect(row).toMatchObject({ payable: false, sellerOrRetailer: 'shop.test', bestPrice: 349, savings: 0, savingsVsMax: -49, riskLevel: null, url: 'https://shop.test/p' })
  })
})

describe('resetUserData', () => {
  it('removes the user\'s matches, negotiations, messages, orders and events, and reactivates the wishlist', async () => {
    const fake = createFakeDb({
      ...seedTables(),
      matches: [{ id: 'm1', wishlist_item_id: 'wl-headphones', listing_id: 'hp-used-ray', status: 'purchased' }, { id: 'other', wishlist_item_id: 'someone-elses-item', listing_id: 'hp-used-ray', status: 'ready' }],
      negotiations: [{ id: 'n1', match_id: 'm1', status: 'agreed' }],
      negotiation_messages: [{ id: 'x1', negotiation_id: 'n1', round: 0, role: 'seller', action: 'counter' }],
      orders: [{ id: 'o1', match_id: 'm1', user_id: DEMO_USER_ID, paypal_order_id: 'P1', amount: 262 }],
      agent_events: [{ id: 'e1', user_id: DEMO_USER_ID, type: 'deal_agreed', message: 'x' }, { id: 'e2', user_id: 'someone-else', type: 'deal_agreed', message: 'y' }],
    })
    await fake.from('wishlist_items').update({ status: 'fulfilled', last_scanned_at: '2026-11-12T00:00:00Z' }).eq('id', 'wl-headphones')
    setDbForTests(fake)
    expect(await resetUserData(DEMO_USER_ID)).toEqual({ matchesDeleted: 1 })
    expect(fake.rows('matches').map((m) => m.id)).toEqual(['other'])
    expect(fake.rows('negotiations')).toHaveLength(0)
    expect(fake.rows('negotiation_messages')).toHaveLength(0)
    expect(fake.rows('orders')).toHaveLength(0)
    expect(fake.rows('agent_events').map((e) => e.id)).toEqual(['e2'])
    expect(fake.rows('wishlist_items').every((w) => w.status === 'active' && w.last_scanned_at === null)).toBe(true)
    expect(fake.rows('listings').length).toBeGreaterThan(0) // marketplace data is untouched
  })
  it('removes the user's generated listings and their secrets, leaving other users' and seeded ones', async () => {
    const base = seedTables()
    const gen = (id: string, ext: string) => ({ id, source: 'marketplace', external_id: ext, title: 't', price: 1 })
    const fake = createFakeDb({
      ...base,
      listings: [...base.listings, gen('g1', 'gen:wl-headphones:0'), gen('g2', 'gen:wl-headphones:1'), gen('g3', 'gen:someone-elses-item:0')],
      listing_secrets: [...base.listing_secrets, { listing_id: 'g1', floor_price: 1, scripted_messages: [] }, { listing_id: 'g2', floor_price: 1, scripted_messages: [] }, { listing_id: 'g3', floor_price: 1, scripted_messages: [] }],
      matches: [{ id: 'm1', wishlist_item_id: 'wl-headphones', listing_id: 'g1', status: 'ready' }],
    })
    setDbForTests(fake)
    await resetUserData(DEMO_USER_ID)
    const ids = fake.rows('listings').map((l) => l.id)
    expect(ids).not.toContain('g1')
    expect(ids).not.toContain('g2')
    expect(ids).toContain('g3')
    expect(ids).toHaveLength(base.listings.length + 1)
    const secretIds = fake.rows('listing_secrets').map((s) => s.listing_id)
    expect(secretIds).toEqual(expect.arrayContaining(['g3']))
    expect(secretIds).not.toContain('g1')
    expect(secretIds).toHaveLength(base.listing_secrets.length + 1)
  })
})
