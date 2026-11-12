import type { Listing, PriceStats, RiskLevel, RiskSignal, Seller } from '#shared/types'
import { OFF_PLATFORM_PATTERN } from '../guardrail'
import { priceStats } from './stats'

export interface RiskInput {
  listing: Listing
  seller: Seller | null
  compPrices: number[]
  maxPrice: number
  sellerOpener?: string | null
}
export interface RiskScore { score: number; level: RiskLevel; signals: RiskSignal[]; priceStats: PriceStats | null }

/** Text rules: first match in the checked text becomes the quoted evidence. */
const TEXT_RULES: { code: RiskSignal['code']; weight: number; pattern: RegExp; detail: string }[] = [
  { code: 'off_platform_payment', weight: 25, pattern: OFF_PLATFORM_PATTERN, detail: 'Asks for payment outside the platform' },
  { code: 'deposit_request', weight: 20, pattern: /deposit|pay first|pay before|reserve fee/i, detail: 'Asks for money before you receive the item' },
  { code: 'suspicious_link', weight: 15, pattern: /http:\/\/\S+|\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|cutt\.ly|is\.gd)\/\S*/i, detail: 'Contains a shortened or insecure link' },
  { code: 'urgency_pressure', weight: 10, pattern: /today only|many people asking|many buyers|other buyers|first to pay|urgent|contact fast/i, detail: 'Pressures you to decide quickly' },
]
const WEAR_PATTERN = /\b(?:used|scratch(?:es|ed)?|wear)\b/i

export const riskLevel = (score: number): RiskLevel => (score >= 65 ? 'high' : score >= 35 ? 'medium' : 'low')

/** The text the rules read. Evidence strings are exact substrings of this. */
export const riskText = (i: Pick<RiskInput, 'listing' | 'sellerOpener'>): string =>
  [i.listing.title, i.listing.description, i.sellerOpener ?? ''].join('\n')

export const normaliseDescription = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** PURE scoring core. `duplicateFound` = another marketplace listing from a different seller has the same normalised description. */
export function scoreRisk(i: RiskInput, duplicateFound: boolean): RiskScore {
  const signals: RiskSignal[] = []
  const text = riskText(i)
  const { price } = i.listing

  const stats = priceStats(price, i.compPrices)
  if (stats) {
    const pct = Math.round(stats.pctOfMedian * 100)
    if (stats.pctOfMedian < 0.35) signals.push({ code: 'price_anomaly', weight: 35, detail: `Price is ${pct}% of the median of ${stats.compsCount} retail offers ($${stats.median})`, evidence: null })
    else if (stats.pctOfMedian < 0.5) signals.push({ code: 'price_anomaly', weight: 20, detail: `Price is ${pct}% of the median of ${stats.compsCount} retail offers ($${stats.median})`, evidence: null })
  } else if (price < 0.3 * i.maxPrice) {
    signals.push({ code: 'price_anomaly', weight: 20, detail: `No retail comparisons yet; price is ${Math.round((price / i.maxPrice) * 100)}% of your maximum`, evidence: null })
  }

  for (const rule of TEXT_RULES) {
    const m = text.match(rule.pattern)
    if (m) signals.push({ code: rule.code, weight: rule.weight, detail: rule.detail, evidence: m[0] })
  }

  if (duplicateFound) signals.push({ code: 'duplicate_text', weight: 20, detail: 'The same description is used by another seller', evidence: null })

  if (i.seller) {
    if (i.seller.accountAgeDays < 30) signals.push({ code: 'new_account', weight: 15, detail: `Seller account is ${i.seller.accountAgeDays} days old`, evidence: null })
    if (i.seller.rating == null || i.seller.rating < 3.5) signals.push({ code: 'low_rating', weight: 10, detail: i.seller.rating == null ? 'Seller has no ratings' : `Seller rating is ${i.seller.rating}`, evidence: null })
  }

  if (i.listing.condition === 'new') {
    const m = `${i.listing.title}\n${i.listing.description}`.match(WEAR_PATTERN)
    if (m) signals.push({ code: 'condition_mismatch', weight: 10, detail: 'Listed as new but the text mentions wear or use', evidence: m[0] })
  }

  signals.sort((a, b) => b.weight - a.weight)
  const score = Math.min(100, signals.reduce((sum, s) => sum + s.weight, 0))
  return { score, level: riskLevel(score), signals, priceStats: stats }
}

/** Deterministic explanation: used for low risk and as the fallback when the LLM explanation fails. */
export function templateExplanation(r: RiskScore): string {
  if (r.signals.length === 0) return 'No significant risk signals.'
  const lead = r.level === 'high' ? 'High risk' : r.level === 'medium' ? 'Some risk' : 'Low risk'
  return `${lead}: ${r.signals.map((s) => s.detail.charAt(0).toLowerCase() + s.detail.slice(1)).join('; ')}.`
}
