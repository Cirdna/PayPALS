import { describe, expect, it } from 'vitest'
import { isBearer, safeEqual } from '~~/server/lib/secure-compare'

describe('safeEqual', () => {
  it('matches equal strings and rejects different ones, including different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
    expect(safeEqual('', 'x')).toBe(false)
  })
})

describe('isBearer', () => {
  it('accepts exactly "Bearer <secret>"', () => {
    expect(isBearer('Bearer s3cret', 's3cret')).toBe(true)
  })
  it('rejects wrong, missing or differently formed headers', () => {
    expect(isBearer('Bearer nope', 's3cret')).toBe(false)
    expect(isBearer('s3cret', 's3cret')).toBe(false)
    expect(isBearer('bearer s3cret', 's3cret')).toBe(false)
    expect(isBearer('', 's3cret')).toBe(false)
    expect(isBearer(undefined, 's3cret')).toBe(false)
    expect(isBearer(null, 's3cret')).toBe(false)
  })
  it('never authorises when no secret is configured', () => {
    expect(isBearer('Bearer ', '')).toBe(false)
    expect(isBearer('Bearer undefined', undefined)).toBe(false)
    expect(isBearer('', undefined)).toBe(false)
  })
})
