import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setDbForTests } from '~~/server/lib/db'
import { getMatchDetail, listDeals, skipMatch } from '~~/server/lib/deals'
import { createFakeDb, type FakeDb } from '../helpers/fake-db'
import { DEMO_USER_ID, seedTables } from '../helpers/seed-fixture'

const OTHER_USER_ID = 'other-user'
const LOW_RISK = { score: 10, level: 'low', signals: [], priceStats: null, explanation: 'No significant risk signals.' }
const HIGH_RISK = { score: 90, level: 'high', signals: [], priceStats: null, explanation: 'High risk.' }

function makeDb(): FakeDb {
  const tables = seedTables()
  return createFakeDb({
    ...tables,
    wishlist_items: [
      ...tables.wishlist_items!,
      { id: 'w-other', user_id: OTHER_USER_ID, title: 'Other wish', query: 'other', specs: '', max_price: 100, target_price: null, currency: 'USD', min_condition: 'good', dealbreakers: [], status: 'active', last_scanned_at: null, created_at: '2026-11-11T00:00:00.000Z' },
    ],
    mandates: [
      ...tables.mandates!,
      { id: 'md-w-other', user_id: OTHER_USER_ID, wishlist_item_id: 'w-other', max_amount: 100, currency: 'USD', require_human_approval: true, expires_at: '2026-11-26T00:00:00.000Z', revoked_at: null, created_at: '2026-11-11T00:00:00.000Z' },
    ],
    matches: [
      { id: 'm-ready', wishlist_item_id: 'wl-headphones', listing_id: 'hp-used-mei', status: 'ready', verdict: null, risk: LOW_RISK, best_price: 295, notified_at: null, created_at: '2026-11-12T00:00:01.000Z', updated_at: '2026-11-12T00:00:01.000Z' },
      { id: 'm-agreed', wishlist_item_id: 'wl-headphones', listing_id: 'hp-used-ray', status: 'agreed', verdict: null, risk: LOW_RISK, best_price: 262, notified_at: null, created_at: '2026-11-12T00:00:02.000Z', updated_at: '2026-11-12T00:00:02.000Z' },
      { id: 'm-flag', wishlist_item_id: 'wl-headphones', listing_id: 'hp-scam-bargain', status: 'flagged', verdict: null, risk: HIGH_RISK, best_price: 120, notified_at: null, created_at: '2026-11-12T00:00:03.000Z', updated_at: '2026-11-12T00:00:03.000Z' },
      { id: 'm-over', wishlist_item_id: 'wl-headphones', listing_id: 'hp-store-sonaro', status: 'over_budget', verdict: null, risk: null, best_price: null, notified_at: null, created_at: '2026-11-12T00:00:04.000Z', updated_at: '2026-11-12T00:00:04.000Z' },
      { id: 'm-mis', wishlist_item_id: 'wl-headphones', listing_id: 'hp-mismatch-wh500', status: 'mismatch', verdict: null, risk: null, best_price: null, notified_at: null, created_at: '2026-11-12T00:00:05.000Z', updated_at: '2026-11-12T00:00:05.000Z' },
      { id: 'm-other', wishlist_item_id: 'w-other', listing_id: 'hp-used-ray', status: 'ready', verdict: null, risk: LOW_RISK, best_price: 279, notified_at: null, created_at: '2026-11-12T00:00:06.000Z', updated_at: '2026-11-12T00:00:06.000Z' },
    ],
  })
}

let fake: FakeDb
beforeEach(() => {
  fake = makeDb()
  setDbForTests(fake)
})
afterEach(() => setDbForTests(null))

describe('listDeals', () => {
  it('returns the user\'s deals without mismatches or other users\' matches', async () => {
    const rows = await listDeals(DEMO_USER_ID)
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.matchId).sort()).toEqual(['m-agreed', 'm-flag', 'm-over', 'm-ready'])
    const agreed = rows.find((r) => r.matchId === 'm-agreed')!
    expect(agreed).toMatchObject({ savings: 17, payable: true, sellerOrRetailer: 'retro_ray', wishlistTitle: 'Sonaro WH-700 headphones', status: 'agreed', riskLevel: 'low' })
  })

  it('returns an empty list for another wishlist item or an unknown user', async () => {
    expect(await listDeals(DEMO_USER_ID, 'wl-handheld')).toEqual([])
    expect(await listDeals('nobody')).toEqual([])
  })

  it('is newest-updated first', async () => {
    const rows = await listDeals(DEMO_USER_ID)
    expect(rows.map((r) => r.matchId)).toEqual(['m-over', 'm-flag', 'm-agreed', 'm-ready'])
  })
})

