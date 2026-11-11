/**
 * shared/types/index.ts — THE contract between workstreams A (AI), B (payments/integrations), C (app/data/UI).
 * TYPES ONLY in this file. Runtime helpers live in shared/utils/money.ts.
 *
 * Import explicitly everywhere (works in Nuxt, Nitro, vitest and tsx scripts):
 *   import type { Match, Listing } from '#shared/types'
 *   import { roundMoney } from '#shared/utils/money'
 *
 * Change policy: C merges changes; announce every change to all three leads first.
 * DB columns are snake_case; these TS types are camelCase. Convert with toCamel()/toSnake() from server/lib/mappers.ts.
 */

// ───────────────────────── primitives ─────────────────────────

export type UUID = string
export type ISODate = string
/** ISO 4217 code. The whole app uses ONE currency: 'USD' (PayPal Agent Toolkit create_order only accepts USD). */
export type Currency = string

export type Condition = 'new' | 'like_new' | 'good' | 'fair'

// ───────────────────────── wishlist & mandate ─────────────────────────

export type WishlistStatus = 'active' | 'paused' | 'fulfilled'

export interface WishlistItem {
  id: UUID
  userId: UUID
  title: string               // "Wireless ANC headphones"
  query: string               // search query sent to Channel3 + marketplace full-text search (category-level, real words)
  specs: string               // free-text must-haves: "over-ear, active noise cancelling, black, 30h+ battery"
  maxPrice: number            // hard ceiling (also enforced by mandate)
  targetPrice: number | null  // what the buyer agent opens near
  currency: Currency
  minCondition: Condition     // e.g. 'like_new'
  dealbreakers: string[]      // ["refurbished", "on-ear"]
  status: WishlistStatus
  lastScannedAt: ISODate | null
  createdAt: ISODate
}

/** AP2-style spending mandate. Enforced in code by server/lib/ai/guardrail.ts. */
export interface Mandate {
  id: UUID
  userId: UUID
  wishlistItemId: UUID
  maxAmount: number             // created equal to wishlistItem.maxPrice
  currency: Currency
  requireHumanApproval: boolean // MVP: always true (user approves in PayPal)
  expiresAt: ISODate
  revokedAt: ISODate | null
  createdAt: ISODate
}

// ───────────────────────── listings & sellers ─────────────────────────

/**
 * channel3    = real retail/used offers from Channel3. NOT payable through our PayPal checkout
 *               (we are not the merchant) → user gets a "Buy at retailer" link. Also used as price comps.
 * marketplace = our demo secondhand marketplace (seeded, sellers are AI agents). Negotiable + payable via PayPal.
 */
export type ListingSource = 'channel3' | 'marketplace'

export interface Listing {
  id: UUID
  source: ListingSource
  externalId: string          // Channel3 product id or marketplace slug
  title: string
  description: string
  price: number
  currency: Currency
  condition: Condition | null // Channel3: 'new' → 'new', 'used' → 'good'
  url: string | null          // Channel3 offer url; null for marketplace
  imageUrl: string | null     // hidden when DEMO_MODE=true
  retailer: string | null     // Channel3 offer domain
  sellerId: UUID | null       // marketplace only
  negotiable: boolean         // channel3 = false, marketplace = true
  fetchedAt: ISODate
}

/** Public seller info (safe for the client). */
export interface Seller {
  id: UUID
  displayName: string
  accountAgeDays: number
  rating: number | null       // 0–5
  ratingCount: number
  isAgent: boolean            // demo marketplace sellers are AI agents
}

/** SERVER-ONLY (table seller_personas). Never select into a client response. */
export interface SellerPersona {
  style: 'friendly' | 'firm' | 'pushy' | 'scammer' | 'injector' | 'store'
  notes: string               // free text used in the seller agent's system prompt
}

/** SERVER-ONLY (table listing_secrets). */
export interface ListingSecret {
  listingId: UUID
  floorPrice: number
  /** Deterministic seller lines keyed by round number as a string, e.g. {"0": "...", "2": "..."}. Round "0" is the seller's auto-reply/opener and is also fed to the risk engine. */
  scriptedMessages: Record<string, string>
}

// ───────────────────────── matching & risk ─────────────────────────

export interface MatchVerdict {
  isMatch: boolean
  confidence: number          // 0–1 ; < 0.6 is treated as not a match
  reason: string              // one sentence
  mismatches: string[]        // e.g. ["on-ear, not over-ear"]
}

export type RiskLevel = 'low' | 'medium' | 'high'

export type RiskSignalCode =
  | 'price_anomaly'          // far below retail comps (or far below the user's max when no comps)
  | 'off_platform_payment'   // bank transfer / gift card / crypto / "pay outside"
  | 'deposit_request'        // pay before viewing/shipping
  | 'urgency_pressure'       // "today only", "many people asking"
  | 'new_account'
  | 'low_rating'
  | 'suspicious_link'        // shorteners / lookalike courier domains / non-https
  | 'duplicate_text'         // same description reused across different sellers
  | 'condition_mismatch'

