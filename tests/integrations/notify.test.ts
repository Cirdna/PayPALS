import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setDbForTests } from '~~/server/lib/db'
import { notifyDeal } from '~~/server/lib/integrations/notify'
import { createFakeDb, type FakeDb } from '../helpers/fake-db'
import { DEMO_USER_ID, seedTables } from '../helpers/seed-fixture'

process.env.APP_URL = 'https://app.test'
process.env.TELEGRAM_BOT_TOKEN = 'test-token'

let fake: FakeDb
let fetchMock: ReturnType<typeof vi.fn>

const setup = (opts: { chat?: number | null; status?: string } = {}) => {
  const tables = seedTables()
  tables.profiles[0]!.telegram_chat_id = opts.chat === undefined ? 555 : opts.chat
  tables.matches = [{
    id: 'm1', wishlist_item_id: 'wl-headphones', listing_id: 'hp-used-ray', status: opts.status ?? 'agreed',
    verdict: null, best_price: 262, notified_at: null,
    risk: { score: 5, level: 'low', signals: [], priceStats: null, explanation: 'No significant risk signals.' },
  }]
  fake = createFakeDb(tables)
  setDbForTests(fake)
}

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} })))
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  setDbForTests(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('notifyDeal', () => {
  it('notifies a linked user once: match notified, one sendMessage, deal_notified event', async () => {
    setup()
    expect(await notifyDeal('m1')).toBe(true)
    const m = fake.rows('matches')[0]!
    expect(m.status).toBe('notified')
    expect(m.notified_at).toBeTruthy()
    const calls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/sendMessage'))
    expect(calls).toHaveLength(1)
    expect(JSON.parse((calls[0]![1] as RequestInit).body as string).chat_id).toBe(555)
    const events = fake.rows('agent_events').filter((e) => e.type === 'deal_notified')
    expect(events).toHaveLength(1)
    expect(events[0]!.user_id).toBe(DEMO_USER_ID)
  })

  it('second call returns false and sends nothing more', async () => {
    setup()
    await notifyDeal('m1')
    fetchMock.mockClear()
    expect(await notifyDeal('m1')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('user without Telegram: true, notified, no fetch', async () => {
    setup({ chat: null })
    expect(await notifyDeal('m1')).toBe(true)
    expect(fake.rows('matches')[0]!.status).toBe('notified')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('match not agreed: false, nothing changes', async () => {
    setup({ status: 'ready' })
    expect(await notifyDeal('m1')).toBe(false)
    expect(fake.rows('matches')[0]!.status).toBe('ready')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Telegram failure still returns true and keeps the match notified', async () => {
    setup()
    fetchMock.mockRejectedValue(new Error('network down'))
    expect(await notifyDeal('m1')).toBe(true)
    expect(fake.rows('matches')[0]!.status).toBe('notified')
  })

  it('loading the listing fails after the claim: still true, sanitised warning, deal_notified event logged', async () => {
    setup()
    const realFrom = fake.from.bind(fake)
    vi.spyOn(fake, 'from').mockImplementation((t: string) => {
      if (t === 'listings') throw Object.assign(new Error('db exploded'), { secret: 'hunter2' })
      return realFrom(t)
    })
    expect(await notifyDeal('m1')).toBe(true)
    expect(fake.rows('matches')[0]!.status).toBe('notified')
    const events = fake.rows('agent_events').filter((e) => e.type === 'deal_notified')
    expect(events).toHaveLength(1)
    expect(events[0]!.user_id).toBe(DEMO_USER_ID)
    const warn = vi.mocked(console.warn)
    expect(warn).toHaveBeenCalled()
    for (const call of warn.mock.calls) for (const arg of call) expect(typeof arg).toBe('string')
    expect(warn.mock.calls.flat().join(' ')).not.toContain('hunter2')
  })
})
