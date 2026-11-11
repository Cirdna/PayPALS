import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Listing, Match, WishlistItem } from '#shared/types'
import { setDbForTests } from '~~/server/lib/db'
import { toCamel } from '~~/server/lib/mappers'
import { integrations } from '~~/server/lib/integrations'
import { CheckoutError } from '~~/server/lib/integrations/checkout'
import { dealMessage, escapeHtml, handleUpdate, receiptMessage, tg } from '~~/server/lib/integrations/telegram'
import { createFakeDb, type FakeDb } from '../helpers/fake-db'
import { DEMO_USER_ID, seedTables } from '../helpers/seed-fixture'

process.env.APP_URL = 'https://app.test'
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.TELEGRAM_WEBHOOK_SECRET = 'hook-secret'

const MATCH_ID = 'm1'
const CHAT = 555

const matchRow = () => ({
  id: MATCH_ID, wishlist_item_id: 'wl-headphones', listing_id: 'hp-used-ray', status: 'notified',
  verdict: null, best_price: 262, notified_at: '2026-11-12T00:00:00.000Z',
  risk: { score: 5, level: 'low', signals: [], priceStats: null, explanation: 'No significant risk signals.' },
})

let fake: FakeDb
let fetchMock: ReturnType<typeof vi.fn>
const sent = (method: string) => fetchMock.mock.calls
  .filter(([url]) => String(url).endsWith(`/${method}`))
  .map(([, init]) => JSON.parse((init as RequestInit).body as string))

beforeEach(() => {
  const tables = seedTables()
  tables.matches = [matchRow()]
  fake = createFakeDb(tables)
  setDbForTests(fake)
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} })))
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  setDbForTests(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const listingRow = (id: string) => fake.rows('listings').find((r) => r.id === id)!
const getItem = () => toCamel<WishlistItem>(fake.rows('wishlist_items').find((r) => r.id === 'wl-headphones')!)
const getMatch = () => toCamel<Match>(fake.rows('matches')[0]!)
const marketplaceListing = (): Listing => toCamel<Listing>(listingRow('hp-used-ray'))
const channel3Listing = (): Listing => ({ ...marketplaceListing(), id: 'c3', source: 'channel3', url: 'https://shop.example/p/1', negotiable: false })
const linkProfile = async () => {
  await fake.from('profiles').update({ telegram_chat_id: CHAT }).eq('id', DEMO_USER_ID)
}

describe('escapeHtml', () => {
  it('escapes & < >', () => expect(escapeHtml('<b>&')).toBe('&lt;b&gt;&amp;'))
})

describe('tg', () => {
  it('posts JSON to the bot API', async () => {
    await tg('sendMessage', { chat_id: 1 })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage')
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ chat_id: 1 })
  })

  it('rejects when Telegram answers ok:false', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: 'x' }), { status: 400 }))
    await expect(tg('sendMessage', {})).rejects.toThrow('x')
  })

  it('never leaks the token in the error when fetch itself fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom https://api.telegram.org/bottest-token/sendMessage'))
    const err = await tg('sendMessage', {}).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain('test-token')
  })
})

describe('dealMessage', () => {
  it('marketplace: shows prices, risk and the pay/skip/view keyboard', () => {
    const m = dealMessage({ listing: marketplaceListing(), item: getItem(), match: getMatch() })
    expect(m.text).toContain(escapeHtml(marketplaceListing().title))
    expect(m.text).toContain(escapeHtml(getItem().title))
    expect(m.text).toContain('$279.00') // list price of hp-used-ray
    expect(m.text).toContain('$17.00') // saving 279 - 262
    expect(m.text).toContain('$262.00')
    expect(m.text).toContain('LOW')
    const kb = m.reply_markup.inline_keyboard.flat() as { callback_data?: string; url?: string }[]
    expect(kb.some((b) => b.callback_data === `pay:${MATCH_ID}`)).toBe(true)
    expect(kb.some((b) => b.callback_data === `skip:${MATCH_ID}`)).toBe(true)
    expect(kb.some((b) => b.url === `https://app.test/deals/${MATCH_ID}`)).toBe(true)
  })

  it('channel3: first button is Buy at retailer, no pay button', () => {
    const m = dealMessage({ listing: channel3Listing(), item: getItem(), match: getMatch() })
    const first = m.reply_markup.inline_keyboard[0]![0] as { text: string; url?: string }
    expect(first.url).toBe('https://shop.example/p/1')
    expect(first.text).toContain('Buy at retailer')
    const kb = m.reply_markup.inline_keyboard.flat() as { callback_data?: string }[]
    expect(kb.some((b) => b.callback_data?.startsWith('pay:'))).toBe(false)
  })

  it('escapes HTML in titles', () => {
    const m = dealMessage({ listing: { ...marketplaceListing(), title: 'Evil <script>x</script> & co' }, item: getItem(), match: getMatch() })
    expect(m.text).not.toContain('<script>')
    expect(m.text).toContain('&lt;script&gt;')
  })

  it('omits the saving when list price equals best price', () => {
    const m = dealMessage({ listing: marketplaceListing(), item: getItem(), match: { ...getMatch(), bestPrice: marketplaceListing().price } })
    expect(m.text).not.toContain('you save')
  })
})

