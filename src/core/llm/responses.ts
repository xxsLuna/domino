import {
  effectiveReasoning,
  isOpenAIReasoningModel,
  modelTakesReasoning,
  openaiReasoningEffort
} from './reasoning'
import { LLMRequestError, withRetry } from './retry'
import { acceptsPromptCacheKey, routingHeaders } from './routing'
import { openStream, sseData } from './sse'
import { wireToolArgs } from './toolArgs'
import type { ChatMessage, ChatRequest, LLMAdapter, LLMConfig, StreamDelta } from './types'

/**
 * OpenAI Responses API streaming adapter (POST <base>/responses).
 *
 * Wire events consumed:
 *   response.output_text.delta        → text
 *   response.output_item.added        → tool_call_start (function_call items)
 *   response.function_call_arguments.delta → tool_call_args
 *   response.output_item.done         → tool_call_end
 *   response.completed / incomplete   → usage (+ truncated on max_output_tokens)
 *   response.failed / error           → error
 *
 * System messages keep their order (stable prompt first) so the automatic
 * prefix cache matches across turns.
 */

function toResponsesInput(messages: ChatMessage[]): unknown[] {
  const input: unknown[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      input.push({ role: 'system', content: [{ type: 'input_text', text: m.content }] })
    } else if (m.role === 'user') {
      input.push({ role: 'user', content: [{ type: 'input_text', text: m.content }] })
    } else if (m.role === 'assistant') {
      if (m.content) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content }] })
      }
      for (const tc of m.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.name,
          arguments: wireToolArgs(tc.args)
        })
      }
    } else if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.toolCallId,
        output: m.content
      })
    }
  }
  return input
}

interface ResponsesUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
}

interface ResponsesEvent {
  type?: string
  delta?: string
  item?: { id?: string; call_id?: string; name?: string; type?: string }
  item_id?: string
  message?: string
  code?: string
  response?: {
    status?: string
    usage?: ResponsesUsage
    incomplete_details?: { reason?: string } | null
    error?: { message?: string; code?: string } | null
  }
}

function usageDelta(usage: ResponsesUsage | undefined): StreamDelta | null {
  if (!usage || !(usage.input_tokens || usage.output_tokens)) return null
  const cached = usage.input_tokens_details?.cached_tokens
  return {
    type: 'usage',
    usage: {
      prompt: usage.input_tokens,
      completion: usage.output_tokens,
      total: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      ...(cached ? { cached } : {})
    }
  }
}

const TRANSIENT_CODES = /overload|rate.?limit|server.?error|unavailable|timeout/i

export function createResponsesAdapter(config: LLMConfig): LLMAdapter {
  const baseUrl = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')

  async function* attempt(req: ChatRequest): AsyncGenerator<StreamDelta> {
    const level = effectiveReasoning(config)
    const body = {
      model: config.model,
      stream: true,
      // Reasoning models reject any temperature but the default.
      ...(isOpenAIReasoningModel(config.model)
        ? {}
        : { temperature: req.temperature ?? config.temperature ?? 0.7 }),
      // Responses API nests its reasoning knob; same "only if the model
      // advertises one" guard as chat-completions, and the same low default.
      ...(level && modelTakesReasoning(config.model)
        ? { reasoning: { effort: openaiReasoningEffort(level, config.model) } }
        : {}),
      ...(req.cacheKey && acceptsPromptCacheKey(baseUrl) ? { prompt_cache_key: req.cacheKey } : {}),
      input: toResponsesInput(req.messages),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              name: t.name,
              description: t.description,
              parameters: t.parameters
            }))
          }
        : {})
    }
    const { res, guard } = await openStream(
      `${baseUrl}/responses`,
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

    // item.id (streaming id) → call_id (stable id used in results)
    const callIds = new Map<string, { callId: string; ended: boolean }>()
    let truncated = false
    let emitted = false

    try {
      for await (const payload of sseData(res, { idleMs: guard.idleMs, signal: guard.signal })) {
        let event: ResponsesEvent
        try {
          event = JSON.parse(payload)
        } catch {
          continue
        }
        switch (event.type) {
          case 'response.output_item.added': {
            const item = event.item
            if (item?.type === 'function_call' && item.call_id) {
              if (item.id) callIds.set(item.id, { callId: item.call_id, ended: false })
              emitted = true
              yield { type: 'tool_call_start', id: item.call_id, name: item.name ?? '' }
            }
            break
          }
          case 'response.output_text.delta': {
            if (event.delta) {
              emitted = true
              yield { type: 'text', text: event.delta }
            }
            break
          }
          case 'response.function_call_arguments.delta': {
            if (!event.delta) break
            const entry = event.item_id ? callIds.get(event.item_id) : undefined
            if (entry) {
              emitted = true
              yield { type: 'tool_call_args', id: entry.callId, argsDelta: event.delta }
            }
            break
          }
          case 'response.output_item.done': {
            const item = event.item
            if (item?.type === 'function_call' && item.call_id) {
              const entry = item.id ? callIds.get(item.id) : undefined
              if (entry && !entry.ended) {
                entry.ended = true
                emitted = true
                yield { type: 'tool_call_end', id: entry.callId }
              } else if (!entry) {
                emitted = true
                yield { type: 'tool_call_end', id: item.call_id }
              }
            }
            break
          }
          case 'response.failed':
          case 'error': {
            const err = event.response?.error
            const message =
              err?.message || event.message || 'responses API reported a failed response'
            const code = err?.code ?? event.code ?? ''
            if (!emitted && TRANSIENT_CODES.test(code)) {
              throw new LLMRequestError(`LLM request failed: ${message}`, { retryable: true })
            }
            emitted = true
            yield { type: 'error', message }
            break
          }
          case 'response.incomplete':
          case 'response.completed': {
            const r = event.response
            if (r?.incomplete_details?.reason === 'max_output_tokens') truncated = true
            const usage = usageDelta(r?.usage)
            if (usage) {
              emitted = true
              yield usage
            }
            break
          }
          default:
            break
        }
      }
    } finally {
      guard.release()
    }

    for (const entry of callIds.values()) {
      if (!entry.ended) yield { type: 'tool_call_end', id: entry.callId }
    }
    yield truncated ? { type: 'done', truncated: true } : { type: 'done' }
  }

  return {
    chat(req: ChatRequest): AsyncIterable<StreamDelta> {
      return withRetry(() => attempt(req), { signal: req.signal })
    }
  }
}
