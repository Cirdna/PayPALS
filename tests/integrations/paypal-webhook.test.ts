import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk'
import { setDbForTests } from '~~/server/lib/db'
import { setRawPayPalToolsForTests } from '~~/server/lib/integrations/paypal-toolkit'
import { handlePayPalWebhook, verifyWebhookSignature } from '~~/server/lib/integrations/paypal-webhook'
import { createFakeDb, type FakeDb } from '../helpers/fake-db'
import { DEMO_USER_ID, seedTables } from '../helpers/seed-fixture'

const ENV_KEYS = ['APP_URL', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'] as const
const savedEnv: Record<string, string | undefined> = {}

const ORDER_ID = 'ORDER1234567890ABC'
/** Real toolkit pay_order shape: { status: 'success', response: <PayPal order JSON> }. */
const CAPTURE_RESULT = {
  status: 'success',
  response: { id: ORDER_ID, status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAPTURE123', status: 'COMPLETED', amount: { value: '262.00', currency_code: 'USD' } }] } }] },
}
const HEADERS = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
  'paypal-transmission-id': 'tx-1',
  'paypal-transmission-sig': 'sig-1',
  'paypal-transmission-time': '2026-11-12T00:00:00Z',
}
const approvedEvent = (id = 'WH-1') => JSON.stringify({ id, event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: ORDER_ID, status: 'APPROVED' } })

let execute: ReturnType<typeof vi.fn>
let fake: FakeDb
let verificationStatus: string
let tokenOk: boolean
let fetchMock: ReturnType<typeof vi.fn>

const fetchCalls = (suffix: string) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix))
const eventTypes = () => fake.rows('agent_events').map((e) => e.type)

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  process.env.APP_URL = 'https://app.test'
  process.env.PAYPAL_CLIENT_ID = 'test-client'
  process.env.PAYPAL_CLIENT_SECRET = 'test-secret'
  process.env.PAYPAL_WEBHOOK_ID = 'WEBHOOK-ID-1'
  process.env.TELEGRAM_BOT_TOKEN = 'test-token'
  process.env.TELEGRAM_WEBHOOK_SECRET = 'hook-secret'

  verificationStatus = 'SUCCESS'
  tokenOk = true
  fetchMock = vi.fn(async (url: unknown) => {
    const u = String(url)
    if (u.endsWith('/v1/oauth2/token')) return tokenOk ? new Response(JSON.stringify({ access_token: 'tok-abc' })) : new Response('nope', { status: 401 })
    if (u.endsWith('/v1/notifications/verify-webhook-signature')) return new Response(JSON.stringify({ verification_status: verificationStatus }))
    return new Response(JSON.stringify({ ok: true, result: {} }))
  })
  vi.stubGlobal('fetch', fetchMock)

  execute = vi.fn(async () => JSON.stringify(CAPTURE_RESULT))
  const toolkit = new PayPalAgentToolkit({
    clientId: 'test', clientSecret: 'test',
    configuration: { actions: { orders: { create: true, get: true, capture: true } }, context: { sandbox: true } },
  })
  const tools = toolkit.getTools() as unknown as Record<string, { execute: unknown }>
  for (const t of Object.values(tools)) t.execute = execute
  setRawPayPalToolsForTests(tools as never)

  fake = createFakeDb({
    ...seedTables(),
    matches: [{ id: 'm1', wishlist_item_id: 'wl-headphones', listing_id: 'hp-used-ray', status: 'checkout_pending', best_price: 262, risk: null }],
    orders: [{ id: 'o1', match_id: 'm1', user_id: DEMO_USER_ID, paypal_order_id: ORDER_ID, amount: 262, currency: 'USD', status: 'created', approve_url: 'https://www.sandbox.paypal.com/checkoutnow?token=x' }],
  })
  setDbForTests(fake)
})
afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
  setRawPayPalToolsForTests(null)
  setDbForTests(null)
  vi.unstubAllGlobals()
})

