import type { ChatMessage, ChatRequest, LLMAdapter, ToolCall } from '../llm/types'
import {
  describeUiSpecProblem,
  iterateNodes,
  tryValidateUiSpec as validate,
  type UiSpec
} from '../spec'
import { getComponent, withRegistryNames } from '../ui/registry'
import { executeApi, type ApiResult, type ApiRuntime } from './api'
import { sanitizeHistory } from './history'
import { extractPartialSpec, parsePartialJson } from './partialJson'
import {
  describeApiSchema,
  diffApiSchema,
  endpointKey,
  hasSchemaChange,
  mergeSchemaFields,
  type SchemaDiff
} from './schema'
import { agentTools, renderUiTool } from './tools'

/**
 * One agent turn: streams deltas from the LLM, projects partial tool-call
 * arguments into progressive UiSpec renders, executes call_api/navigate
 * tools, and feeds results back until a screen (or a page switch) lands.
 *
 * Every extra pass costs a full time-to-first-token plus a resend of the
 * whole prompt, so the loop ends as early as the outcome is settled:
 * - a valid render_ui ends the turn, even when the same response also
 *   called call_api (bindings re-resolve against the stored responses) —
 *   only a failed call or a changed response shape earns another pass;
 * - a navigate to a page the runtime knows ends the turn (no closing pass);
 * - the last allowed pass offers render_ui alone, so a turn spent on data
 *   rounds still ends on a screen.
 */

export type TurnUsage = { prompt?: number; completion?: number; total?: number; cached?: number }

export type AgentUpdate =
  | { type: 'spec'; spec: UiSpec; final: boolean }
  | { type: 'text'; text: string }
  | {
      type: 'api_result'
      result: ApiResult
      endpoint: string
      /** Request method (upper-case) — a non-GET result means the turn mutated data. */
      method?: string
      schema?: Record<string, string>
      schemaChanged?: SchemaDiff
      /** The call was refused without executing (read-only background build). */
      blocked?: boolean
    }
  | { type: 'navigated'; page: string }
  /** Streaming render_ui argument size — drives the top rendering gauge. */
  | { type: 'progress'; chars: number }
  /**
   * Token accounting: the TURN's cumulative totals so far, summed across every
   * pass (each pass is a separate provider response with its own usage).
   * Monotonic within a turn, so a caller can diff consecutive updates.
   */
  | { type: 'usage'; usage: TurnUsage }
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

/** Passes per turn: data rounds, a corrective round, and a final render-only round fit. */
const DEFAULT_MAX_ITERATIONS = 5

/** Nudge before the render-only final pass (an engine nudge — see history.ts). */
const DATA_BUDGET_NUDGE =
  'Data budget reached: call render_ui now with the data you already have (bind known endpoints with {"$data": …}).'

export interface AgentTurnOptions {
  adapter: LLMAdapter
  /** STABLE system prompt — identical across turns of a session (cacheable prefix). */
  system: string
  /**
   * VOLATILE system context (auth state, app map, live snapshots, known
   * shapes) — sent as a second system message after `system`, so the stable
   * prefix stays byte-identical for the provider's prompt cache.
   */
  systemDynamic?: string
  /**
   * Per-turn context (current screen state, screen history line) appended to
   * the LAST user message of the outgoing request only — never written back
   * to `history`, so stale copies don't pile up in later turns.
   */
  transientContext?: string
  /** Conversation state owned by the caller; appended to as the turn progresses. */
  history: ChatMessage[]
  api: ApiRuntime
  /** Passes per turn (default 5); the last one offers only render_ui. */
  maxIterations?: number
  /** Endpoint shapes (`METHOD /path` → type map) remembered from earlier turns. */
  knownSchemas?: Record<string, Record<string, string>>
  /**
   * Builds a deeper-reasoning adapter for the one corrective round. A failed
   * or absent render is exactly when extra thinking pays for its latency, so
   * the cheap default stays cheap and only the retry gets the depth.
   */
  escalateReasoning?: () => LLMAdapter
  /** Caller cancellation: passed to the adapter; on abort the turn ends quietly. */
  signal?: AbortSignal
  /** Stable per-domino prompt-cache key, passed to the adapter. */
  cacheKey?: string
  /**
   * Page ids the runtime can switch to (built pages, plus nav ids that
   * resolve to one). A navigate to one of them — or to `history:<n>` — ends
   * the turn; an unknown id gets `{ok:false, knownPages}` and one corrective
   * round. Omitted: every navigate target is accepted.
   */
  knownPages?: string[]
  /**
   * Background builds: call_api with a non-GET method is refused without
   * executing (a pre-generated screen must never write to the backend).
   */
  readOnlyApi?: boolean
}

