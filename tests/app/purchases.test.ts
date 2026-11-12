import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setDbForTests } from '~~/server/lib/db'
import { listDeals, listPurchases } from '~~/server/lib/deals'
import { purchaseTotals } from '../../app/utils/purchases'
import { createFakeDb } from '../helpers/fake-db'
import { DEMO_USER_ID, seedTables } from '../helpers/seed-fixture'

const OTHER_USER_ID = 'other-user'
const LOW_RISK = { score: 10, level: 'low', signals: [], priceStats: null, explanation: 'No significant risk signals.' }

function match(id: string, wishlistItemId: string, listingId: string, status: string, bestPrice: number, updatedAt: string) {
  return { id, wishlist_item_id: wishlistItemId, listing_id: listingId, status, verdict: null, risk: LOW_RISK, best_price: bestPrice, notified_at: null, created_at: updatedAt, updated_at: updatedAt }
}

function order(id: string, matchId: string, userId: string, status: string, amount: number, updatedAt: string) {
  return { id, match_id: matchId, user_id: userId, paypal_order_id: `PP-${id}`, amount, currency: 'USD', status, approve_url: null, capture_id: status === 'completed' ? `CAP-${id}` : null, created_at: updatedAt, updated_at: updatedAt }
}

beforeEach(() => {
  const tables = seedTables()
  setDbForTests(createFakeDb({
    ...tables,
    wishlist_items: [
      ...tables.wishlist_items!,
      { id: 'w-other', user_id: OTHER_USER_ID, title: 'Other wish', query: 'other', specs: '', max_price: 300, target_price: null, currency: 'USD', min_condition: 'good', dealbreakers: [], status: 'active', last_scanned_at: null, created_at: '2026-11-11T00:00:00.000Z' },
    ],
    matches: [
      match('m-ready', 'wl-headphones', 'hp-used-mei', 'ready', 295, '2026-11-12T00:00:01.000Z'),
      match('m-hp-bought', 'wl-headphones', 'hp-used-ray', 'purchased', 262, '2026-11-12T01:00:00.000Z'),
      match('m-hh-bought', 'wl-handheld', 'hh-used-techdad', 'purchased', 250, '2026-11-12T03:00:00.000Z'),
      match('m-hh-pending', 'wl-handheld', 'hh-used-kelvin', 'checkout_pending', 255, '2026-11-12T04:00:00.000Z'),
      match('m-no-order', 'wl-headphones', 'hp-used-techdad', 'purchased', 270, '2026-11-12T05:00:00.000Z'),
      match('m-other-bought', 'w-other', 'hp-used-gadgetflip', 'purchased', 280, '2026-11-12T06:00:00.000Z'),
    ],
    orders: [
      order('o-hp', 'm-hp-bought', DEMO_USER_ID, 'completed', 262, '2026-11-12T01:00:00.000Z'),
      order('o-hh-failed', 'm-hh-bought', DEMO_USER_ID, 'failed', 250, '2026-11-12T02:00:00.000Z'),
      order('o-hh', 'm-hh-bought', DEMO_USER_ID, 'completed', 250, '2026-11-12T03:00:00.000Z'),
      order('o-pending', 'm-hh-pending', DEMO_USER_ID, 'created', 255, '2026-11-12T04:00:00.000Z'),
      order('o-other', 'm-other-bought', OTHER_USER_ID, 'completed', 280, '2026-11-12T06:00:00.000Z'),
    ],
  }))
})
afterEach(() => setDbForTests(null))

describe('listDeals (board)', () => {
  it('leaves purchased deals out of the board', async () => {
    const rows = await listDeals(DEMO_USER_ID)
    expect(rows.map((r) => r.matchId).sort()).toEqual(['m-hh-pending', 'm-ready'])
  })
})

describe('listPurchases', () => {
  it('returns only the user\'s purchased deals with a completed PayPal order, newest payment first', async () => {
    const purchases = await listPurchases(DEMO_USER_ID)
    expect(purchases.map((p) => p.deal.matchId)).toEqual(['m-hh-bought', 'm-hp-bought'])
  })

  it('pairs each deal with its completed order, not an earlier failed attempt', async () => {
    const [handheld, headphones] = await listPurchases(DEMO_USER_ID)
    expect(handheld!.order).toMatchObject({ id: 'o-hh', status: 'completed', amount: 250, paypalOrderId: 'PP-o-hh', captureId: 'CAP-o-hh' })
    expect(headphones!.order).toMatchObject({ id: 'o-hp', amount: 262 })
    expect(headphones!.deal).toMatchObject({ listingTitle: expect.any(String), listPrice: 279, bestPrice: 262, savings: 17, sellerOrRetailer: 'retro_ray', wishlistTitle: 'Sonaro WH-700 headphones', status: 'purchased' })
  })

  it('never returns another user\'s purchases', async () => {
    expect(await listPurchases('nobody')).toEqual([])
    const other = await listPurchases(OTHER_USER_ID)
    expect(other.map((p) => p.deal.matchId)).toEqual(['m-other-bought'])
  })
})

describe('purchaseTotals', () => {
  it('sums what was paid and saved against list prices', () => {
    expect(purchaseTotals([])).toEqual({ count: 0, spent: 0, saved: 0 })
    expect(purchaseTotals([
      { deal: { listPrice: 279 }, order: { amount: 262.1 } },
      { deal: { listPrice: 265 }, order: { amount: 250.2 } },
      { deal: { listPrice: 300 }, order: { amount: 300 } },
    ])).toEqual({ count: 3, spent: 812.3, saved: 31.7 })
  })
})
