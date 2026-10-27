import type { ChatMessage, LLMAdapter, ToolCall } from '../llm/types'
import { describeUiSpecProblem, tryValidateUiSpec as validate, type UiSpec } from '../spec'
import { withRegistryNames } from '../ui/registry'
import { executeApi, type ApiResult, type ApiRuntime } from './api'
import { extractPartialSpec, parsePartialJson } from './partialJson'
import { describeApiSchema, diffApiSchema, endpointKey, hasSchemaChange, type SchemaDiff } from './schema'
import { agentTools } from './tools'

/**
 * One agent turn: streams deltas from the LLM, projects partial tool-call
 * arguments into progressive UiSpec renders, executes call_api/navigate
 * tools, and feeds results back until the model stops calling tools.
 */

export type AgentUpdate =
  | { type: 'spec'; spec: UiSpec; final: boolean }
  | { type: 'text'; text: string }
  | {
      type: 'api_result'
      result: ApiResult
      endpoint: string
      schema?: Record<string, string>
      schemaChanged?: SchemaDiff
    }
  | { type: 'navigated'; page: string }
  /** Streaming render_ui argument size — drives the top rendering gauge. */
  | { type: 'progress'; chars: number }
  /** Terminal token accounting from the provider, when it reports one. */
  | { type: 'usage'; usage: { prompt?: number; completion?: number; total?: number } }
  | { type: 'error'; message: string }
  | { type: 'done' }

/**
 * Minimum gap between progressive previews. Deltas arrive every few ms; parsing
 * and re-rendering the whole screen for each one wastes frames on phones while
 * adding nothing a person can see. The final spec is always delivered.
 */
const PREVIEW_INTERVAL_MS = 80

/**
 * Tool-call argument streams come straight off the network: stop accepting
 * past this cap (the call then fails its parse cleanly) so a runaway or
 * hostile stream can't grow memory without bound.
 */
const MAX_TOOL_ARGS_CHARS = 2_000_000

/**
 * A failed render_ui blob stays in history as the model's own example — keep
 * only a short head so a megabyte of garbage can't bloat (or teach) later
 * passes. The validation error beside it carries the actual diagnosis.
 */
const MAX_FAILED_ARGS_CHARS = 2_000

/**
 * One call_api payload as the MODEL reads it: arrays trimmed to their head
 * (the spec embeds the first rows anyway), whole body capped — a 400KB
 * response would otherwise ride every later pass and turn as history, and
 * models rarely read past the first rows. The full response still reaches
 * the runtime through the api_result update.
 */
const MAX_RESULT_CHARS = 24_000
const MAX_RESULT_ARRAY = 40

export function compactToolResult(data: unknown): unknown {
  const trim = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const head = v.slice(0, MAX_RESULT_ARRAY).map(trim)
      return v.length > MAX_RESULT_ARRAY ? [...head, `…+${v.length - MAX_RESULT_ARRAY} more`] : head
    }
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = trim(val)
      return out
    }
    return v
  }
  const trimmed = trim(data)
  const text = JSON.stringify(trimmed)
  if (text === undefined) return data // non-JSON-able payload: hand it through as-is
  if (text.length <= MAX_RESULT_CHARS) return trimmed
  // Still too big (many wide objects): replace with a valid-JSON head.
  return { truncated: true, chars: text.length, head: text.slice(0, 4_000) }
}

/**
 * Minimum gap between progress updates. Same reasoning as previews: the
 * gauge animates smoothly at 150ms spacing without a yield per delta.
 */
const PROGRESS_INTERVAL_MS = 150

export interface AgentTurnOptions {
  adapter: LLMAdapter
  system: string
  /** Conversation state owned by the caller; appended to as the turn progresses. */
  history: ChatMessage[]
  api: ApiRuntime
  maxIterations?: number
  /** Endpoint shapes (`METHOD /path` → type map) remembered from earlier turns. */
  knownSchemas?: Record<string, Record<string, string>>
}

