import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { LanguageModel } from 'ai'
import { env } from '../env'

export type ModelKind = 'smart' | 'fast'

const overrides: Partial<Record<ModelKind, LanguageModel>> = {}

/** Tests: inject a mock model (see tests/helpers/mock-model.ts). Pass null to clear. */
export function setModelForTests(kind: ModelKind, model: LanguageModel | null): void {
  if (model) overrides[kind] = model
  else delete overrides[kind]
}

/**
 * smart = negotiation + risk explanation, fast = batch matching.
 * Model ids come from env (AI_MODEL_SMART / AI_MODEL_FAST) — never hard-code model names elsewhere.
 * To switch provider, change only this file.
 */
export function getModel(kind: ModelKind): LanguageModel {
  const override = overrides[kind]
  if (override) return override
  const google = createGoogleGenerativeAI({ apiKey: env.googleApiKey })
  return google(kind === 'smart' ? env.aiModelSmart : env.aiModelFast)
}
