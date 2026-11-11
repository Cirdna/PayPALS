import { describe, expect, it } from 'vitest'
import type { Listing, Seller } from '#shared/types'
import { normaliseDescription, riskText, scoreRisk, templateExplanation, type RiskInput } from '~~/server/lib/ai/risk/rules'
import { mad, median, priceStats } from '~~/server/lib/ai/risk/stats'
import seed from '~~/supabase/seed/data.json'

type SeedListing = (typeof seed.listings)[number]
const sellerOf = (l: SeedListing): Seller => {
  const s = seed.sellers.find((x) => x.slug === l.sellerSlug)!
  return { id: s.slug, displayName: s.displayName, accountAgeDays: s.accountAgeDays, rating: s.rating, ratingCount: s.ratingCount, isAgent: true }
}
const toListing = (l: SeedListing): Listing => ({
  id: l.key, source: 'marketplace', externalId: l.key, title: l.title, description: l.description, price: l.price, currency: 'USD',
  condition: l.condition as Listing['condition'], url: null, imageUrl: null, retailer: null, sellerId: l.sellerSlug, negotiable: l.negotiable, fetchedAt: '2026-11-12T00:00:00Z',
})
/** Builds the exact input the scan pipeline will build for a seeded listing. */
const inputFor = (l: SeedListing): { input: RiskInput; duplicateFound: boolean } => {
  const wish = seed.wishlist.find((w) => w.key === l.theme)!
  const compPrices = seed.listings.filter((x) => x.theme === l.theme && x.expected.match && !x.negotiable).map((x) => x.price)
  const duplicateFound = seed.listings.some((x) => x.key !== l.key && x.sellerSlug !== l.sellerSlug && normaliseDescription(x.description) === normaliseDescription(l.description))
  return { input: { listing: toListing(l), seller: sellerOf(l), compPrices, maxPrice: wish.maxPrice, sellerOpener: (l.scriptedMessages as Record<string, string>)['0'] ?? null }, duplicateFound }
}

describe('stats', () => {
  it('median and mad', () => {
    expect(median([349, 339.99, 359, 344.5])).toBe(346.75)
    expect(median([3, 1, 2])).toBe(2)
    expect(mad([1, 2, 3, 4, 100])).toBe(1)
  })
  it('priceStats needs 3 comps and handles zero spread', () => {
    expect(priceStats(100, [300, 310])).toBeNull()
    expect(priceStats(89, [349, 339.99, 359, 344.5])).toMatchObject({ compsCount: 4, median: 346.75, pctOfMedian: 0.257 })
    expect(priceStats(100, [200, 200, 200])!.robustZ).toBe(0)
  })
})

describe('scoreRisk against every seeded listing', () => {
  for (const l of seed.listings.filter((x) => x.expected.match && x.negotiable)) {
    it(`${l.key} → ${l.expected.risk}`, () => {
      const { input, duplicateFound } = inputFor(l)
      const r = scoreRisk(input, duplicateFound)
      expect(r.level, JSON.stringify(r.signals.map((s) => [s.code, s.weight]))).toBe(l.expected.risk)
      const text = riskText(input)
      for (const s of r.signals) if (s.evidence !== null) expect(text.includes(s.evidence), `${s.code}: ${s.evidence}`).toBe(true)
    })
  }
  it('stores (fixed price, new) are low risk', () => {
    for (const l of seed.listings.filter((x) => x.expected.match && !x.negotiable)) {
      const { input, duplicateFound } = inputFor(l)
      expect(scoreRisk(input, duplicateFound).level, l.key).toBe('low')
    }
  })
})

describe('scoreRisk details', () => {
  const get = (key: string) => inputFor(seed.listings.find((l) => l.key === key)!)
  const codes = (key: string) => { const { input, duplicateFound } = get(key); return scoreRisk(input, duplicateFound).signals.map((s) => s.code) }

  it('the deposit scam carries every expected signal with quoted evidence', () => {
    const { input, duplicateFound } = get('hp-scam-bargain')
    const r = scoreRisk(input, duplicateFound)
    expect(r.score).toBe(100)
    expect(r.signals.map((s) => s.code)).toEqual(expect.arrayContaining(['price_anomaly', 'off_platform_payment', 'deposit_request', 'suspicious_link', 'urgency_pressure', 'duplicate_text', 'new_account', 'low_rating']))
    expect(r.signals.find((s) => s.code === 'off_platform_payment')!.evidence).toBe('bank transfer')
    expect(r.signals.find((s) => s.code === 'suspicious_link')!.evidence).toBe('http://bit.ly/sg-courier-track')
    expect(r.signals[0]!.weight).toBeGreaterThanOrEqual(r.signals.at(-1)!.weight) // sorted, strongest first
  })
  it('"Payment through the platform only" is not an off-platform signal', () => {
    expect(codes('hp-used-ray')).toEqual([])
  })
  it('a pushy but honest seller only gets the urgency signal', () => {
    expect(codes('hp-used-gadgetflip')).toEqual(['urgency_pressure'])
  })
  it('falls back to the wishlist maximum when there are fewer than 3 comps', () => {
    const { input } = get('hp-used-mei')
    const cheap = scoreRisk({ ...input, compPrices: [349], listing: { ...input.listing, price: 60 } }, false)
    expect(cheap.priceStats).toBeNull()
    expect(cheap.signals.map((s) => s.code)).toEqual(['price_anomaly'])
    expect(cheap.signals[0]!.weight).toBe(20)
    expect(scoreRisk({ ...input, compPrices: [] }, false).signals).toEqual([])
  })
  it('seller signals are skipped for retail offers without a seller', () => {
    const { input } = get('hp-scam-quickdeals')
    expect(scoreRisk({ ...input, seller: null }, false).signals.map((s) => s.code)).not.toContain('new_account')
  })
  it('flags "new" listings that describe wear', () => {
    const { input } = get('hp-store-sonaro')
    const r = scoreRisk({ ...input, listing: { ...input.listing, description: 'Brand new, a few scratches on the cup.' } }, false)
    expect(r.signals.map((s) => s.code)).toEqual(['condition_mismatch'])
  })
  it('templateExplanation lists the signals', () => {
    const { input, duplicateFound } = get('hp-scam-bargain')
    expect(templateExplanation(scoreRisk(input, duplicateFound))).toMatch(/^High risk: .*outside the platform/)
    expect(templateExplanation(scoreRisk(get('hp-used-ray').input, false))).toBe('No significant risk signals.')
  })
})
