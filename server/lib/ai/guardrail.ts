import type { BuyerDecision, Currency, GuardrailResult, Mandate, SellerDecision, WishlistItem } from '#shared/types'
import { formatMoney, isValidPrice, roundMoney } from '#shared/utils/money'

/**
 * PURE functions only — no I/O, no LLM, no clock except the `now` parameter.
 * This file is the "AI you can trust with money" claim: every buyer move and every checkout passes through it.
 */
type Violation = GuardrailResult['violations'][number]
const result = (violations: Violation[]): GuardrailResult => ({ allowed: violations.length === 0, violations })

export function checkMandate(mandate: Mandate, amount: number, currency: Currency, now: Date = new Date()): GuardrailResult {
  const v: Violation[] = []
  if (!isValidPrice(amount)) v.push({ code: 'invalid_price', detail: `Amount ${amount} is not a valid price` })
  if (mandate.revokedAt) v.push({ code: 'mandate_revoked', detail: 'The spending mandate was revoked' })
  // fail closed: an unparsable expiry counts as expired
  if (!(Date.parse(mandate.expiresAt) > now.getTime())) v.push({ code: 'mandate_expired', detail: `The spending mandate expired on ${mandate.expiresAt}` })
  if (currency !== mandate.currency) v.push({ code: 'currency_mismatch', detail: `Currency ${currency} does not match mandate currency ${mandate.currency}` })
  // fail closed: a NaN / missing limit is exceeded by everything
  if (isValidPrice(amount) && !(amount <= mandate.maxAmount)) v.push({ code: 'exceeds_mandate', detail: `Amount ${amount} is above the mandate limit ${mandate.maxAmount}` })
  return result(v)
}

/** Phrases that mean "pay outside the platform". Shared with the risk engine. */
export const OFF_PLATFORM_PATTERN = /bank transfer|wire transfer|western union|gift ?card|crypto|usdt|bitcoin|paynow|pay outside|whatsapp/i

/** The price a buyer decision commits to: accept → the seller's price; offer → the stated price, capped at the seller's price. */
export function effectivePrice(decision: BuyerDecision, sellerLastPrice: number): number | null {
  if (decision.action === 'walk_away') return null
  if (decision.action === 'accept') return sellerLastPrice
  return isValidPrice(decision.price) ? Math.min(roundMoney(decision.price), sellerLastPrice) : null
}

export interface BuyerCheckInput {
  decision: BuyerDecision
  mandate: Mandate
  item: WishlistItem
  listingCurrency: Currency
  /** The buyer's earlier offers in this negotiation, oldest first. */
  previousBuyerOffers: number[]
  sellerLastPrice: number
  /** The round this decision belongs to (1-based). */
  round: number
  maxRounds: number
  now?: Date
}

export function checkBuyerDecision(i: BuyerCheckInput): GuardrailResult {
  const { decision } = i
  if (decision.action === 'walk_away') return result([])

  const v: Violation[] = []
  if (i.round > i.maxRounds) v.push({ code: 'max_rounds', detail: `Round ${i.round} is past the limit of ${i.maxRounds} rounds` })

  // accept always means "at the seller's price", whatever number the model wrote; an offer is judged on its stated price.
  const price = decision.action === 'accept' ? i.sellerLastPrice : decision.price
  if (!isValidPrice(price)) {
    v.push({ code: 'invalid_price', detail: `Price ${price} is not a valid price` })
    return result(v)
  }
  v.push(...checkMandate(i.mandate, price, i.listingCurrency, i.now).violations)
  if (!(price <= i.item.maxPrice)) v.push({ code: 'exceeds_max_price', detail: `Price ${price} is above your maximum ${i.item.maxPrice}` })

  const lastOffer = i.previousBuyerOffers.at(-1)
  if (decision.action === 'offer' && lastOffer !== undefined && price < lastOffer) {
    v.push({ code: 'non_monotonic_offer', detail: `Offer ${price} is lower than the previous offer ${lastOffer}` })
  }
  const offPlatform = decision.message.match(OFF_PLATFORM_PATTERN)
  if (offPlatform) v.push({ code: 'off_platform_payment', detail: `Buyer message mentions paying outside the platform ("${offPlatform[0]}")` })
  return result(v)
}

const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all |your |the )?(previous|prior|above) instructions/i,
  /disregard/i,
  /system (notice|prompt|message)/i,
  /you are (now )?authori[sz]ed/i,
  /(new|raised|updated|increased) (the )?(budget|limit|maximum)/i,
  /budget (is|to) (now )?\$?\d/i,
  /as an ai/i,
  /reply with:/i,
]

/** Does seller text try to give the buyer agent instructions or change its limits? Logged and shown, never obeyed. */
export function detectInjection(text: string): { hit: boolean; pattern: string | null } {
  for (const p of INJECTION_PATTERNS) {
    const m = text.match(p)
    if (m) return { hit: true, pattern: m[0] }
  }
  return { hit: false, pattern: null }
}

