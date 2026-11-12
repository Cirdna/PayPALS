import { listDeals } from '~~/server/lib/deals'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const wishlistItemId = getQuery(event).wishlistItemId
  return listDeals(user.id, typeof wishlistItemId === 'string' && wishlistItemId ? wishlistItemId : undefined)
})