export async function* runAgentTurn(opts: AgentTurnOptions): AsyncGenerator<AgentUpdate> {
  const maxIterations = opts.maxIterations ?? 4
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.system },
    ...opts.history.filter((m) => m.role !== 'system')
  ]

  // One corrective round when render_ui arrives unusable or not at all.
  let retriesLeft = 1
  // A turn should end on a screen (or a page switch); otherwise say so.
  let rendered = false
  let reported = false

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      let text = ''
      const toolCalls = new Map<string, ToolCall>()
      const overflowed = new Set<string>()
      const order: string[] = []

      const stream = opts.adapter.chat({ messages, tools: agentTools })
      let lastPreviewAt = 0
      let lastProgressAt = 0

      for await (const delta of stream) {
        switch (delta.type) {
          case 'text':
            // Same cap as tool args: assistant text lands in history untrimmed.
            if (text.length + delta.text.length <= MAX_TOOL_ARGS_CHARS) text += delta.text
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
            if (tc && !overflowed.has(delta.id)) {
              if (tc.args.length + delta.argsDelta.length > MAX_TOOL_ARGS_CHARS) {
                overflowed.add(delta.id)
                tc.args = '' // freed; the parse at completion fails with a clear error
              } else {
                tc.args += delta.argsDelta
                const now = Date.now()
                if (tc.name === 'render_ui' && now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
                  lastProgressAt = now
                  yield { type: 'progress', chars: tc.args.length }
                }
                if (tc.name === 'render_ui' && now - lastPreviewAt >= PREVIEW_INTERVAL_MS) {
                  const partial = extractPartialSpec(tc.args)
                  const spec = partial ? tryValidateUiSpec(partial) : null
                  if (spec) {
                    lastPreviewAt = now
                    yield { type: 'spec', spec, final: false }
                  }
                }
              }
            }
            break
          }
          case 'tool_call_end':
            break
          case 'error':
            reported = true
            yield { type: 'error', message: delta.message }
            break
          case 'usage':
            yield { type: 'usage', usage: delta.usage }
            break
          case 'done':
            break
        }
      }

      const completed = order.map((id) => toolCalls.get(id)!).filter(Boolean)

      // Record assistant turn in history (an empty reply would be an invalid message).
      const assistantMsg: ChatMessage = { role: 'assistant', content: text }
      if (completed.length) {
        assistantMsg.toolCalls = completed.map((tc) => ({ ...tc }))
      }
      if (text || completed.length) messages.push(assistantMsg)

      if (!completed.length) {
        // Text-only reply: look for a fenced UiSpec as a fallback.
        const spec = specFromFencedJson(text)
        if (spec) {
          rendered = true
          yield { type: 'spec', spec, final: true }
          break
        }
        // Empty or chatty reply (seen with real models): ask once for the screen.
        if (!reported && retriesLeft > 0 && iteration < maxIterations - 1) {
          retriesLeft--
          messages.push({
            role: 'user',
            content: 'No screen was rendered. Call render_ui now with the screen for the request above.'
          })
          continue
        }
        break
      }

      let sawRender = false
      let failedRender = false
      for (const tc of completed) {
        if (tc.name === 'render_ui') {
          const { spec: raw } = specFromArgs(tc.args)
          const spec = raw === null ? null : tryValidateUiSpec(raw)
          // Models copy their own earlier calls: a stringified spec, a missing
          // "version" or props-before-grid in history repeats on every later
          // turn. Keep the validated spec, in contract key order, there instead
          // — and when there is none, only a short head of the failed blob.
          const recorded = assistantMsg.toolCalls?.find((c) => c.id === tc.id)
          if (spec) {
            sawRender = true
            rendered = true
            if (recorded) recorded.args = JSON.stringify({ spec })
          } else {
            failedRender = true
            if (recorded && recorded.args.length > MAX_FAILED_ARGS_CHARS) {
              recorded.args = `${recorded.args.slice(0, MAX_FAILED_ARGS_CHARS)}…`
            }
          }
          // Record the tool result before yielding: if the caller walks away
          // at the yield (superseded turn), history must still carry it.
          messages.push({
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.name,
            content: JSON.stringify(
              spec
                ? { ok: true }
                : {
                    ok: false,
                    error:
                      raw === null
                        ? 'render_ui arguments are not valid JSON. Send {"spec": {...}} with spec as a JSON object.'
                        : `invalid UiSpec — ${describeUiSpecProblem(raw)}. Call render_ui again with the corrected spec.`
                  }
            )
          })
          if (spec) yield { type: 'spec', spec, final: true }
        } else if (tc.name === 'call_api') {
          const parsed = safeParseArgs(tc.args)
          const method = parsed?.method ? String(parsed.method) : undefined
          const result = await executeApi(opts.api, {
            path: String(parsed?.path ?? ''),
            method,
            body: parsed?.body
          })
          // 2xx JSON only: error bodies ({error: …}) are a different shape than
          // the success payload — remembering them would fake schema changes.
          const endpoint = endpointKey(method, result.path)
          const schema =
            result.status >= 200 &&
            result.status < 300 &&
            result.data !== null &&
            typeof result.data === 'object'
              ? describeApiSchema(result.data)
              : null
          const prev = schema ? opts.knownSchemas?.[endpoint] : undefined
          const diff = schema && prev ? diffApiSchema(prev, schema) : null
          const changed = diff && hasSchemaChange(diff) ? diff : null
          // Record before yielding so an already-executed (possibly non-idempotent)
          // call is never lost to an abandoned turn — the model would repeat it.
          messages.push({
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.name,
            content: JSON.stringify({
              status: result.status,
              data: compactToolResult(result.data),
              // Show this data by binding, not copying: any prop takes
              // {"$data": "<bind>.<json path>"} and re-resolves on every render.
              bind: endpoint,
              // Keys added/removed/changed vs. what earlier screens were built
              // on: the model re-renders so the cached layout catches up.
              ...(changed ? { _schemaChange: changed } : {})
            })
          })
          yield {
            type: 'api_result',
            result,
            endpoint,
            schema: schema ?? undefined,
            schemaChanged: changed ?? undefined
          }
        } else if (tc.name === 'navigate') {
          const parsed = safeParseArgs(tc.args)
          const page = String(parsed?.page ?? '')
          rendered = true
          messages.push({
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.name,
            content: JSON.stringify({ ok: true, page })
          })
          yield { type: 'navigated', page }
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
      const canContinue = iteration < maxIterations - 1
      const retry = failedRender && !sawRender && retriesLeft > 0 && canContinue
      if (failedRender && !sawRender && !retry) {
        reported = true
        yield { type: 'error', message: 'render_ui received an invalid UiSpec' }
      }
      if (retry) retriesLeft--
      const shouldContinue =
        canContinue &&
        (retry || completed.some((tc) => tc.name === 'call_api' || tc.name === 'navigate'))
      if (!shouldContinue) break
    }
    if (!rendered && !reported) {
      yield { type: 'error', message: 'The model ended its turn without rendering a screen.' }
    }
  } catch (err) {
    yield { type: 'error', message: (err as Error).message }
  } finally {
    // Hand the accumulated conversation back to the caller (without the system
    // prompt) — including when the caller walks away mid-turn, so executed
    // tool calls always reach the next turn's history.
    opts.history.splice(0, opts.history.length, ...messages.filter((m) => m.role !== 'system'))
  }
  yield { type: 'done' }
}

