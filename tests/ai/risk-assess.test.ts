import { afterEach, describe, expect, it } from 'vitest'
import type { Listing, Seller } from '#shared/types'
import { setModelForTests } from '~~/server/lib/ai/model'
import { assessRisk, hasDuplicateDescription } from '~~/server/lib/ai/risk'
import { setDbForTests } from '~~/server/lib/db'
import { createFakeDb } from '../helpers/fake-db'
import { countingJsonModel, mockFailingModel } from '../helpers/mock-model'

const SCAM_TEXT = 'Brand new sealed Sonaro WH-700 black with carrying case. Warehouse clearance, limited units, today only.'
const listing = (over: Partial<Listing> = {}): Listing => ({ id: 'l1', source: 'marketplace', externalId: 'k1', title: 'Sonaro WH-700 NEW', description: SCAM_TEXT, price: 89, currency: 'USD', condition: 'new', url: null, imageUrl: null, retailer: null, sellerId: 's1', negotiable: true, fetchedAt: '', ...over })
const scammer: Seller = { id: 's1', displayName: 'bargain_hub88', accountAgeDays: 6, rating: null, ratingCount: 0, isAgent: true }
const honest: Seller = { id: 's3', displayName: 'mei_audio', accountAgeDays: 910, rating: 4.9, ratingCount: 212, isAgent: true }
const comps = [349, 339.99, 359, 344.5]
const dbWith = (rows: Record<string, unknown>[]) => setDbForTests(createFakeDb({ listings: rows }))

afterEach(() => { setDbForTests(null); setModelForTests('smart', null) })

describe('hasDuplicateDescription', () => {
  it('finds the same text from a different seller, ignoring case and spacing', async () => {
    dbWith([{ id: 'l2', source: 'marketplace', seller_id: 's2', description: `  ${SCAM_TEXT.toUpperCase()}  ` }])
    expect(await hasDuplicateDescription(listing())).toBe(true)
  })
  it('ignores the same seller, other sources, retail listings and very short texts', async () => {
    dbWith([{ id: 'l2', source: 'marketplace', seller_id: 's1', description: SCAM_TEXT }, { id: 'l3', source: 'channel3', seller_id: null, description: SCAM_TEXT }])
    expect(await hasDuplicateDescription(listing())).toBe(false)
    expect(await hasDuplicateDescription(listing({ source: 'channel3', sellerId: null }))).toBe(false)
    dbWith([{ id: 'l2', source: 'marketplace', seller_id: 's2', description: 'Good condition.' }])
    expect(await hasDuplicateDescription(listing({ description: 'Good condition.' }))).toBe(false)
  })
})

describe('assessRisk', () => {
  it('high risk: computed signals plus an LLM explanation', async () => {
    dbWith([{ id: 'l2', source: 'marketplace', seller_id: 's2', description: SCAM_TEXT }])
    const m = countingJsonModel([{ explanation: 'The price is far below retail and the seller account is brand new. The same text is used by another seller.' }]); setModelForTests('smart', m.model)
    const r = await assessRisk({ listing: listing(), seller: scammer, compPrices: comps, maxPrice: 300, sellerOpener: 'Pay deposit of $40 by bank transfer today' })
    expect(r.level).toBe('high')
    expect(r.signals.map((s) => s.code)).toEqual(expect.arrayContaining(['price_anomaly', 'duplicate_text', 'deposit_request', 'off_platform_payment']))
    expect(r.explanation).toMatch(/far below retail/)
    expect(m.calls()).toBe(1)
  })
  it('low risk: no LLM call, template explanation', async () => {
    dbWith([])
    const m = countingJsonModel([{ explanation: 'unused unused unused' }]); setModelForTests('smart', m.model)
    const r = await assessRisk({ listing: listing({ price: 285, condition: 'good', description: 'Good condition with case.', sellerId: 's3' }), seller: honest, compPrices: comps, maxPrice: 300 })
    expect(r).toMatchObject({ level: 'low', score: 0, explanation: 'No risk signals found.' })
    expect(m.calls()).toBe(0)
  })
  it('falls back to the template when the explanation model fails', async () => {
    dbWith([])
    setModelForTests('smart', mockFailingModel())
    const r = await assessRisk({ listing: listing(), seller: scammer, compPrices: comps, maxPrice: 300 })
    expect(r.level).toBe('high')
    expect(r.explanation).toMatch(/^High risk: /)
  })
})
