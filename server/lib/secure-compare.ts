import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Constant-time string comparison. Both sides are hashed first so the inputs always have the same length
 * (timingSafeEqual throws on different lengths, and a length check would itself leak the secret's length).
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

/** true when `header` is exactly `Bearer <secret>` (and a secret is configured). */
export function isBearer(header: string | undefined | null, secret: string | undefined): boolean {
  if (!secret) return false
  return safeEqual(header ?? '', `Bearer ${secret}`)
}
