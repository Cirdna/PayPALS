import { listEvents } from '~~/server/lib/deals'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return listEvents(user.id, Number(getQuery(event).limit) || 50)
})
