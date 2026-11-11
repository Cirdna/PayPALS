import { Channel3, type Channel3Api } from '@channel3/sdk'
import type { ListingDraft } from '#shared/types'
import { env } from '../env'
import { normaliseProduct } from './channel3-normalise'

/** The slice of the Channel3 SDK we use (lets tests inject a fake). */
export interface Channel3Like {
  products: {
    search(req: { query: string; limit: number; filters?: object }): Promise<{ data: Channel3Api.Product[] }>
  }
}

const CACHE_MS = 10 * 60_000
const cache = new Map<string, { at: number; drafts: ListingDraft[] }>()
let client: Channel3Like | null = null
let retryDelayMs = 1000

/** Tests: inject a fake client (null = back to the real one). Also clears the cache. */
export function setChannel3ClientForTests(c: Channel3Like | null): void {
  client = c
  cache.clear()
}
export function setRetryDelayForTests(ms: number): void {
  retryDelayMs = ms
}

function getClient(): Channel3Like {
  client ??= new Channel3({ apiKey: env.channel3ApiKey, currency: 'USD', country: 'US' }) as unknown as Channel3Like
  return client
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Channel3 search → ListingDrafts (USD, in stock, cheapest offer per product).
 * Cached 10 min per (query, limit), one retry on error, NEVER throws: on failure returns [] so scan continues with the marketplace.
 */
export async function searchProducts(query: string, opts: { limit?: number } = {}): Promise<ListingDraft[]> {
  const limit = opts.limit ?? 10
  const key = `${query}|${limit}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.drafts

  const request = { query, limit, filters: { availability: ['InStock'] } }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const page = await getClient().products.search(request)
      const drafts = (page.data ?? []).map(normaliseProduct).filter((d): d is ListingDraft => d !== null)
      cache.set(key, { at: Date.now(), drafts })
      return drafts
    } catch (e) {
      if (attempt === 1) await sleep(retryDelayMs)
      else console.warn('[channel3] search failed, continuing without retail results:', (e as Error)?.message ?? e)
    }
  }
  return []
}
