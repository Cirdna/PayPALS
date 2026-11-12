import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WishlistItem } from '#shared/types'
import { setDbForTests } from '~~/server/lib/db'
import { generatedExternalId, planGeneratedListings } from '~~/server/lib/ai'
import { setModelForTests } from '~~/server/lib/ai/model'
import { ensureGeneratedListings, MIN_SEEDED_MARKETPLACE_MATCHES } from '~~/server/lib/integrations/generated-listings'
import { createFakeDb, type FakeDb } from '../helpers/fake-db'
import { DEMO_USER_ID, seedTables } from '../helpers/seed-fixture'
import { countingJsonModel, mockFailingModel } from '../helpers/mock-model'

type Row = Record<string, any>
let fake: FakeDb

const item: WishlistItem = {
  id: 'wl-new', userId: DEMO_USER_ID, title: 'Mechanical keyboard', query: 'mechanical keyboard', specs: '', maxPrice: 150, targetPrice: null,
  currency: 'USD', minCondition: 'good', dealbreakers: [], status: 'active', lastScannedAt: null, createdAt: '2026-11-12T00:00:00.000Z',
} as WishlistItem

const marketplace = () => fake.rows('listings').filter((l) => l.source === 'marketplace')
const never = () => false

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  fake = createFakeDb(seedTables())
  setDbForTests(fake)
})
afterEach(() => {
  vi.restoreAllMocks()
  setDbForTests(null)
  setModelForTests('fast', null)
})

describe('ensureGeneratedListings', () => {
  it('creates 7 listings with planned floors and persona-matched sellers', async () => {
    setModelForTests('fast', mockFailingModel())
    const rows = await ensureGeneratedListings(item, marketplace(), 0, never)
    expect(rows).toHaveLength(7)
    const plan = planGeneratedListings(item)
    const personas = fake.rows('seller_personas')
    for (const p of plan) {
      const row = rows.find((r) => r.external_id === generatedExternalId(item.id, p.slot))!
      expect(row, `slot ${p.slot}`).toBeTruthy()
      expect(row).toMatchObject({ source: 'marketplace', price: p.price, negotiable: p.negotiable, condition: p.condition, url: null })
      const secret = fake.rows('listing_secrets').find((s) => s.listing_id === row.id)!
      expect(secret.floor_price).toBe(p.floorPrice)
      expect(secret.scripted_messages).toEqual(p.opener ? { '0': p.opener } : {})
      expect(personas.find((x) => x.seller_id === row.seller_id)!.style).toBe(p.sellerStyle)
    }
    expect(fake.rows('listing_secrets').filter((s) => rows.some((r) => r.id === s.listing_id))).toHaveLength(7)
  })

  it('is once per item: a second call returns the same rows with no LLM call and no duplicates', async () => {
    const { model, calls } = countingJsonModel([{ listings: [] }])
    setModelForTests('fast', model)
    const first = await ensureGeneratedListings(item, marketplace(), 0, never)
    const afterFirst = calls()
    expect(afterFirst).toBe(1)
    const second = await ensureGeneratedListings(item, marketplace(), 0, never)
    expect(calls()).toBe(afterFirst)
    expect(second.map((r) => r.id).sort()).toEqual(first.map((r) => r.id).sort())
    expect(marketplace().filter((l) => l.external_id.startsWith('gen:'))).toHaveLength(7)
  })

  it('returns [] when enough seeded listings match', async () => {
    const { model, calls } = countingJsonModel([{ listings: [] }])
    setModelForTests('fast', model)
    expect(MIN_SEEDED_MARKETPLACE_MATCHES).toBe(3)
    expect(await ensureGeneratedListings(item, marketplace(), 3, never)).toEqual([])
    expect(calls()).toBe(0)
    expect(marketplace().some((l) => l.external_id.startsWith('gen:'))).toBe(false)
  })

  it('returns [] when over budget', async () => {
    const { model, calls } = countingJsonModel([{ listings: [] }])
    setModelForTests('fast', model)
    expect(await ensureGeneratedListings(item, marketplace(), 0, () => true)).toEqual([])
    expect(calls()).toBe(0)
  })

  it('returns [] and warns when there are no seller personas', async () => {
    setModelForTests('fast', mockFailingModel())
    fake = createFakeDb({ ...seedTables(), seller_personas: [] })
    setDbForTests(fake)
    expect(await ensureGeneratedListings(item, marketplace(), 0, never)).toEqual([])
    expect(console.warn).toHaveBeenCalled()
  })

  it('falls back to any friendly seller when a style has no sellers', async () => {
    setModelForTests('fast', mockFailingModel())
    const personas = seedTables().seller_personas!.filter((p: Row) => p.style !== 'scammer')
    fake = createFakeDb({ ...seedTables(), seller_personas: personas })
    setDbForTests(fake)
    const rows = await ensureGeneratedListings(item, marketplace(), 0, never)
    expect(rows).toHaveLength(7)
    const scam = rows.find((r) => r.external_id === generatedExternalId(item.id, 5))!
    expect(personas.find((p: Row) => p.seller_id === scam.seller_id)!.style).toBe('friendly')
  })
})
