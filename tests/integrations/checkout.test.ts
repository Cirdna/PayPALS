import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk'
import { setDbForTests } from '~~/server/lib/db'
import { setModelForTests } from '~~/server/lib/ai/model'
import { setRawPayPalToolsForTests, buildCreateOrderInput } from '~~/server/lib/integrations/paypal-toolkit'
import { cancelOrder, captureOrder, CheckoutError, createCheckout } from '~~/server/lib/integrations/checkout'
import { createFakeDb, type FakeDb } from '../helpers/fake-db'
import { DEMO_USER_ID, seedTables } from '../helpers/seed-fixture'
import { MockLanguageModelV4 } from 'ai/test'
import { mockFailingModel, mockToolCallModel } from '../helpers/mock-model'

process.env.APP_URL = 'https://app.test'
process.env.PAYPAL_CLIENT_ID = 'test'
process.env.PAYPAL_CLIENT_SECRET = 'test'
process.env.TELEGRAM_BOT_TOKEN = 'test-token'
process.env.TELEGRAM_WEBHOOK_SECRET = 'hook-secret'

const ORDER_ID = 'ORDER1234567890ABC'
const CREATE_RESULT = { id: ORDER_ID, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}` }] }
/** The toolkit's pay_order wraps the PayPal order JSON: { status: 'success', response: <order> } (verified in @paypal/agent-toolkit 1.11.0). */
const wrapped = (order: unknown) => ({ status: 'success', response: order })
const capturedOrder = (over: { orderStatus?: string; captureStatus?: string; value?: string; currency?: string } = {}) => ({
  id: ORDER_ID, status: over.orderStatus ?? 'COMPLETED',
  purchase_units: [{ payments: { captures: [{ id: 'CAPTURE123', status: over.captureStatus ?? 'COMPLETED', amount: { value: over.value ?? '262.00', currency_code: over.currency ?? 'USD' } }] } }],
})
const CAPTURE_RESULT = wrapped(capturedOrder())

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

describe('createCheckout hardening', () => {
  const buildInput = (over: Record<string, unknown> = {}) => ({ ...buildCreateOrderInput({ title: 'Sonaro WH-700 black, like new, with case', amount: 262, returnUrl: RETURN_URL, cancelUrl: CANCEL_URL }), ...over })
  const createdInput = () => callsOf('create')[0]![0] as { returnUrl: string; cancelUrl: string }

  it('M1. the model only sees create_order and must call it', async () => {
    let seen: { tools?: { name: string }[]; toolChoice?: unknown } = {}
    setModelForTests('fast', new MockLanguageModelV4({
      doGenerate: async (opts: any) => {
        seen = { tools: opts.tools, toolChoice: opts.toolChoice }
        return {
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'create_order', input: JSON.stringify(buildInput()) }],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          warnings: [],
        }
      },
    } as never) as never)
    await createCheckout('m1', DEMO_USER_ID)
    expect(seen.tools?.map((t) => t.name)).toEqual(['create_order'])
    expect(seen.toolChoice).toEqual({ type: 'tool', toolName: 'create_order' })
  })

  it('M1. a model that swaps returnUrl / cancelUrl is blocked by the guard; the fallback creates the correct order', async () => {
    setModelForTests('fast', mockToolCallModel('create_order', buildInput({ returnUrl: 'https://evil.test/r', cancelUrl: 'https://evil.test/c' })))
    const res = await createCheckout('m1', DEMO_USER_ID)
    expect(res.paypalOrderId).toBe(ORDER_ID)
    expect(callsOf('create')).toHaveLength(1)
    expect(createdInput()).toMatchObject({ returnUrl: RETURN_URL, cancelUrl: CANCEL_URL })
    expect(JSON.stringify(execute.mock.calls)).not.toContain('evil.test')
  })

  it('M1. a model that rewrites the item name is blocked the same way', async () => {
    const base = buildInput()
    setModelForTests('fast', mockToolCallModel('create_order', { ...base, items: [{ ...base.items[0]!, name: 'free money' }] }))
    await createCheckout('m1', DEMO_USER_ID)
    expect(JSON.stringify(execute.mock.calls)).not.toContain('free money')
  })

  it('M1. the prompt wraps the listing title as untrusted data', async () => {
    let prompt = ''
    setModelForTests('fast', new MockLanguageModelV4({
      doGenerate: async (opts: any) => {
        prompt = JSON.stringify(opts.prompt)
        throw new Error('stop')
      },
    } as never) as never)
    await createCheckout('m1', DEMO_USER_ID)
    expect(prompt).toContain('untrusted_listing_title')
  })

  it('M4. rejects when the wishlist item is no longer active (not_allowed), no PayPal call', async () => {
    await fake.from('wishlist_items').update({ status: 'fulfilled' }).eq('id', 'wl-headphones')
    await expect(createCheckout('m1', DEMO_USER_ID)).rejects.toMatchObject({ code: 'not_allowed' })
    expect(execute).not.toHaveBeenCalled()
    expect(fake.rows('orders')).toHaveLength(0)
  })

  it('M4. two concurrent createCheckout calls create exactly ONE PayPal order', async () => {
    const results = await Promise.allSettled([createCheckout('m1', DEMO_USER_ID), createCheckout('m1', DEMO_USER_ID)])
    expect(callsOf('create')).toHaveLength(1)
    expect(fake.rows('orders')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: 'checkout_in_progress', statusCode: 409 })
    expect(fake.rows('matches')[0]!.status).toBe('checkout_pending')
  })

  it('M4. a match already checkout_pending without an open order is checkout_in_progress (409)', async () => {
    await fake.from('matches').update({ status: 'checkout_pending' }).eq('id', 'm1')
    await expect(createCheckout('m1', DEMO_USER_ID)).rejects.toMatchObject({ code: 'checkout_in_progress', statusCode: 409 })
    expect(execute).not.toHaveBeenCalled()
  })

  it('M4. if PayPal order creation fails the previous match status is restored (agreed stays agreed)', async () => {
    await fake.from('matches').update({ status: 'agreed' }).eq('id', 'm1')
    execute.mockImplementation(async () => { throw new Error('paypal down') })
    setModelForTests('fast', mockFailingModel())
    await expect(createCheckout('m1', DEMO_USER_ID)).rejects.toMatchObject({ code: 'paypal_error', statusCode: 502 })
    expect(fake.rows('matches')[0]!.status).toBe('agreed')
    expect(fake.rows('orders')).toHaveLength(0)
    // and the user can simply try again
    execute.mockImplementation(async (input: unknown) => JSON.stringify(Array.isArray((input as { items?: unknown })?.items) ? CREATE_RESULT : captureBehaviour()))
    await expect(createCheckout('m1', DEMO_USER_ID)).resolves.toMatchObject({ paypalOrderId: ORDER_ID })
  })

  it('L6. an amount above the wishlist max price is exceeds_max_price with a guardrail_blocked event', async () => {
    await fake.from('wishlist_items').update({ max_price: 200 }).eq('id', 'wl-headphones')
    await expect(createCheckout('m1', DEMO_USER_ID)).rejects.toMatchObject({ code: 'exceeds_max_price', statusCode: 409 })
    expect(execute).not.toHaveBeenCalled()
    expect(eventTypes()).toContain('guardrail_blocked')
    expect(fake.rows('matches')[0]!.status).toBe('notified')
  })

  it('L7. an open order older than 2 hours is stale: cancelled, and a fresh order is created', async () => {
    await createCheckout('m1', DEMO_USER_ID)
    execute.mockClear()
    const old = new Date(Date.now() - 3 * 3600_000).toISOString()
    await fake.from('orders').update({ created_at: old }).eq('paypal_order_id', ORDER_ID)
    await fake.from('orders').update({ paypal_order_id: 'OLD-ORDER' }).eq('paypal_order_id', ORDER_ID)
    const res = await createCheckout('m1', DEMO_USER_ID)
    expect(res.paypalOrderId).toBe(ORDER_ID)
    expect(callsOf('create')).toHaveLength(1)
    const orders = fake.rows('orders')
    expect(orders).toHaveLength(2)
    expect(orders.find((o) => o.paypal_order_id === 'OLD-ORDER')!.status).toBe('cancelled')
    expect(orders.find((o) => o.paypal_order_id === ORDER_ID)!.status).toBe('created')
    expect(fake.rows('matches')[0]!.status).toBe('checkout_pending')
  })

  it('L7. a recent open order is still returned as is', async () => {
    const a = await createCheckout('m1', DEMO_USER_ID)
    fake.advance(3600_000)
    const b = await createCheckout('m1', DEMO_USER_ID)
    expect(b).toEqual(a)
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
    captureBehaviour = () => wrapped({ id: ORDER_ID, status: 'PAYER_ACTION_REQUIRED' })
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

  it('9e. captured amount differs from the stored order amount: failed, never completed', async () => {
    captureBehaviour = () => wrapped(capturedOrder({ value: '1.00' }))
    await expect(captureOrder(ORDER_ID)).rejects.toMatchObject({ code: 'capture_failed' })
    expect(fake.rows('orders')[0]!.status).toBe('failed')
    expect(fake.rows('matches')[0]!.status).toBe('checkout_pending')
    expect(eventTypes()).toContain('order_failed')
    expect(eventTypes()).not.toContain('order_captured')
  })

  it('9f. captured currency is not USD: failed', async () => {
    captureBehaviour = () => wrapped(capturedOrder({ currency: 'SGD' }))
    await expect(captureOrder(ORDER_ID)).rejects.toMatchObject({ code: 'capture_failed' })
    expect(fake.rows('orders')[0]!.status).toBe('failed')
  })

  it('9g. capture status PENDING (order COMPLETED): failed', async () => {
    captureBehaviour = () => wrapped(capturedOrder({ captureStatus: 'PENDING' }))
    await expect(captureOrder(ORDER_ID)).rejects.toMatchObject({ code: 'capture_failed' })
    expect(fake.rows('orders')[0]!.status).toBe('failed')
    expect(fake.rows('matches')[0]!.status).toBe('checkout_pending')
  })

  it('9h. error-shaped toolkit result: failed, the sanitised PayPal message ends up in the event detail', async () => {
    captureBehaviour = () => ({ error: { message: 'UNPROCESSABLE_ENTITY: INSTRUMENT_DECLINED', type: 'paypal_error' } })
    const err = await captureOrder(ORDER_ID).catch((e) => e)
    expect(err).toMatchObject({ code: 'capture_failed' })
    expect(err.message).toContain('INSTRUMENT_DECLINED')
    expect(fake.rows('orders')[0]!.status).toBe('failed')
    const ev = fake.rows('agent_events').find((e) => e.type === 'order_failed')!
    expect(ev.payload.detail).toContain('INSTRUMENT_DECLINED')
  })

  it('9i. wrapper status "error": failed; a long message is truncated to 200 chars and never the raw object', async () => {
    captureBehaviour = () => ({ status: 'error', response: { message: 'x'.repeat(500) } })
    await expect(captureOrder(ORDER_ID)).rejects.toMatchObject({ code: 'capture_failed' })
    const ev = fake.rows('agent_events').find((e) => e.type === 'order_failed')!
    expect(String(ev.payload.detail).length).toBeLessThanOrEqual(200)
    expect(ev.payload.detail).not.toContain('[object Object]')
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
      return JSON.stringify(wrapped({ id: ORDER_ID, status: 'PAYER_ACTION_REQUIRED' }))
    })
    await expect(captureOrder(ORDER_ID)).resolves.toMatchObject({ status: 'completed' })
    expect(fake.rows('orders')[0]!.status).toBe('completed')
    expect(eventTypes()).not.toContain('order_failed')
  })

  it('M4. a match that is already purchased refuses a second capture without calling PayPal', async () => {
    await fake.from('matches').update({ status: 'purchased' }).eq('id', 'm1')
    await expect(captureOrder(ORDER_ID)).rejects.toMatchObject({ code: 'already_purchased' })
    expect(execute).not.toHaveBeenCalled()
    expect(fake.rows('orders')[0]!.status).toBe('created')
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