/** What one render_ui call amounted to, decided before any tool runs. */
interface RenderOutcome {
  spec: UiSpec | null
  /** Parsed spec object before validation (null: not JSON at all). */
  raw: unknown
  /** Arguments only parsed by closing a cut-off stream — never a final screen. */
  cutOff: boolean
  /** Repairs the runtime made, reported back so the model stops repeating them. */
  notes: string[]
}

export async function* runAgentTurn(opts: AgentTurnOptions): AsyncGenerator<AgentUpdate> {
  const maxIterations = Math.max(1, opts.maxIterations ?? DEFAULT_MAX_ITERATIONS)
  // The caller's messages stay as they are (callers slice off "their" new
  // messages by index); only the outgoing request is sanitized.
  const prior = opts.history.filter((m) => m.role !== 'system')
  const added: ChatMessage[] = []
  const transientTarget = [...prior].reverse().find((m) => m.role === 'user') ?? null

  const system: ChatMessage[] = [{ role: 'system', content: opts.system }]
  if (opts.systemDynamic && opts.systemDynamic.trim()) {
    system.push({ role: 'system', content: opts.systemDynamic })
  }

  /** The request's messages: system prefix, sanitized history, transient context on the turn's user message. */
  const outgoing = (): ChatMessage[] => {
    const convo = sanitizeHistory([...prior, ...added])
    const extra = opts.transientContext
    if (extra) {
      const at = transientTarget ? convo.indexOf(transientTarget) : -1
      if (at >= 0) {
        const m = convo[at]
        const sep = /^\s/.test(extra) ? '' : '\n\n'
        convo[at] = { ...m, content: `${m.content}${sep}${extra}` }
      } else {
        const firstNew = added.length ? convo.indexOf(added[0]) : -1
        const ctx: ChatMessage = { role: 'user', content: extra.trim() }
        if (firstNew >= 0) convo.splice(firstNew, 0, ctx)
        else convo.push(ctx)
      }
    }
    return [...system, ...convo]
  }

  // One corrective round when render_ui arrives unusable or not at all.
  let retriesLeft = 1
  // A navigate to an unknown page gets its own single correction.
  let navRetriesLeft = 1
  // A turn should end on a screen (or a page switch); otherwise say so.
  let rendered = false
  let reported = false
  let aborted = false
  // Starts on the caller's adapter; a retry may swap to a deeper thinker.
  let adapter = opts.adapter
  // Both retry paths spend the single round, so only the first one escalates.
  const escalate = (): void => {
    if (opts.escalateReasoning && retriesLeft === 0) adapter = opts.escalateReasoning()
  }
  // Turn totals: finished passes summed, plus the running pass.
  const turnUsage: Required<Omit<TurnUsage, 'cached'>> & { cached?: number } = {
    prompt: 0,
    completion: 0,
    total: 0
  }
  const isAborted = (): boolean => {
    if (opts.signal?.aborted) aborted = true
    return aborted
  }
  /** Every tool-call id the conversation already holds (history and this turn). */
  const usedToolCallIds = (): Set<string> => {
    const ids = new Set<string>()
    for (const m of [...prior, ...added]) for (const c of m.toolCalls ?? []) ids.add(c.id)
    return ids
  }
  // The turn's own copy of the remembered shapes: updated as responses
  // arrive, so a change is reported once, not on every later pass.
  const turnSchemas: Record<string, Record<string, string>> = { ...(opts.knownSchemas ?? {}) }
  // Why the previous pass asked for another one: an API round earns the
  // data-budget nudge before a render-only final pass.
  let continuedForData = false

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (isAborted()) break
      const finalRound = maxIterations > 1 && iteration === maxIterations - 1
      if (finalRound && continuedForData) added.push({ role: 'user', content: DATA_BUDGET_NUDGE })

      let text = ''
      // Provider id → id recorded in history. Some OpenAI-compatible servers
      // number calls per response (`call_0` every time); a reused id would
      // pair this call with an older result, so a colliding one is renamed.
      const localIds = new Map<string, string>()
      const localId = (id: string): string => localIds.get(id) ?? id
      const toolCalls = new Map<string, ToolCall>()
      const overflowed = new Set<string>()
      const order: string[] = []
      // Provider-opaque blocks (thinking) to replay on this assistant message.
      let providerBlocks: unknown[] | undefined
      // The stream stopped short (output limit) or failed mid-way: salvaged
      // arguments are a cut-off screen, not a finished one.
      let truncated = false
      let streamError = false
      // This pass's usage — cumulative within one response.
      const passUsage = { prompt: 0, completion: 0, total: 0, cached: 0 }

      const request: ChatRequest = {
        messages: outgoing(),
        tools: finalRound ? [renderUiTool] : agentTools
      }
      if (opts.signal) request.signal = opts.signal
      if (opts.cacheKey) request.cacheKey = opts.cacheKey
      let lastPreviewAt = 0
      let lastProgressAt = 0

      try {
        for await (const delta of adapter.chat(request)) {
          if (isAborted()) break
          switch (delta.type) {
            case 'text':
              // Same cap as tool args: assistant text lands in history untrimmed.
              if (text.length + delta.text.length <= MAX_TOOL_ARGS_CHARS) text += delta.text
              yield { type: 'text', text: delta.text }
              break
            case 'tool_call_start': {
              if (!localIds.has(delta.id)) {
                const taken = usedToolCallIds()
                let id = delta.id
                for (let n = 2; taken.has(id) || toolCalls.has(id); n++) id = `${delta.id}~${n}`
                localIds.set(delta.id, id)
              }
              const id = localId(delta.id)
              if (!toolCalls.has(id)) {
                toolCalls.set(id, { id, name: delta.name, args: '' })
                order.push(id)
              } else {
                const tc = toolCalls.get(id)!
                if (!tc.name && delta.name) tc.name = delta.name
              }
              break
            }
            case 'tool_call_args': {
              const id = localId(delta.id)
              const tc = toolCalls.get(id)
              if (tc && !overflowed.has(id)) {
                if (tc.args.length + delta.argsDelta.length > MAX_TOOL_ARGS_CHARS) {
                  overflowed.add(id)
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
            case 'provider_blocks':
              // The full list for this response (emitted once): replay as-is.
              providerBlocks = delta.blocks
              break
            case 'error':
              reported = true
              streamError = true
              yield { type: 'error', message: delta.message }
              break
            case 'usage': {
              const u = delta.usage
              passUsage.prompt = Math.max(passUsage.prompt, u.prompt ?? 0)
              passUsage.completion = Math.max(passUsage.completion, u.completion ?? 0)
              passUsage.total = Math.max(
                passUsage.total,
                u.total ?? (u.prompt ?? 0) + (u.completion ?? 0)
              )
              passUsage.cached = Math.max(passUsage.cached, u.cached ?? 0)
              const cached = (turnUsage.cached ?? 0) + passUsage.cached
              yield {
                type: 'usage',
                usage: {
                  prompt: turnUsage.prompt + passUsage.prompt,
                  completion: turnUsage.completion + passUsage.completion,
                  total: turnUsage.total + passUsage.total,
                  ...(cached > 0 ? { cached } : {})
                }
              }
              break
            }
            case 'done':
              if (delta.truncated) truncated = true
              break
          }
        }
      } catch (err) {
        if (isAborted()) break
        throw err
      }
      if (isAborted()) break
      turnUsage.prompt += passUsage.prompt
      turnUsage.completion += passUsage.completion
      turnUsage.total += passUsage.total
      if (passUsage.cached > 0) turnUsage.cached = (turnUsage.cached ?? 0) + passUsage.cached

      const completed = order.map((id) => toolCalls.get(id)!).filter(Boolean)

      // Record assistant turn in history (an empty reply would be an invalid message).
      const assistantMsg: ChatMessage = { role: 'assistant', content: text }
      if (completed.length) {
        assistantMsg.toolCalls = completed.map((tc) => ({ ...tc }))
      }
      if (providerBlocks?.length && (text || completed.length)) {
        assistantMsg.providerBlocks = providerBlocks
      }
      if (text || completed.length) added.push(assistantMsg)

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
          escalate()
          continuedForData = false
          added.push({
            role: 'user',
            content: 'No screen was rendered. Call render_ui now with the screen for the request above.'
          })
          continue
        }
        break
      }

      // Decide every render up front: whether this response produced a valid
      // screen changes how its navigate and call_api calls are answered.
      const cutOff = truncated || streamError
      const renders = new Map<string, RenderOutcome>()
      for (const tc of completed) {
        if (tc.name === 'render_ui') renders.set(tc.id, renderOutcome(tc.args, cutOff))
      }
      const anyValidRender = [...renders.values()].some((r) => r.spec && !r.cutOff)

      // Writes settle before anything this response decided is shown: the
      // caller caches a screen, records a page edge and replays it later, so
      // a render_ui (or navigate) yielded ahead of a POST in the same
      // response would be cached as a non-mutating answer — and the next
      // press would never reach the backend. Order of handling:
      //   1. call_api writes (or their read-only refusals), in call order;
      //   2. render_ui / navigate / unknown tools, in call order;
      //   3. call_api reads, in call order.
      // Reads start together (they are idempotent); a read placed after a
      // write starts only once that write has landed. Tool results may sit in
      // a different order from the calls — each still follows its assistant
      // message, which is all providers need.
      const apiCalls = completed
        .filter((tc) => tc.name === 'call_api')
        .map((tc) => ({ tc, args: safeParseArgs(tc.args) }))
      const pendingApi = new Map<string, Promise<ApiResult>>()
      const methodOf = (args: Record<string, any> | null): string =>
        String(args?.method ?? 'GET').toUpperCase()
      const blockedWrite = (method: string): boolean => Boolean(opts.readOnlyApi) && method !== 'GET'
      const runApi = (args: Record<string, any> | null): Promise<ApiResult> => {
        const path = String(args?.path ?? '')
        return executeApi(opts.api, {
          path,
          method: args?.method ? String(args.method) : undefined,
          body: args?.body
        }).catch((err: unknown) => ({ path, status: 0, data: { error: (err as Error).message } }))
      }
      const startReads = (from: number): void => {
        for (let k = from; k < apiCalls.length; k++) {
          const { tc, args } = apiCalls[k]
          if (methodOf(args) !== 'GET') break
          if (!pendingApi.has(tc.id)) pendingApi.set(tc.id, runApi(args))
        }
      }
      startReads(0)

      let sawRender = false
      let failedRender = false
      let navigatedOk = false
      let failedNav = false
      const calledApi = apiCalls.length > 0
      // A call that failed or answered in a new shape: the screen needs
      // another look even when this response already rendered one.
      let apiNeedsFollowUp = false
      // Writes of this response that certainly did not land (an error status,
      // or refused before sending): a navigate beside them would end the turn
      // on a page that looks as if they worked. Status 0 (timeout, network)
      // is an unknown outcome — the server may have acted — so it never
      // counts: inviting a resend could duplicate the write.
      const failedWrites: string[] = []

      /** Run (or refuse) one call_api, record its result, and describe the update. */
      async function* settleApi(index: number): AsyncGenerator<AgentUpdate> {
        const { tc, args: parsed } = apiCalls[index]
        const method = methodOf(parsed)
        const path = String(parsed?.path ?? '')
        if (blockedWrite(method)) {
          apiNeedsFollowUp = true
          failedWrites.push(`${method} ${path} (refused: read-only build)`)
          const error = `call_api ${method} is not allowed in a background build (read-only) — render the screen without performing writes.`
          added.push({
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.name,
            content: JSON.stringify({ ok: false, status: 403, error })
          })
          yield {
            type: 'api_result',
            result: { path, status: 403, data: { error } },
            endpoint: endpointKey(method, path),
            method,
            blocked: true
          }
          startReads(index + 1)
          return
        }
        const result = await (pendingApi.get(tc.id) ?? runApi(parsed))
        // A write has landed: reads queued behind it may start now.
        if (method !== 'GET') startReads(index + 1)
        // 2xx JSON only: error bodies ({error: …}) are a different shape than
        // the success payload — remembering them would fake schema changes.
        const endpoint = endpointKey(method, result.path)
        const success = result.status >= 200 && result.status < 300
        const schema =
          success && result.data !== null && typeof result.data === 'object'
            ? describeApiSchema(result.data)
            : null
        const prev = schema ? turnSchemas[endpoint] : undefined
        const diff = schema && prev ? diffApiSchema(prev, schema) : null
        const changed = diff && hasSchemaChange(diff) ? diff : null
        // The turn's own baseline moves with what it has seen: the same
        // endpoint called again in a later pass is not "changed" twice.
        if (schema) turnSchemas[endpoint] = mergeSchemaFields(prev, schema)
        if (!success || changed) apiNeedsFollowUp = true
        if (method !== 'GET' && result.status >= 400) {
          failedWrites.push(`${method} ${result.path} → ${result.status}`)
        }
        // Record before yielding so an already-executed (possibly non-idempotent)
        // call is never lost to an abandoned turn — the model would repeat it.
        added.push({
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
          method,
          schema: schema ?? undefined,
          schemaChanged: changed ?? undefined
        }
      }

      // 1. Writes (and refused writes) first, in call order.
      for (let k = 0; k < apiCalls.length; k++) {
        if (methodOf(apiCalls[k].args) === 'GET') continue
        yield* settleApi(k)
        if (isAborted()) break
      }
      if (isAborted()) break

      // 2. Screens and page switches, now that every write has landed.
      for (const tc of completed) {
        if (tc.name === 'call_api') continue
        if (tc.name === 'render_ui') {
          const outcome = renders.get(tc.id)!
          const ok = outcome.spec !== null && !outcome.cutOff
          const spec = ok ? outcome.spec : null
          // Models copy their own earlier calls: a stringified spec, a missing
          // "version" or props-before-grid in history repeats on every later
          // turn. Keep the validated spec, in contract key order, there instead
          // — and when there is none, only a short head of the failed blob,
          // wrapped as valid JSON (strict OpenAI-compatible backends re-parse
          // every replayed `arguments` and answer 400 on anything else).
          const recorded = assistantMsg.toolCalls?.find((c) => c.id === tc.id)
          if (spec) {
            sawRender = true
            rendered = true
            if (recorded) recorded.args = JSON.stringify({ spec })
          } else {
            failedRender = true
            if (recorded) recorded.args = failedCallArgs(recorded.args)
          }
          // Record the tool result before yielding: if the caller walks away
          // at the yield (superseded turn), history must still carry it.
          added.push({
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.name,
            content: JSON.stringify(renderResult(tc.args, outcome))
          })
          if (spec) yield { type: 'spec', spec, final: true }
          // A cut-off screen still shows as a preview while the retry runs.
          else if (outcome.cutOff && outcome.spec) yield { type: 'spec', spec: outcome.spec, final: false }
        } else if (tc.name === 'navigate') {
          const parsed = safeParseArgs(tc.args)
          const page = String(parsed?.page ?? '').trim()
          const target = page ? resolveNavigateTarget(page, opts.knownPages) : null
          let content: Record<string, unknown>
          let switchTo: string | null = null
          if (anyValidRender) {
            // The screen this response rendered is the answer; a page switch
            // on top of it would hide it.
            content = { ok: true, page: target ?? page, note: 'render_ui in the same response was shown instead' }
          } else if (navigatedOk) {
            content = { ok: false, error: 'ignored — one navigate per response' }
          } else if (failedWrites.length > 0) {
            // Not a failedNav: the page exists, a write didn't land. The data
            // round that follows shows what went wrong (the model sees which
            // call failed, and that the others went through).
            content = {
              ok: false,
              error: `ignored — ${failedWrites.join(', ')} failed; render a screen that shows what went wrong instead of switching pages`
            }
          } else if (target) {
            navigatedOk = true
            rendered = true
            switchTo = target
            content = { ok: true, page: target }
          } else {
            failedNav = true
            content = {
              ok: false,
              error: `unknown page "${page}" — it has not been built yet. Call render_ui to design it, or navigate to one of knownPages.`,
              knownPages: (opts.knownPages ?? []).slice(0, 40)
            }
          }
          added.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, content: JSON.stringify(content) })
          if (switchTo) yield { type: 'navigated', page: switchTo }
        } else {
          added.push({
            role: 'tool',
            toolCallId: tc.id,
            toolName: tc.name,
            content: JSON.stringify({ ok: false, error: `unknown tool ${tc.name}` })
          })
        }
      }
      if (isAborted()) break

      // 3. Reads, in call order (already running since the response ended).
      for (let k = 0; k < apiCalls.length; k++) {
        if (methodOf(apiCalls[k].args) !== 'GET') continue
        yield* settleApi(k)
        if (isAborted()) break
      }

      // Anything else the history replays must be a JSON object too (an
      // overflowed or malformed call_api / navigate argument string).
      for (const c of assistantMsg.toolCalls ?? []) {
        if (!isJsonObjectText(c.args)) c.args = failedCallArgs(c.args)
      }
      if (isAborted()) break

      // Continue only when another pass can change the outcome: a corrective
      // round for a broken render or an unknown page, or API results that
      // still need a screen (none rendered, or a call failed / changed shape).
      const settled = sawRender || navigatedOk
      const canContinue = iteration < maxIterations - 1
      const retry = failedRender && !settled && retriesLeft > 0 && canContinue
      const navRetry = failedNav && !settled && !retry && navRetriesLeft > 0 && canContinue
      const dataRound = calledApi && !navigatedOk && (!sawRender || apiNeedsFollowUp) && canContinue
      const shouldContinue = retry || navRetry || dataRound
      if (failedRender && !settled && !shouldContinue) {
        reported = true
        const cut = [...renders.values()].some((r) => r.cutOff)
        yield {
          type: 'error',
          message: cut
            ? 'render_ui output was cut off before the screen was complete'
            : 'render_ui received an invalid UiSpec'
        }
      }
      if (retry) {
        retriesLeft--
        escalate()
      }
      if (navRetry) navRetriesLeft--
      continuedForData = dataRound && !retry
      if (!shouldContinue) break
    }
    if (!aborted && !rendered && !reported) {
      yield { type: 'error', message: 'The model ended its turn without rendering a screen.' }
    }
  } catch (err) {
    if (!isAborted()) yield { type: 'error', message: (err as Error).message }
  } finally {
    // Hand the accumulated conversation back to the caller (without the system
    // prompt) — including when the caller walks away mid-turn, so executed
    // tool calls always reach the next turn's history.
    opts.history.splice(0, opts.history.length, ...prior, ...added)
  }
  if (aborted) return
  yield { type: 'done' }
}