describe('receiptMessage', () => {
  it('escapes the title and shows the amount', () => {
    const t = receiptMessage({ listing: { ...marketplaceListing(), title: 'A <b>' }, amount: 262 })
    expect(t).toContain('A &lt;b&gt;')
    expect(t).toContain('$262.00')
  })
})

describe('handleUpdate: /start', () => {
  it('links the chat with a valid token and confirms', async () => {
    await handleUpdate({ message: { text: '/start demo-link-token', chat: { id: CHAT, type: 'private' } } })
    expect(fake.rows('profiles')[0]!.telegram_chat_id).toBe(CHAT)
    const msgs = sent('sendMessage')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].chat_id).toBe(CHAT)
  })

  it('rotates the link token after linking so a leaked token is single-use', async () => {
    await handleUpdate({ message: { text: '/start demo-link-token', chat: { id: CHAT, type: 'private' } } })
    expect(fake.rows('profiles')[0]!.telegram_link_token).toMatch(/^[0-9a-f]{24}$/)
    expect(fake.rows('profiles')[0]!.telegram_link_token).not.toBe('demo-link-token')
  })

  it('replaying the same token from another chat links nothing and changes nothing', async () => {
    await handleUpdate({ message: { text: '/start demo-link-token', chat: { id: CHAT, type: 'private' } } })
    const rotated = fake.rows('profiles')[0]!.telegram_link_token
    fetchMock.mockClear()
    await handleUpdate({ message: { text: '/start demo-link-token', chat: { id: 999, type: 'private' } } })
    expect(fake.rows('profiles')[0]!.telegram_chat_id).toBe(CHAT)
    expect(fake.rows('profiles')[0]!.telegram_link_token).toBe(rotated)
  })

  it('a valid unused token may re-link the profile to a new chat (switching phones)', async () => {
    await fake.from('profiles').update({ telegram_chat_id: 111 }).eq('id', DEMO_USER_ID)
    await handleUpdate({ message: { text: '/start demo-link-token', chat: { id: CHAT, type: 'private' } } })
    expect(fake.rows('profiles')[0]!.telegram_chat_id).toBe(CHAT)
  })

  it('does not link from a group chat, even with a valid token', async () => {
    await handleUpdate({ message: { text: '/start demo-link-token', chat: { id: -100123, type: 'group' } } })
    expect(fake.rows('profiles')[0]!.telegram_chat_id).toBeNull()
    expect(fake.rows('profiles')[0]!.telegram_link_token).toBe('demo-link-token')
  })

  it('does not link when the chat type is missing', async () => {
    await handleUpdate({ message: { text: '/start demo-link-token', chat: { id: CHAT } } })
    expect(fake.rows('profiles')[0]!.telegram_chat_id).toBeNull()
  })

  it('does not link with a wrong token and sends help', async () => {
    await handleUpdate({ message: { text: '/start wrong-token', chat: { id: CHAT, type: 'private' } } })
    expect(fake.rows('profiles')[0]!.telegram_chat_id).toBeNull()
    expect(sent('sendMessage')).toHaveLength(1)
  })
})

