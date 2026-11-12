import { describe, expect, it } from 'vitest'
import type { Channel3Api } from '@channel3/sdk'
import { normaliseProduct, safeUrl } from '~~/server/lib/integrations/channel3-normalise'

const product = (over: Partial<Channel3Api.Product> = {}): Channel3Api.Product => ({
  id: 'p_1',
  title: 'Over-ear ANC headphones',
  description: 'Wireless, 30h battery',
  key_features: ['Active noise cancelling', 'Bluetooth 5.3'],
  images: [{ url: 'https://img.test/side.jpg' }, { url: 'https://img.test/main.jpg', is_main_image: true }],
  offers: [
    { url: 'https://shop-a.test/p', domain: 'shop-a.test', price: { price: 329.99, currency: 'USD' }, availability: 'InStock', condition: 'new' },
    { url: 'https://shop-b.test/p', domain: 'shop-b.test', price: { price: 299.5, currency: 'USD' }, availability: 'InStock', condition: 'used' },
    { url: 'https://shop-c.test/p', domain: 'shop-c.test', price: { price: 199, currency: 'USD' }, availability: 'OutOfStock' },
    { url: 'https://shop-d.test/p', domain: 'shop-d.test', price: { price: 150, currency: 'EUR' }, availability: 'InStock' },
  ],
  ...over,
})

describe('normaliseProduct', () => {
  it('picks the cheapest in-stock USD offer', () => {
    expect(normaliseProduct(product())).toMatchObject({
      source: 'channel3', externalId: 'p_1', price: 299.5, currency: 'USD', retailer: 'shop-b.test',
      url: 'https://shop-b.test/p', condition: 'good', negotiable: false, imageUrl: 'https://img.test/main.jpg',
    })
  })
  it('returns null when nothing is buyable in USD', () => {
    expect(normaliseProduct(product({ offers: [] }))).toBeNull()
    expect(normaliseProduct(product({ offers: undefined }))).toBeNull()
  })
  it('includes key features in the description for the matcher', () => {
    expect(normaliseProduct(product())?.description).toContain('Active noise cancelling')
  })
  it('M5. offer urls other than http(s) are dropped: the offer is skipped', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'not a url', '', 'ftp://shop.test/p']) {
      const p = product({ offers: [{ url: bad, domain: 'evil.test', price: { price: 10, currency: 'USD' }, availability: 'InStock' }] })
      expect(normaliseProduct(p)).toBeNull()
    }
  })
  it('M5. a bad offer never wins over a good one, even when it is cheaper', () => {
    const p = product({
      offers: [
        { url: 'javascript:alert(1)', domain: 'evil.test', price: { price: 1, currency: 'USD' }, availability: 'InStock' },
        { url: 'https://shop-a.test/p', domain: 'shop-a.test', price: { price: 300, currency: 'USD' }, availability: 'InStock' },
      ],
    })
    expect(normaliseProduct(p)).toMatchObject({ price: 300, url: 'https://shop-a.test/p' })
  })
  it('M5. an unsafe image url becomes null, the product is kept', () => {
    const p = product({ images: [{ url: 'javascript:alert(1)', is_main_image: true }] })
    expect(normaliseProduct(p)).toMatchObject({ imageUrl: null })
  })
})

describe('safeUrl', () => {
  it('keeps http and https only', () => {
    expect(safeUrl('https://shop.test/p?a=1')).toBe('https://shop.test/p?a=1')
    expect(safeUrl('http://shop.test/p')).toBe('http://shop.test/p')
    for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'garbage', '', null, undefined, 42]) expect(safeUrl(bad)).toBeNull()
  })
})
