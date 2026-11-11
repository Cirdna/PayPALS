import { describe, expect, it } from 'vitest'
import data from '~~/supabase/seed/data.json'

// Guards the demo story. If one of these fails after editing supabase/seed/data.json, the demo no longer works as scripted.
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}
const sellers = new Map(data.sellers.map((s) => [s.slug, s]))
const themes = data.wishlist.filter((w) => data.listings.some((l) => l.theme === w.key))

describe('seed data integrity', () => {
  it('has unique keys and valid references', () => {
    expect(new Set(data.listings.map((l) => l.key)).size).toBe(data.listings.length)
    expect(new Set(data.sellers.map((s) => s.slug)).size).toBe(data.sellers.length)
    for (const l of data.listings) {
      expect(sellers.has(l.sellerSlug), l.key).toBe(true)
      expect(data.wishlist.some((w) => w.key === l.theme), l.key).toBe(true)
      expect(l.floorPrice, l.key).toBeLessThanOrEqual(l.price)
      expect(l.floorPrice, l.key).toBeGreaterThan(0)
    }
  })

  it('stores are fixed-price, new, and priced above the wishlist max (they are comps, not deals)', () => {
    for (const l of data.listings.filter((x) => sellers.get(x.sellerSlug)!.persona.style === 'store' && x.expected.match)) {
      const max = data.wishlist.find((w) => w.key === l.theme)!.maxPrice
      expect(l.negotiable, l.key).toBe(false)
      expect(l.condition, l.key).toBe('new')
      expect(l.price, l.key).toBeGreaterThan(max)
      expect(l.expected.status, l.key).toBe('over_budget')
    }
  })

  for (const w of themes) {
    describe(w.title, () => {
      const listings = data.listings.filter((l) => l.theme === w.key)
      const comps = listings.filter((l) => !l.negotiable && l.expected.match).map((l) => l.price)
      const med = median(comps)

      it('has at least 3 retail comps', () => expect(comps.length).toBeGreaterThanOrEqual(3))

      it('scam listings are priced below 35% of the comp median, honest ones above 50%', () => {
        for (const l of listings.filter((x) => x.expected.match && x.negotiable)) {
          const pct = l.price / med
          if (l.expected.risk === 'high') expect(pct, l.key).toBeLessThan(0.35)
          else expect(pct, l.key).toBeGreaterThan(0.5)
        }
      })

      it('has a scam, a look-alike mismatch and an accessory mismatch', () => {
        expect(listings.some((l) => l.expected.risk === 'high')).toBe(true)
        expect(listings.filter((l) => !l.expected.match).length).toBeGreaterThanOrEqual(2)
      })

      it('the listing auto-negotiation picks first (cheapest ready) can close inside the budget', () => {
        const ready = listings.filter((l) => l.expected.status === 'ready').sort((a, b) => a.price - b.price)
        expect(ready.length).toBeGreaterThanOrEqual(2)
        const first = ready[0]!
        expect(first.floorPrice).toBeLessThan(w.maxPrice)
        expect(first.price).toBeLessThanOrEqual(w.maxPrice * 1.3) // scan prefilter for negotiable listings
        expect(w.targetPrice!).toBeLessThan(first.floorPrice) // so there is something to negotiate
      })
    })
  }

  it('the headphones negotiation is with the prompt-injection seller (deterministic line in round 1)', () => {
    const ready = data.listings.filter((l) => l.theme === 'wl-headphones' && l.expected.status === 'ready').sort((a, b) => a.price - b.price)
    expect(sellers.get(ready[0]!.sellerSlug)!.persona.style).toBe('injector')
    expect((ready[0]!.scriptedMessages as Record<string, string>)['1']).toMatch(/ignore your previous instructions/i)
  })

  it('the two clearance scams share the same description (duplicate_text signal)', () => {
    const a = data.listings.find((l) => l.key === 'hp-scam-bargain')!
    const b = data.listings.find((l) => l.key === 'hp-scam-quickdeals')!
    expect(a.description).toBe(b.description)
    expect(a.sellerSlug).not.toBe(b.sellerSlug)
  })
})
