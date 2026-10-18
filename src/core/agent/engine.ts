import type { ChatMessage, LLMAdapter, ToolCall } from '../llm/types'
import { tryValidateUiSpec, type UiSpec } from '../spec'
import { executeApi, type ApiResult, type ApiRuntime } from './api'
import { extractPartialSpec } from './partialJson'
import { agentTools } from './tools'

/**
 * One agent turn: streams deltas from the LLM, projects partial tool-call
 * arguments into progressive UiSpec renders, executes call_api/navigate
 * tools, and feeds results back until the model stops calling tools.
 */

export type AgentUpdate =
  | { type: 'spec'; spec: UiSpec; final: boolean }
  | { type: 'text'; text: string }
  | { type: 'api_result'; result: ApiResult }
  | { type: 'navigated'; page: string }
  | { type: 'error'; message: string }
  | { type: 'done' }

export interface AgentTurnOptions {
  adapter: LLMAdapter
  system: string
  /** Conversation state owned by the caller; appended to as the turn progresses. */
  history: ChatMessage[]
  api: ApiRuntime
  maxIterations?: number
}

export async function* runAgentTurn(opts: AgentTurnOptions): AsyncGenerator<AgentUpdate> {
  const maxIterations = opts.maxIterations ?? 4
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.system },
    ...opts.history.filter((m) => m.role !== 'system')
  ]

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      let text = ''
      const toolCalls = new Map<string, ToolCall>()
      const order: string[] = []

      const stream = opts.adapter.chat({ messages, tools: agentTools })
      let finalSpecYielded = false

      for await (const delta of stream) {
        switch (delta.type) {
          case 'text':
            text += delta.text
            yield { type: 'text', text: delta.text }
            break
          case 'tool_call_start': {
            if (!toolCalls.has(delta.id)) {
              toolCalls.set(delta.id, { id: delta.id, name: delta.name, args: '' })
              order.push(delta.id)
            } else {
              const tc = toolCalls.get(delta.id)!
              if (!tc.name && delta.name) tc.name = delta.name
            }
            break
          }
          case 'tool_call_args': {
            const tc = toolCalls.get(delta.id)
            if (tc) {
              tc.args += delta.argsDelta
              if (tc.name === 'render_ui') {
                const partial = extractPartialSpec(tc.args)
                const spec = partial ? tryValidateUiSpec(partial) : null
                if (spec) yield { type: 'spec', spec, final: false }
              }
            }
            break
          }
          case 'tool_call_end':
            break
          case 'error':
            yield { type: 'error', message: delta.message }
            break
          case 'done':
            break
        }
      }

      const completed = order.map((id) => toolCalls.get(id)!).filter(Boolean)

      // Record assistant turn in history.
      const assistantMsg: ChatMessage = { role: 'assistant', content: text }
      if (completed.length) {
        assistantMsg.toolCalls = completed.map((tc) => ({ ...tc }))
      }
      messages.push(assistantMsg)

      if (!completed.length) {
        // Text-only reply: look for a fenced UiSpec as a fallback.
        const spec = specFromFencedJson(text)
        if (spec) yield { type: 'spec', spec, final: true }
        break
      }

      let sawRender = false
      for (const tc of completed) {
        if (tc.name === 'render_ui') {
          const parsed = safeParseArgs(tc.args)
          const spec = parsed ? tryValidateUiSpec(parsed.spec ?? parsed) : null
          if (spec) {
            sawRender = true
            yield { type: 'spec', spec, final: true }
            finalSpecYielded = true
          } else {
            yield { type: 'error', message: 'render_ui received an invalid UiSpec' }
          }
          messages.push({
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.name,
            content: JSON.stringify(
              spec
                ? { ok: true }
                : { ok: false, error: 'invalid UiSpec — check version/page/pages structure' }
            )
          })
        } else if (tc.name === 'call_api') {
          const parsed = safeParseArgs(tc.args)
          const result = await executeApi(opts.api, {
            path: String(parsed?.path ?? ''),
            method: parsed?.method ? String(parsed.method) : undefined,
            body: parsed?.body
          })
          yield { type: 'api_result', result }
          messages.push({
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.name,
            content: JSON.stringify({ status: result.status, data: result.data })
          })
        } else if (tc.name === 'navigate') {
          const parsed = safeParseArgs(tc.args)
          const page = String(parsed?.page ?? '')
          yield { type: 'navigated', page }
          messages.push({
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.name,
            content: JSON.stringify({ ok: true, page })
          })
        } else {
          messages.push({
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.name,
            content: JSON.stringify({ ok: false, error: `unknown tool ${tc.name}` })
          })
        }
      }

      // Only continue if the model asked for something that benefits from a
      // second round (API results to render with, or a page switch).
      const shouldContinue = completed.some(
        (tc) => (tc.name === 'call_api' || tc.name === 'navigate') && iteration < maxIterations - 1
      )
      void sawRender
      void finalSpecYielded
      if (!shouldContinue) break
    }
  } catch (err) {
    yield { type: 'error', message: (err as Error).message }
  }

  // Hand the accumulated conversation back to the caller (without the system prompt).
  opts.history.splice(0, opts.history.length, ...messages.filter((m) => m.role !== 'system'))
  yield { type: 'done' }
}

function safeParseArgs(args: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(args)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : null
  } catch {
    return null
  }
}

function specFromFencedJson(text: string): UiSpec | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  if (!fence) return null
  try {
    const json = JSON.parse(fence[1])
    return tryValidateUiSpec(json.spec ?? json)
  } catch {
    return null
  }
}
