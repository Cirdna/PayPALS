/**
 * shared/types.ts — THE contract between workstreams A (AI), B (payments/integrations), C (app/data/UI).
 * Nuxt 4 auto-imports `shared/` into both `app/` and `server/`.
 *
 * Change policy: C merges changes; announce every change to all three leads.
 * DB columns are snake_case; these TS types are camelCase. Map at the DB boundary (server/utils/db-mappers.ts, owned by C).
 */

// ───────────────────────── primitives ─────────────────────────

export type UUID = string
export type ISODate = string
/** ISO 4217 code. MVP uses a single app currency from APP_CURRENCY (default 'USD'). */
export type Currency = string

export const roundMoney = (x: number): number => Math.round(x * 100) / 100
/** PayPal wants amounts as strings with 2 decimals. */
export const toPayPalAmount = (x: number): string => roundMoney(x).toFixed(2)

export type Condition = 'new' | 'like_new' | 'good' | 'fair'
export const CONDITION_RANK: Record<Condition, number> = { new: 3, like_new: 2, good: 1, fair: 0 }

// ───────────────────────── wishlist & mandate ─────────────────────────

export type WishlistStatus = 'active' | 'paused' | 'fulfilled'

export interface WishlistItem {
  id: UUID
  userId: UUID
  title: string               // "Noise-cancelling headphones X5"
  query: string               // search query sent to Channel3 / marketplace
  specs: string               // free-text must-haves: "black, model X5 not X4, with case"
  maxPrice: number            // hard ceiling (also enforced by mandate)
  targetPrice: number | null  // what the buyer agent opens near
  currency: Currency
  minCondition: Condition     // e.g. 'like_new'
  dealbreakers: string[]      // ["no meet-up outside Singapore", "no refurbished"]
  status: WishlistStatus
  createdAt: ISODate
}

/** AP2-style spending mandate. Enforced in code by server/lib/ai/guardrail.ts. */
export interface Mandate {
  id: UUID
  userId: UUID
  wishlistItemId: UUID
  maxAmount: number
  currency: Currency
  requireHumanApproval: boolean // MVP: always true (approve in PayPal)
  expiresAt: ISODate
  revokedAt: ISODate | null
  createdAt: ISODate
}

// ───────────────────────── listings & sellers ─────────────────────────

export type ListingSource = 'channel3' | 'marketplace'

