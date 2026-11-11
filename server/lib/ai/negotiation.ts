import { z } from 'zod'
import type {
  BuyerDecision, GuardrailResult, Listing, Mandate, Negotiation, NegotiationMessage, NegotiationStepResponse,
  RiskAssessment, SellerDecision, SellerPersona, WishlistItem,
} from '#shared/types'
import { formatMoney, isValidPrice, roundMoney } from '#shared/utils/money'
import { db, unwrap } from '../db'
import { logEvent } from '../events'
import { toCamel, toCamelList } from '../mappers'
import { NegotiationError } from './errors'
import { checkBuyerDecision, detectInjection, enforceSellerFloor } from './guardrail'
import { buyerPrompt, sellerPrompt } from './prompts/negotiation'
import { generateStructured } from './structured'

type Row = Record<string, any>

const buyerSchema = z.object({ action: z.enum(['offer', 'accept', 'walk_away']), price: z.number().nullable(), message: z.string().min(1).max(600) })
const sellerSchema = z.object({ action: z.enum(['counter', 'accept', 'reject']), price: z.number().nullable(), message: z.string().min(1).max(600) })

/** Violations after which the buyer cannot simply restate an offer. */
const FATAL = new Set(['mandate_expired', 'mandate_revoked', 'currency_mismatch', 'max_rounds'])
const LOCK_SECONDS = 45

const toNegotiation = (r: Row): Negotiation => ({
  id: r.id, matchId: r.match_id, status: r.status, round: r.round, maxRounds: r.max_rounds,
  agreedPrice: r.agreed_price == null ? null : Number(r.agreed_price), createdAt: r.created_at, updatedAt: r.updated_at,
})

async function loadNegotiationRow(id: string): Promise<Row> {
  const row = unwrap(await db().from('negotiations').select('*').eq('id', id).maybeSingle(), 'load negotiation') as Row | null
  if (!row) throw new NegotiationError('not_found', `Negotiation ${id} not found`)
  return row
}

/** Opening offer: the user's target, else 80% of the list price — never above the limit. */
export function openingOffer(item: WishlistItem, listing: Listing, limit: number): number {
  return roundMoney(Math.min(limit, item.targetPrice ?? listing.price * 0.8))
}

export async function startNegotiation(matchId: string): Promise<Negotiation> {
  const match = unwrap(await db().from('matches').select('*').eq('id', matchId).maybeSingle(), 'load match') as Row | null
  if (!match) throw new NegotiationError('not_found', `Match ${matchId} not found`)

  const existing = unwrap(await db().from('negotiations').select('*').eq('match_id', matchId).maybeSingle(), 'load negotiation') as Row | null
  if (existing) return toNegotiation(existing)
  if (match.status !== 'ready') throw new NegotiationError('not_ready', `Match is ${match.status}; only a "ready" match can be negotiated`)

  const listing = toCamel<Listing>(unwrap(await db().from('listings').select('*').eq('id', match.listing_id).single(), 'load listing') as Row)
  const item = unwrap(await db().from('wishlist_items').select('*').eq('id', match.wishlist_item_id).single(), 'load wishlist item') as Row
  const secret = unwrap(await db().from('listing_secrets').select('*').eq('listing_id', listing.id).maybeSingle(), 'load listing secret') as Row | null

  const created = await db().from('negotiations').insert({ match_id: matchId }).select().single()
  if (created.error) {
    // Lost a race with another request: return the negotiation that won.
    const winner = unwrap(await db().from('negotiations').select('*').eq('match_id', matchId).maybeSingle(), 'load negotiation') as Row | null
    if (winner) return toNegotiation(winner)
    throw new Error(`Could not create negotiation: ${created.error.message}`)
  }
  const negotiation = created.data as Row

  unwrap(await db().from('matches').update({ status: 'negotiating' }).eq('id', matchId), 'update match')
  const opener = (secret?.scripted_messages as Record<string, string> | undefined)?.['0']
    ?? `Hi! Yes, it's still available. I'm asking ${formatMoney(listing.price)}.`
  unwrap(await db().from('negotiation_messages').insert({
    negotiation_id: negotiation.id, round: 0, role: 'seller', action: 'counter', price: listing.price, message: opener,
  }), 'insert opener')
  await logEvent({ userId: item.user_id, matchId, type: 'negotiation_started', message: `Negotiating "${listing.title}" (asking ${formatMoney(listing.price)})` })
  return toNegotiation(negotiation)
}

