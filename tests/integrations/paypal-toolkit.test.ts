import { generateText, stepCountIs } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk'
import type { GuardrailResult } from '#shared/types'
import {
  buildCreateOrderInput, callPayPalTool, findApproveUrl, guardedPayPalTools, makeCheckoutGuard,
  PayPalGuardError, setRawPayPalToolsForTests,
} from '~~/server/lib/integrations/paypal-toolkit'
import { mockToolCallModel } from '../helpers/mock-model'

// Real toolkit schemas (no network needed to construct), fake execute so PayPal is never contacted.
const execute = vi.fn(async () => JSON.stringify({ id: '5O190127TN364715T', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T' }] }))

beforeEach(() => {
  execute.mockClear()
  const toolkit = new PayPalAgentToolkit({
    clientId: 'test', clientSecret: 'test',
    configuration: { actions: { orders: { create: true, get: true, capture: true } }, context: { sandbox: true } },
  })
  const tools = toolkit.getTools() as unknown as Record<string, { description?: string; parameters: unknown; execute: typeof execute }>
  for (const t of Object.values(tools)) t.execute = execute
  setRawPayPalToolsForTests(tools as never)
})
afterEach(() => setRawPayPalToolsForTests(null))

const mandateCheck = (limit: number) => (amount: number): GuardrailResult =>
  amount <= limit ? { allowed: true, violations: [] } : { allowed: false, violations: [{ code: 'exceeds_mandate', detail: 'over limit' }] }
const input = (amount: number) => buildCreateOrderInput({ title: 'ANC headphones', amount, returnUrl: 'https://app.test/api/checkout/return', cancelUrl: 'https://app.test/api/checkout/cancel' })

describe('toolkit surface (fails loudly if a toolkit upgrade renames tools)', () => {
  it('exposes create_order, get_order, pay_order', () => {
    expect(Object.keys(guardedPayPalTools(() => {})).sort()).toEqual(['create_order', 'get_order', 'pay_order'])
  })
})

describe('checkout guard — direct call', () => {
  it('lets the exact agreed amount through and parses the JSON result', async () => {
    const guard = makeCheckoutGuard({ expectedAmount: 365, mandateCheck: mandateCheck(380) })
    const order = await callPayPalTool('create_order', input(365), guard)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(findApproveUrl(order)).toContain('token=5O190127TN364715T')
  })
  it('blocks an amount above the mandate before PayPal is called', async () => {
    const guard = makeCheckoutGuard({ expectedAmount: 520, mandateCheck: mandateCheck(380) })
    await expect(callPayPalTool('create_order', input(520), guard)).rejects.toBeInstanceOf(PayPalGuardError)
    expect(execute).not.toHaveBeenCalled()
  })
  it('blocks an amount that differs from the agreed price even when it is under the mandate', async () => {
    const guard = makeCheckoutGuard({ expectedAmount: 365, mandateCheck: mandateCheck(380) })
    await expect(callPayPalTool('create_order', input(370), guard)).rejects.toMatchObject({ result: { violations: [{ code: 'amount_mismatch' }] } })
    expect(execute).not.toHaveBeenCalled()
  })
  it('blocks padded orders (extra items, shipping, tax, quantity)', async () => {
    const guard = makeCheckoutGuard({ expectedAmount: 365, mandateCheck: mandateCheck(380) })
    const base = input(365)
    const variants = [
      { ...base, shippingCost: 10 },
      { ...base, items: [...base.items, base.items[0]!] },
      { ...base, items: [{ ...base.items[0]!, quantity: 2 }] },
      { ...base, items: [{ ...base.items[0]!, taxPercent: 8 }] },
      { ...base, currencyCode: 'SGD' },
    ]
    for (const v of variants) await expect(callPayPalTool('create_order', v, guard)).rejects.toBeInstanceOf(PayPalGuardError)
    expect(execute).not.toHaveBeenCalled()
  })
  it('allows capture and lookup', async () => {
    const guard = makeCheckoutGuard({ expectedAmount: 365, mandateCheck: mandateCheck(380) })
    await callPayPalTool('pay_order', { id: '5O190127TN364715T' }, guard)
    await callPayPalTool('get_order', { id: '5O190127TN364715T' }, guard)
    expect(execute).toHaveBeenCalledTimes(2)
  })
})

describe('checkout guard — LLM tool call (AI SDK v7)', () => {
  const run = (amount: number, expectedAmount: number) => generateText({
    model: mockToolCallModel('create_order', input(amount)),
    tools: guardedPayPalTools(makeCheckoutGuard({ expectedAmount, mandateCheck: mandateCheck(380) })),
    toolChoice: 'required',
    stopWhen: stepCountIs(1), // single step: with toolChoice 'required' a second step without a tool call throws
    prompt: 'Create the PayPal order.',
  })
  const parts = (r: Awaited<ReturnType<typeof run>>) => r.steps.flatMap((s) => s.content)

  it('a correct tool call reaches PayPal and returns a tool-result', async () => {
    const r = await run(365, 365)
    expect(execute).toHaveBeenCalledTimes(1)
    const result = parts(r).find((p) => p.type === 'tool-result')
    expect(findApproveUrl(result && 'output' in result ? result.output : null)).toContain('sandbox.paypal.com')
  })
  it('a tool call the model inflated (prompt injection) becomes a tool-error and never reaches PayPal', async () => {
    const r = await run(520, 365)
    expect(execute).not.toHaveBeenCalled()
    expect(parts(r).some((p) => p.type === 'tool-error')).toBe(true)
    expect(parts(r).some((p) => p.type === 'tool-result')).toBe(false)
  })
})
