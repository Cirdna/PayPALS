import { db, unwrap } from '../db'
import { env } from '../env'
import { captureOrder, CheckoutError } from './checkout'

/**
 * PayPal webhook handling (docs/ARCHITECTURE.md §9). The return URL already captures; the webhook covers a buyer who
 * closed the tab after approving. Framework-free. NEVER throws. Never logs secrets, tokens or whole bodies
 * (only event id / type / order id).
 */

type Row = Record<string, any>
export type WebhookOutcome = 'ignored' | 'duplicate' | 'captured' | 'noop' | 'error'

const text = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Verifies the event with PayPal's verify-webhook-signature API. True only on `SUCCESS`; any failure is false. */
export async function verifyWebhookSignature(headers: Record<string, string | undefined>, rawBody: string): Promise<boolean> {
  try {
    const webhookId = env.paypalWebhookId
    if (!webhookId) return false
    const h = (name: string) => text(headers[name])
    const event = JSON.parse(rawBody)

    const tokenRes = await fetch(`${env.paypalApiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${env.paypalClientId}:${env.paypalClientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    })
    if (!tokenRes.ok) return false
    const accessToken = text(((await tokenRes.json()) as Row)?.access_token)
    if (!accessToken) return false

    const res = await fetch(`${env.paypalApiBase}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        auth_algo: h('paypal-auth-algo'),
        cert_url: h('paypal-cert-url'),
        transmission_id: h('paypal-transmission-id'),
        transmission_sig: h('paypal-transmission-sig'),
        transmission_time: h('paypal-transmission-time'),
        webhook_id: webhookId,
        webhook_event: event,
      }),
    })
    if (!res.ok) return false
    return ((await res.json()) as Row)?.verification_status === 'SUCCESS'
  } catch (e) {
    console.warn('[paypal-webhook] signature verification failed:', e instanceof Error ? e.message : 'unknown error')
    return false
  }
}

/** Handles one PayPal webhook delivery. `headers` must have lowercase keys. Never throws. */
export async function handlePayPalWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<WebhookOutcome> {
  try {
    if (!env.paypalWebhookId) {
      console.warn('[paypal-webhook] PAYPAL_WEBHOOK_ID is not set: event ignored')
      return 'ignored'
    }
    let event: Row
    try {
      const parsed = JSON.parse(rawBody)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'ignored'
      event = parsed
    } catch {
      console.warn('[paypal-webhook] body is not valid JSON: ignored')
      return 'ignored'
    }
    const eventId = text(event.id)
    const eventType = text(event.event_type)
    if (!eventId || !eventType) return 'ignored'

    if (!(await verifyWebhookSignature(headers, rawBody))) {
      console.warn(`[paypal-webhook] signature not verified: event ${eventId} ignored`)
      return 'ignored'
    }

    // Idempotency: the first delivery claims the event id, a unique violation means it was already processed.
    const claim = await db().from('webhook_events').insert({ id: eventId, type: eventType })
    if (claim.error) {
      if ((claim.error as { code?: string }).code === '23505') return 'duplicate'
      throw new Error(`Supabase claim webhook event failed: ${claim.error.message}`)
    }

    const resource = (event.resource ?? {}) as Row

    if (eventType === 'CHECKOUT.ORDER.APPROVED') {
      const orderId = text(resource.id)
      if (!orderId) return 'ignored'
      try {
        await captureOrder(orderId)
        return 'captured'
      } catch (e) {
        if (e instanceof CheckoutError) console.warn(`[paypal-webhook] capture of ${orderId} not done: ${e.code}`)
        else console.warn(`[paypal-webhook] capture of ${orderId} failed:`, e instanceof Error ? e.message : 'unknown error')
        return 'error'
      }
    }

    if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      const orderId = text(resource.supplementary_data?.related_ids?.order_id)
      if (!orderId) return 'noop'
      const row = unwrap(await db().from('orders').select('status').eq('paypal_order_id', orderId).maybeSingle(), 'load order') as Row | null
      // Completed: nothing to do. Otherwise the capture itself is driven by captureOrder (return URL / APPROVED event),
      // never from here: calling PayPal's capture for an already captured order would only fail.
      if (row && row.status !== 'completed') console.warn(`[paypal-webhook] capture completed at PayPal for order ${orderId} in status "${row.status}"`)
      return 'noop'
    }

    return 'ignored'
  } catch (e) {
    console.warn('[paypal-webhook] handler error:', e instanceof Error ? e.message : 'unknown error')
    return 'error'
  }
}