/**
 * The page a navigate call lands on: `history:<n>` passes through (the
 * runtime validates the index), otherwise an exact id from `knownPages`, then
 * a case/space-insensitive match. No list: anything goes (legacy callers).
 */
export function resolveNavigateTarget(page: string, knownPages?: string[]): string | null {
  if (/^history:\d+$/.test(page)) return page
  if (!knownPages) return page
  if (knownPages.includes(page)) return page
  const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase()
  const t = norm(page)
  return knownPages.find((p) => norm(p) === t) ?? null
}

/** Parse, validate and audit one render_ui call. */
function renderOutcome(args: string, cutOff: boolean): RenderOutcome {
  const { spec: raw, repaired, salvaged } = specFromArgs(args)
  const spec = raw === null ? null : tryValidateUiSpec(raw)
  const notes: string[] = []
  if (spec) {
    if (repaired) {
      notes.push(
        'arguments were not a clean JSON object (spec sent as a string, or brackets unbalanced) — repaired; send {"spec": {...}} with spec as a plain JSON object'
      )
    }
    notes.push(...specRepairNotes(raw, spec))
  }
  // On a stream that stopped short, a spec that only parsed by closing the
  // prefix — or arguments that don't parse at all — are a cut-off screen.
  const cut = cutOff && args.length > 0 && (salvaged || raw === null)
  return { spec, raw, cutOff: cut, notes }
}

