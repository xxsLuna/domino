import { readError, sseData } from './sse'
import type { ChatMessage, ChatRequest, LLMAdapter, LLMConfig, StreamDelta } from './types'

/**
 * Anthropic Messages API streaming adapter (tool use via content blocks).
 */

function toAnthropic(messages: ChatMessage[]): {
  system: string
  messages: unknown[]
} {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')

  const out: unknown[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'assistant') {
      const content: unknown[] = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls ?? []) {
        let input: unknown = {}
        try {
          input = tc.args ? JSON.parse(tc.args) : {}
        } catch {
          input = {}
        }
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input })
      }
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] })
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]
      })
    } else {
      out.push({ role: m.role, content: [{ type: 'text', text: m.content }] })
    }
  }
  // Anthropic requires the first message to be a user message.
  if (out.length && (out[0] as { role: string }).role === 'assistant') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: 'Start.' }] })
  }
  return { system, messages: out }
}

export function createAnthropicAdapter(config: LLMConfig): LLMAdapter {
  const baseUrl = (config.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')
  return {
    async *chat(req: ChatRequest): AsyncIterable<StreamDelta> {
      const { system, messages } = toAnthropic(req.messages)
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey ?? '',
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 8192,
          stream: true,
          temperature: config.temperature ?? 0.7,
          ...(system ? { system } : {}),
          messages,
          ...(req.tools?.length
            ? {
                tools: req.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.parameters
                }))
              }
            : {})
        })
      })
      if (!res.ok) throw new Error(`LLM request failed: ${await readError(res)}`)

      let currentToolId: string | null = null

      for await (const payload of sseData(res)) {
        let event: {
          type?: string
          content_block?: { type?: string; id?: string; name?: string }
          delta?: { type?: string; text?: string; partial_json?: string }
        }
        try {
          event = JSON.parse(payload)
        } catch {
          continue
        }
        switch (event.type) {
          case 'content_block_start': {
            const block = event.content_block
            if (block?.type === 'tool_use' && block.id) {
              currentToolId = block.id
              yield { type: 'tool_call_start', id: block.id, name: block.name ?? '' }
            }
            break
          }
          case 'content_block_delta': {
            const d = event.delta
            if (d?.type === 'text_delta' && d.text) {
              yield { type: 'text', text: d.text }
            } else if (d?.type === 'input_json_delta' && d.partial_json && currentToolId) {
              yield { type: 'tool_call_args', id: currentToolId, argsDelta: d.partial_json }
            }
            break
          }
          case 'content_block_stop': {
            if (currentToolId) {
              yield { type: 'tool_call_end', id: currentToolId }
              currentToolId = null
            }
            break
          }
          case 'error': {
            yield { type: 'error', message: 'anthropic stream error' }
            break
          }
          default:
            break
        }
      }
      if (currentToolId) yield { type: 'tool_call_end', id: currentToolId }
      yield { type: 'done' }
    }
  }
}
