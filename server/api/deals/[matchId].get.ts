import { getMatchDetail } from '~~/server/lib/deals'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const detail = await getMatchDetail(user.id, getRouterParam(event, 'matchId') ?? '')
  if (!detail) throw createError({ statusCode: 404, statusMessage: 'Deal not found' })
  return detail
})
