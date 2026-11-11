import { handleUpdate } from '~~/server/lib/integrations/telegram'

// POST /api/telegram/webhook. Always answers 200 so Telegram does not retry.
export default defineEventHandler(async (event) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!secret || getHeader(event, 'x-telegram-bot-api-secret-token') !== secret) return { ok: true }
  await handleUpdate(await readBody(event).catch(() => null))
  return { ok: true }
})