/** Validate model output and settle component names on the registry's spelling. */
function tryValidateUiSpec(input: unknown): UiSpec | null {
  const spec = validate(input)
  return spec && withRegistryNames(spec)
}

function safeParseArgs(args: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(args)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : null
  } catch {
    return null
  }
}

/** JSON.parse, falling back to salvaging a truncated or over-closed object. */
function parseLoose(text: string): { value: Record<string, unknown>; salvaged: boolean } | null {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? { value, salvaged: false } : null
  } catch {
    const value = parsePartialJson<Record<string, unknown>>(text)
    return value && typeof value === 'object' ? { value, salvaged: true } : null
  }
}

/**
 * The spec out of render_ui arguments. Some models send `spec` as a JSON
 * *string* (often with a bracket too many or too few) or skip the wrapper;
 * accept all of it. `repaired` says the arguments weren't clean JSON objects.
 */
export function specFromArgs(args: string): { spec: unknown; repaired: boolean } {
  const outer = parseLoose(args)
  if (!outer) return { spec: null, repaired: false }
  const value = 'spec' in outer.value ? outer.value.spec : outer.value
  if (typeof value === 'string') {
    const inner = parseLoose(value)
    return { spec: inner ? inner.value : null, repaired: true }
  }
  return { spec: value ?? null, repaired: outer.salvaged }
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
