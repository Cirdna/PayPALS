import { afterEach, describe, expect, it } from 'vitest'
import type { Listing, Seller } from '#shared/types'
import { setModelForTests } from '~~/server/lib/ai/model'
import { startNegotiation } from '~~/server/lib/ai/negotiation'
import { assessRisk } from '~~/server/lib/ai/risk'
import { setDbForTests } from '~~/server/lib/db'
import { toCamel } from '~~/server/lib/mappers'
import { createFakeDb } from './fake-db'
import { mockFailingModel } from './mock-model'
import { expectedFor, seedTables } from './seed-fixture'

afterEach(() => { setDbForTests(null); setModelForTests('smart', null) })

describe('seed fixture end to end (database rows → real risk engine → negotiation)', () => {
  it('every seeded marketplace listing that should match gets its expected risk level through assessRisk()', async () => {
    const tables = seedTables()
    const fake = createFakeDb(tables)
    setDbForTests(fake)
    setModelForTests('smart', mockFailingModel()) // explanation falls back to the template; levels come from code
    for (const item of tables.wishlist_items!) {
      const rows = tables.listings!.filter((l) => l.id.startsWith(item.id === 'wl-headphones' ? 'hp-' : item.id === 'wl-handheld' ? 'hh-' : '--'))
      const compPrices = rows.filter((l) => expectedFor(l.id).match && !l.negotiable).map((l) => l.price)
      for (const row of rows.filter((l) => expectedFor(l.id).match)) {
        const listing = toCamel<Listing>(row)
        const seller = toCamel<Seller>(tables.sellers!.find((s) => s.id === row.seller_id)!)
        const opener = tables.listing_secrets!.find((s) => s.listing_id === row.id)!.scripted_messages['0'] ?? null
        const risk = await assessRisk({ listing, seller, compPrices, maxPrice: item.max_price, sellerOpener: opener })
        expect(risk.level, row.id).toBe(expectedFor(row.id).risk)
      }
    }
  })

  it('a seeded ready match can be negotiated', async () => {
    const fake = createFakeDb({ ...seedTables(), matches: [{ id: 'm1', wishlist_item_id: 'wl-headphones', listing_id: 'hp-used-ray', status: 'ready', best_price: 279 }] })
    setDbForTests(fake)
    const n = await startNegotiation('m1')
    expect(n.status).toBe('active')
    expect(fake.rows('negotiation_messages')[0]).toMatchObject({ role: 'seller', price: 279 })
  })
})
