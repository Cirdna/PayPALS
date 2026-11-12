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

export {
  GENERATED_PREFIX, generatedExternalId, generateListings, isGenerated, isGeneratedFor, planGeneratedListings, templateText,
} from './listing-gen'
export type { GeneratedListingDraft, GeneratedSellerStyle, GeneratedSlotKind } from './listing-gen'

export const ai:AiEngine = {
  matchListings,
  assessRisk,
  startNegotiation,
  stepNegotiation,
  checkMandate,
}
