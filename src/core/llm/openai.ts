import { httpFetch } from '../net'
import { modelTakesReasoning, openaiReasoningEffort } from './reasoning'
import { routingHeaders } from './routing'
import { readError, sseData } from './sse'
import type { ChatMessage, ChatRequest, LLMAdapter, LLMConfig, StreamDelta } from './types'
import { LLM_TIMEOUT_MS } from './types'

/**
 * OpenAI chat-completions streaming adapter.
 * Also serves Ollama (http://host:11434/v1) and any OpenAI-compatible
 * endpoint (OpenRouter, Groq, LM Studio, vLLM, ...) via baseUrl override.
 */

interface OpenAIToolCallDelta {
  index: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
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
          function: { name: tc.name, arguments: tc.args }
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

export function createOpenAIAdapter(config: LLMConfig): LLMAdapter {
  const baseUrl = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')
  return {
    async *chat(req: ChatRequest): AsyncIterable<StreamDelta> {
      // Only models that advertise a reasoning knob get one; classic models
      // (and non-OpenAI-compatible backends) reject the param outright.
      const effort =
        config.reasoning && modelTakesReasoning(config.model)
          ? { reasoning_effort: openaiReasoningEffort(config.reasoning) }
          : {}
      const body = {
        model: config.model,
        stream: true,
        temperature: config.temperature ?? 0.7,
        ...effort,
        messages: toOpenAIMessages(req.messages),
        // Ask for the terminal usage chunk (OpenAI-compatible servers ignore
        // the flag; those that never send usage simply never emit a delta).
        stream_options: { include_usage: true },
        ...(req.tools?.length
          ? { tools: req.tools.map((t) => ({ type: 'function', function: t })) }
          : {})
      }
      const res = await httpFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...routingHeaders(baseUrl),
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {})
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
      })
      if (!res.ok) throw new Error(`LLM request failed: ${await readError(res)}`)

      // Track open tool calls by chunk index (provider re-sends id/name early only).
      const open = new Map<number, { id: string; name: string; ended: boolean }>()
      let sawToolCall = false

      for await (const payload of sseData(res)) {
        let json: {
          choices?: Array<{
            delta?: {
              content?: string | null
              tool_calls?: OpenAIToolCallDelta[]
            }
            finish_reason?: string | null
          }>
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
        }
        try {
          json = JSON.parse(payload)
        } catch {
          continue
        }
        if (json.usage && (json.usage.prompt_tokens || json.usage.completion_tokens)) {
          yield {
            type: 'usage',
            usage: {
              prompt: json.usage.prompt_tokens,
              completion: json.usage.completion_tokens,
              total: json.usage.total_tokens
            }
          }
        }
        const choice = json.choices?.[0]
        if (!choice) continue

        if (choice.delta?.content) {
          yield { type: 'text', text: choice.delta.content }
        }

        for (const tc of choice.delta?.tool_calls ?? []) {
          sawToolCall = true
          let entry = open.get(tc.index)
          if (!entry && tc.id) {
            entry = { id: tc.id, name: tc.function?.name ?? '', ended: false }
            open.set(tc.index, entry)
            yield { type: 'tool_call_start', id: entry.id, name: entry.name }
          } else if (entry && tc.function?.name && !entry.name) {
            entry.name = tc.function.name
            yield { type: 'tool_call_start', id: entry.id, name: entry.name }
          }
          if (tc.function?.arguments) {
            if (!entry && tc.id) {
              entry = { id: tc.id, name: tc.function.name ?? '', ended: false }
              open.set(tc.index, entry)
              yield { type: 'tool_call_start', id: entry.id, name: entry.name }
            }
            if (entry) yield { type: 'tool_call_args', id: entry.id, argsDelta: tc.function.arguments }
          }
        }

        if (choice.finish_reason === 'tool_calls') {
          for (const entry of open.values()) {
            if (!entry.ended) {
              entry.ended = true
              yield { type: 'tool_call_end', id: entry.id }
            }
          }
        }
      }

      for (const entry of open.values()) {
        if (!entry.ended) yield { type: 'tool_call_end', id: entry.id }
      }
      void sawToolCall
      yield { type: 'done' }
    }
  }
}
