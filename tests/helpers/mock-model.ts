import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModel } from 'ai'

/**
 * Mock LLMs for unit tests (AI SDK v7). Verified shapes — copy these, do not guess:
 *   usage and finishReason are OBJECTS in v7, and a tool call's `input` is a JSON STRING.
 * Usage:
 *   setModelForTests('smart', mockJsonModel([{ action: 'offer', price: 300, message: 'hi' }]))
 */
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}
const finish = (unified: string) => ({ unified, raw: unified })

/** Returns the given objects as JSON, one per call (the last one repeats). Pass a string to simulate invalid JSON. */
export function mockJsonModel(responses: unknown[]): LanguageModel {
  let call = 0
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const r = responses[Math.min(call++, responses.length - 1)]
      const text = typeof r === 'string' ? r : JSON.stringify(r)
      return { content: [{ type: 'text', text }], finishReason: finish('stop'), usage, warnings: [] }
    },
  } as never) as unknown as LanguageModel
}

/** Like mockJsonModel, and also counts how many times the model was called (to assert "no LLM call happened"). */
export function countingJsonModel(responses: unknown[]): { model: LanguageModel; calls: () => number } {
  let calls = 0
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      const r = responses[Math.min(calls++, responses.length - 1)]
      const text = typeof r === 'string' ? r : JSON.stringify(r)
      return { content: [{ type: 'text', text }], finishReason: finish('stop'), usage, warnings: [] }
    },
  } as never) as unknown as LanguageModel
  return { model, calls: () => calls }
}

/** Emits exactly one tool call. Use with generateText({ toolChoice: 'required', stopWhen: stepCountIs(1) }). */
export function mockToolCallModel(toolName: string, input: unknown): LanguageModel {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify(input) }],
      finishReason: finish('tool-calls'),
      usage,
      warnings: [],
    }),
  } as never) as unknown as LanguageModel
}

/** Always throws — to test fallbacks. */
export function mockFailingModel(message = 'mock model failure'): LanguageModel {
  return new MockLanguageModelV4({ doGenerate: async () => { throw new Error(message) } } as never) as unknown as LanguageModel
}
