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

/**
 * Longest silence tolerated on an open request — no response headers, or no
 * body bytes once streaming. Providers send keep-alives or tokens well within
 * this even while a reasoning model thinks; a connection quiet this long is
 * dead, and waiting out the whole hard cap only bills and blocks the turn.
 */
export const LLM_IDLE_TIMEOUT_MS = 90_000

export interface LLMConfig {
  provider: ProviderId
  /** BYOK key — never logged, never sent anywhere but the provider itself. */
  apiKey?: string
  /** Overrides the provider default base URL (e.g. OpenRouter, Ollama). */
  baseUrl?: string
  model: string
  temperature?: number
  /**
   * Reasoning/thinking depth, provider-agnostic. Adapters map it to their own
   * knob (reasoning_effort, extended-thinking budget, …) on models that
   * advertise one and stay silent where the backend has none — most screen
   * generation is mechanical transcription, so the default leaves it unset
   * and the engine escalates only its corrective round.
   */
  reasoning?: 'none' | 'low' | 'medium' | 'high'
  /**
   * Visible output budget per response (Anthropic's required max_tokens; the
   * thinking budget is added on top). Unset uses the adapter default, always
   * clamped to what the model can emit.
   */
  maxOutputTokens?: number
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
  /**
   * assistant: provider-specific content blocks that must be replayed
   * verbatim (Anthropic thinking / redacted_thinking with their signatures).
   * Opaque to everything but the adapter that produced them — never edit,
   * trim or reorder; other adapters ignore them.
   */
  providerBlocks?: unknown[]
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
  /**
   * The response ended. `truncated` is true when the provider stopped on its
   * output-token limit (Anthropic stop_reason max_tokens, OpenAI
   * finish_reason length, Responses incomplete/max_output_tokens) — any tool
   * call still open at that point is cut off, not finished.
   */
  | { type: 'done'; truncated?: boolean }
  | { type: 'error'; message: string }
  /**
   * Token accounting for ONE HTTP response — each adapter call is its own
   * response, and the values are that response's totals so far (cumulative
   * within it, never across calls). `prompt` includes cached input tokens;
   * `cached` is the part of `prompt` served from the provider's prompt cache.
   */
  | { type: 'usage'; usage: TokenUsage }
  /**
   * Opaque blocks the assistant message must carry for a faithful replay
   * (see ChatMessage.providerBlocks) — the full list for this response,
   * emitted once before `done`.
   */
  | { type: 'provider_blocks'; blocks: unknown[] }

export interface TokenUsage {
  prompt?: number
  completion?: number
  total?: number
  cached?: number
}

export interface ChatRequest {
  /**
   * The FIRST system message is the stable, cacheable prefix (rules, registry,
   * app description — identical across turns of one session); any later
   * system messages are volatile context sent after it, outside the cache
   * breakpoint.
   */
  messages: ChatMessage[]
  tools?: ToolDef[]
  temperature?: number
  /** Caller cancellation (superseded turn, cancelled background build). */
  signal?: AbortSignal
  /** Stable per-domino prompt-cache routing key (sent where the provider takes one). */
  cacheKey?: string
}

export interface LLMAdapter {
  /** Streams normalized deltas; throws on transport/provider errors. */
  chat(req: ChatRequest): AsyncIterable<StreamDelta>
}

export const PROVIDER_META: Record<
  ProviderId,
  {
    label: string
    endpoint: string
    defaultBaseUrl: string
    defaultModel: string
    keyHint: string
    note: string
  }
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