/** The tool result the model reads for one render_ui call. */
function renderResult(args: string, outcome: RenderOutcome): Record<string, unknown> {
  if (outcome.cutOff) {
    return {
      ok: false,
      error: `render_ui output was cut off after ${args.length} chars (output token limit). Send a more compact screen: fewer nodes, bind data with {"$data": …} instead of inline rows, shorter texts.`
    }
  }
  if (outcome.spec) return outcome.notes.length ? { ok: true, notes: outcome.notes } : { ok: true }
  return {
    ok: false,
    error:
      outcome.raw === null
        ? 'render_ui arguments are not valid JSON. Send {"spec": {...}} with spec as a JSON object.'
        : `invalid UiSpec — ${describeUiSpecProblem(outcome.raw)}. Call render_ui again with the corrected spec.`
  }
}

/** Count node-shaped objects in a raw (unvalidated) layout tree. */
function countRawNodes(value: unknown, depth = 0): number {
  if (!Array.isArray(value) || depth > 40) return 0
  let n = 0
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    n += 1 + countRawNodes((item as { children?: unknown }).children, depth + 1)
  }
  return n
}

/**
 * Silent repairs the validator made, in words the model can act on: unknown
 * component names, a `page` that wasn't among `pages`, nodes dropped for
 * having no name. The screen still lands — the notes just stop the same
 * mistake from repeating every turn.
 */
