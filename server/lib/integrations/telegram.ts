import { randomBytes } from 'node:crypto'
import type { Listing, Match, WishlistItem } from '#shared/types'
import { formatMoney, roundMoney } from '#shared/utils/money'
import { db, unwrap } from '../db'
import { env } from '../env'
import { toCamel } from '../mappers'

type Row = Record<string, any>

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Plain-fetch Telegram Bot API call. Throws on HTTP error or { ok: false }.
 * The bot token is part of the URL: errors are re-thrown without the original message so it can never be logged.
 */
export async function tg(method: string, body: object): Promise<any> {
  let res: Response
  try {
    res = await fetch(`https://api.telegram.org/bot${env.telegramBotToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error(`Telegram ${method} request failed`)
  }
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok || !json?.ok) throw new Error(json?.description ?? res.statusText ?? `Telegram ${method} failed`)
  return json
}

export function dealMessage(i: { listing: Listing; item: WishlistItem; match: Match }): {
  text: string
  reply_markup: { inline_keyboard: object[][] }
} {
  const { listing, item, match } = i
  const best = match.bestPrice ?? listing.price
  const saving = roundMoney(listing.price - best)
  const underLimit = roundMoney(item.maxPrice - best)
  const savingText = saving > 0 ? `  (you save ${formatMoney(saving)}; ${formatMoney(underLimit)} under your limit)` : ''
  const lines = [
    `🎯 <b>Deal found: ${escapeHtml(item.title)}</b>`,
    escapeHtml(listing.title),
    `Listed ${formatMoney(listing.price)} → <b>${formatMoney(best)}</b>${savingText}`,
  ]
  if (match.risk) lines.push(`Risk: ${match.risk.level.toUpperCase()} — ${escapeHtml(match.risk.explanation.slice(0, 200))}`)

  const viewUrl = `${env.appUrl}/deals/${match.id}`
  const skip = { text: '🙅 Skip', callback_data: `skip:${match.id}` }
  const view = { text: '🔎 View', url: viewUrl }
  const inline_keyboard: object[][] = listing.source === 'marketplace'
    ? [[{ text: '✅ Approve & pay', callback_data: `pay:${match.id}` }], [view, skip]]
    : [[{ text: '🛒 Buy at retailer', url: listing.url ?? viewUrl }], [view, skip]]
  return { text: lines.join('\n'), reply_markup: { inline_keyboard } }
}

export function receiptMessage(i: { listing: Listing; amount: number }): string {
  return `✅ <b>Paid ${formatMoney(i.amount)}</b> for ${escapeHtml(i.listing.title)}.\nThe seller has been notified. Thanks for using DealHound!`
}

const say = (chatId: number | string, text: string, extra: object = {}) =>
  tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra })

/** Never throws: Telegram retries a webhook that fails, and a bad update must not break anything. */
export async function handleUpdate(update: any): Promise<void> {
  try {
    if (update?.callback_query) return await handleCallback(update.callback_query)
    const text: unknown = update?.message?.text
    const chatId = update?.message?.chat?.id
    if (typeof text === 'string' && chatId != null && text.startsWith('/start')) {
      await handleStart(chatId, text, update.message.chat.type === 'private')
    }
  } catch (e) {
    console.warn('[telegram] handleUpdate failed:', e instanceof Error ? e.message : 'unknown error')
  }
}

async function handleStart(chatId: number, text: string, isPrivate: boolean): Promise<void> {
  // A link token pasted into a group would hand the profile to everyone in that group: private chats only.
  if (!isPrivate) {
    await say(chatId, 'Please open DealHound in a private chat with the bot to link your account.')
    return
  }
  const token = text.split(/\s+/)[1]
  const profile = token
    ? (unwrap(await db().from('profiles').select('*').eq('telegram_link_token', token).maybeSingle(), 'load profile by token') as Row | null)
    : null
  if (!profile) {
    await say(chatId, 'Open Settings in the app and tap “Link Telegram”.')
    return
  }
  // Rotate the token: a leaked link token is single-use.
  const rotated = randomBytes(12).toString('hex')
  unwrap(
    await db().from('profiles').update({ telegram_chat_id: chatId, telegram_link_token: rotated }).eq('id', profile.id),
    'link telegram',
  )
  await say(chatId, "✅ Linked. I'll message you here when I find a deal.")
}

async function handleCallback(cq: any): Promise<void> {
  const cqId = cq.id
  const chatId = cq.message?.chat?.id
  const [action, matchId] = String(cq.data ?? '').split(':')
  if (chatId == null || !matchId || (action !== 'pay' && action !== 'skip')) return
  if (cq.message?.chat?.type !== 'private' || cq.from?.id == null || String(cq.from.id) !== String(chatId)) {
    await tg('answerCallbackQuery', { callback_query_id: cqId, text: 'Please use this button in a private chat' })
    return
  }

  const profile = unwrap(await db().from('profiles').select('*').eq('telegram_chat_id', chatId).maybeSingle(), 'load profile by chat') as Row | null
  if (!profile) {
    await tg('answerCallbackQuery', { callback_query_id: cqId, text: 'Please link your account first' })
    return
  }
  const userId: string = profile.id

  // Ownership: match → wishlist item → user_id (one table per query).
  const match = unwrap(await db().from('matches').select('*').eq('id', matchId).maybeSingle(), 'load match') as Row | null
  const item = match
    ? (unwrap(await db().from('wishlist_items').select('*').eq('id', match.wishlist_item_id).maybeSingle(), 'load item') as Row | null)
    : null
  if (!match || !item || item.user_id !== userId) {
    await tg('answerCallbackQuery', { callback_query_id: cqId, text: 'Deal not found' })
    return
  }

  if (action === 'skip') {
    unwrap(
      await db().from('matches').update({ status: 'skipped' }).eq('id', matchId).in('status', ['ready', 'agreed', 'notified', 'no_deal']),
      'skip match',
    )
    await tg('answerCallbackQuery', { callback_query_id: cqId, text: 'Skipped' })
    return
  }

  await tg('answerCallbackQuery', { callback_query_id: cqId, text: 'Creating your PayPal order…' })
  try {
    // Dynamic import: a static one would create the cycle index → notify → telegram → index.
    const { integrations } = await import('./index')
    const c = await integrations.createCheckout(matchId, userId)
    await say(chatId, 'Approve the payment in PayPal:', {
      reply_markup: { inline_keyboard: [[{ text: '💳 Pay with PayPal', url: c.approveUrl }]] },
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown error'
    // Only CheckoutError messages are written for end users. A static import of the class would create a cycle
    // (checkout → telegram), so match on the name.
    if (e instanceof Error && e.name === 'CheckoutError') {
      await say(chatId, `Couldn't start checkout: ${escapeHtml(message)}`)
    } else {
      console.warn('[telegram] createCheckout failed:', message)
      await say(chatId, 'Something went wrong creating your PayPal order. Please try again from the app.')
    }
  }
}
