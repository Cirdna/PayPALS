import type { H3Event } from 'h3'
import { createError } from 'h3'
import { serverSupabaseUser } from '#supabase/server'
import { isBearer } from '../lib/secure-compare'

export interface AuthUser { id: string; email: string | null }

/**
 * Auto-imported in every server route. Returns the logged-in user or throws 401.
 * NOTE (@nuxtjs/supabase v2): serverSupabaseUser returns JWT CLAIMS — the user id is `claims.sub`, there is no `.id`.
 */
export async function requireUser(event: H3Event): Promise<AuthUser> {
  const claims = await serverSupabaseUser(event).catch(() => null)
  if (!claims?.sub) throw createError({ statusCode: 401, statusMessage: 'Not signed in' })
  return { id: claims.sub, email: (claims.email as string | undefined) ?? null }
}

/** true when the request carries `Authorization: Bearer <CRON_SECRET>` (used by pg_cron). */
export function isCronRequest(event: H3Event): boolean {
  return isBearer(getHeader(event, 'authorization'), process.env.CRON_SECRET)
}