export interface RiskSignal {
  code: RiskSignalCode
  weight: number              // contribution to score
  detail: string              // human-readable
  evidence: string | null     // EXACT substring of the listing text / seller opener (validated in code), or null for non-text signals
}

export interface PriceStats {
  compsCount: number
  median: number
  mad: number                 // median absolute deviation
  robustZ: number             // (price - median) / (1.4826 * mad); 0 when mad = 0
  pctOfMedian: number         // price / median
}

export interface RiskAssessment {
  score: number               // 0–100
  level: RiskLevel            // low < 35 ≤ medium < 65 ≤ high
  signals: RiskSignal[]
  priceStats: PriceStats | null // null when fewer than 3 comps
  explanation: string         // LLM summary for medium/high, template for low; may only reference listed signals
}

// ───────────────────────── matches (pipeline state) ─────────────────────────

/**
 * State machine (who sets it):
 *   scan (B):    → mismatch | over_budget | flagged | ready | agreed
 *   negotiate (A): ready → negotiating → agreed | no_deal
 *   notify (B):  agreed → notified
 *   checkout (B): notified|agreed → checkout_pending → purchased   (cancel: checkout_pending → notified)
 *   user (C):    ready|agreed|notified|no_deal → skipped
 */
export type MatchStatus =
  | 'mismatch'         // matcher rejected (kept as the cache so the pair is never re-scored)
  | 'over_budget'      // channel3 match priced above maxPrice: not a deal, kept as a price comp + market context
  | 'flagged'          // risk HIGH → never negotiated or bought
  | 'ready'            // marketplace match, risk ok, waiting to be negotiated
  | 'negotiating'
  | 'agreed'           // negotiation success, or fixed price ≤ maxPrice
  | 'no_deal'
  | 'notified'         // user has been told (Telegram and/or in-app)
  | 'checkout_pending' // PayPal order created, waiting for approval/capture
  | 'purchased'
  | 'skipped'

export interface Match {
  id: UUID
  wishlistItemId: UUID
  listingId: UUID
  status: MatchStatus
  verdict: MatchVerdict | null
  risk: RiskAssessment | null
  bestPrice: number | null    // agreed price, else list price
  notifiedAt: ISODate | null
  createdAt: ISODate
  updatedAt: ISODate
}

// ───────────────────────── negotiation ─────────────────────────

export type NegotiationStatus = 'active' | 'agreed' | 'no_deal'

export interface Negotiation {
  id: UUID
  matchId: UUID
  status: NegotiationStatus
  round: number               // number of completed rounds; one round = one buyer move + one seller move
  maxRounds: number           // default 6
  agreedPrice: number | null
  createdAt: ISODate
  updatedAt: ISODate
}

/** LLM structured output — buyer side. */
export interface BuyerDecision {
  action: 'offer' | 'accept' | 'walk_away'
  price: number | null        // required for 'offer'; for 'accept' it is the seller's last price
  message: string
}

/** LLM structured output — seller side (demo marketplace agents). */
export interface SellerDecision {
  action: 'counter' | 'accept' | 'reject'
  price: number | null
  message: string
}

export type GuardrailViolationCode =
  | 'exceeds_mandate'
  | 'exceeds_max_price'
  | 'mandate_expired'
  | 'mandate_revoked'
  | 'currency_mismatch'
  | 'invalid_price'           // NaN, ≤ 0, missing price on an offer
  | 'non_monotonic_offer'     // buyer offer lower than its own previous offer
  | 'max_rounds'
  | 'off_platform_payment'    // buyer message agrees to pay outside PayPal
  | 'amount_mismatch'         // checkout amount ≠ agreed price
  | 'injection_detected'      // seller text tried to change buyer instructions/limits (logged, never fatal)

export interface GuardrailResult {
  allowed: boolean
  violations: { code: GuardrailViolationCode; detail: string }[]
}

export type NegotiationRole = 'buyer' | 'seller' | 'guardrail'

export interface NegotiationMessage {
  id: UUID
  negotiationId: UUID
  round: number
  role: NegotiationRole
  action: BuyerDecision['action'] | SellerDecision['action'] | 'blocked' | 'flagged'
  price: number | null
  message: string
  guardrail: GuardrailResult | null
  createdAt: ISODate
}

// ───────────────────────── orders (PayPal) ─────────────────────────

export type OrderStatus = 'created' | 'completed' | 'failed' | 'cancelled'

export interface Order {
  id: UUID
  matchId: UUID
  userId: UUID
  paypalOrderId: string
  amount: number
  currency: Currency
  status: OrderStatus
  approveUrl: string | null
  captureId: string | null
  createdAt: ISODate
  updatedAt: ISODate
}

// ───────────────────────── activity log ─────────────────────────

export type AgentEventType =
  | 'scan_started' | 'scan_finished'
  | 'listing_matched' | 'listing_rejected'
  | 'risk_flagged' | 'risk_cleared'
  | 'negotiation_started' | 'negotiation_round' | 'guardrail_blocked' | 'injection_detected' | 'deal_agreed' | 'no_deal'
  | 'deal_notified' | 'order_created' | 'order_captured' | 'order_failed'