describe('handleUpdate: callbacks', () => {
  const cb = (data: string, chat = CHAT) => ({ callback_query: { id: 'cq1', data, from: { id: chat }, message: { chat: { id: chat, type: 'private' } } } })

  it('skip from the owner marks the match skipped', async () => {
    await linkProfile()
    await handleUpdate(cb(`skip:${MATCH_ID}`))
    expect(fake.rows('matches')[0]!.status).toBe('skipped')
    expect(sent('answerCallbackQuery')).toHaveLength(1)
  })

  it('skip from a chat that does not own the match changes nothing', async () => {
    await linkProfile()
    await handleUpdate(cb(`skip:${MATCH_ID}`, 999))
    expect(fake.rows('matches')[0]!.status).toBe('notified')
  })

  it('skip for a match of another user changes nothing', async () => {
    await linkProfile()
    await fake.from('wishlist_items').update({ user_id: 'someone-else' }).eq('id', 'wl-headphones')
    await handleUpdate(cb(`skip:${MATCH_ID}`))
    expect(fake.rows('matches')[0]!.status).toBe('notified')
  })

  it('pay creates a checkout and sends the approve link', async () => {
    await linkProfile()
    const spy = vi.spyOn(integrations, 'createCheckout').mockResolvedValue({ orderId: 'o1', paypalOrderId: 'P1', approveUrl: 'https://paypal.test/approve' })
    await handleUpdate(cb(`pay:${MATCH_ID}`))
    expect(spy).toHaveBeenCalledWith(MATCH_ID, DEMO_USER_ID)
    const msgs = sent('sendMessage')
    expect(msgs).toHaveLength(1)
    expect(JSON.stringify(msgs[0].reply_markup)).toContain('https://paypal.test/approve')
  })

  it('pay reports the error text when checkout fails, without throwing', async () => {
    await linkProfile()
    vi.spyOn(integrations, 'createCheckout').mockRejectedValue(new CheckoutError('blocked', 'Blocked by <mandate>'))
    await expect(handleUpdate(cb(`pay:${MATCH_ID}`))).resolves.toBeUndefined()
    const msgs = sent('sendMessage')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].text).toContain('Blocked by &lt;mandate&gt;')
  })

  it('pay does not leak non-checkout error text to the user and logs only the message', async () => {
    await linkProfile()
    const warn = vi.mocked(console.warn)
    const err = new Error('postgres://user:secret@host failed')
    vi.spyOn(integrations, 'createCheckout').mockRejectedValue(err)
    await handleUpdate(cb(`pay:${MATCH_ID}`))
    const msgs = sent('sendMessage')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].text).toBe('Something went wrong creating your PayPal order. Please try again from the app.')
    expect(msgs[0].text).not.toContain('secret')
    for (const call of warn.mock.calls) for (const arg of call) expect(arg).not.toBe(err)
  })

  it('pay shows the message of a CheckoutError', async () => {
    await linkProfile()
    vi.spyOn(integrations, 'createCheckout').mockRejectedValue(new CheckoutError('blocked', 'Over your limit'))
    await handleUpdate(cb(`pay:${MATCH_ID}`))
    expect(sent('sendMessage')[0].text).toContain('Over your limit')
  })

  it('callback from a group chat does nothing', async () => {
    await linkProfile()
    const spy = vi.spyOn(integrations, 'createCheckout')
    const groupCb = (data: string) => ({ callback_query: { id: 'cq1', data, from: { id: 42 }, message: { chat: { id: CHAT, type: 'group' } } } })
    await handleUpdate(groupCb(`skip:${MATCH_ID}`))
    await handleUpdate(groupCb(`pay:${MATCH_ID}`))
    expect(fake.rows('matches')[0]!.status).toBe('notified')
    expect(spy).not.toHaveBeenCalled()
    expect(sent('sendMessage')).toHaveLength(0)
    expect(sent('answerCallbackQuery').every((b) => b.text === 'Please use this button in a private chat')).toBe(true)
  })

  it('callback whose sender is not the chat owner does nothing', async () => {
    await linkProfile()
    await handleUpdate({ callback_query: { id: 'cq1', data: `skip:${MATCH_ID}`, from: { id: 42 }, message: { chat: { id: CHAT, type: 'private' } } } })
    expect(fake.rows('matches')[0]!.status).toBe('notified')
  })

  it('asks an unlinked chat to link first', async () => {
    const spy = vi.spyOn(integrations, 'createCheckout')
    await handleUpdate(cb(`pay:${MATCH_ID}`))
    expect(spy).not.toHaveBeenCalled()
    expect(sent('answerCallbackQuery')[0].text).toContain('link')
  })
})

describe('handleUpdate: junk', () => {
  it('ignores empty and null updates without calling fetch', async () => {
    await handleUpdate({})
    await handleUpdate(null)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
