// Owner: C ("pages"). Purchase history helpers (pure, unit-tested in tests/app/purchases.test.ts).
import type { DealRow, Order } from '#shared/types'
import { roundMoney } from '#shared/utils/money'

/** One row of GET /api/deals/purchases: a purchased deal and its completed PayPal order. */
export interface Purchase {
  deal: DealRow
  order: Order
}

export interface PurchaseTotals {
  count: number
  spent: number
  /** Sum of (list price − amount paid), never negative per purchase. */
  saved: number
}

type TotalsInput = { deal: Pick<DealRow, 'listPrice'>; order: Pick<Order, 'amount'> }

export function purchaseTotals(purchases: readonly TotalsInput[]): PurchaseTotals {
  let spent = 0
  let saved = 0
  for (const p of purchases) {
    spent = roundMoney(spent + p.order.amount)
    saved = roundMoney(saved + Math.max(0, p.deal.listPrice - p.order.amount))
  }
  return { count: purchases.length, spent, saved }
}
