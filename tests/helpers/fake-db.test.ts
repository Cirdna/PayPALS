import { afterEach, describe, expect, it } from 'vitest'
import { db, setDbForTests, unwrap } from '~~/server/lib/db'
import { logEvent } from '~~/server/lib/events'
import { toCamel } from '~~/server/lib/mappers'
import { createFakeDb } from './fake-db'

afterEach(() => setDbForTests(null))

describe('createFakeDb', () => {
  it('selects with filters, order and limit', async () => {
    const fake = createFakeDb({ wishlist_items: [
      { id: 'a', status: 'active', last_scanned_at: '2026-11-11T10:00:00Z' },
      { id: 'b', status: 'active', last_scanned_at: null },
      { id: 'c', status: 'paused', last_scanned_at: null },
      { id: 'd', status: 'active', last_scanned_at: '2026-11-11T09:00:00Z' },
    ] })
    const { data } = await fake.from('wishlist_items').select('*').eq('status', 'active').order('last_scanned_at', { ascending: true, nullsFirst: true }).limit(2)
    expect(data!.map((r: any) => r.id)).toEqual(['b', 'd'])
  })

  it('insert returns data only with .select(), fills id/timestamps/defaults, and enforces unique constraints', async () => {
    const fake = createFakeDb()
    const silent = await fake.from('matches').insert({ wishlist_item_id: 'w1', listing_id: 'l1', status: 'ready' })
    expect(silent).toEqual({ data: null, error: null })
    const dup = await fake.from('matches').insert({ wishlist_item_id: 'w1', listing_id: 'l1', status: 'ready' }).select().single()
    expect(dup.error?.code).toBe('23505')
    const ok = await fake.from('negotiations').insert({ match_id: 'm1' }).select().single()
    expect(ok.data).toMatchObject({ match_id: 'm1', status: 'active', round: 0, max_rounds: 6 })
    expect(ok.data!.id).toBeTruthy()
    expect(ok.data!.created_at).toBeTruthy()
  })

  it('messages inserted one after another keep their order by created_at', async () => {
    const fake = createFakeDb()
    for (const m of ['one', 'two', 'three']) await fake.from('negotiation_messages').insert({ negotiation_id: 'n1', round: 1, role: 'buyer', action: 'offer', message: m })
    const { data } = await fake.from('negotiation_messages').select('*').eq('negotiation_id', 'n1').order('created_at')
    expect(data!.map((r: any) => r.message)).toEqual(['one', 'two', 'three'])
  })

  it('update, upsert and delete', async () => {
    const fake = createFakeDb({ listings: [{ id: 'l1', source: 'channel3', external_id: 'p1', price: 100 }] })
    await fake.from('listings').upsert([{ source: 'channel3', external_id: 'p1', price: 90 }, { source: 'channel3', external_id: 'p2', price: 50 }], { onConflict: 'source,external_id' })
    expect(fake.rows('listings').map((r) => [r.external_id, r.price])).toEqual([['p1', 90], ['p2', 50]])
    const upd = await fake.from('listings').update({ price: 80 }).eq('id', 'l1').select()
    expect(upd.data).toHaveLength(1)
    await fake.from('listings').delete().eq('external_id', 'p2')
    expect(fake.rows('listings')).toHaveLength(1)
    expect((await fake.from('listings').select('*').eq('id', 'nope').maybeSingle()).data).toBeNull()
    expect((await fake.from('listings').select('*').eq('id', 'nope').single()).error).toBeTruthy()
  })

  it('claim_negotiation gives the lock to one caller until it expires or is released', async () => {
    const fake = createFakeDb({ negotiations: [{ id: 'n1', match_id: 'm1', status: 'active', round: 0, locked_until: null }] })
    expect((await fake.rpc('claim_negotiation', { p_id: 'n1', p_lock_seconds: 45 })).data).toHaveLength(1)
    expect((await fake.rpc('claim_negotiation', { p_id: 'n1', p_lock_seconds: 45 })).data).toHaveLength(0)
    fake.advance(46_000)
    expect((await fake.rpc('claim_negotiation', { p_id: 'n1' })).data).toHaveLength(1)
    await fake.from('negotiations').update({ locked_until: null }).eq('id', 'n1')
    expect((await fake.rpc('claim_negotiation', { p_id: 'n1' })).data).toHaveLength(1)
    await fake.from('negotiations').update({ status: 'agreed', locked_until: null }).eq('id', 'n1')
    expect((await fake.rpc('claim_negotiation', { p_id: 'n1' })).data).toHaveLength(0)
  })

  it('claim_deal_notification succeeds exactly once', async () => {
    const fake = createFakeDb({ matches: [{ id: 'm1', status: 'agreed', notified_at: null }] })
    expect((await fake.rpc('claim_deal_notification', { p_match_id: 'm1' })).data).toHaveLength(1)
    expect((await fake.rpc('claim_deal_notification', { p_match_id: 'm1' })).data).toHaveLength(0)
    expect(fake.rows('matches')[0]).toMatchObject({ status: 'notified' })
    expect(fake.rows('matches')[0]!.notified_at).toBeTruthy()
  })

  it('works through db(), unwrap(), toCamel() and logEvent()', async () => {
    const fake = createFakeDb({ mandates: [{ id: 'md1', wishlist_item_id: 'w1', max_amount: '300.00', expires_at: '2026-11-26T00:00:00Z' }] })
    setDbForTests(fake)
    const row = unwrap(await db().from('mandates').select('*').eq('wishlist_item_id', 'w1').single(), 'load mandate')
    expect(toCamel<{ maxAmount: number; wishlistItemId: string }>(row)).toMatchObject({ maxAmount: 300, wishlistItemId: 'w1' })
    await logEvent({ userId: 'u1', type: 'deal_agreed', message: 'Agreed $262', matchId: 'm1' })
    expect(fake.rows('agent_events')[0]).toMatchObject({ user_id: 'u1', type: 'deal_agreed', match_id: 'm1', payload: {} })
  })
})
