import { generateText, Output } from 'ai'
import type { z } from 'zod'
import { getModel, type ModelKind } from './model'

export interface StructuredResult<T> {
  value: T
  /** true when the model failed twice and `fallback` was returned. */
  usedFallback: boolean
  error?: string
}

/**
 * The ONLY way this codebase asks an LLM for JSON.
 * AI SDK v7: `generateObject` is deprecated → `generateText` + `Output.object`. Result is on `.output`.
 * Never throws: two attempts, then the caller's deterministic fallback.
 */
export async function generateStructured<S extends z.ZodTypeAny>(opts: {
  kind: ModelKind
  schema: S
  system: string
  prompt: string
  fallback: z.infer<S>
  temperature?: number
  attempts?: number
}): Promise<StructuredResult<z.infer<S>>> {
  const attempts = opts.attempts ?? 2
  let lastError = ''
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await generateText({
        model: getModel(opts.kind),
        output: Output.object({ schema: opts.schema }),
        system: opts.system,
        prompt: opts.prompt,
        temperature: opts.temperature ?? 0.3,
        maxRetries: 2, // SDK-level retry for 429/5xx with backoff
        abortSignal: AbortSignal.timeout(10_000), // a hung model counts as a failed attempt → retry, then the fallback (Vercel allows 60 s per request)
      })
      return { value: result.output as z.infer<S>, usedFallback: false }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
  }
  console.warn(`[ai] structured generation failed, using fallback: ${lastError}`)
  return { value: opts.fallback, usedFallback: true, error: lastError }
}

/** Wrap untrusted text (seller messages, listing descriptions, Channel3 data) before putting it in a prompt. */
export function untrusted(tag: string, text: string): string {
  const safe = text.replaceAll('<', '‹').replaceAll('>', '›')
  return `<untrusted_${tag}>\n${safe}\n</untrusted_${tag}>`
}
