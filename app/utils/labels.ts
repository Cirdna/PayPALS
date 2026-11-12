// Owner: C ("grid"). Shared labels/colours/icons. Auto-imported in app/** (Nuxt scans app/utils).
import type { AgentEventType, Condition, ListingSource, MatchStatus, RiskLevel } from '#shared/types'

export type UiColor = 'primary' | 'success' | 'warning' | 'error' | 'info' | 'neutral'

export const STATUS_LABEL: Record<MatchStatus, { label: string; color: UiColor; icon: string }> = {
  mismatch: { label: 'Not a match', color: 'neutral', icon: 'i-lucide-x' },
  over_budget: { label: 'Over budget', color: 'neutral', icon: 'i-lucide-trending-up' },
  flagged: { label: 'Flagged', color: 'error', icon: 'i-lucide-flag' },
  ready: { label: 'Ready to negotiate', color: 'info', icon: 'i-lucide-message-circle' },
  negotiating: { label: 'Negotiating…', color: 'primary', icon: 'i-lucide-messages-square' },
  agreed: { label: 'Deal agreed', color: 'success', icon: 'i-lucide-handshake' },
  no_deal: { label: 'No deal', color: 'neutral', icon: 'i-lucide-ban' },
  notified: { label: 'Awaiting your approval', color: 'success', icon: 'i-lucide-bell-ring' },
  checkout_pending: { label: 'Paying…', color: 'warning', icon: 'i-lucide-credit-card' },
  purchased: { label: 'Purchased', color: 'success', icon: 'i-lucide-circle-check' },
  skipped: { label: 'Skipped', color: 'neutral', icon: 'i-lucide-skip-forward' },
}

export const RISK_LABEL: Record<RiskLevel, { label: string; color: UiColor }> = {
  low: { label: 'Low risk', color: 'success' },
  medium: { label: 'Medium risk', color: 'warning' },
  high: { label: 'High risk', color: 'error' },
}

export const EVENT_ICON: Partial<Record<AgentEventType, string>> = {
  scan_started: 'i-lucide-search',
  scan_finished: 'i-lucide-search-check',
  listing_matched: 'i-lucide-check',
  risk_flagged: 'i-lucide-flag',
  negotiation_started: 'i-lucide-messages-square',
  negotiation_round: 'i-lucide-message-circle',
  guardrail_blocked: 'i-lucide-shield-alert',
  injection_detected: 'i-lucide-shield-alert',
  deal_agreed: 'i-lucide-handshake',
  no_deal: 'i-lucide-ban',
  deal_notified: 'i-lucide-bell-ring',
  order_created: 'i-lucide-receipt',
  order_captured: 'i-lucide-circle-check',
  order_failed: 'i-lucide-circle-x',
}

/** Event types that are rendered in the error colour in the activity feed. */
export const EVENT_DANGER: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
  'guardrail_blocked',
  'injection_detected',
  'risk_flagged',
])

export const SOURCE_LABEL: Record<ListingSource, string> = { marketplace: 'Marketplace', channel3: 'Retail' }

export const CONDITION_LABEL: Record<Condition, string> = {
  new: 'New',
  like_new: 'Like new',
  good: 'Good',
  fair: 'Fair',
}

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

/** "just now", "5 minutes ago", "yesterday". `now` is injectable so callers can tick and tests stay deterministic. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const seconds = Math.round((t - now) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 45) return 'just now'
  if (abs < 3600) return RTF.format(Math.round(seconds / 60), 'minute')
  if (abs < 86_400) return RTF.format(Math.round(seconds / 3600), 'hour')
  if (abs < 86_400 * 30) return RTF.format(Math.round(seconds / 86_400), 'day')
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
