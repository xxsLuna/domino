import { createAnthropicAdapter } from './anthropic'
import { createOpenAIAdapter } from './openai'
import { createResponsesAdapter } from './responses'
import type { LLMAdapter, LLMConfig } from './types'

export * from './types'

/** Builds the streaming adapter for a BYOK config. Throws on unknown provider. */
export function createAdapter(config: LLMConfig): LLMAdapter {
  switch (config.provider) {
    case 'chat_completions':
      return createOpenAIAdapter(config)
    case 'responses':
      return createResponsesAdapter(config)
    case 'anthropic':
      return createAnthropicAdapter(config)
    default: {
      const never: never = config.provider
      throw new Error(`unknown provider: ${String(never)}`)
    }
  }
}

export function isConfigured(config: LLMConfig | null | undefined): boolean {
  if (!config) return false
  if (!config.model.trim()) return false
  return true
}
