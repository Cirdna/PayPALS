import type { PriceStats } from '#shared/types'
import { roundMoney } from '#shared/utils/money'

export function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** Median absolute deviation. */
export function mad(xs: number[]): number {
  const m = median(xs)
  return median(xs.map((x) => Math.abs(x - m)))
}

/** Robust position of `price` among retail comps. null when there are fewer than 3 comps. */
export function priceStats(price: number, compPrices: number[]): PriceStats | null {
  const comps = compPrices.filter((p) => Number.isFinite(p) && p > 0)
  if (comps.length < 3) return null
  const med = median(comps)
  const deviation = mad(comps)
  return {
    compsCount: comps.length,
    median: roundMoney(med),
    mad: roundMoney(deviation),
    robustZ: deviation === 0 ? 0 : Math.round(((price - med) / (1.4826 * deviation)) * 10) / 10,
    pctOfMedian: Math.round((price / med) * 1000) / 1000,
  }
}
