import { listPurchases } from '~~/server/lib/deals'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return listPurchases(user.id)
})
