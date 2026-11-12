import { ai, NegotiationError } from '~~/server/lib/ai'
import { isUuid, ownerOfNegotiation } from '~~/server/lib/ai/ownership'
import { integrations } from '~~/server/lib/integrations'

// POST /api/negotiations/:id/step → NegotiationStepResponse. Runs ONE round. Safe to call repeatedly (busy/done are reported, not thrown).
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  // Malformed, unknown and foreign ids all get the same 404 (and a malformed id never reaches the database).
  if (!isUuid(id) || (await ownerOfNegotiation(id)) !== user.id) throw createError({ statusCode: 404, statusMessage: 'Negotiation not found' })
  try {
    const result = await ai.stepNegotiation(id)
    // The notification lives in workstream B. It is idempotent (atomic claim), so calling it here and from the scan is safe.
    if (result.negotiation.status === 'agreed' && result.newMessages.length > 0) {
      try {
        await integrations.notifyDeal(result.negotiation.matchId)
      } catch (err) {
        // Log the message only: the error object can carry request/response details.
        console.warn(`[negotiation] notifyDeal failed: ${err instanceof Error ? err.message : 'unknown error'}`)
      }
    }
    return result
  } catch (e) {
    if (e instanceof NegotiationError) throw createError({ statusCode: 404, statusMessage: e.message, data: { code: e.code } })
    throw e
  }
})
