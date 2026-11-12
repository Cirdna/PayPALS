import { existsSync, readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel3Api } from '@channel3/sdk'
import { searchProducts, setChannel3ClientForTests, setRetryDelayForTests } from '~~/server/lib/integrations/channel3'

const product = (over: Partial<Channel3Api.Product> = {}): Channel3Api.Product => ({
  id: 'p_1',
  title: 'Over-ear ANC headphones',
  description: 'Wireless, 30h battery',
  key_features: ['Active noise cancelling'],
  images: [{ url: 'https://img.test/main.jpg', is_main_image: true }],
  offers: [{ url: 'https://shop-a.test/p', domain: 'shop-a.test', price: { price: 299.5, currency: 'USD' }, availability: 'InStock', condition: 'new' }],
  ...over,
})
const noOffers = product({ id: 'p_2', offers: [{ url: 'https://x.test', domain: 'x.test', price: { price: 10, currency: 'EUR' }, availability: 'InStock' }] })

const fakeClient = (search = vi.fn(async () => ({ data: [product(), noOffers] }))) => ({ products: { search } }) as any

beforeEach(() => setRetryDelayForTests(0))
afterEach(() => {
  setChannel3ClientForTests(null)
  setRetryDelayForTests(1000)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('searchProducts', () => {
  it('returns normalised drafts and drops products without a USD in-stock offer', async () => {
    setChannel3ClientForTests(fakeClient())
    const drafts = await searchProducts('headphones')
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ source: 'channel3', externalId: 'p_1', price: 299.5, negotiable: false })
  })

  it('passes query, default limit 10 and the availability filter to the SDK', async () => {
    const search = vi.fn(async () => ({ data: [] as Channel3Api.Product[] }))
    setChannel3ClientForTests(fakeClient(search))
    await searchProducts('headphones')
    expect(search).toHaveBeenCalledWith({ query: 'headphones', limit: 10, filters: { availability: ['InStock'] } })
    await searchProducts('headphones', { limit: 3 })
    expect(search).toHaveBeenLastCalledWith({ query: 'headphones', limit: 3, filters: { availability: ['InStock'] } })
  })

  it('serves the same query from cache within 10 minutes, then refetches', async () => {
    vi.useFakeTimers()
    const search = vi.fn(async () => ({ data: [product()] }))
    setChannel3ClientForTests(fakeClient(search))
    await searchProducts('headphones')
    await searchProducts('headphones')
    expect(search).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10 * 60_000 + 1)
    await searchProducts('headphones')
    expect(search).toHaveBeenCalledTimes(2)
  })

  it('retries once when the first call rejects', async () => {
    const search = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ data: [product()] })
    setChannel3ClientForTests(fakeClient(search))
    const drafts = await searchProducts('headphones')
    expect(drafts).toHaveLength(1)
    expect(search).toHaveBeenCalledTimes(2)
  })

  it('returns [] (never throws) when both attempts fail, and does not cache the failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const search = vi.fn().mockRejectedValue(new Error('down'))
    setChannel3ClientForTests(fakeClient(search))
    await expect(searchProducts('headphones')).resolves.toEqual([])
    expect(search).toHaveBeenCalledTimes(2)
    search.mockResolvedValue({ data: [product()] })
    await expect(searchProducts('headphones')).resolves.toHaveLength(1)
    expect(search).toHaveBeenCalledTimes(3)
  })

  const fixture = new URL('./fixtures/channel3-keyboard.json', import.meta.url)
  it.skipIf(!existsSync(fixture))('turns the recorded keyboard response into channel3 drafts', async () => {
    const data = JSON.parse(readFileSync(fixture, 'utf8')) as Channel3Api.Product[]
    setChannel3ClientForTests(fakeClient(vi.fn(async () => ({ data }))))
    const drafts = await searchProducts('75% hot-swappable wireless mechanical keyboard')
    expect(drafts.length).toBeGreaterThanOrEqual(1)
    for (const d of drafts) {
      expect(d.source).toBe('channel3')
      expect(d.price).toBeGreaterThan(0)
    }
  })
})
