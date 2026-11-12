import { listWishlist } from '~~/server/lib/deals'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return listWishlist(user.id)
})
