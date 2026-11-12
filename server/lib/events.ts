import type { AgentEventType } from '#shared/types'
import { db } from './db'

/**
 * Append one line to the user's activity feed (table agent_events, shown live in the UI).
 * Never throws: a failed log line must not break a scan, a negotiation or a payment.
 */
export async function logEvent(e: {
  userId: string
  type: AgentEventType
  message: string
  matchId?: string | null
  payload?: Record<string, unknown>
}): Promise<void> {
  try {
    const { error } = await db().from('agent_events').insert({
      user_id: e.userId,
      match_id: e.matchId ?? null,
      type: e.type,
      message: e.message,
      payload: e.payload ?? {},
    })
    if (error) console.warn(`[events] could not log ${e.type}: ${error.message}`)
  } catch (err) {
    console.warn(`[events] could not log ${e.type}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