describe('getMatchDetail', () => {
  it('returns match, listing, public seller, wishlist item and mandate', async () => {
    const detail = await getMatchDetail(DEMO_USER_ID, 'm-agreed')
    expect(detail).not.toBeNull()
    expect(detail!.match).toMatchObject({ id: 'm-agreed', status: 'agreed', bestPrice: 262 })
    expect(detail!.listing).toMatchObject({ id: 'hp-used-ray', source: 'marketplace', price: 279 })
    expect(detail!.seller).toEqual({ id: 'retro-ray', displayName: 'retro_ray', accountAgeDays: expect.any(Number), rating: expect.any(Number), ratingCount: expect.any(Number), isAgent: true })
    expect(detail!.wishlistItem).toMatchObject({ id: 'wl-headphones', userId: DEMO_USER_ID })
    expect(detail!.mandate).toMatchObject({ wishlistItemId: 'wl-headphones', maxAmount: 300 })
    expect(detail!.negotiation).toBeNull()
    expect(detail!.messages).toEqual([])
    expect(detail!.order).toBeNull()
  })

  it('includes the negotiation (without the lock) and its messages in created_at order', async () => {
    await fake.from('negotiations').insert({ id: 'n1', match_id: 'm-agreed', status: 'agreed', round: 2, agreed_price: 262, locked_until: '2026-11-12T00:10:00.000Z' })
    await fake.from('negotiation_messages').insert([
      { id: 'x3', negotiation_id: 'n1', round: 2, role: 'seller', action: 'accept', price: 262, message: 'Deal.', created_at: '2026-11-12T00:00:30.000Z' },
      { id: 'x1', negotiation_id: 'n1', round: 0, role: 'seller', action: 'counter', price: 279, message: 'Hi, available.', created_at: '2026-11-12T00:00:10.000Z' },
      { id: 'x2', negotiation_id: 'n1', round: 1, role: 'buyer', action: 'offer', price: 250, message: 'Would you take 250?', created_at: '2026-11-12T00:00:20.000Z' },
    ])
    const detail = await getMatchDetail(DEMO_USER_ID, 'm-agreed')
    expect(detail!.negotiation).toMatchObject({ id: 'n1', matchId: 'm-agreed', status: 'agreed', round: 2, agreedPrice: 262 })
    expect(detail!.negotiation).not.toHaveProperty('lockedUntil')
    expect(detail!.messages.map((m) => m.id)).toEqual(['x1', 'x2', 'x3'])
  })

  it('returns the newest order of the match', async () => {
    await fake.from('orders').insert([
      { id: 'o-old', match_id: 'm-agreed', user_id: DEMO_USER_ID, paypal_order_id: 'PAYPALOLD', amount: 262, status: 'cancelled', created_at: '2026-11-12T00:00:10.000Z' },
      { id: 'o-new', match_id: 'm-agreed', user_id: DEMO_USER_ID, paypal_order_id: 'PAYPALNEW', amount: 262, status: 'created', created_at: '2026-11-12T00:00:20.000Z' },
    ])
    const detail = await getMatchDetail(DEMO_USER_ID, 'm-agreed')
    expect(detail!.order).toMatchObject({ id: 'o-new', paypalOrderId: 'PAYPALNEW', amount: 262 })
  })

  it('returns null for another user\'s match and for unknown ids', async () => {
    expect(await getMatchDetail(DEMO_USER_ID, 'm-other')).toBeNull()
    expect(await getMatchDetail(DEMO_USER_ID, 'does-not-exist')).toBeNull()
  })

  it('never leaks seller secrets', async () => {
    for (const id of ['m-ready', 'm-agreed', 'm-flag', 'm-over']) {
      const detail = await getMatchDetail(DEMO_USER_ID, id)
      expect(JSON.stringify(detail)).not.toMatch(/floor|scripted/i)
      expect(JSON.stringify(detail)).not.toMatch(/paypalEmail|persona/i)
    }
    expect(fake.calls.map((c) => c.table)).not.toContain('listing_secrets')
    expect(fake.calls.map((c) => c.table)).not.toContain('seller_personas')
  })
})

describe('skipMatch', () => {
  it('skips a ready match', async () => {
    expect(await skipMatch(DEMO_USER_ID, 'm-ready')).toBe(true)
    expect(fake.rows('matches').find((m) => m.id === 'm-ready')!.status).toBe('skipped')
  })

  it('skips agreed matches too', async () => {
    expect(await skipMatch(DEMO_USER_ID, 'm-agreed')).toBe(true)
    expect(fake.rows('matches').find((m) => m.id === 'm-agreed')!.status).toBe('skipped')
  })

  it('refuses flagged matches', async () => {
    expect(await skipMatch(DEMO_USER_ID, 'm-flag')).toBe(false)
    expect(fake.rows('matches').find((m) => m.id === 'm-flag')!.status).toBe('flagged')
  })

  it('refuses another user\'s match and unknown ids', async () => {
    expect(await skipMatch(DEMO_USER_ID, 'm-other')).toBe(false)
    expect(fake.rows('matches').find((m) => m.id === 'm-other')!.status).toBe('ready')
    expect(await skipMatch(DEMO_USER_ID, 'does-not-exist')).toBe(false)
  })
})
