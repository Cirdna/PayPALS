import { afterEach, describe, expect, it } from 'vitest'
import { getModel } from '~~/server/lib/ai/model'

const saved = { ...process.env }
afterEach(() => { process.env = { ...saved } })

const providerOf = (m: unknown) => (m as { provider: string }).provider
const idOf = (m: unknown) => (m as { modelId: string }).modelId

describe('getModel provider switch', () => {
  it('defaults to Groq: gpt-oss-20b negotiates, gpt-oss-120b matches', () => {
    delete process.env.AI_PROVIDER; delete process.env.AI_MODEL_SMART; delete process.env.AI_MODEL_FAST
    process.env.GROQ_API_KEY = 'test'
    expect(providerOf(getModel('smart'))).toContain('groq')
    expect(idOf(getModel('smart'))).toBe('openai/gpt-oss-20b')
    expect(idOf(getModel('fast'))).toBe('openai/gpt-oss-120b')
  })
  it('AI_MODEL_SMART / AI_MODEL_FAST override the ids', () => {
    process.env.GROQ_API_KEY = 'test'; process.env.AI_MODEL_SMART = 'x/smart'; process.env.AI_MODEL_FAST = 'x/fast'
    expect(idOf(getModel('smart'))).toBe('x/smart')
    expect(idOf(getModel('fast'))).toBe('x/fast')
  })
  it('AI_PROVIDER=google switches back to Gemini with its own defaults', () => {
    process.env.AI_PROVIDER = 'google'; process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test'
    delete process.env.AI_MODEL_SMART; delete process.env.AI_MODEL_FAST
    expect(providerOf(getModel('smart'))).toContain('google')
    expect(idOf(getModel('smart'))).toBe('gemini-flash-latest')
    expect(idOf(getModel('fast'))).toBe('gemini-flash-lite-latest')
  })
  it('fails clearly when the Groq key is missing', () => {
    delete process.env.AI_PROVIDER; delete process.env.GROQ_API_KEY
    expect(() => getModel('smart')).toThrow(/GROQ_API_KEY/)
  })
})
