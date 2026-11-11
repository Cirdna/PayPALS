import { resetUserData } from '~~/server/lib/demo'
import { env } from '~~/server/lib/env'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  if (user.email !== env.demoEmail) throw createError({ statusCode: 403, statusMessage: 'Only the demo account can be reset' })
  await resetUserData(user.id)
  setResponseStatus(event, 204)
  return null
})