export function specRepairNotes(raw: unknown, spec: UiSpec): string[] {
  const notes: string[] = []
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  if (typeof r.page === 'string' && r.page && r.page !== spec.page) {
    notes.push(`page "${r.page}" is not in pages — showed "${spec.page}"`)
  }
  let validCount = 0
  const unknown: string[] = []
  for (const page of spec.pages) {
    for (const node of iterateNodes(page.layout)) {
      validCount++
      if (!getComponent(node.name) && unknown.length < 5) {
        unknown.push(`unknown component "${node.name}"${node.id ? ` (${node.id})` : ''} — use a registry name`)
      }
    }
  }
  notes.push(...unknown)
  const rawPages = Array.isArray(r.pages) ? r.pages : []
  const rawCount = rawPages.reduce<number>(
    (n, p) => n + (p && typeof p === 'object' ? countRawNodes((p as { layout?: unknown }).layout) : 0),
    0
  )
  if (rawCount > validCount) {
    notes.push(`${rawCount - validCount} malformed node(s) were dropped — every node needs a "name" from the registry`)
  }
  return notes
}

/** Validate model output and settle component names on the registry's spelling. */
function tryValidateUiSpec(input: unknown): UiSpec | null {
  const spec = validate(input)
  return spec && withRegistryNames(spec)
}

