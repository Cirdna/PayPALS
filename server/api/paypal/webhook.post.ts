import { handlePayPalWebhook } from '~~/server/lib/integrations/paypal-webhook'

// POST /api/paypal/webhook. The signature is verified on the RAW body inside the handler. Always answers 200.
export default defineEventHandler(async (event) => {
  try {
    const rawBody = (await readRawBody(event, 'utf8')) ?? ''
    const headers: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(getHeaders(event))) headers[k.toLowerCase()] = v
    await handlePayPalWebhook(headers, rawBody)
  } catch (e) {
    console.warn('[paypal-webhook] route error:', e instanceof Error ? e.message : 'unknown error')
  }
  return { ok: true }
})