describe('verifyWebhookSignature', () => {
  it('calls the token endpoint with basic auth, then verify-webhook-signature with the transmission headers', async () => {
    const body = approvedEvent()
    expect(await verifyWebhookSignature(HEADERS, body)).toBe(true)

    const token = fetchCalls('/v1/oauth2/token')
    expect(token).toHaveLength(1)
    expect(String(token[0]![0]).startsWith('https://api-m.sandbox.paypal.com/')).toBe(true)
    const tokenInit = token[0]![1] as { headers: Record<string, string>; body: string }
    expect(tokenInit.headers.authorization).toBe(`Basic ${Buffer.from('test-client:test-secret').toString('base64')}`)
    expect(tokenInit.body).toBe('grant_type=client_credentials')

    const verify = fetchCalls('/v1/notifications/verify-webhook-signature')
    expect(verify).toHaveLength(1)
    const init = verify[0]![1] as { headers: Record<string, string>; body: string }
    expect(init.headers.authorization).toBe('Bearer tok-abc')
    expect(JSON.parse(init.body)).toEqual({
      auth_algo: 'SHA256withRSA',
      cert_url: HEADERS['paypal-cert-url'],
      transmission_id: 'tx-1',
      transmission_sig: 'sig-1',
      transmission_time: '2026-11-12T00:00:00Z',
      webhook_id: 'WEBHOOK-ID-1',
      webhook_event: JSON.parse(body),
    })
  })

  it('is false for FAILURE, without PAYPAL_WEBHOOK_ID (no network), and when the token call fails', async () => {
    verificationStatus = 'FAILURE'
    expect(await verifyWebhookSignature(HEADERS, approvedEvent())).toBe(false)

    verificationStatus = 'SUCCESS'
    tokenOk = false
    expect(await verifyWebhookSignature(HEADERS, approvedEvent())).toBe(false)

    tokenOk = true
    fetchMock.mockClear()
    process.env.PAYPAL_WEBHOOK_ID = ''
    expect(await verifyWebhookSignature(HEADERS, approvedEvent())).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('handlePayPalWebhook', () => {
  it('bad signature: nothing captured, event not recorded', async () => {
    verificationStatus = 'FAILURE'
    expect(await handlePayPalWebhook(HEADERS, approvedEvent())).toBe('ignored')
    expect(execute).not.toHaveBeenCalled()
    expect(fake.rows('orders')[0]!.status).toBe('created')
    expect(fake.rows('webhook_events')).toHaveLength(0)
  })

  it('verified CHECKOUT.ORDER.APPROVED: captures the order once, even when PayPal delivers it twice', async () => {
    expect(await handlePayPalWebhook(HEADERS, approvedEvent())).toBe('captured')
    expect(fake.rows('orders')[0]).toMatchObject({ status: 'completed', capture_id: 'CAPTURE123' })
    expect(fake.rows('matches')[0]!.status).toBe('purchased')
    expect(eventTypes()).toContain('order_captured')
    expect(fake.rows('webhook_events')).toEqual([expect.objectContaining({ id: 'WH-1', type: 'CHECKOUT.ORDER.APPROVED' })])

    expect(await handlePayPalWebhook(HEADERS, approvedEvent())).toBe('duplicate')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(eventTypes().filter((t) => t === 'order_captured')).toHaveLength(1)
  })

  it('a different event id for an already completed order does not call PayPal again', async () => {
    await handlePayPalWebhook(HEADERS, approvedEvent('WH-1'))
    expect(await handlePayPalWebhook(HEADERS, approvedEvent('WH-2'))).toBe('captured')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(fake.rows('orders')[0]!.status).toBe('completed')
  })

  it('missing PAYPAL_WEBHOOK_ID: ignored, no network, nothing captured', async () => {
    process.env.PAYPAL_WEBHOOK_ID = ''
    expect(await handlePayPalWebhook(HEADERS, approvedEvent())).toBe('ignored')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(fake.rows('orders')[0]!.status).toBe('created')
  })

  it('malformed or non-object JSON: no throw, ignored', async () => {
    await expect(handlePayPalWebhook(HEADERS, '{not json')).resolves.toBe('ignored')
    await expect(handlePayPalWebhook(HEADERS, '')).resolves.toBe('ignored')
    await expect(handlePayPalWebhook(HEADERS, '[1,2]')).resolves.toBe('ignored')
    await expect(handlePayPalWebhook(HEADERS, 'null')).resolves.toBe('ignored')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('PAYMENT.CAPTURE.COMPLETED on a completed order: no-op', async () => {
    await fake.from('orders').update({ status: 'completed', capture_id: 'CAPTURE123' }).eq('id', 'o1')
    const body = JSON.stringify({
      id: 'WH-CAP', event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { id: 'CAPTURE123', status: 'COMPLETED', supplementary_data: { related_ids: { order_id: ORDER_ID } } },
    })
    expect(await handlePayPalWebhook(HEADERS, body)).toBe('noop')
    expect(execute).not.toHaveBeenCalled()
    expect(fake.rows('orders')[0]).toMatchObject({ status: 'completed', capture_id: 'CAPTURE123' })
    expect(eventTypes()).not.toContain('order_failed')
  })

  it('unknown event type: ignored', async () => {
    const body = JSON.stringify({ id: 'WH-X', event_type: 'BILLING.SUBSCRIPTION.CREATED', resource: { id: ORDER_ID } })
    expect(await handlePayPalWebhook(HEADERS, body)).toBe('ignored')
    expect(execute).not.toHaveBeenCalled()
    expect(fake.rows('orders')[0]!.status).toBe('created')
  })

  it('token endpoint failure: no throw, nothing captured', async () => {
    tokenOk = false
    await expect(handlePayPalWebhook(HEADERS, approvedEvent())).resolves.toBe('ignored')
    expect(execute).not.toHaveBeenCalled()
    expect(fake.rows('orders')[0]!.status).toBe('created')
  })

  it('network failure on fetch: no throw', async () => {
    fetchMock.mockImplementation(async () => { throw new Error('network down') })
    await expect(handlePayPalWebhook(HEADERS, approvedEvent())).resolves.toBe('ignored')
    expect(execute).not.toHaveBeenCalled()
  })

  it('capture failure (CheckoutError) is caught: no throw, order marked failed by captureOrder', async () => {
    execute.mockImplementation(async () => JSON.stringify({ status: 'success', response: { id: ORDER_ID, status: 'PAYER_ACTION_REQUIRED' } }))
    await expect(handlePayPalWebhook(HEADERS, approvedEvent())).resolves.toBe('error')
    expect(fake.rows('orders')[0]!.status).toBe('failed')
  })

  it('unknown order id in an APPROVED event: no throw', async () => {
    const body = JSON.stringify({ id: 'WH-U', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'NOPE' } })
    await expect(handlePayPalWebhook(HEADERS, body)).resolves.toBe('error')
    expect(execute).not.toHaveBeenCalled()
  })

  it('database failure while claiming the event: no throw', async () => {
    setDbForTests({ from: () => { throw new Error('db down') } })
    await expect(handlePayPalWebhook(HEADERS, approvedEvent())).resolves.toBe('error')
  })

  it('never logs secrets, tokens or the request body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    verificationStatus = 'FAILURE'
    await handlePayPalWebhook(HEADERS, approvedEvent())
    tokenOk = false
    await handlePayPalWebhook(HEADERS, approvedEvent('WH-2'))
    const logged = JSON.stringify(warn.mock.calls)
    for (const secret of ['test-secret', 'tok-abc', 'sig-1', 'APPROVED']) expect(logged).not.toContain(secret)
    warn.mockRestore()
  })
})