/** Every money amount written in a text: "$255", "$1,200.50", "255 dollars", "255 usd", "255 bucks", "USD 255". */
export function mentionedAmounts(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(/\$\s*(\d[\d,]*(?:\.\d+)?)|\b(\d[\d,]*(?:\.\d+)?)\s*(?:dollars?|usd|bucks?)\b|\busd\s*(\d[\d,]*(?:\.\d+)?)/gi)) {
    const n = Number((m[1] ?? m[2] ?? m[3]!).replaceAll(',', ''))
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}
const mentionsOnly = (text: string, allowed: number[]): boolean =>
  mentionedAmounts(text).every((a) => allowed.some((x) => Math.abs(x - a) < 0.005))

/** Words a seller uses when giving away the hidden minimum. */
const SELLER_LEAK_PATTERN = /floor|minimum|lowest|bottom\s*line|rock[- ]?bottom|can'?t go (any )?(lower|below)/i
/** Words a buyer uses when giving away its ceiling. */
const BUYER_LEAK_PATTERN = /\bmy (max|maximum|limit|budget|ceiling|cap)\b|\bup to \$|\bceiling\b|\bbudget\b|\b(max|maximum) (price|budget)\b|\bupper limit\b|can'?t go (any )?(higher|above|over)/i

/**
 * Seller / buyer messages written by an LLM may never reveal the hidden floor / the private ceiling.
 * `allowed` = the only amounts the message may mention. Returns `text` when it is clean, otherwise the neutral template.
 */
const scrub = (text: string, leak: RegExp, allowed: number[], neutral: string): string =>
  leak.test(text) || !mentionsOnly(text, allowed) ? neutral : text

/** The buyer's message, with anything that could reveal the private ceiling replaced by a neutral template. Action and price are unchanged. */
export function sanitizeBuyerMessage(decision: BuyerDecision, ctx: { sellerLastPrice: number; previousBuyerOffers: number[] }): BuyerDecision {
  const allowed = [ctx.sellerLastPrice, ...ctx.previousBuyerOffers]
  if (decision.action === 'walk_away') return { ...decision, message: scrub(decision.message, BUYER_LEAK_PATTERN, allowed, "Thanks, I'll pass.") }
  if (decision.action === 'accept') return { ...decision, message: scrub(decision.message, BUYER_LEAK_PATTERN, allowed, `Deal. I accept ${formatMoney(ctx.sellerLastPrice)}.`) }
  const price = isValidPrice(decision.price) ? decision.price : ctx.sellerLastPrice
  return { ...decision, message: scrub(decision.message, BUYER_LEAK_PATTERN, [...allowed, price], `My offer is ${formatMoney(price)}.`) }
}

/**
 * Keeps the demo seller honest to its hidden floor, whatever the seller LLM said.
 * Returns an accept (at the buyer's offer) or a counter with floor ≤ price ≤ sellerLastPrice.
 * When the price had to be changed, the message is replaced so the text matches the number.
 * An LLM message that names the floor, or mentions an amount other than {final price, buyer offer, previous price}, is replaced too.
 * (Scripted seller lines never go through here: they are trusted.)
 */
export function enforceSellerFloor(i: { decision: SellerDecision; floor: number; buyerOffer: number; sellerLastPrice: number }): SellerDecision {
  const { decision, floor, buyerOffer, sellerLastPrice } = i
  const safe = (text: string, finalPrice: number, neutral: string) => scrub(text, SELLER_LEAK_PATTERN, [finalPrice, buyerOffer, sellerLastPrice], neutral)
  const accept = (): SellerDecision => ({
    action: 'accept', price: buyerOffer,
    message: decision.action === 'accept' ? safe(decision.message, buyerOffer, `Deal at ${formatMoney(buyerOffer)}.`) : `Okay, $${buyerOffer} works. Deal.`,
  })

  if (decision.action === 'accept') {
    if (buyerOffer >= floor) return accept()
    const price = Math.min(sellerLastPrice, Math.max(floor, roundMoney((buyerOffer + sellerLastPrice) / 2)))
    return { action: 'counter', price, message: `I can't do $${buyerOffer}. How about $${price}?` }
  }
  if (decision.action === 'reject') return { action: 'counter', price: sellerLastPrice, message: safe(decision.message, sellerLastPrice, "Sorry, I can't do that price.") }

  const wanted = isValidPrice(decision.price) ? roundMoney(decision.price) : sellerLastPrice
  const price = Math.min(sellerLastPrice, Math.max(floor, wanted))
  if (price <= buyerOffer && buyerOffer >= floor) return accept()
  return price === wanted
    ? { action: 'counter', price, message: safe(decision.message, price, `I can do ${formatMoney(price)}.`) }
    : { action: 'counter', price, message: `The best I can do is $${price}.` }
}
