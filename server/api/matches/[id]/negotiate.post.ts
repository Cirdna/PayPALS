import { ai, NegotiationError } from '~~/server/lib/ai'
import { isUuid, ownerOfMatch } from '~~/server/lib/ai/ownership'

// POST /api/matches/:id/negotiate → Negotiation. Starts (or returns) the negotiation for a "ready" match the user owns.
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const id = getRouterParam(event, 'id') ?? ''
  // Malformed, unknown and foreign ids all get the same 404 (and a malformed id never reaches the database).
  if (!isUuid(id) || (await ownerOfMatch(id)) !== user.id) throw createError({ statusCode: 404, statusMessage: 'Match not found' })
  try {
    return await ai.startNegotiation(id)
  } catch (e) {
    if (e instanceof NegotiationError) {
      throw createError({ statusCode: e.code === 'not_found' ? 404 : 409, statusMessage: e.message, data: { code: e.code } })
    }
    throw e
  }
})
