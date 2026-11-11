import { deleteWishlistItem } from '~~/server/lib/deals'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const deleted = await deleteWishlistItem(user.id, getRouterParam(event, 'id') ?? '')
  if (!deleted) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  setResponseStatus(event, 204)
  return null
})
