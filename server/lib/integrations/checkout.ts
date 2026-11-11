import { generateText, stepCountIs } from 'ai'
import type { CheckoutCreateResponse, Listing, Mandate, Match, Order, WishlistItem } from '#shared/types'
import { roundMoney } from '#shared/utils/money'
import { ai } from '../ai'
import { getModel } from '../ai/model'
import { db, unwrap } from '../db'
import { env } from '../env'
import { logEvent } from '../events'
import { toCamel } from '../mappers'
import {
  buildCreateOrderInput, callPayPalTool, findApproveUrl, guardedPayPalTools, makeCheckoutGuard, PayPalGuardError,
} from './paypal-toolkit'
import { receiptMessage, tg } from './telegram'

/**
 * Checkout for marketplace listings (docs/ARCHITECTURE.md §9). The spending limit is enforced in CODE:
 * mandate pre-check + makeCheckoutGuard (exact agreed amount) run before PayPal is contacted, on the agentic
 * path and on the deterministic fallback alike. The LLM only gets to reproduce a JSON we built.
 */

type Row = Record<string, any>

export class CheckoutError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 409) {
    super(message)
    this.name = 'CheckoutError'
  }
}

// ── PayPal response parsing. Kept tiny on purpose: adjust to the raw results recorded by the B0 spike. ──
const orderIdOf = (r: any): string | null => (typeof r?.id === 'string' ? r.id : null)
const captureOf = (r: any) => ({ status: r?.status as string | undefined, captureId: (r?.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? null) as string | null })
const isGuardError = (e: unknown): e is PayPalGuardError => e instanceof PayPalGuardError || (e as Error)?.name === 'PayPalGuardError'

const PAYABLE_STATUSES = ['agreed', 'notified', 'checkout_pending']
const orderOf = (row: Row): Order => toCamel<Order>(row)

export async function createCheckout(matchId: string, userId: string): Promise<CheckoutCreateResponse> {
  // 1. load + ownership. Every row is checked against the user (service role bypasses RLS).
  const matchRow = unwrap(await db().from('matches').select('*').eq('id', matchId).maybeSingle(), 'load match') as Row | null
  const itemRow = matchRow ? (unwrap(await db().from('wishlist_items').select('*').eq('id', matchRow.wishlist_item_id).eq('user_id', userId).maybeSingle(), 'load wishlist item') as Row | null) : null
  if (!matchRow || !itemRow) throw new CheckoutError('not_found', 'Match not found', 404)
  const match = toCamel<Match>(matchRow)
  const item = toCamel<WishlistItem>(itemRow)
  const listingRow = unwrap(await db().from('listings').select('*').eq('id', match.listingId).maybeSingle(), 'load listing') as Row | null
  if (!listingRow) throw new CheckoutError('not_found', 'Listing not found', 404)
  const listing = toCamel<Listing>(listingRow)

  if (listing.source !== 'marketplace') throw new CheckoutError('not_payable', 'This listing is sold by a retailer: buy it at the retailer link')
  if (!PAYABLE_STATUSES.includes(match.status) || match.risk?.level === 'high') {
    throw new CheckoutError('not_allowed', `A match in status "${match.status}"${match.risk?.level === 'high' ? ' with high risk' : ''} cannot be paid`)
  }

  // 2. idempotent: an open order for this match is returned as is.
  const open = unwrap(await db().from('orders').select('*').eq('match_id', matchId).eq('user_id', userId).eq('status', 'created').limit(1), 'load open order') as Row[] | null
  if (open?.[0]?.approve_url) return { orderId: open[0].id, paypalOrderId: open[0].paypal_order_id, approveUrl: open[0].approve_url }

  // 3. mandate pre-check: fail fast, before any PayPal or LLM call.
  const mandateRow = unwrap(await db().from('mandates').select('*').eq('wishlist_item_id', item.id).eq('user_id', userId).maybeSingle(), 'load mandate') as Row | null
  if (!mandateRow) throw new CheckoutError('no_mandate', 'There is no spending mandate for this wishlist item')
  const mandate = toCamel<Mandate>(mandateRow)
  const amount = roundMoney(match.bestPrice ?? listing.price)
  const mandateCheck = (a: number) => ai.checkMandate(mandate, a, 'USD')
  const pre = mandateCheck(amount)
  if (!pre.allowed) {
    const v = pre.violations[0]!
    await logEvent({ userId, matchId, type: 'guardrail_blocked', message: `Checkout blocked: ${v.detail}`, payload: { violations: pre.violations, amount } })
    throw new CheckoutError(v.code, v.detail)
  }

  // 4. guard + the exact input, both built in code.
  const guard = makeCheckoutGuard({ expectedAmount: amount, mandateCheck })
  const input = buildCreateOrderInput({ title: listing.title, amount, returnUrl: `${env.appUrl}/api/checkout/return`, cancelUrl: `${env.appUrl}/api/checkout/cancel` })

  // 5. agentic path: the model calls the guarded PayPal tool. A guard-rejected call becomes a tool-error part, not a result.
  let result: unknown = null
  try {
    const r = await generateText({
      model: getModel('fast'), tools: guardedPayPalTools(guard), toolChoice: 'required', stopWhen: stepCountIs(1),
      prompt: `Create the PayPal order for this purchase. Call the create_order tool with exactly this JSON input and nothing else:\n${JSON.stringify(input)}`,
    })
    const part = r.steps.flatMap((s) => s.content).find((p) => p.type === 'tool-result' && p.toolName === 'create_order')
    if (part && 'output' in part) result = part.output
  } catch (e) {
    console.warn('[checkout] agent path failed, using direct call:', e)
  }
  // deterministic fallback with the code-built input, same guard
  if (!orderIdOf(result)) {
    try {
      result = await callPayPalTool('create_order', input, guard)
    } catch (e) {
      if (isGuardError(e)) {
        const v = e.result.violations[0]
        await logEvent({ userId, matchId, type: 'guardrail_blocked', message: `Checkout blocked: ${v?.detail ?? e.message}`, payload: { violations: e.result.violations, amount } })
        throw new CheckoutError(v?.code ?? 'guardrail_blocked', v?.detail ?? e.message)
      }
      console.warn('[checkout] PayPal create_order failed:', e)
      throw new CheckoutError('paypal_error', 'PayPal could not create the order', 502)
    }
  }
  const paypalOrderId = orderIdOf(result)
  const approveUrl = findApproveUrl(result)
  if (!paypalOrderId || !approveUrl) throw new CheckoutError('paypal_error', 'PayPal did not return an order id and approval link', 502)

  // 6. persist
  const created = unwrap(await db().from('orders').insert({
    match_id: matchId, user_id: userId, paypal_order_id: paypalOrderId, amount, currency: 'USD', status: 'created', approve_url: approveUrl,
  }).select().single(), 'insert order') as Row
  unwrap(await db().from('matches').update({ status: 'checkout_pending' }).eq('id', matchId), 'update match')
  await logEvent({ userId, matchId, type: 'order_created', message: `🧾 PayPal order created for $${amount.toFixed(2)}`, payload: { paypalOrderId, amount } })
  return { orderId: created.id, paypalOrderId, approveUrl }
}

