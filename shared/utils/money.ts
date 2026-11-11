import type { Condition } from '#shared/types'

/** The whole app uses one currency. PayPal Agent Toolkit's create_order only accepts USD. */
export const APP_CURRENCY = 'USD'

export const roundMoney = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100

/** PayPal REST wants amounts as strings with 2 decimals. */
export const toPayPalAmount = (x: number): string => roundMoney(x).toFixed(2)

export const isValidPrice = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0

export const formatMoney = (x: number, currency: string = APP_CURRENCY): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(x)

export const CONDITION_RANK: Record<Condition, number> = { new: 3, like_new: 2, good: 1, fair: 0 }

/** true when `actual` is at least as good as `min`. Unknown condition (null) is treated as 'good'. */
export const meetsCondition = (actual: Condition | null, min: Condition): boolean =>
  CONDITION_RANK[actual ?? 'good'] >= CONDITION_RANK[min]
