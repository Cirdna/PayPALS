import { runScan, ScanError } from '~~/server/lib/integrations/scan'
import type { ScanRequest } from '#shared/types'

// POST /api/scan → ScanResponse. Cron: Authorization: Bearer CRON_SECRET, body {}. User: body { wishlistItemId }.
export default defineEventHandler(async (event) => {
  const body = ((await readBody(event).catch(() => null)) ?? {}) as ScanRequest
  if (isCronRequest(event)) return runScan({ isCron: true })
  const user = await requireUser(event)
  if (!body.wishlistItemId) throw createError({ statusCode: 400, statusMessage: 'wishlistItemId is required' })
  try {
    return await runScan({ wishlistItemId: body.wishlistItemId, userId: user.id, isCron: false })
  } catch (e) {
    if (e instanceof ScanError) throw createError({ statusCode: 404, statusMessage: e.message })
    throw e
  }
})
