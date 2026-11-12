import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel3Api } from '@channel3/sdk'
import type { Listing, MatchVerdict } from '#shared/types'
import seed from '~~/supabase/seed/data.json'
import { setDbForTests } from '~~/server/lib/db'
import { ai, MatcherUnavailableError } from '~~/server/lib/ai'
import { integrations } from '~~/server/lib/integrations'
import { searchProducts, setChannel3ClientForTests } from '~~/server/lib/integrations/channel3'
import { keywordMatch, queryKeywords, runScan, ScanError } from '~~/server/lib/integrations/scan'
import { createFakeDb, type FakeDb } from '../helpers/fake-db'
import { DEMO_USER_ID, expectedFor, seedTables } from '../helpers/seed-fixture'
import { mockFailingModel } from '../helpers/mock-model'
import { setModelForTests } from '~~/server/lib/ai/model'

describe('keywordMatch', () => {
  it('extracts keywords', () => {
    expect(queryKeywords('Sonaro WH-700 noise cancelling headphones')).toEqual(['sonaro', 'noise', 'cancelling', 'headphones'])
    expect(queryKeywords('75% hot-swappable wireless mechanical keyboard')).toEqual(['swappable', 'mechanical', 'keyboard'])
  })
  for (const w of seed.wishlist) {
    it(`${w.key}: matches exactly its own theme's seeded listings`, () => {
      for (const l of seed.listings) expect(keywordMatch(w.query, l.title), `${w.key} vs ${l.key}`).toBe(l.theme === w.key)
    })
  }
})

// ───────────────────────── runScan ─────────────────────────

type Row = Record<string, any>
let fake: FakeDb
let search: ReturnType<typeof vi.fn>
let matchSpy: ReturnType<typeof vi.spyOn>
let notifySpy: ReturnType<typeof vi.spyOn>

const c3Product = (over: Partial<Channel3Api.Product> = {}): Channel3Api.Product => ({
  id: 'p_1',
  title: 'Sonaro WH-700 headphones retail',
  description: 'Wireless, 30h battery',
  offers: [{ url: 'https://shop-a.test/p', domain: 'shop-a.test', price: { price: 299.5, currency: 'USD' }, availability: 'InStock', condition: 'new' }],
  ...over,
})

/** Matcher that answers exactly what the seed expects; anything not in the seed (extra test listings, channel3) is a match. */
const seedVerdict = (l: Listing): MatchVerdict => {
  let isMatch = true
  try { isMatch = expectedFor(l.externalId).match } catch { /* not a seeded listing */ }
  return { isMatch, confidence: 0.95, reason: 'seed', mismatches: [] }
}

const scanHeadphones = () => runScan({ wishlistItemId: 'wl-headphones', userId: DEMO_USER_ID, isCron: false })
const matchRows = (item = 'wl-headphones') => fake.rows('matches').filter((m) => m.wishlist_item_id === item)
const matchOf = (listingId: string, item = 'wl-headphones') => matchRows(item).find((m) => m.listing_id === listingId)
const addListing = (over: Row) => {
  // fake-db has no public insert helper: reuse the query builder, which is the same path production code takes
  return fake.from('listings').insert({ source: 'marketplace', currency: 'USD', description: '', url: null, ...over, external_id: over.id, fetched_at: '2026-11-12T00:00:00.000Z' })
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  fake = createFakeDb(seedTables())
  setDbForTests(fake)
  search = vi.fn(async () => ({ data: [] as Channel3Api.Product[] }))
  setChannel3ClientForTests({ products: { search } })
  setModelForTests('smart', mockFailingModel())
  matchSpy = vi.spyOn(ai, 'matchListings').mockImplementation(async (_item, listings) => listings.map(seedVerdict))
  notifySpy = vi.spyOn(integrations, 'notifyDeal').mockResolvedValue(true)
  // scan goes through the entry point; route it to the real client (fed by the fake SDK above) so this works before and after the lead wires index.ts
  vi.spyOn(integrations, 'searchProducts').mockImplementation(searchProducts)
})
afterEach(() => {
  vi.restoreAllMocks()
  setDbForTests(null)
  setChannel3ClientForTests(null)
  setModelForTests('smart', null)
})

