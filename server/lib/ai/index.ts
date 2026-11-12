import type { AiEngine } from '#shared/types'
import { checkMandate } from './guardrail'
import { matchListings } from './matcher'
import { startNegotiation, stepNegotiation } from './negotiation'
import { assessRisk } from './risk'

/**
 * THE interface other workstreams import:  import { ai } from '~~/server/lib/ai'
 * Owner: A (lead edits this file).
 * RULE: nothing under server/lib/ai may import from server/lib/integrations (B imports us, not the reverse).
 */
export { MatcherUnavailableError, NegotiationError } from './errors'

export const ai: AiEngine = {
  matchListings,
  assessRisk,
  startNegotiation,
  stepNegotiation,
  checkMandate,
}
