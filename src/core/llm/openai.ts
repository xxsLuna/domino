import {
  effectiveReasoning,
  isOpenAIReasoningModel,
  modelTakesReasoning,
  openaiReasoningEffort
} from './reasoning'
import { LLMRequestError, RETRYABLE_STATUS, withRetry } from './retry'
import { acceptsPromptCacheKey, routingHeaders } from './routing'
import { openStream, sseData } from './sse'
import { wireToolArgs } from './toolArgs'
import type { ChatMessage, ChatRequest, LLMAdapter, LLMConfig, StreamDelta } from './types'

/**
 * OpenAI chat-completions streaming adapter.
 * Also serves Ollama (http://host:11434/v1) and any OpenAI-compatible
 * endpoint (OpenRouter, Groq, LM Studio, vLLM, ...) via baseUrl override.
 *
 * System messages keep their order — the stable prompt first, volatile
 * context after it — so the provider's automatic prefix cache matches the
 * whole stable part from one turn to the next.
 */

interface OpenAIToolCallDelta {
  /** Missing on some gateways; identity then falls back to id, then to the previous call. */
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      tool_calls?: OpenAIToolCallDelta[]
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  error?: { message?: string; type?: string; code?: string | number }
}

function toOpenAIMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = []
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: wireToolArgs(tc.args) }
        }))
      })
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content })
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

/** A mid-stream error object that means "try again later" (overload, rate limit, server fault). */
function transientError(err: NonNullable<OpenAIChunk['error']>): boolean {
  const code = Number(err.code)
  if (Number.isFinite(code) && RETRYABLE_STATUS.has(code)) return true
  return /overload|rate.?limit|server.?error|unavailable|timeout/i.test(
    `${err.type ?? ''} ${err.code ?? ''}`
  )
}

/**
 * Turns tool-call chunks into normalized start/args/end deltas.
 *
 * Identity is the chunk `index` first; the `id` may arrive on the first chunk
 * only, on every chunk, or never (llama.cpp, LM Studio, some vLLM builds —
 * then a unique `call_<index>_…` id is synthesized). Gateways that omit the
 * index are keyed by id, and id-less continuation chunks extend the previous
 * call. A new id at an index already in use is a new call (the old one is
 * closed first) — two calls are never merged.
 */
export class ToolCallTracker {
  private open = new Map<string, { id: string; name: string; ended: boolean; args: boolean }>()
  private lastKey: string | undefined
  private seq = 0
  /** Per-response salt so synthesized ids never collide across iterations of a turn. */
  private readonly nonce: string

  constructor() {
    this.nonce = Math.random().toString(36).slice(2, 8)
  }

  *push(tc: OpenAIToolCallDelta): Generator<StreamDelta> {
    const name = tc.function?.name ?? ''
    let key: string
    if (typeof tc.index === 'number') key = `i${tc.index}`
    else if (tc.id) key = `id:${tc.id}`
    else key = this.lastKey ?? 'i0'

    let entry = this.open.get(key)
    const reused =
      !!entry &&
      (!!(tc.id && tc.id !== entry.id) ||
        // No index, no id, but a fresh name on a call that already has its
        // name and arguments: a provider sending whole calls back to back.
        (typeof tc.index !== 'number' && !tc.id && !!name && !!entry.name && entry.args))
    if (entry && reused) {
      if (!entry.ended) {
        entry.ended = true
        yield { type: 'tool_call_end', id: entry.id }
      }
      this.open.delete(key)
      if (key.startsWith('id:') || !tc.id) key = tc.id ? `id:${tc.id}` : `n${this.seq}`
      entry = undefined
    }
    if (!entry) {
      const id = tc.id || `call_${tc.index ?? this.seq}_${this.nonce}${this.seq}`
      this.seq++
      entry = { id, name, ended: false, args: false }
      this.open.set(key, entry)
      yield { type: 'tool_call_start', id: entry.id, name: entry.name }
    } else if (name && !entry.name) {
      entry.name = name
      yield { type: 'tool_call_start', id: entry.id, name: entry.name }
    }
    this.lastKey = key
    if (tc.function?.arguments) {
      entry.args = true
      yield { type: 'tool_call_args', id: entry.id, argsDelta: tc.function.arguments }
    }
  }

