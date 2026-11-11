import { afterEach, describe, expect, it } from 'vitest'
import { ownerOfMatch, ownerOfNegotiation } from '~~/server/lib/ai/ownership'
import { setDbForTests } from '~~/server/lib/db'
import { createFakeDb } from '../helpers/fake-db'

afterEach(() => setDbForTests(null))

describe('ownership', () => {
  it('resolves the owner through the wishlist item, and null for unknown ids', async () => {
    setDbForTests(createFakeDb({
      wishlist_items: [{ id: 'w1', user_id: 'u1' }],
      matches: [{ id: 'm1', wishlist_item_id: 'w1', listing_id: 'l1', status: 'ready' }],
      negotiations: [{ id: 'n1', match_id: 'm1', status: 'active' }],
    }))
    expect(await ownerOfMatch('m1')).toBe('u1')
    expect(await ownerOfNegotiation('n1')).toBe('u1')
    expect(await ownerOfMatch('nope')).toBeNull()
    expect(await ownerOfNegotiation('nope')).toBeNull()
  })
})