/** Whether a tool-call argument string is a JSON object (what every provider replays). */
function isJsonObjectText(args: string): boolean {
  try {
    const v: unknown = JSON.parse(args)
    return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
  } catch {
    return false
  }
}

/**
 * A failed call's arguments as history keeps them: always a JSON object
 * (OpenAI-compatible backends such as Ollama and vLLM re-parse replayed
 * `arguments` and answer 400 otherwise), and never more than a short head —
 * the validation error beside it carries the diagnosis.
 */
export function failedCallArgs(args: string): string {
  if (args.length <= MAX_FAILED_ARGS_CHARS && isJsonObjectText(args)) return args
  if (!args.trim()) return '{}'
  return JSON.stringify({ invalid: true, head: args.slice(0, MAX_FAILED_ARGS_CHARS) })
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
 * accept all of it. `repaired` says the arguments weren't clean JSON objects;
 * `salvaged` says some level only parsed by closing an unfinished prefix —
 * on a stream that was cut off, that is a partial screen, not a final one.
 */
export function specFromArgs(args: string): { spec: unknown; repaired: boolean; salvaged: boolean } {
  const outer = parseLoose(args)
  if (!outer) return { spec: null, repaired: false, salvaged: false }
  const value = 'spec' in outer.value ? outer.value.spec : outer.value
  if (typeof value === 'string') {
    const inner = parseLoose(value)
    return {
      spec: inner ? inner.value : null,
      repaired: true,
      salvaged: outer.salvaged || Boolean(inner?.salvaged)
    }
  }
  return { spec: value ?? null, repaired: outer.salvaged, salvaged: outer.salvaged }
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