  /** Close every call still open (finish_reason, or the end of the stream). */
  *flush(): Generator<StreamDelta> {
    for (const entry of this.open.values()) {
      if (!entry.ended) {
        entry.ended = true
        yield { type: 'tool_call_end', id: entry.id }
      }
    }
  }
}

export function createOpenAIAdapter(config: LLMConfig): LLMAdapter {
  const baseUrl = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')

  async function* attempt(req: ChatRequest): AsyncGenerator<StreamDelta> {
    // Only models that advertise a reasoning knob get one; classic models
    // (and non-OpenAI-compatible backends) reject the param outright. An
    // unset level runs OpenAI reasoning models at low, not their slow
    // default — and they reject any temperature, so none is sent.
    const level = effectiveReasoning(config)
    const effort =
      level && modelTakesReasoning(config.model)
        ? { reasoning_effort: openaiReasoningEffort(level, config.model) }
        : {}
    const body = {
      model: config.model,
      stream: true,
      ...(isOpenAIReasoningModel(config.model)
        ? {}
        : { temperature: req.temperature ?? config.temperature ?? 0.7 }),
      ...effort,
      ...(req.cacheKey && acceptsPromptCacheKey(baseUrl) ? { prompt_cache_key: req.cacheKey } : {}),
      messages: toOpenAIMessages(req.messages),
      // Ask for the terminal usage chunk (OpenAI-compatible servers ignore
      // the flag; those that never send usage simply never emit a delta).
      stream_options: { include_usage: true },
      ...(req.tools?.length
        ? { tools: req.tools.map((t) => ({ type: 'function', function: t })) }
        : {})
    }
    const { res, guard } = await openStream(
      `${baseUrl}/chat/completions`,
      {
        headers: {
          'content-type': 'application/json',
          ...routingHeaders(baseUrl),
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {})
        },
        body: JSON.stringify(body)
      },
      { signal: req.signal }
    )

    const calls = new ToolCallTracker()
    let truncated = false
    let emitted = false

    try {
      for await (const payload of sseData(res, { idleMs: guard.idleMs, signal: guard.signal })) {
        let json: OpenAIChunk
        try {
          json = JSON.parse(payload)
        } catch {
          continue
        }
        if (json.error) {
          const message = json.error.message || json.error.type || 'provider error'
          if (!emitted && transientError(json.error)) {
            throw new LLMRequestError(`LLM request failed: ${message}`, { retryable: true })
          }
          emitted = true
          yield { type: 'error', message }
          continue
        }
        const u = json.usage
        if (u && (u.prompt_tokens || u.completion_tokens)) {
          const cached = u.prompt_tokens_details?.cached_tokens
          emitted = true
          yield {
            type: 'usage',
            usage: {
              prompt: u.prompt_tokens,
              completion: u.completion_tokens,
              total: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
              ...(cached ? { cached } : {})
            }
          }
        }
        const choice = json.choices?.[0]
        if (!choice) continue

        if (choice.delta?.content) {
          emitted = true
          yield { type: 'text', text: choice.delta.content }
        }

        for (const tc of choice.delta?.tool_calls ?? []) {
          emitted = true
          yield* calls.push(tc)
        }

        if (choice.finish_reason) {
          if (choice.finish_reason === 'length') truncated = true
          yield* calls.flush()
        }
      }
    } finally {
      guard.release()
    }

    yield* calls.flush()
    yield truncated ? { type: 'done', truncated: true } : { type: 'done' }
  }

  return {
    chat(req: ChatRequest): AsyncIterable<StreamDelta> {
      return withRetry(() => attempt(req), { signal: req.signal })
    }
  }
}
