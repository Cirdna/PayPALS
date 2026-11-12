import { buildCreateOrderInput, callPayPalTool, findApproveUrl } from '~~/server/lib/integrations/paypal-toolkit'

const orderId = process.argv[2]
if (!orderId) {
  const order = await callPayPalTool('create_order', buildCreateOrderInput({ title: 'Spike item', amount: 1, returnUrl: 'https://example.com/return', cancelUrl: 'https://example.com/cancel' }), () => {})
  console.log('RAW create_order result:\n', JSON.stringify(order, null, 2))
  console.log('\nApprove here with the SANDBOX PERSONAL account:\n', findApproveUrl(order))
  console.log('\nThen run:  pnpm spike:paypal <ORDER_ID>')
} else {
  const captured = await callPayPalTool('pay_order', { id: orderId }, () => {})
  console.log('RAW pay_order result:\n', JSON.stringify(captured, null, 2))
}
