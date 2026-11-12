import { tool, type ToolSet } from 'ai'
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk'
import type { GuardrailResult } from '#shared/types'
import { APP_CURRENCY, roundMoney } from '#shared/utils/money'
import { env } from '../env'

/**
 * PayPal Agent Toolkit behind a code-enforced guard. Verified against @paypal/agent-toolkit 1.11.0 + ai 7:
 *  - with actions { orders: { create, get, capture } } the toolkit exposes exactly: create_order, get_order, pay_order
 *    (pay_order = capture an approved order).
 *  - create_order input: { currencyCode: 'USD' (only USD!), items: [{ name, quantity, itemCost, itemTotal, description?,
 *    taxPercent? }], shippingCost?, discount?, returnUrl?, cancelUrl? }
 *  - the toolkit ships tools in the AI SDK v4 shape ({ description, parameters, execute }); the app uses AI SDK v7,
 *    so guardedPayPalTools() re-wraps them with tool({ inputSchema }) — do not pass toolkit.getTools() to generateText directly.
 */

export class PayPalGuardError extends Error {
  constructor(public readonly result: GuardrailResult) {
    super(`Blocked by guardrail: ${result.violations.map((v) => v.code).join(', ')}`)
    this.name = 'PayPalGuardError'
  }
}

/** Throw PayPalGuardError to block the call BEFORE PayPal is contacted. */
export type ToolGuard = (toolName: string, input: unknown) => void

interface RawTool { description?: string; parameters: unknown; execute: (input: unknown, options: unknown) => Promise<unknown> }
type RawTools = Record<string, RawTool>

let raw: RawTools | null = null

function rawTools(): RawTools {
  if (!raw) {
    const toolkit = new PayPalAgentToolkit({
      clientId: env.paypalClientId,
      clientSecret: env.paypalClientSecret,
      configuration: { actions: { orders: { create: true, get: true, capture: true } }, context: { sandbox: true } },
    })
    raw = toolkit.getTools() as unknown as RawTools
  }
  return raw
}

/** Tests: replace the toolkit tools (or pass null to reset). */
export function setRawPayPalToolsForTests(tools: RawTools | null): void {
  raw = tools
}

/**
 * Toolkit tools re-wrapped for AI SDK v7, every execute goes through `guard` first. Pass to generateText({ tools }).
 * `names` limits what the model can even see (checkout exposes ONLY create_order).
 */
export function guardedPayPalTools(guard: ToolGuard, names?: readonly string[]): ToolSet {
  const out: ToolSet = {}
  for (const [name, t] of Object.entries(rawTools())) {
    if (names && !names.includes(name)) continue
    out[name] = tool({
      description: t.description,
      inputSchema: t.parameters as never,
      execute: async (input: unknown) => {
        guard(name, input)
        return parseToolResult(await t.execute(input, { toolCallId: `guarded-${name}`, messages: [] }))
      },
    })
  }
  return out
}

/** Deterministic call (no LLM) through the same guard. Use for capture, and as the fallback when the LLM tool call fails. */
export async function callPayPalTool(name: 'create_order' | 'get_order' | 'pay_order', input: unknown, guard: ToolGuard): Promise<unknown> {
  const t = rawTools()[name]
  if (!t) throw new Error(`PayPal tool ${name} is not enabled`)
  guard(name, input)
  return parseToolResult(await t.execute(input, { toolCallId: `direct-${name}`, messages: [] }))
}

export interface CreateOrderInput {
  currencyCode: string
  items: { name: string; quantity?: number; description?: string; itemCost: number; itemTotal: number; taxPercent?: number }[]
  shippingCost?: number
  discount?: number
  returnUrl?: string
  cancelUrl?: string
}

/** The exact create_order input for one deal. Build it in code; the LLM is only asked to reproduce it. */
export function buildCreateOrderInput(o: { title: string; amount: number; returnUrl: string; cancelUrl: string }): CreateOrderInput {
  const amount = roundMoney(o.amount)
  return {
    currencyCode: APP_CURRENCY,
    items: [{ name: o.title.slice(0, 120), quantity: 1, itemCost: amount, itemTotal: amount }],
    shippingCost: 0,
    discount: 0,
    returnUrl: o.returnUrl,
    cancelUrl: o.cancelUrl,
  }
}

/**
 * Guard for a single checkout: create_order must be ONE item, quantity 1, no tax/shipping/discount, in USD,
 * for EXACTLY the agreed amount, that amount must pass the mandate check, and returnUrl / cancelUrl / item name /
 * item description must equal the code-built `expectedInput` (the model may not redirect the buyer elsewhere).
 * get_order / pay_order are blocked unless `allowCapture` (the model-facing path never sets it; the deterministic
 * capture in checkout.ts uses its own no-op guard). Every other tool is blocked.
 */
export function makeCheckoutGuard(opts: {
  expectedAmount: number
  mandateCheck: (amount: number) => GuardrailResult
  expectedInput: CreateOrderInput
  allowCapture?: boolean
}): ToolGuard {
  return (toolName, input) => {
    if ((toolName === 'get_order' || toolName === 'pay_order') && opts.allowCapture) return
    if (toolName !== 'create_order') {
      throw new PayPalGuardError({ allowed: false, violations: [{ code: 'amount_mismatch', detail: `Tool ${toolName} is not allowed during checkout` }] })
    }
    const i = input as CreateOrderInput
    const violations: GuardrailResult['violations'] = []
    const item = i?.items?.[0]
    const simple = i?.items?.length === 1 && (item?.quantity ?? 1) === 1 && !item?.taxPercent && !i.shippingCost && !i.discount
    const amount = item ? roundMoney(item.itemTotal) : Number.NaN
    if (i?.currencyCode !== APP_CURRENCY) violations.push({ code: 'currency_mismatch', detail: `Order currency must be ${APP_CURRENCY}` })
    if (!simple || !item || roundMoney(item.itemCost) !== amount) violations.push({ code: 'amount_mismatch', detail: 'Order must be exactly one item, quantity 1, without tax, shipping or discount' })
    if (amount !== roundMoney(opts.expectedAmount)) violations.push({ code: 'amount_mismatch', detail: `Order amount ${amount} does not equal the agreed price ${roundMoney(opts.expectedAmount)}` })
    const want = opts.expectedInput
    if (i?.returnUrl !== want.returnUrl || i?.cancelUrl !== want.cancelUrl || item?.name !== want.items[0]?.name || item?.description !== want.items[0]?.description) {
      violations.push({ code: 'amount_mismatch', detail: 'Order return URL, cancel URL, item name and description must be exactly the ones built by the server' })
    }
    if (Number.isFinite(amount)) violations.push(...opts.mandateCheck(amount).violations)
    if (violations.length > 0) throw new PayPalGuardError({ allowed: false, violations })
  }
}

/** Toolkit tools return a JSON string (or an object). Normalise to an object; leave non-JSON strings alone. */
export function parseToolResult(result: unknown): unknown {
  if (typeof result !== 'string') return result
  try { return JSON.parse(result) } catch { return result }
}

/** Find the buyer approval link in a PayPal order object (REST or toolkit result). */
export function findApproveUrl(order: unknown): string | null {
  const links = (order as { links?: { rel?: string; href?: string }[] } | null)?.links ?? []
  const link = links.find((l) => l.rel === 'payer-action') ?? links.find((l) => l.rel === 'approve')
  return link?.href ?? null
}
