import type { LanguageModelV3 } from "@ai-sdk/provider"
import { KiroLanguageModel } from "./kiro-language-model"

export interface KiroProviderSettings {
  readonly fetch?: typeof globalThis.fetch
  readonly context?: number
}

export interface KiroProvider {
  (modelId: string): LanguageModelV3
  languageModel(modelId: string): LanguageModelV3
}

export function createKiro(settings: KiroProviderSettings = {}): KiroProvider {
  const provider = (modelId: string): LanguageModelV3 =>
    new KiroLanguageModel(modelId, {
      provider: "kiro",
      fetch: settings.fetch,
      context: settings.context,
    })

  provider.languageModel = provider

  return provider
}
