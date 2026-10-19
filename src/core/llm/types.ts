/**
 * Normalized chat/stream types shared by every provider adapter.
 * Adapters translate these to and from each provider's wire format.
 */

/**
 * BYOK providers are grouped by the endpoint they expose:
 *   chat_completions → POST <base>/chat/completions (OpenAI-compatible: OpenAI,
 *                      OpenRouter, Groq, LM Studio, Ollama, vLLM, gateways…)
 *   responses        → POST <base>/responses (OpenAI Responses API)
 *   anthropic        → POST <base>/v1/messages (Anthropic Messages API)
 */
export type ProviderId = 'chat_completions' | 'responses' | 'anthropic'

/**
 * Hard ceiling for one streamed LLM request. Normal turns finish in seconds;
 * past this the provider (or the network) is hung, and the turn must fail
 * instead of spinning forever.
 */
export const LLM_TIMEOUT_MS = 300_000

export interface LLMConfig {
  provider: ProviderId
  /** BYOK key — never logged, never sent anywhere but the provider itself. */
  apiKey?: string
  /** Overrides the provider default base URL (e.g. OpenRouter, Ollama). */
  baseUrl?: string
  model: string
  temperature?: number
}

/**
 * Whether a BYOK key must still be entered for this config.
 *
 * A same-origin base URL (leading `/`) goes through the dev proxy, which may
 * inject the key itself — otherwise parse the URL and match loopback hosts by
 * *hostname*, never by substring (an unanchored `localhost` test also matched
 * `https://localhost.evil.com` and `https://evil.com/?x=localhost`).
 */
export function needsApiKey(config: Pick<LLMConfig, 'apiKey' | 'baseUrl'>): boolean {
  if (config.apiKey) return false
  const raw = config.baseUrl ?? ''
  if (raw.startsWith('/')) return false // dev proxy injects the key
  try {
    const h = new URL(raw).hostname
    return h !== 'localhost' && h !== '127.0.0.1' && h !== '[::1]'
  } catch {
    return true // not parseable as absolute URL and not a proxy path
  }
}

export interface ToolCall {
  id: string
  name: string
  /** Accumulated JSON argument text (may be partial while streaming). */
  args: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** assistant: emitted tool calls. */
  toolCalls?: ToolCall[]
  /** tool: which call this result answers, and its original tool name. */
  toolCallId?: string
  toolName?: string
}

export interface ToolDef {
  name: string
  description: string
  /** JSON Schema for arguments. */
  parameters: Record<string, unknown>
}

export type StreamDelta =
  | { type: 'text'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_args'; id: string; argsDelta: string }
  | { type: 'tool_call_end'; id: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: ToolDef[]
  temperature?: number
}

export interface LLMAdapter {
  /** Streams normalized deltas; throws on transport/provider errors. */
  chat(req: ChatRequest): AsyncIterable<StreamDelta>
}

export const PROVIDER_META: Record<
  ProviderId,
  { label: string; endpoint: string; defaultBaseUrl: string; defaultModel: string; keyHint: string; note: string }
> = {
  chat_completions: {
    label: 'Chat Completions (OpenAI 호환)',
    endpoint: '/chat/completions',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keyHint: 'sk-...',
    note: 'OpenAI · OpenRouter · Groq · LM Studio · Ollama(http://127.0.0.1:11434/v1) 등 Base URL만 바꿔 연결됩니다.'
  },
  responses: {
    label: 'Responses (OpenAI)',
    endpoint: '/responses',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keyHint: 'sk-...',
    note: 'OpenAI Responses API를 직접 사용하는 서비스.'
  },
  anthropic: {
    label: 'Anthropic Messages',
    endpoint: '/v1/messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-5',
    keyHint: 'sk-ant-...',
    note: 'Claude 공식 API 및 Anthropic Messages 호환 게이트웨이.'
  }
}