describe('runScan (headphones, seeded marketplace)', () => {
  it('1. statuses match the seed (cheapest ready one is negotiating); no hh-* rows', async () => {
    await scanHeadphones()
    for (const l of seed.listings.filter((x) => x.key.startsWith('hp-'))) {
      const want = l.key === 'hp-used-ray' ? 'negotiating' : expectedFor(l.key).status
      expect(matchOf(l.key)?.status, l.key).toBe(want)
    }
    expect(fake.rows('matches').filter((m) => m.listing_id.startsWith('hh-'))).toHaveLength(0)
  })

  it('2. returns the expected counts', async () => {
    expect(await scanHeadphones()).toEqual({
      itemsScanned: 1, listingsFetched: 0, matchesCreated: 12, flagged: 2, negotiationsStarted: 1, negotiationsAdvanced: 0, notificationsSent: 0,
    })
  })

  it('3. flagged rows carry high risk with evidence, over_budget keeps the list price, mismatch keeps the verdict', async () => {
    await scanHeadphones()
    for (const key of ['hp-scam-bargain', 'hp-scam-quickdeals']) {
      const m = matchOf(key)!
      expect(m.status).toBe('flagged')
      expect(m.risk.level).toBe('high')
      expect(m.risk.signals.length).toBeGreaterThanOrEqual(2)
    }
    const over = matchOf('hp-store-sonaro')!
    expect(over.status).toBe('over_budget')
    expect(over.best_price).toBe(349)
    expect(over.risk).toBeNull()
    for (const key of ['hp-mismatch-wh500', 'hp-mismatch-earpads']) {
      expect(matchOf(key)!.verdict).toMatchObject({ isMatch: false })
    }
  })

  it('4. exactly one negotiation, for hp-used-ray, with the seller opener', async () => {
    await scanHeadphones()
    const negs = fake.rows('negotiations')
    expect(negs).toHaveLength(1)
    expect(negs[0]!.match_id).toBe(matchOf('hp-used-ray')!.id)
    expect(fake.rows('negotiation_messages').filter((m) => m.role === 'seller')).toHaveLength(1)
  })

  it('5. is idempotent: no new rows, no second negotiation, no new matcher call', async () => {
    await scanHeadphones()
    const before = fake.rows('matches').length
    matchSpy.mockClear()
    const second = await scanHeadphones()
    expect(fake.rows('matches')).toHaveLength(before)
    expect(fake.rows('negotiations')).toHaveLength(1)
    expect(matchSpy).not.toHaveBeenCalled()
    expect(second.matchesCreated).toBe(0)
    expect(second.negotiationsStarted).toBe(0)
  })

  it('6. sets last_scanned_at and logs events', async () => {
    await scanHeadphones()
    expect(fake.rows('wishlist_items').find((w) => w.id === 'wl-headphones')!.last_scanned_at).not.toBeNull()
    const types = fake.rows('agent_events').map((e) => e.type)
    expect(types).toContain('scan_started')
    expect(types).toContain('scan_finished')
    expect(types.filter((t) => t === 'risk_flagged')).toHaveLength(2)
  })

  it('7. ownership: someone else cannot scan the item, nothing is written', async () => {
    const writes = () => fake.calls.filter((c) => c.op !== 'select').length
    const before = writes()
    await expect(runScan({ wishlistItemId: 'wl-headphones', userId: 'someone-else', isCron: false })).rejects.toMatchObject({ name: 'ScanError', code: 'not_found' })
    await expect(runScan({ wishlistItemId: 'wl-headphones', userId: 'someone-else', isCron: false })).rejects.toBeInstanceOf(ScanError)
    expect(writes()).toBe(before)
    expect(matchSpy).not.toHaveBeenCalled()
  })

  it('8. cron scans the 2 least recently scanned items', async () => {
    await fake.from('wishlist_items').update({ last_scanned_at: '2026-11-11T00:00:00.000Z' }).eq('id', 'wl-headphones')
    const res = await runScan({ isCron: true })
    expect(res.itemsScanned).toBe(2)
    const rows = fake.rows('wishlist_items')
    expect(rows.find((w) => w.id === 'wl-headphones')!.last_scanned_at).toBe('2026-11-11T00:00:00.000Z')
    expect(rows.find((w) => w.id === 'wl-handheld')!.last_scanned_at).not.toBeNull()
    expect(rows.find((w) => w.id === 'wl-keyboard')!.last_scanned_at).not.toBeNull()
    expect(matchRows('wl-headphones')).toHaveLength(0)
    expect(matchRows('wl-handheld').length).toBeGreaterThan(0)
  })

  it('9. cron advances an active negotiation first and notifies when it agrees', async () => {
    await fake.from('negotiations').insert({ id: 'n-x', match_id: 'mX', status: 'active', round: 1 })
    const step = vi.spyOn(ai, 'stepNegotiation').mockResolvedValue({
      negotiation: { id: 'n-x', matchId: 'mX', status: 'agreed', round: 2, maxRounds: 6, agreedPrice: 270, createdAt: '', updatedAt: '' },
      newMessages: [], done: true, busy: false,
    })
    const res = await runScan({ isCron: true })
    expect(step).toHaveBeenCalledWith('n-x')
    expect(notifySpy).toHaveBeenCalledWith('mX')
    expect(res.negotiationsAdvanced).toBe(1)
    expect(res.notificationsSent).toBe(1)
  })

  it('10. matcher down: no matches rows are inserted, scan still resolves', async () => {
    matchSpy.mockRejectedValue(new MatcherUnavailableError())
    await expect(scanHeadphones()).resolves.toMatchObject({ itemsScanned: 1, matchesCreated: 0 })
    expect(matchRows()).toHaveLength(0)
  })

  it('11. fixed price within budget becomes agreed and triggers one notification', async () => {
    await addListing({ id: 'hp-store-sale', seller_id: 'soundhouse', title: 'Sonaro WH-700 headphones sale', price: 289, negotiable: false, condition: 'new' })
    const res = await scanHeadphones()
    const m = matchOf('hp-store-sale')!
    expect(m.status).toBe('agreed')
    expect(m.best_price).toBe(289)
    expect(notifySpy).toHaveBeenCalledTimes(1)
    expect(notifySpy).toHaveBeenCalledWith(m.id)
    expect(res.notificationsSent).toBe(1)
  })

  it('12. does not notify when a better deal was already notified', async () => {
    await addListing({ id: 'hp-store-sale', seller_id: 'soundhouse', title: 'Sonaro WH-700 headphones sale', price: 289, negotiable: false, condition: 'new' })
    await fake.from('matches').insert({ wishlist_item_id: 'wl-headphones', listing_id: 'hp-store-soundhouse', status: 'notified', best_price: 280, notified_at: '2026-11-11T12:00:00.000Z' })
    await scanHeadphones()
    expect(matchOf('hp-store-sale')!.status).toBe('agreed')
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('13. negotiable prefilter: above 1.3x budget or below minimum condition is a mismatch', async () => {
    // the 12-candidate cap (cheapest first) would cut the extra listings, so make room
    await fake.from('listings').delete().in('id', ['hp-store-electromart', 'hp-store-sonaro'])
    await addListing({ id: 'hp-used-pricey', seller_id: 'techdad', title: 'Sonaro WH-700 headphones pricey', price: 400, negotiable: true, condition: 'good' })
    await addListing({ id: 'hp-used-fair', seller_id: 'techdad', title: 'Sonaro WH-700 headphones worn', price: 250, negotiable: true, condition: 'fair' })
    await scanHeadphones()
    const pricey = matchOf('hp-used-pricey')!
    expect(pricey.status).toBe('mismatch')
    expect(pricey.verdict.reason).toMatch(/budget/i)
    const fair = matchOf('hp-used-fair')!
    expect(fair.status).toBe('mismatch')
    expect(fair.verdict.reason).toMatch(/condition/i)
  })

  it('14. stores Channel3 results as listings and matches them', async () => {
    search.mockResolvedValue({ data: [c3Product()] })
    const res = await scanHeadphones()
    const listing = fake.rows('listings').find((l) => l.source === 'channel3')!
    expect(listing).toMatchObject({ external_id: 'p_1', price: 299.5, negotiable: false })
    const m = matchOf(listing.id)!
    expect(m.status).toBe('agreed')
    expect(m.risk.level).not.toBe('high')
    expect(res.listingsFetched).toBe(1)
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: 'Sonaro WH-700 noise cancelling headphones', limit: 10 }))
  })

  it('16. failures are logged as messages only, never as whole error objects', async () => {
    const warn = vi.mocked(console.warn)
    await addListing({ id: 'hp-store-sale', seller_id: 'soundhouse', title: 'Sonaro WH-700 headphones sale', price: 289, negotiable: false, condition: 'new' })
    notifySpy.mockRejectedValue(Object.assign(new Error('notify boom'), { config: { headers: { Authorization: 'Bearer secret' } } }))
    vi.spyOn(integrations, 'searchProducts').mockRejectedValue(new Error('search boom'))
    vi.spyOn(ai, 'startNegotiation').mockRejectedValue(new Error('negotiation boom'))
    await scanHeadphones()
    const logged = warn.mock.calls.filter((c) => /notify|search|negotiation/.test(String(c.join(' '))))
    expect(logged.length).toBeGreaterThanOrEqual(3)
    for (const call of warn.mock.calls) for (const arg of call) expect(typeof arg).toBe('string')
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret')
  })

  it('15. respects the time budget', async () => {
    const res = await runScan({ wishlistItemId: 'wl-headphones', userId: DEMO_USER_ID, isCron: false, budgetMs: 0 })
    expect(matchSpy).not.toHaveBeenCalled()
    expect(res.itemsScanned).toBe(0)
    expect(fake.rows('matches')).toHaveLength(0)
  })
})