export async function stepNegotiation(negotiationId: string): Promise<NegotiationStepResponse> {
  const before = await loadNegotiationRow(negotiationId)
  if (before.status !== 'active') return { negotiation: toNegotiation(before), newMessages: [], done: true, busy: false }

  const claimed = unwrap(await db().rpc('claim_negotiation', { p_id: negotiationId, p_lock_seconds: LOCK_SECONDS }), 'claim negotiation') as Row[]
  if (claimed.length === 0) {
    const now = await loadNegotiationRow(negotiationId)
    return { negotiation: toNegotiation(now), newMessages: [], done: now.status !== 'active', busy: now.status === 'active' }
  }
  try {
    return await runRound(claimed[0]!)
  } finally {
    await db().from('negotiations').update({ locked_until: null }).eq('id', negotiationId)
  }
}

async function runRound(neg: Row): Promise<NegotiationStepResponse> {
  // ── load everything this round needs (simple queries, one table each) ──
  const match = unwrap(await db().from('matches').select('*').eq('id', neg.match_id).single(), 'load match') as Row
  const listing = toCamel<Listing>(unwrap(await db().from('listings').select('*').eq('id', match.listing_id).single(), 'load listing') as Row)
  const item = toCamel<WishlistItem>(unwrap(await db().from('wishlist_items').select('*').eq('id', match.wishlist_item_id).single(), 'load wishlist item') as Row)
  const mandate = toCamel<Mandate>(unwrap(await db().from('mandates').select('*').eq('wishlist_item_id', item.id).single(), 'load mandate') as Row)
  const secret = unwrap(await db().from('listing_secrets').select('*').eq('listing_id', listing.id).maybeSingle(), 'load listing secret') as Row | null
  const personaRow = listing.sellerId
    ? unwrap(await db().from('seller_personas').select('*').eq('seller_id', listing.sellerId).maybeSingle(), 'load persona') as Row | null
    : null
  const persona: SellerPersona | null = personaRow ? { style: personaRow.style, notes: personaRow.notes } : null
  const history = toCamelList<NegotiationMessage>(unwrap(await db().from('negotiation_messages').select('*').eq('negotiation_id', neg.id).order('created_at', { ascending: true }), 'load messages') as Row[])

  const floor = secret ? Number(secret.floor_price) : listing.price
  const scripted = (secret?.scripted_messages ?? {}) as Record<string, string>
  const limit = Math.min(mandate.maxAmount, item.maxPrice)
  const n: number = neg.round + 1
  const maxRounds: number = neg.max_rounds
  const lastSeller = history.filter((m) => m.role === 'seller').at(-1)
  const sellerLastPrice = lastSeller?.price ?? listing.price
  const previousBuyerOffers = history.filter((m) => m.role === 'buyer' && m.action === 'offer' && m.price != null).map((m) => m.price as number)
  const opening = openingOffer(item, listing, limit)
  const newMessages: NegotiationMessage[] = []

  // Messages are inserted ONE AT A TIME so created_at keeps their order.
  const say = async (role: NegotiationMessage['role'], action: NegotiationMessage['action'], price: number | null, message: string, guardrail: GuardrailResult | null = null) => {
    const row = unwrap(await db().from('negotiation_messages').insert({ negotiation_id: neg.id, round: n, role, action, price, message, guardrail }).select().single(), 'insert message') as Row
    const msg = toCamel<NegotiationMessage>(row)
    newMessages.push(msg)
    history.push(msg)
  }
  const finish = async (status: 'agreed' | 'no_deal', price: number | null): Promise<NegotiationStepResponse> => {
    const row = unwrap(await db().from('negotiations').update({ status, round: n, agreed_price: price }).eq('id', neg.id).select().single(), 'finish negotiation') as Row
    if (status === 'agreed') {
      unwrap(await db().from('matches').update({ status: 'agreed', best_price: price }).eq('id', match.id), 'update match')
      await logEvent({ userId: item.userId, matchId: match.id, type: 'deal_agreed', message: `Agreed ${formatMoney(price!)} for "${listing.title}" (listed ${formatMoney(listing.price)})`, payload: { price, listPrice: listing.price } })
    } else {
      unwrap(await db().from('matches').update({ status: 'no_deal' }).eq('id', match.id), 'update match')
      await logEvent({ userId: item.userId, matchId: match.id, type: 'no_deal', message: `No deal on "${listing.title}"` })
    }
    return { negotiation: toNegotiation(row), newMessages, done: true, busy: false }
  }

  // ── 1. did the seller's last message try to instruct the agent? (logged, never obeyed) ──
  if (lastSeller) {
    const injection = detectInjection(lastSeller.message)
    if (injection.hit) {
      const detail = `Seller message tried to instruct the agent ("${injection.pattern}"). Ignored.`
      await say('guardrail', 'flagged', null, detail, { allowed: true, violations: [{ code: 'injection_detected', detail }] })
      await logEvent({ userId: item.userId, matchId: match.id, type: 'injection_detected', message: `Prompt injection attempt blocked on "${listing.title}"`, payload: { pattern: injection.pattern } })
    }
  }

  // ── 2. buyer move: LLM proposes, code decides ──
  const lastOffer = previousBuyerOffers.at(-1) ?? null
  const fallbackPrice = lastOffer ?? opening
  const bp = buyerPrompt({
    item, listing, limit, openingOffer: opening, retailMedian: (match.risk as RiskAssessment | null)?.priceStats?.median ?? null,
    sellerLastPrice, previousOffer: lastOffer, round: n, maxRounds, history,
  })
  const proposed = await generateStructured({
    kind: 'smart', schema: buyerSchema, system: bp.system, prompt: bp.prompt,
    fallback: { action: 'offer', price: fallbackPrice, message: `My offer is ${formatMoney(fallbackPrice)}.` },
  })
  let decision: BuyerDecision = { ...proposed.value, price: isValidPrice(proposed.value.price) ? roundMoney(proposed.value.price) : proposed.value.price }
  const check = (d: BuyerDecision) => checkBuyerDecision({ decision: d, mandate, item, listingCurrency: listing.currency, previousBuyerOffers, sellerLastPrice, round: n, maxRounds })

  const verdict = check(decision)
  if (!verdict.allowed) {
    const storable = isValidPrice(decision.price) && decision.price < 1e8 ? decision.price : null
    await say('guardrail', 'blocked', storable, `Blocked a buyer move: ${verdict.violations.map((v) => v.detail).join('; ')}`, verdict)
    await logEvent({ userId: item.userId, matchId: match.id, type: 'guardrail_blocked', message: `Guardrail blocked a move on "${listing.title}" (${verdict.violations.map((v) => v.code).join(', ')})`, payload: { violations: verdict.violations } })
    const restated: BuyerDecision = { action: 'offer', price: fallbackPrice, message: `That's more than I can do. My offer stands at ${formatMoney(fallbackPrice)}.` }
    const fatal = verdict.violations.some((v) => FATAL.has(v.code))
    decision = !fatal && check(restated).allowed ? restated : { action: 'walk_away', price: null, message: "I can't go further on this one. Thanks for your time." }
  }

  if (decision.action === 'walk_away') {
    await say('buyer', 'walk_away', null, decision.message)
    return finish('no_deal', null)
  }
  if (decision.action === 'accept') {
    await say('buyer', 'accept', sellerLastPrice, decision.message)
    return finish('agreed', sellerLastPrice)
  }
  const buyerOffer = decision.price as number
  await say('buyer', 'offer', buyerOffer, decision.message)
  if (buyerOffer >= sellerLastPrice) return finish('agreed', sellerLastPrice)

  // ── 3. seller move: scripted line (deterministic demo) or LLM, always clamped to the hidden floor ──
  let seller: SellerDecision
  const line = scripted[String(n)]
  if (line) {
    seller = { action: 'counter', price: sellerLastPrice, message: line }
  } else {
    const sp = sellerPrompt({ persona, listing, floor, sellerLastPrice, buyerOffer, round: n, maxRounds, history })
    const fallbackCounter = Math.max(floor, roundMoney(sellerLastPrice - 5))
    const raw = await generateStructured({
      kind: 'smart', schema: sellerSchema, system: sp.system, prompt: sp.prompt, temperature: 0.6,
      fallback: { action: 'counter', price: fallbackCounter, message: `I can do ${formatMoney(fallbackCounter)}.` },
    })
    seller = enforceSellerFloor({ decision: raw.value, floor, buyerOffer, sellerLastPrice })
  }
  await say('seller', seller.action, seller.price, seller.message)
  if (seller.action === 'accept') return finish('agreed', buyerOffer)

  // ── 4. round bookkeeping ──
  if (n >= maxRounds) return finish('no_deal', null)
  const row = unwrap(await db().from('negotiations').update({ round: n }).eq('id', neg.id).select().single(), 'update round') as Row
  await logEvent({ userId: item.userId, matchId: match.id, type: 'negotiation_round', message: `Round ${n}: offered ${formatMoney(buyerOffer)}, seller at ${formatMoney(seller.price ?? sellerLastPrice)}`, payload: { round: n, buyerOffer, sellerPrice: seller.price } })
  return { negotiation: toNegotiation(row), newMessages, done: false, busy: false }
}
