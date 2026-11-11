import type { Integrations } from '#shared/types'

/**
 * THE interface other workstreams import:  import { integrations } from '~~/server/lib/integrations'
 * Owner: B. The bodies below are STUBS so A and C can build in parallel — B replaces them one by one.
 * Files under server/lib/integrations MAY import from server/lib/ai (never the other way round).
 */
const notImplemented = (name: string): never => {
  throw new Error(`integrations.${name} is not implemented yet (workstream B)`)
}

export const integrations: Integrations = {
  // STUB: no Channel3 results. B → channel3.ts (use normaliseProduct from channel3-normalise.ts)
  async searchProducts() { return [] },
  // STUB: logs only. B → notify.ts
  async notifyDeal(matchId) {
    console.log(`[stub] notifyDeal(${matchId})`)
    return false
  },
  // B → checkout.ts
  async createCheckout() { return notImplemented('createCheckout') },
  async captureOrder() { return notImplemented('captureOrder') },
}
