import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setDbForTests } from '~~/server/lib/db'
import { createFakeDb, type FakeDb } from '../helpers/fake-db'

// The routes are plain handler functions that use Nitro auto-imports; stub those globals and call the default export.
const { notifyDeal, stepNegotiation, startNegotiation } = vi.hoisted(() => ({ notifyDeal: vi.fn(), stepNegotiation: vi.fn(), startNegotiation: vi.fn() }))
vi.mock('~~/server/lib/integrations', () => ({ integrations: { notifyDeal } }))
vi.mock('~~/server/lib/ai', async (importOriginal) => ({ ...(await importOriginal<typeof import('~~/server/lib/ai')>()), ai: { stepNegotiation, startNegotiation } }))

type Handler = (event: { userId: string; params: Record<string, string> }) => Promise<any>
let step: Handler
let negotiate: Handler

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const [W1, M1, N1, W2, M2, N2, MISSING] = [UUID(1), UUID(2), UUID(3), UUID(4), UUID(5), UUID(6), UUID(99)]

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (h: unknown) => h)
  vi.stubGlobal('requireUser', async (event: { userId: string }) => ({ id: event.userId, email: 'x@example.com' }))
  vi.stubGlobal('getRouterParam', (event: { params: Record<string, string> }, name: string) => event.params[name])
  vi.stubGlobal('createError', (o: { statusCode: number; statusMessage: string; data?: unknown }) => Object.assign(new Error(o.statusMessage), o))
  step = (await import('~~/server/api/negotiations/[id]/step.post')).default as unknown as Handler
  negotiate = (await import('~~/server/api/matches/[id]/negotiate.post')).default as unknown as Handler
})

let fake: FakeDb
beforeEach(() => {
  fake = createFakeDb({
    wishlist_items: [{ id: W1, user_id: 'u1' }, { id: W2, user_id: 'u2' }],
    matches: [{ id: M1, wishlist_item_id: W1, listing_id: 'l1', status: 'ready' }, { id: M2, wishlist_item_id: W2, listing_id: 'l2', status: 'ready' }],
    negotiations: [{ id: N1, match_id: M1, status: 'active' }, { id: N2, match_id: M2, status: 'active' }],
  })
  setDbForTests(fake)
  for (const m of [notifyDeal, stepNegotiation, startNegotiation]) m.mockReset()
})
afterEach(() => { setDbForTests(null); vi.restoreAllMocks() })

const call = (h: Handler, id: string, userId = 'u1') => h({ userId, params: { id } })
const failure = async (p: Promise<unknown>) => p.then(() => null, (e: any) => ({ statusCode: e.statusCode, statusMessage: e.statusMessage, data: e.data }))

const stepResult = (status: 'active' | 'agreed' | 'no_deal', newMessages: unknown[]) => ({ negotiation: { id: N1, matchId: M1, status }, newMessages, done: status !== 'active', busy: false })

describe('POST /api/negotiations/:id/step', () => {
  it('answers the same 404 for a foreign id, a missing id and a malformed id — and does not query for the malformed one', async () => {
    const foreign = await failure(call(step, N2))
    const missing = await failure(call(step, MISSING))
    expect(foreign).toEqual({ statusCode: 404, statusMessage: 'Negotiation not found', data: undefined })
    expect(missing).toEqual(foreign)
    fake.calls.length = 0
    const malformed = await failure(call(step, "1' or '1'='1"))
    expect(malformed).toEqual(foreign)
    expect(fake.calls).toHaveLength(0)
    expect(stepNegotiation).not.toHaveBeenCalled()
  })

  it('notifies only when the negotiation is agreed AND this call produced messages', async () => {
    const cases: [ReturnType<typeof stepResult>, boolean][] = [
      [stepResult('agreed', [{ id: 'a' }]), true],
      [stepResult('agreed', []), false],
      [stepResult('no_deal', [{ id: 'a' }]), false],
      [stepResult('active', [{ id: 'a' }]), false],
    ]
    for (const [result, expected] of cases) {
      notifyDeal.mockReset()
      stepNegotiation.mockResolvedValueOnce(result)
      expect(await call(step, N1)).toBe(result)
      expect(notifyDeal.mock.calls.length, JSON.stringify(result)).toBe(expected ? 1 : 0)
      if (expected) expect(notifyDeal).toHaveBeenCalledWith(M1)
    }
  })

  it('a throwing notifyDeal does not break the response, and only its message is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = stepResult('agreed', [{ id: 'a' }])
    stepNegotiation.mockResolvedValue(result)
    notifyDeal.mockRejectedValueOnce(new Error('telegram down'))
    expect(await call(step, N1)).toBe(result)
    notifyDeal.mockRejectedValueOnce({ token: 'secret-token' })
    expect(await call(step, N1)).toBe(result)
    const logged = warn.mock.calls.flat()
    expect(logged.every((x) => typeof x === 'string')).toBe(true)
    expect(logged.join(' ')).toContain('telegram down')
    expect(logged.join(' ')).toContain('unknown error')
    expect(logged.join(' ')).not.toContain('secret-token')
  })

  it('maps NegotiationError to 404', async () => {
    const { NegotiationError } = await import('~~/server/lib/ai')
    stepNegotiation.mockRejectedValueOnce(new NegotiationError('not_found', 'gone'))
    expect(await failure(call(step, N1))).toMatchObject({ statusCode: 404, statusMessage: 'gone' })
  })
})

describe('POST /api/matches/:id/negotiate', () => {
  it('answers the same 404 for a foreign id, a missing id and a malformed id — and does not query for the malformed one', async () => {
    const foreign = await failure(call(negotiate, M2))
    const missing = await failure(call(negotiate, MISSING))
    expect(foreign).toEqual({ statusCode: 404, statusMessage: 'Match not found', data: undefined })
    expect(missing).toEqual(foreign)
    fake.calls.length = 0
    expect(await failure(call(negotiate, 'not-a-uuid'))).toEqual(foreign)
    expect(fake.calls).toHaveLength(0)
    expect(startNegotiation).not.toHaveBeenCalled()
  })
  it('starts the negotiation for the owner, and maps not_ready to 409', async () => {
    startNegotiation.mockResolvedValueOnce({ id: N1 })
    expect(await call(negotiate, M1)).toEqual({ id: N1 })
    expect(startNegotiation).toHaveBeenCalledWith(M1)
    const { NegotiationError } = await import('~~/server/lib/ai')
    startNegotiation.mockRejectedValueOnce(new NegotiationError('not_ready', 'Match is flagged'))
    expect(await failure(call(negotiate, M1))).toMatchObject({ statusCode: 409, statusMessage: 'Match is flagged', data: { code: 'not_ready' } })
  })
})