export interface Listing {
  id: UUID
  source: ListingSource
  externalId: string          // Channel3 product id or marketplace slug
  title: string
  description: string
  price: number
  currency: Currency
  condition: Condition | null // Channel3 retail → 'new'
  url: string | null
  imageUrl: string | null     // hidden in DEMO_MODE (trademark-safe video)
  retailer: string | null     // Channel3 retailer name
  sellerId: UUID | null       // marketplace only
  negotiable: boolean         // retail = false, marketplace = usually true
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

/** SERVER-ONLY. Never select into a client response. */
export interface SellerPersona {
  style: 'friendly' | 'firm' | 'pushy' | 'scammer' | 'injector'
  /** Floor price per listing is stored on listings.floor_price (server-only column). */
  notes: string               // free text used in the seller agent's system prompt
}

// ───────────────────────── matching & risk ─────────────────────────

export interface MatchVerdict {
  isMatch: boolean
  confidence: number          // 0–1
  reason: string              // one sentence
  mismatches: string[]        // e.g. ["model X4 not X5"]
}

export type RiskLevel = 'low' | 'medium' | 'high'

export type RiskSignalCode =
  | 'price_anomaly'          // statistically far below retail comps
  | 'off_platform_payment'   // PayNow/bank transfer/gift card/crypto to a stranger
  | 'deposit_request'        // pay before viewing/shipping
  | 'urgency_pressure'       // "today only", "many people asking"
  | 'new_account'
  | 'low_rating'
  | 'suspicious_link'        // shortened / lookalike domains, fake courier links
  | 'duplicate_text'         // same description reused across sellers
  | 'condition_mismatch'

export interface RiskSignal {
  code: RiskSignalCode
  weight: number              // contribution to score
  detail: string              // human-readable
  evidence: string | null     // EXACT substring from the listing/message (validated)
}

export interface PriceStats {
  compsCount: number
  median: number
  mad: number                 // median absolute deviation
  robustZ: number             // (price - median) / (1.4826 * mad)
  pctOfMedian: number         // price / median
}

export interface RiskAssessment {
  score: number               // 0–100
  level: RiskLevel            // low < 35 ≤ medium < 65 ≤ high
  signals: RiskSignal[]
  priceStats: PriceStats | null
  explanation: string         // LLM summary, must reference only listed signals
}

// ───────────────────────── matches (pipeline state) ─────────────────────────

export type MatchStatus =
  | 'new'             // created by scan, not yet scored
  | 'mismatch'        // matcher rejected
  | 'flagged'         // risk HIGH → never negotiated or bought
  | 'ready'           // matched + risk ok, not negotiable or awaiting negotiation
  | 'negotiating'
  | 'agreed'          // negotiation success (or fixed price within mandate)
  | 'no_deal'
  | 'notified'        // Telegram sent
  | 'checkout_pending'
  | 'purchased'
  | 'skipped'         // user said no

export interface Match {
  id: UUID
  wishlistItemId: UUID
  listingId: UUID
  status: MatchStatus
  verdict: MatchVerdict | null
  risk: RiskAssessment | null
  bestPrice: number | null    // agreed price, else list price
  createdAt: ISODate
  updatedAt: ISODate
}

// ───────────────────────── negotiation ─────────────────────────

export type NegotiationStatus = 'active' | 'agreed' | 'no_deal' | 'blocked'

export interface Negotiation {
  id: UUID
  matchId: UUID
  status: NegotiationStatus
  round: number
  maxRounds: number           // default 6
  agreedPrice: number | null
  createdAt: ISODate
  updatedAt: ISODate
}

/** LLM structured output — buyer side. */
export interface BuyerDecision {
  action: 'offer' | 'accept' | 'walk_away'
  price: number | null
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
  | 'non_monotonic_offer'     // buyer may not lower→raise→lower erratically; offers must be non-decreasing
  | 'max_rounds'
  | 'off_platform_payment'    // buyer agent must never agree to pay outside PayPal
  | 'injection_detected'      // seller text tried to change buyer instructions/limits (logged, not fatal)

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
  action: BuyerDecision['action'] | SellerDecision['action'] | 'blocked'
  price: number | null
  message: string
  guardrail: GuardrailResult | null
  createdAt: ISODate
}

// ───────────────────────── orders (PayPal) ─────────────────────────

export type OrderStatus = 'created' | 'approved' | 'completed' | 'failed' | 'cancelled'

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
  | 'negotiation_round' | 'guardrail_blocked' | 'injection_detected' | 'deal_agreed' | 'no_deal'
  | 'telegram_sent' | 'order_created' | 'order_captured' | 'order_failed'

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
  savingsVsMax: number        // wishlist.maxPrice - bestPrice
  currency: Currency
  riskLevel: RiskLevel | null
  riskScore: number | null
  status: MatchStatus
  url: string | null
  updatedAt: ISODate
}

export interface MatchDetail {
  match: Match
  listing: Listing
  seller: Seller | null
  wishlistItem: WishlistItem
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

export interface ScanRequest { wishlistItemId?: UUID } // omit = all active items (cron)
export interface ScanResponse {
  itemsScanned: number
  listingsFetched: number
  matchesCreated: number
  flagged: number
  negotiationsStarted: number
  notificationsSent: number
}

export interface NegotiationStepResponse {
  negotiation: Negotiation
  newMessages: NegotiationMessage[]
  done: boolean
}

export interface CheckoutCreateRequest { matchId: UUID }
export interface CheckoutCreateResponse { orderId: UUID; paypalOrderId: string; approveUrl: string }

// ───────────────────────── cross-workstream function signatures ─────────────────────────
// Implemented by A in server/lib/ai/*, called by B's scan pipeline and C's endpoints.

export interface AiEngine {
  matchListing(item: WishlistItem, listing: Listing): Promise<MatchVerdict>
  assessRisk(input: { listing: Listing; seller: Seller | null; comps: Listing[]; firstSellerMessage?: string }): Promise<RiskAssessment>
  startNegotiation(matchId: UUID): Promise<Negotiation>
  stepNegotiation(negotiationId: UUID): Promise<NegotiationStepResponse>
  checkMandate(mandate: Mandate, amount: number, currency: Currency, now?: Date): GuardrailResult
}

// Implemented by B in server/lib/integrations/*.
export interface Integrations {
  searchProducts(query: string, opts?: { maxPrice?: number; limit?: number }): Promise<Omit<Listing, 'id' | 'fetchedAt'>[]>
  sendDealNotification(userId: UUID, matchId: UUID): Promise<void>
  createCheckout(matchId: UUID, userId: UUID): Promise<CheckoutCreateResponse>
  captureOrder(paypalOrderId: string): Promise<Order>
}
