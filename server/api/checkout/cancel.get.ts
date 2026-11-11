import { cancelOrder } from '~~/server/lib/integrations/checkout'

export default defineEventHandler(async (event) => {
  const res = await cancelOrder(String(getQuery(event).token ?? ''))
  return sendRedirect(event, res ? `/deals/${res.matchId}?cancelled=1` : '/deals')
})
