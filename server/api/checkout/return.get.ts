// Opened by PayPal's redirect after the buyer approves: NO requireUser here (the order id is the capability).
import { db } from '~~/server/lib/db'
import { captureOrder } from '~~/server/lib/integrations/checkout'

export default defineEventHandler(async (event) => {
  const token = String(getQuery(event).token ?? '')
  const { data: order } = await db().from('orders').select('match_id').eq('paypal_order_id', token).maybeSingle()
  if (!order) return sendRedirect(event, '/deals?failed=1')
  try {
    await captureOrder(token)
    return sendRedirect(event, `/deals/${order.match_id}?paid=1`)
  } catch (e) {
    console.warn('[checkout] capture failed:', e instanceof Error ? e.message : 'unknown error')
    return sendRedirect(event, `/deals/${order.match_id}?failed=1`)
  }
})
