import { ai, NegotiationError } from '~~/server/lib/ai'
import { ownerOfNegotiation } from '~~/server/lib/ai/ownership'
import { integrations } from '~~/server/lib/integrations'

// POST /api/negotiations/:id/step → NegotiationStepResponse. Runs ONE round. Safe to call repeatedly (busy/done are reported, not thrown).
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  if ((await ownerOfNegotiation(id)) !== user.id) throw createError({ statusCode: 404, statusMessage: 'Negotiation not found' })
  try {
    const result = await ai.stepNegotiation(id)
    // The notification lives in workstream B. It is idempotent (atomic claim), so calling it here and from the scan is safe.
    if (result.negotiation.status === 'agreed' && result.newMessages.length > 0) {
      try {
        await integrations.notifyDeal(result.negotiation.matchId)
      } catch (err) {
        console.warn('[negotiation] notifyDeal failed:', err)
      }
    }
    return result
  } catch (e) {
    if (e instanceof NegotiationError) throw createError({ statusCode: 404, statusMessage: e.message, data: { code: e.code } })
    throw e
  }
})
