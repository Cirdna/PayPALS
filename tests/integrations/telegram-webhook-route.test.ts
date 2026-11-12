import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handleUpdate = vi.fn(async () => {})
vi.mock('~~/server/lib/integrations/telegram', () => ({ handleUpdate }))

let headerValue: string | undefined
let route: (event: unknown) => Promise<{ ok: boolean }>

beforeEach(async () => {
  handleUpdate.mockClear()
  headerValue = undefined
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getHeader', (_e: unknown, name: string) => (name === 'x-telegram-bot-api-secret-token' ? headerValue : undefined))
  vi.stubGlobal('readBody', async () => ({ update_id: 1 }))
  vi.resetModules()
  route = (await import('~~/server/api/telegram/webhook.post')).default as never
})
afterEach(() => {
  delete process.env.TELEGRAM_WEBHOOK_SECRET
  vi.unstubAllGlobals()
})

describe('POST /api/telegram/webhook secret check', () => {
  it('processes the update when the secret header matches', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 'hook-secret'
    headerValue = 'hook-secret'
    expect(await route({})).toEqual({ ok: true })
    expect(handleUpdate).toHaveBeenCalledTimes(1)
  })

  it('answers 200 and ignores the update on a wrong, missing, or different-length header', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 'hook-secret'
    for (const h of ['wrong-secret', 'hook-secre', 'hook-secret-and-more', '', undefined]) {
      headerValue = h
      expect(await route({})).toEqual({ ok: true })
    }
    expect(handleUpdate).not.toHaveBeenCalled()
  })

  it('fails closed (200, ignored) when TELEGRAM_WEBHOOK_SECRET is unset, even for an empty header', async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET
    for (const h of ['', 'anything', undefined]) {
      headerValue = h
      expect(await route({})).toEqual({ ok: true })
    }
    expect(handleUpdate).not.toHaveBeenCalled()
  })
})