/** Capture an approved order (return URL / webhook). Idempotent: a completed order is returned without calling PayPal. */
export async function captureOrder(paypalOrderId: string): Promise<Order> {
  const row = unwrap(await db().from('orders').select('*').eq('paypal_order_id', paypalOrderId).maybeSingle(), 'load order') as Row | null
  if (!row) throw new CheckoutError('not_found', 'Order not found', 404)
  if (row.status === 'completed') return orderOf(row)
  if (row.status !== 'created' && row.status !== 'failed') throw new CheckoutError('not_capturable', `An order in status "${row.status}" cannot be captured`)

  let status: string | undefined
  let captureId: string | null = null
  let detail = ''
  try {
    // pay_order captures; the checkout guard allows it unconditionally (the amount was fixed at creation).
    const captured = captureOf(await callPayPalTool('pay_order', { id: paypalOrderId }, () => {}))
    status = captured.status
    captureId = captured.captureId
    detail = `status ${status ?? 'unknown'}`
  } catch (e) {
    detail = e instanceof Error ? e.message : 'unknown error'
    console.warn('[checkout] pay_order failed:', e)
  }

  if (status !== 'COMPLETED') {
    unwrap(await db().from('orders').update({ status: 'failed' }).eq('id', row.id), 'fail order')
    await logEvent({ userId: row.user_id, matchId: row.match_id, type: 'order_failed', message: `Payment could not be captured (${detail})`, payload: { paypalOrderId, detail } })
    throw new CheckoutError('capture_failed', `PayPal did not complete the payment (${detail})`)
  }

  const done = unwrap(await db().from('orders').update({ status: 'completed', capture_id: captureId }).eq('id', row.id).select().single(), 'complete order') as Row
  unwrap(await db().from('matches').update({ status: 'purchased' }).eq('id', row.match_id), 'update match')
  const match = unwrap(await db().from('matches').select('*').eq('id', row.match_id).maybeSingle(), 'load match') as Row | null
  const listing = match ? (unwrap(await db().from('listings').select('*').eq('id', match.listing_id).maybeSingle(), 'load listing') as Row | null) : null
  if (match) unwrap(await db().from('wishlist_items').update({ status: 'fulfilled' }).eq('id', match.wishlist_item_id).eq('user_id', row.user_id), 'fulfil wishlist item')
  const title = listing?.title ?? 'your item'
  await logEvent({ userId: row.user_id, matchId: row.match_id, type: 'order_captured', message: `💸 Paid $${roundMoney(Number(row.amount)).toFixed(2)} for "${title}"`, payload: { paypalOrderId, captureId } })
  await sendReceipt(row.user_id, listing ? toCamel<Listing>(listing) : null, roundMoney(Number(row.amount)))
  return orderOf(done)
}

/** The user closed PayPal's approval page: order cancelled, match back to `notified`. Unknown order: null. */
export async function cancelOrder(paypalOrderId: string): Promise<{ matchId: string } | null> {
  const row = unwrap(await db().from('orders').select('*').eq('paypal_order_id', paypalOrderId).maybeSingle(), 'load order') as Row | null
  if (!row) return null
  if (row.status === 'created' || row.status === 'failed') {
    unwrap(await db().from('orders').update({ status: 'cancelled' }).eq('id', row.id), 'cancel order')
    unwrap(await db().from('matches').update({ status: 'notified' }).eq('id', row.match_id).eq('status', 'checkout_pending'), 'reset match')
  }
  return { matchId: row.match_id }
}

/** Telegram receipt: best effort, never blocks or fails the capture. */
async function sendReceipt(userId: string, listing: Listing | null, amount: number): Promise<void> {
  try {
    const profile = unwrap(await db().from('profiles').select('telegram_chat_id').eq('id', userId).maybeSingle(), 'load profile') as Row | null
    if (!profile?.telegram_chat_id || !listing) return
    await tg('sendMessage', { chat_id: profile.telegram_chat_id, parse_mode: 'HTML', text: receiptMessage({ listing, amount }) })
  } catch (e) {
    console.warn('[checkout] telegram receipt failed:', e)
  }
}
