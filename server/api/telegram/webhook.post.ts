import { createHash, timingSafeEqual } from 'node:crypto'
import { handleUpdate } from '~~/server/lib/integrations/telegram'

// Hash both sides so the comparison is constant-time and independent of the length of what the caller sent.
const sha256 = (v: string) => createHash('sha256').update(v).digest()
const secretMatches = (given: string | undefined, secret: string) => timingSafeEqual(sha256(given ?? ''), sha256(secret))

// POST /api/telegram/webhook. Always answers 200 so Telegram does not retry.
export default defineEventHandler(async (event) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!secret || !secretMatches(getHeader(event, 'x-telegram-bot-api-secret-token'), secret)) return { ok: true }
  await handleUpdate(await readBody(event).catch(() => null))
  return { ok: true }
})
