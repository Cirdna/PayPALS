import { skipMatch } from '~~/server/lib/deals'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const skipped = await skipMatch(user.id, getRouterParam(event, 'matchId') ?? '')
  if (!skipped) throw createError({ statusCode: 404, statusMessage: 'Deal not found' })
  setResponseStatus(event, 204)
  return null
})
