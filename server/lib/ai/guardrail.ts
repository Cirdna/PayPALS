import type { BuyerDecision, Currency, GuardrailResult, Mandate, SellerDecision, WishlistItem } from '#shared/types'
import { isValidPrice, roundMoney } from '#shared/utils/money'

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
  if (new Date(mandate.expiresAt).getTime() <= now.getTime()) v.push({ code: 'mandate_expired', detail: `The spending mandate expired on ${mandate.expiresAt}` })
  if (currency !== mandate.currency) v.push({ code: 'currency_mismatch', detail: `Currency ${currency} does not match mandate currency ${mandate.currency}` })
  if (isValidPrice(amount) && amount > mandate.maxAmount) v.push({ code: 'exceeds_mandate', detail: `Amount ${amount} is above the mandate limit ${mandate.maxAmount}` })
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
  if (price > i.item.maxPrice) v.push({ code: 'exceeds_max_price', detail: `Price ${price} is above your maximum ${i.item.maxPrice}` })

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
  /disregard (all |your |the )?(previous|prior|above)/i,
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

/**
 * Keeps the demo seller honest to its hidden floor, whatever the seller LLM said.
 * Returns an accept (at the buyer's offer) or a counter with floor ≤ price ≤ sellerLastPrice.
 * When the price had to be changed, the message is replaced so the text matches the number.
 */
export function enforceSellerFloor(i: { decision: SellerDecision; floor: number; buyerOffer: number; sellerLastPrice: number }): SellerDecision {
  const { decision, floor, buyerOffer, sellerLastPrice } = i
  const accept = (): SellerDecision => ({ action: 'accept', price: buyerOffer, message: decision.action === 'accept' ? decision.message : `Okay, $${buyerOffer} works. Deal.` })

  if (decision.action === 'accept') {
    if (buyerOffer >= floor) return accept()
    const price = Math.min(sellerLastPrice, Math.max(floor, roundMoney((buyerOffer + sellerLastPrice) / 2)))
    return { action: 'counter', price, message: `I can't do $${buyerOffer}. How about $${price}?` }
  }
  if (decision.action === 'reject') return { action: 'counter', price: sellerLastPrice, message: decision.message }

  const wanted = isValidPrice(decision.price) ? roundMoney(decision.price) : sellerLastPrice
  const price = Math.min(sellerLastPrice, Math.max(floor, wanted))
  if (price <= buyerOffer && buyerOffer >= floor) return accept()
  return price === wanted ? { action: 'counter', price, message: decision.message } : { action: 'counter', price, message: `The best I can do is $${price}.` }
}
