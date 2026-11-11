import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from './env'

let client: SupabaseClient | null = null

/**
 * Service-role Supabase client: bypasses RLS. SERVER ONLY.
 * Every query that returns user data MUST filter by the user's id yourself.
 * Framework-free so it also works in tsx scripts (seed, eval) and can be mocked in vitest with setDbForTests().
 */
export function db(): SupabaseClient {
  if (!client) {
    client = createClient(env.supabaseUrl, env.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  }
  return client
}

export function setDbForTests(mock: unknown): void {
  client = mock as SupabaseClient | null
}

/** Throws a readable error when a Supabase call failed; returns data otherwise. */
export function unwrap<T>(res: { data: T | null; error: { message: string } | null }, what = 'query'): T {
  if (res.error) throw new Error(`Supabase ${what} failed: ${res.error.message}`)
  return res.data as T
}
