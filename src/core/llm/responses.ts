import { httpFetch } from '../net'
import { routingHeaders } from './routing'
import { readError, sseData } from './sse'
import type { ChatMessage, ChatRequest, LLMAdapter, LLMConfig, StreamDelta } from './types'
import { LLM_TIMEOUT_MS } from './types'

/**
 * OpenAI Responses API streaming adapter (POST <base>/responses).
 *
 * Wire events consumed:
 *   response.output_text.delta        → text
 *   response.output_item.added        → tool_call_start (function_call items)
 *   response.function_call_arguments.delta → tool_call_args
 *   response.output_item.done         → tool_call_end
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
          arguments: tc.args || '{}'
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

interface ResponsesEvent {
  type?: string
  delta?: string
  item?: { id?: string; call_id?: string; name?: string; type?: string }
  item_id?: string
}

export function createResponsesAdapter(config: LLMConfig): LLMAdapter {
  const baseUrl = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')
  return {
    async *chat(req: ChatRequest): AsyncIterable<StreamDelta> {
      const res = await httpFetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...routingHeaders(baseUrl),
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {})
        },
        body: JSON.stringify({
          model: config.model,
          stream: true,
          temperature: config.temperature ?? 0.7,
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
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS)
      })
      if (!res.ok) throw new Error(`LLM request failed: ${await readError(res)}`)

      // item.id (streaming id) → call_id (stable id used in results)
      const callIds = new Map<string, { callId: string; started: boolean; ended: boolean }>()

      for await (const payload of sseData(res)) {
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
              const entry = {
                callId: item.call_id,
                started: true,
                ended: false
              }
              if (item.id) callIds.set(item.id, entry)
              yield { type: 'tool_call_start', id: item.call_id, name: item.name ?? '' }
            }
            break
          }
          case 'response.output_text.delta': {
            if (event.delta) yield { type: 'text', text: event.delta }
            break
          }
          case 'response.function_call_arguments.delta': {
            if (!event.delta) break
            const entry = event.item_id ? callIds.get(event.item_id) : undefined
            if (entry) yield { type: 'tool_call_args', id: entry.callId, argsDelta: event.delta }
            break
          }
          case 'response.output_item.done': {
            const item = event.item
            if (item?.type === 'function_call' && item.call_id) {
              const entry = item.id ? callIds.get(item.id) : undefined
              if (entry && !entry.ended) {
                entry.ended = true
                yield { type: 'tool_call_end', id: entry.callId }
              } else if (!entry) {
                yield { type: 'tool_call_end', id: item.call_id }
              }
            }
            break
          }
          case 'response.failed': {
            yield { type: 'error', message: 'responses API reported a failed response' }
            break
          }
          default:
            break
        }
      }

      for (const entry of callIds.values()) {
        if (!entry.ended) yield { type: 'tool_call_end', id: entry.callId }
      }
      yield { type: 'done' }
    }
  }
}
