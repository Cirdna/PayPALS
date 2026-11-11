import { describe, expect, it } from 'vitest'
import type { Mandate } from '#shared/types'
import { checkMandate } from '~~/server/lib/ai/guardrail'

const now = new Date('2026-11-12T00:00:00Z')
const mandate = (over: Partial<Mandate> = {}): Mandate => ({
  id: 'm1', userId: 'u1', wishlistItemId: 'w1', maxAmount: 380, currency: 'USD', requireHumanApproval: true,
  expiresAt: '2026-11-26T00:00:00Z', revokedAt: null, createdAt: '2026-11-11T00:00:00Z', ...over,
})
const codes = (r: ReturnType<typeof checkMandate>) => r.violations.map((v) => v.code)

// Starter tests. A: extend this file test-first (see spec A §Guardrail) — including the property test.
describe('checkMandate', () => {
  it('allows an amount at or below the limit', () => {
    expect(checkMandate(mandate(), 380, 'USD', now).allowed).toBe(true)
    expect(checkMandate(mandate(), 365, 'USD', now).allowed).toBe(true)
  })
  it('blocks anything above the limit', () => {
    expect(codes(checkMandate(mandate(), 380.01, 'USD', now))).toEqual(['exceeds_mandate'])
  })
  it('blocks expired and revoked mandates', () => {
    expect(codes(checkMandate(mandate({ expiresAt: '2026-11-11T23:59:59Z' }), 100, 'USD', now))).toContain('mandate_expired')
    expect(codes(checkMandate(mandate({ revokedAt: '2026-11-11T12:00:00Z' }), 100, 'USD', now))).toContain('mandate_revoked')
  })
  it('blocks other currencies and nonsense amounts', () => {
    expect(codes(checkMandate(mandate(), 100, 'SGD', now))).toContain('currency_mismatch')
    for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      expect(checkMandate(mandate(), bad, 'USD', now).allowed).toBe(false)
    }
  })
})
