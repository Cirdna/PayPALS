import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk'
import { setDbForTests } from '~~/server/lib/db'
import { setModelForTests } from '~~/server/lib/ai/model'
import { setRawPayPalToolsForTests, buildCreateOrderInput } from '~~/server/lib/integrations/paypal-toolkit'
import { cancelOrder, captureOrder, CheckoutError, createCheckout } from '~~/server/lib/integrations/checkout'
import { createFakeDb, type FakeDb } from '../helpers/fake-db'
import { DEMO_USER_ID, seedTables } from '../helpers/seed-fixture'
import { mockFailingModel, mockToolCallModel } from '../helpers/mock-model'

process.env.APP_URL = 'https://app.test'
process.env.PAYPAL_CLIENT_ID = 'test'
process.env.PAYPAL_CLIENT_SECRET = 'test'
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.TELEGRAM_WEBHOOK_SECRET = 'hook-secret'

const ORDER_ID = 'ORDER1234567890ABC'
const CREATE_RESULT = { id: ORDER_ID, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}` }] }
const CAPTURE_RESULT = { id: ORDER_ID, status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAPTURE123' }] } }] }

let captureBehaviour: () => unknown
const execute = vi.fn(async (input: unknown) => {
  const isCreate = Array.isArray((input as { items?: unknown })?.items)
  return JSON.stringify(isCreate ? CREATE_RESULT : captureBehaviour())
})
const callsOf = (tool: 'create' | 'capture') =>
  execute.mock.calls.filter(([i]) => Array.isArray((i as { items?: unknown })?.items) === (tool === 'create'))

const RETURN_URL = 'https://app.test/api/checkout/return'
const CANCEL_URL = 'https://app.test/api/checkout/cancel'
const agentCall = (amount: number) =>
  mockToolCallModel('create_order', buildCreateOrderInput({ title: 'Sonaro WH-700 black, like new, with case', amount, returnUrl: RETURN_URL, cancelUrl: CANCEL_URL }))

let fake: FakeDb
const match = (over: Record<string, unknown> = {}) => ({
  id: 'm1', wishlist_item_id: 'wl-headphones', listing_id: 'hp-used-ray', status: 'notified', best_price: 262,
  risk: { level: 'low', score: 0, signals: [], priceStats: null, explanation: '' }, ...over,
})

beforeEach(() => {
  captureBehaviour = () => CAPTURE_RESULT
  execute.mockClear()
  const toolkit = new PayPalAgentToolkit({
    clientId: 'test', clientSecret: 'test',
    configuration: { actions: { orders: { create: true, get: true, capture: true } }, context: { sandbox: true } },
  })
  const tools = toolkit.getTools() as unknown as Record<string, { execute: unknown }>
  for (const t of Object.values(tools)) t.execute = execute
  setRawPayPalToolsForTests(tools as never)
  setModelForTests('fast', agentCall(262))
  fake = createFakeDb({ ...seedTables(), matches: [match()] })
  setDbForTests(fake)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} }))))
})
afterEach(() => {
  setRawPayPalToolsForTests(null)
  setModelForTests('fast', null)
  setDbForTests(null)
  vi.unstubAllGlobals()
})

const eventTypes = () => fake.rows('agent_events').map((e) => e.type)

describe('createCheckout', () => {
  it('1. agentic path: the model calls the guarded create_order tool', async () => {
    const res = await createCheckout('m1', DEMO_USER_ID)
    expect(res.paypalOrderId).toBe(ORDER_ID)
    expect(res.approveUrl).toContain('https://www.sandbox.paypal.com/')
    const orders = fake.rows('orders')
    expect(orders).toHaveLength(1)
    expect(orders[0]).toMatchObject({ paypal_order_id: ORDER_ID, status: 'created', amount: 262, user_id: DEMO_USER_ID, match_id: 'm1' })
    expect(res.orderId).toBe(orders[0]!.id)
    expect(fake.rows('matches')[0]!.status).toBe('checkout_pending')
    expect(eventTypes()).toContain('order_created')
    expect(callsOf('create')).toHaveLength(1)
  })

  it('2. falls back to a direct call when the model makes no tool call', async () => {
    setModelForTests('fast', mockFailingModel())
    const res = await createCheckout('m1', DEMO_USER_ID)
    expect(res.paypalOrderId).toBe(ORDER_ID)
    expect(callsOf('create')).toHaveLength(1)
    expect(fake.rows('orders')[0]!.amount).toBe(262)
  })

  it('3. a model-inflated amount is blocked by the guard; the correct order is created, never 520', async () => {
    setModelForTests('fast', agentCall(520))
    const res = await createCheckout('m1', DEMO_USER_ID)
    expect(res.paypalOrderId).toBe(ORDER_ID)
    const creates = callsOf('create')
    expect(creates).toHaveLength(1)
    const input = creates[0]![0] as { items: { itemTotal: number; itemCost: number }[] }
    expect(input.items[0]!.itemTotal).toBe(262)
    expect(JSON.stringify(execute.mock.calls)).not.toContain('520')
    expect(fake.rows('orders')[0]!.amount).toBe(262)
  })

  it('4. mandate below the price: exceeds_mandate, no PayPal call, no order, guardrail_blocked event', async () => {
    const md = fake.rows('mandates').find((m) => m.wishlist_item_id === 'wl-headphones')!
    await fake.from('mandates').update({ max_amount: 200 }).eq('id', md.id)
    await expect(createCheckout('m1', DEMO_USER_ID)).rejects.toMatchObject({ code: 'exceeds_mandate', statusCode: 409 })
    expect(execute).not.toHaveBeenCalled()
    expect(fake.rows('orders')).toHaveLength(0)
    expect(eventTypes()).toContain('guardrail_blocked')
    expect(fake.rows('matches')[0]!.status).toBe('notified')
  })

  it('5. not payable (channel3), not allowed (flagged / high risk), not found (other user)', async () => {
    await fake.from('listings').update({ source: 'channel3' }).eq('id', 'hp-used-ray')
    await expect(createCheckout('m1', DEMO_USER_ID)).rejects.toMatchObject({ code: 'not_payable' })
    await fake.from('listings').update({ source: 'marketplace' }).eq('id', 'hp-used-ray')

    await fake.from('matches').update({ status: 'flagged' }).eq('id', 'm1')
    await expect(createCheckout('m1', DEMO_USER_ID)).rejects.toMatchObject({ code: 'not_allowed' })

    await fake.from('matches').update({ status: 'notified', risk: { level: 'high', score: 90, signals: [], priceStats: null, explanation: '' } }).eq('id', 'm1')
    await expect(createCheckout('m1', DEMO_USER_ID)).rejects.toMatchObject({ code: 'not_allowed' })

    const err = await createCheckout('m1', 'someone-else').catch((e) => e)
    expect(err).toBeInstanceOf(CheckoutError)
    expect(err).toMatchObject({ code: 'not_found', statusCode: 404 })
    await expect(createCheckout('nope', DEMO_USER_ID)).rejects.toMatchObject({ code: 'not_found', statusCode: 404 })
    expect(execute).not.toHaveBeenCalled()
    expect(fake.rows('orders')).toHaveLength(0)
  })

  it('6. is idempotent: a second call returns the same order without calling PayPal again', async () => {
    const a = await createCheckout('m1', DEMO_USER_ID)
    const b = await createCheckout('m1', DEMO_USER_ID)
    expect(b).toEqual(a)
    expect(callsOf('create')).toHaveLength(1)
    expect(fake.rows('orders')).toHaveLength(1)
  })

  it('fails with paypal_error (502) when PayPal returns no approval link, and writes nothing', async () => {
    execute.mockImplementationOnce(async () => JSON.stringify({ id: ORDER_ID, links: [] }))
    setModelForTests('fast', mockFailingModel())
    await expect(createCheckout('m1', DEMO_USER_ID)).rejects.toMatchObject({ code: 'paypal_error', statusCode: 502 })
    expect(fake.rows('orders')).toHaveLength(0)
    expect(fake.rows('matches')[0]!.status).toBe('notified')
  })
})

describe('captureOrder', () => {
  beforeEach(async () => { await createCheckout('m1', DEMO_USER_ID); execute.mockClear() })

  it('7. captures: order completed, match purchased, wishlist fulfilled, event, camelCase Order', async () => {
    const order = await captureOrder(ORDER_ID)
    expect(order).toMatchObject({ paypalOrderId: ORDER_ID, status: 'completed', captureId: 'CAPTURE123', amount: 262, matchId: 'm1', userId: DEMO_USER_ID })
    expect(fake.rows('orders')[0]).toMatchObject({ status: 'completed', capture_id: 'CAPTURE123' })
    expect(fake.rows('matches')[0]!.status).toBe('purchased')
    expect(fake.rows('wishlist_items').find((w) => w.id === 'wl-headphones')!.status).toBe('fulfilled')
    expect(eventTypes()).toContain('order_captured')
    expect(callsOf('capture')).toHaveLength(1)
    expect(execute.mock.calls[0]![0]).toEqual({ id: ORDER_ID })
  })

  it('7b. a linked Telegram chat never makes the capture fail', async () => {
    await fake.from('profiles').update({ telegram_chat_id: 12345 }).eq('id', DEMO_USER_ID)
    await expect(captureOrder(ORDER_ID)).resolves.toMatchObject({ status: 'completed' })
  })

  it('8. is idempotent: second call returns the completed order without calling PayPal', async () => {
    await captureOrder(ORDER_ID)
    execute.mockClear()
    const again = await captureOrder(ORDER_ID)
    expect(again.status).toBe('completed')
    expect(execute).not.toHaveBeenCalled()
  })

  it('9a. not COMPLETED: order failed, match stays checkout_pending, order_failed event, capture_failed', async () => {
    captureBehaviour = () => ({ id: ORDER_ID, status: 'PAYER_ACTION_REQUIRED' })
    await expect(captureOrder(ORDER_ID)).rejects.toMatchObject({ code: 'capture_failed' })
    expect(fake.rows('orders')[0]!.status).toBe('failed')
    expect(fake.rows('matches')[0]!.status).toBe('checkout_pending')
    expect(eventTypes()).toContain('order_failed')
    expect(fake.rows('wishlist_items').find((w) => w.id === 'wl-headphones')!.status).toBe('active')
  })

  it('9b. PayPal throws: same outcome', async () => {
    execute.mockImplementationOnce(async () => { throw new Error('boom') })
    await expect(captureOrder(ORDER_ID)).rejects.toMatchObject({ code: 'capture_failed' })
    expect(fake.rows('orders')[0]!.status).toBe('failed')
    expect(fake.rows('matches')[0]!.status).toBe('checkout_pending')
    expect(eventTypes()).toContain('order_failed')
  })

  it('9c. race: a concurrent capture completed the order while ours failed: returns it, never marks it failed', async () => {
    execute.mockImplementationOnce(async () => {
      // the other caller (webhook / return URL) wins the race and finishes first, then PayPal rejects our capture
      await fake.from('orders').update({ status: 'completed', capture_id: 'CAPTURE-OTHER' }).eq('paypal_order_id', ORDER_ID)
      throw new Error('ORDER_ALREADY_CAPTURED')
    })
    const order = await captureOrder(ORDER_ID)
    expect(order).toMatchObject({ status: 'completed', captureId: 'CAPTURE-OTHER' })
    expect(fake.rows('orders')[0]!.status).toBe('completed')
    expect(eventTypes()).not.toContain('order_failed')
  })

  it('9d. race: a non-COMPLETED capture result after another caller completed the order is not a failure either', async () => {
    execute.mockImplementationOnce(async () => {
      await fake.from('orders').update({ status: 'completed', capture_id: 'CAPTURE-OTHER' }).eq('paypal_order_id', ORDER_ID)
      return JSON.stringify({ id: ORDER_ID, status: 'PAYER_ACTION_REQUIRED' })
    })
    await expect(captureOrder(ORDER_ID)).resolves.toMatchObject({ status: 'completed' })
    expect(fake.rows('orders')[0]!.status).toBe('completed')
    expect(eventTypes()).not.toContain('order_failed')
  })

  it('10. unknown order: not_found 404', async () => {
    await expect(captureOrder('UNKNOWN')).rejects.toMatchObject({ code: 'not_found', statusCode: 404 })
  })

  it('does not capture a cancelled order', async () => {
    await cancelOrder(ORDER_ID)
    execute.mockClear()
    await expect(captureOrder(ORDER_ID)).rejects.toMatchObject({ code: 'not_capturable', statusCode: 409 })
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('cancelOrder', () => {
  it('11. cancels: order cancelled, match back to notified, returns the match id; unknown id returns null', async () => {
    await createCheckout('m1', DEMO_USER_ID)
    expect(await cancelOrder(ORDER_ID)).toEqual({ matchId: 'm1' })
    expect(fake.rows('orders')[0]!.status).toBe('cancelled')
    expect(fake.rows('matches')[0]!.status).toBe('notified')
    expect(await cancelOrder('UNKNOWN')).toBeNull()
  })

  it('does not undo a completed purchase', async () => {
    await createCheckout('m1', DEMO_USER_ID)
    await captureOrder(ORDER_ID)
    expect(await cancelOrder(ORDER_ID)).toEqual({ matchId: 'm1' })
    expect(fake.rows('orders')[0]!.status).toBe('completed')
    expect(fake.rows('matches')[0]!.status).toBe('purchased')
  })
})
