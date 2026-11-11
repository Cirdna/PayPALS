import { mkdirSync, writeFileSync } from 'node:fs'
import { Channel3, type Channel3Api } from '@channel3/sdk'
import { normaliseProduct } from '~~/server/lib/integrations/channel3-normalise'

// B0 spike: run with `pnpm spike:channel3` (needs CHANNEL3_API_KEY in .env).
// Saves the raw responses as test fixtures and prints what survives normalisation, price spread and latency.
const apiKey = process.env.CHANNEL3_API_KEY
if (!apiKey) throw new Error('Missing CHANNEL3_API_KEY (see .env.example)')
const client = new Channel3({ apiKey, currency: 'USD', country: 'US' })

const queries = [
  { query: '75% hot-swappable wireless mechanical keyboard', file: 'channel3-keyboard.json' },
  { query: 'wireless noise cancelling headphones', file: 'channel3-headphones.json' },
]
const outDir = new URL('../tests/integrations/fixtures/', import.meta.url)
mkdirSync(outDir, { recursive: true })

async function run(query: string, filters: object) {
  const started = Date.now()
  const page = await client.products.search({ query, limit: 10, filters })
  const ms = Date.now() - started
  const products: Channel3Api.Product[] = page.data
  const drafts = products.map(normaliseProduct).filter((d) => d !== null)
  const prices = drafts.map((d) => d.price).sort((a, b) => a - b)
  return { products, drafts, prices, ms }
}

for (const { query, file } of queries) {
  let variant = "filters: { availability: ['InStock'] }"
  let r = await run(query, { availability: ['InStock'] })
  if (r.drafts.length < 3) {
    const retry = await run(query, {})
    console.log(`  only ${r.drafts.length} products survived with the availability filter; with filters {}: ${retry.drafts.length}`)
    if (retry.drafts.length > r.drafts.length) {
      r = retry
      variant = 'filters: {} (no availability filter)'
    }
  }
  writeFileSync(new URL(file, outDir), JSON.stringify(r.products, null, 2))
  const median = r.prices.length ? r.prices[Math.floor(r.prices.length / 2)] : null
  console.log(`\n"${query}"  [${variant}]`)
  console.log(`  products returned: ${r.products.length}`)
  console.log(`  surviving normaliseProduct: ${r.drafts.length}`)
  console.log(`  price min / median / max: ${r.prices[0] ?? '-'} / ${median ?? '-'} / ${r.prices[r.prices.length - 1] ?? '-'}`)
  console.log(`  elapsed: ${r.ms} ms`)
  console.log(`  saved: tests/integrations/fixtures/${file}`)
}