describe('runScan (generated demo listings)', () => {
  const newItem = (over: Row = {}) => ({
    id: 'wl-mouse', user_id: DEMO_USER_ID, title: 'Ergonomic vertical mouse', query: 'ergonomic vertical mouse', specs: '', max_price: 60, target_price: null,
    currency: 'USD', min_condition: 'good', dealbreakers: [], status: 'active', last_scanned_at: null, created_at: '2026-11-12T00:00:00.000Z', ...over,
  })
  const generated = () => fake.rows('listings').filter((l) => String(l.external_id).startsWith('gen:'))

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    // the accessory ("Protective case for ...") is not the wanted product; everything else matches
    matchSpy.mockImplementation(async (_item, listings) => listings.map((l) => ({ isMatch: !/^Protective case/.test(l.title), confidence: 0.95, reason: 'test', mismatches: [] })))
  })

  it('G1. a brand-new item gets generated listings and match rows for them; the accessory is a mismatch', async () => {
    await fake.from('wishlist_items').insert(newItem())
    await runScan({ wishlistItemId: 'wl-mouse', userId: DEMO_USER_ID, isCron: false })
    expect(generated()).toHaveLength(7)
    const rows = matchRows('wl-mouse')
    expect(rows).toHaveLength(7)
    const byExt = (slot: number) => generated().find((l) => l.external_id === `gen:wl-mouse:${slot}`)!
    expect(rows.find((m) => m.listing_id === byExt(6).id)!.status).toBe('mismatch')
    expect(rows.find((m) => m.listing_id === byExt(5).id)!.status).toBe('flagged')
    expect(rows.find((m) => m.listing_id === byExt(0).id)!.status).toBe('over_budget')
  })

  it('G2. scanning again does not generate again', async () => {
    await fake.from('wishlist_items').insert(newItem())
    await runScan({ wishlistItemId: 'wl-mouse', userId: DEMO_USER_ID, isCron: false })
    const ids = generated().map((l) => l.id).sort()
    await runScan({ wishlistItemId: 'wl-mouse', userId: DEMO_USER_ID, isCron: false })
    expect(generated().map((l) => l.id).sort()).toEqual(ids)
  })

  it('G3. a second user with the same query never sees the first item generated listings', async () => {
    await fake.from('wishlist_items').insert(newItem())
    await runScan({ wishlistItemId: 'wl-mouse', userId: DEMO_USER_ID, isCron: false })
    await fake.from('wishlist_items').insert(newItem({ id: 'wl-mouse-2', user_id: 'other-user' }))
    await runScan({ wishlistItemId: 'wl-mouse-2', userId: 'other-user', isCron: false })
    const ownIds = new Set(generated().filter((l) => l.external_id.startsWith('gen:wl-mouse:')).map((l) => l.id))
    expect(matchRows('wl-mouse-2').filter((m) => ownIds.has(m.listing_id))).toHaveLength(0)
    expect(generated().filter((l) => l.external_id.startsWith('gen:wl-mouse-2:'))).toHaveLength(7)
  })

  it('G4. seeded items with enough seeded matches generate nothing', async () => {
    await scanHeadphones()
    expect(generated()).toHaveLength(0)
  })
})