export interface AgentEvent {
  id: UUID
  userId: UUID
  matchId: UUID | null
  type: AgentEventType
  message: string             // one line for the activity feed
  payload: Record<string, unknown>
  createdAt: ISODate
}

// ───────────────────────── read models for UI ─────────────────────────

/** One row in the AG Grid Deals board. Built by GET /api/deals. */
export interface DealRow {
  matchId: UUID
  wishlistItemId: UUID
  wishlistTitle: string
  listingTitle: string
  source: ListingSource
  sellerOrRetailer: string
  condition: Condition | null
  listPrice: number
  bestPrice: number
  savings: number             // listPrice - bestPrice
  savingsVsMax: number        // wishlist.maxPrice - bestPrice (negative for over_budget)
  currency: Currency
  riskLevel: RiskLevel | null
  riskScore: number | null
  status: MatchStatus
  payable: boolean            // source === 'marketplace'
  url: string | null
  updatedAt: ISODate
}

export interface MatchDetail {
  match: Match
  listing: Listing
  seller: Seller | null
  wishlistItem: WishlistItem
  mandate: Mandate | null
  negotiation: Negotiation | null
  messages: NegotiationMessage[]
  order: Order | null
}

// ───────────────────────── API payloads ─────────────────────────

export interface CreateWishlistRequest {
  title: string
  query: string
  specs: string
  maxPrice: number
  targetPrice?: number | null
  minCondition: Condition
  dealbreakers?: string[]
  mandateExpiresInDays?: number // default 14
}

/** Cron sends {} (scan the 2 least-recently-scanned active items across all users). The UI sends one wishlistItemId per call. */
export interface ScanRequest { wishlistItemId?: UUID }
export interface ScanResponse {
  itemsScanned: number
  listingsFetched: number
  matchesCreated: number
  flagged: number
  negotiationsStarted: number
  negotiationsAdvanced: number
  notificationsSent: number
}

export interface NegotiationStepResponse {
  negotiation: Negotiation
  newMessages: NegotiationMessage[]
  done: boolean               // negotiation.status !== 'active'
  busy: boolean               // another request holds the lock; nothing was done, call again
}

export interface CheckoutCreateRequest { matchId: UUID }
export interface CheckoutCreateResponse { orderId: UUID; paypalOrderId: string; approveUrl: string }

// ───────────────────────── cross-workstream function contracts ─────────────────────────

/** Implemented by A, exported as `ai` from server/lib/ai/index.ts. Must NOT import from server/lib/integrations. */
export interface AiEngine {
  /** ONE LLM call for up to 10 listings. Returns verdicts in the same order as `listings`.
   *  Throws MatcherUnavailableError (exported from server/lib/ai) when the LLM failed — the caller must then skip the batch
   *  and NOT insert match rows, so the pair is retried on the next scan. */
  matchListings(item: WishlistItem, listings: Listing[]): Promise<MatchVerdict[]>
  /** Rules + stats in code; LLM explanation only when score ≥ 35. `sellerOpener` = listing_secrets.scripted_messages["0"]. */
  assessRisk(input: {
    listing: Listing
    seller: Seller | null
    compPrices: number[]         // prices of Channel3 listings that matched the same wishlist item (any price)
    maxPrice: number             // wishlist max, used as fallback reference when < 3 comps
    sellerOpener?: string | null
  }): Promise<RiskAssessment>
  /** Creates the negotiation (match must be 'ready'), sets match 'negotiating'. Idempotent: returns the existing one. */
  startNegotiation(matchId: UUID): Promise<Negotiation>
  /** Runs ONE round under a DB lock. Never throws for "busy"/"already done" — returns the current state. */
  stepNegotiation(negotiationId: UUID): Promise<NegotiationStepResponse>
  /** Pure. Used by negotiation and by checkout. */
  checkMandate(mandate: Mandate, amount: number, currency: Currency, now?: Date): GuardrailResult
}

/** Normalised Channel3 offer before it is stored as a Listing. */
export type ListingDraft = Omit<Listing, 'id' | 'fetchedAt' | 'sellerId'>

/** Implemented by B, exported as `integrations` from server/lib/integrations/index.ts. May import from server/lib/ai. */
export interface Integrations {
  /** Channel3 search, normalised, USD only, in-stock only, cheapest offer per product. */
  searchProducts(query: string, opts?: { limit?: number }): Promise<ListingDraft[]>
  /**
   * Idempotent. Atomically claims the match (status 'agreed' → 'notified', sets notified_at); only the caller that
   * wins the claim sends Telegram (skipped silently when the user has not linked Telegram). Returns true if it claimed.
   */
  notifyDeal(matchId: UUID): Promise<boolean>
  /** marketplace listings only; checks mandate + amount; reuses an existing 'created' order for the match. */
  createCheckout(matchId: UUID, userId: UUID): Promise<CheckoutCreateResponse>
  /** Idempotent capture by PayPal order id. */
  captureOrder(paypalOrderId: string): Promise<Order>
}
