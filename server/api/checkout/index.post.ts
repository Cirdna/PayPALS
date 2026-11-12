import { CheckoutError, createCheckout } from '~~/server/lib/integrations/checkout'
import type { CheckoutCreateRequest } from '#shared/types'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = (await readBody(event)) as CheckoutCreateRequest
  if (!body?.matchId) throw createError({ statusCode: 400, statusMessage: 'matchId is required' })
  try {
    return await createCheckout(body.matchId, user.id)
  } catch (e) {
    if (e instanceof CheckoutError) throw createError({ statusCode: e.statusCode, statusMessage: e.message, data: { code: e.code } })
    throw e
  }
})
