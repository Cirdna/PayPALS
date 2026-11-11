import { describe, expect, it } from 'vitest'
import { CONDITION_LABEL, EVENT_DANGER, EVENT_ICON, RISK_LABEL, SOURCE_LABEL, STATUS_LABEL, relativeTime } from '../../app/utils/labels'

const NOW = Date.parse('2026-11-12T12:00:00Z')
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString()

describe('relativeTime', () => {
  it('returns an empty string for missing or invalid input', () => {
    expect(relativeTime(null, NOW)).toBe('')
    expect(relativeTime(undefined, NOW)).toBe('')
    expect(relativeTime('not a date', NOW)).toBe('')
  })

  it('says "just now" under 45 seconds, in either direction', () => {
    expect(relativeTime(ago(5), NOW)).toBe('just now')
    expect(relativeTime(ago(-30), NOW)).toBe('just now')
  })

  it('uses minutes, hours and days', () => {
    expect(relativeTime(ago(5 * 60), NOW)).toBe('5 minutes ago')
    expect(relativeTime(ago(3 * 3600), NOW)).toBe('3 hours ago')
    expect(relativeTime(ago(2 * 86_400), NOW)).toBe('2 days ago')
  })

  it('falls back to a short date after a month', () => {
    expect(relativeTime(ago(90 * 86_400), NOW)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/)
  })
})

describe('labels', () => {
  it('every match status has a label, a colour and an icon', () => {
    for (const [status, l] of Object.entries(STATUS_LABEL)) {
      expect(l.label, status).toBeTruthy()
      expect(l.icon, status).toMatch(/^i-lucide-/)
    }
  })

  it('risk colours are green / amber / red', () => {
    expect(RISK_LABEL.low.color).toBe('success')
    expect(RISK_LABEL.medium.color).toBe('warning')
    expect(RISK_LABEL.high.color).toBe('error')
  })

  it('flagged and safety events are shown as dangerous in the activity feed', () => {
    for (const type of ['guardrail_blocked', 'injection_detected', 'risk_flagged'] as const) {
      expect(EVENT_DANGER.has(type), type).toBe(true)
      expect(EVENT_ICON[type], type).toBeTruthy()
    }
  })

  it('names listing sources and conditions for people, not for code', () => {
    expect(SOURCE_LABEL.marketplace).toBe('Marketplace')
    expect(SOURCE_LABEL.channel3).toBe('Retail')
    expect(Object.values(CONDITION_LABEL).every((l) => !l.includes('_'))).toBe(true)
  })
})
