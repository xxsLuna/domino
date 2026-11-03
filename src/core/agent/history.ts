import type { ChatMessage, ToolCall } from '../llm/types'

/**
 * Conversation history hygiene.
 *
 * Every provider insists on pairing: a tool result must answer a tool call of
 * the assistant message right before it, and (Anthropic) every tool call must
 * get its result. A history cut at an arbitrary index, or a turn abandoned
 * between a tool call and its result, breaks that pairing — and then EVERY
 * later request is rejected with a 400 until the app is rebuilt. Separately,
 * each past screen stays in history as a full spec (several KB) and each
 * call_api result as a full payload, re-sent on every pass of every turn.
 *
 * `sanitizeHistory` restores the pairing invariant; `compactHistory` bounds
 * the size: whole turns drop from the front, and turns older than the last
 * few keep only stubs of their specs and payloads (the runtime already holds
 * the pages and the response bodies — the model only needs to know that they
 * happened). Both are pure: the input array and its messages are never
 * mutated.
 */

/**
 * Corrective nudges the engine adds as `user` messages mid-turn. They are
 * NOT turn boundaries: cutting history there would keep a "call render_ui
 * for the request above" without the request.
 */
export const ENGINE_NUDGE_PREFIXES = ['No screen was rendered.', 'Data budget reached:']

export function isEngineNudge(m: ChatMessage): boolean {
  return m.role === 'user' && ENGINE_NUDGE_PREFIXES.some((p) => m.content.startsWith(p))
}

/**
 * Restore the tool-call pairing invariant:
 * - leading messages before the first user message are dropped (a history
 *   may never open with a tool result or an assistant reply);
 * - a tool message survives only inside the contiguous block of results
 *   right after the assistant message that issued its call (once per call);
 * - tool calls that never got a result are stripped from their message;
 * - an assistant message left with no text and no calls is dropped.
 * System messages pass through untouched. Unchanged messages keep their
 * identity, so callers can still find "their" message in the output.
 */
export function sanitizeHistory(msgs: ChatMessage[]): ChatMessage[] {
  const firstUser = msgs.findIndex((m) => m.role === 'user')
  const body =
    firstUser < 0
      ? msgs.filter((m) => m.role === 'system')
      : [...msgs.slice(0, firstUser).filter((m) => m.role === 'system'), ...msgs.slice(firstUser)]

  // Pass 1: keep only tool results that answer the open block's calls.
  // "Answered" is tracked per assistant message: OpenAI-compatible servers
  // (llama.cpp, Ollama, some vLLM builds) reuse ids like `call_0` in every
  // response, so an id answered earlier says nothing about this block.
  const kept: ChatMessage[] = []
  const answeredBy = new Map<ChatMessage, Set<string>>()
  let open: Set<string> | null = null
  let answered: Set<string> | null = null
  for (const m of body) {
    if (m.role === 'tool') {
      const id = m.toolCallId
      if (open && answered && id && open.has(id) && !answered.has(id)) {
        answered.add(id)
        kept.push(m)
      }
      continue
    }
    const calling = m.role === 'assistant' && Boolean(m.toolCalls?.length)
    open = calling ? new Set(m.toolCalls!.map((c) => c.id)) : null
    answered = calling ? new Set<string>() : null
    if (answered) answeredBy.set(m, answered)
    kept.push(m)
  }

  // Pass 2: strip unanswered calls; drop assistants left empty.
  const out: ChatMessage[] = []
  for (const m of kept) {
    if (m.role !== 'assistant' || !m.toolCalls) {
      out.push(m)
      continue
    }
    const mine = answeredBy.get(m) ?? new Set<string>()
    const calls = m.toolCalls.filter((c) => mine.has(c.id))
    if (calls.length === m.toolCalls.length) {
      out.push(m)
      continue
    }
    if (!calls.length && !m.content) continue
    const next: ChatMessage = { ...m }
    if (calls.length) next.toolCalls = calls
    else delete next.toolCalls
    out.push(next)
  }
  return out
}

/** Default bounds: ~40 messages, the last 3 user turns kept verbatim. */
const DEFAULT_MAX_MESSAGES = 40
const DEFAULT_KEEP_TURNS = 3
/** Total character budget after stubbing — a handful of huge user prompts can't escape the cap. */
const DEFAULT_MAX_CHARS = 160_000
/** Older user/assistant prose is capped: edit prompts can carry whole specs. */
const OLD_TEXT_CHARS = 2_000

/**
 * Split into turns: a turn starts at a user message that is not an engine
 * nudge. After sanitizing, a user message can never sit between an assistant
 * tool call and its results, so every such boundary is a safe cut.
 */
function splitTurns(msgs: ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = []
  for (const m of msgs) {
    if ((m.role === 'user' && !isEngineNudge(m)) || turns.length === 0) turns.push([m])
    else turns[turns.length - 1].push(m)
  }
  return turns
}

function size(m: ChatMessage): number {
  let n = m.content.length
  for (const c of m.toolCalls ?? []) n += c.args.length + c.name.length
  return n
}

function clipText(text: string): string {
  return text.length > OLD_TEXT_CHARS
    ? `${text.slice(0, OLD_TEXT_CHARS)}…(trimmed, ${text.length} chars)`
    : text
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Page id (and page list) of a render_ui call, from clean JSON or — failing that — a regex peek. */
function renderedPages(args: string): { page?: string; pages?: string[]; stub: boolean } {
  const outer = parseObject(args)
  if (outer) {
    let spec: unknown = 'spec' in outer ? outer.spec : outer
    if (typeof spec === 'string') spec = parseObject(spec)
    if (spec && typeof spec === 'object') {
      const s = spec as Record<string, unknown>
      const page = typeof s.page === 'string' ? s.page : undefined
      const stub = s.rendered !== undefined && !Array.isArray(s.pages)
      const pages = Array.isArray(s.pages)
        ? s.pages.flatMap((p) =>
            p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string'
              ? [(p as { id: string }).id]
              : []
          )
        : Array.isArray(s.pageIds)
          ? (s.pageIds as unknown[]).filter((x): x is string => typeof x === 'string')
          : undefined
      return { page, pages, stub }
    }
  }
  const m = /"page"\s*:\s*"([^"\\]{1,120})"/.exec(args)
  return { page: m ? m[1] : undefined, stub: false }
}

function stubRenderArgs(args: string, ok: boolean): string {
  const { page, pages, stub } = renderedPages(args)
  if (stub) return args
  const spec: Record<string, unknown> = {}
  if (page) spec.page = page
  if (pages && pages.length > 1) spec.pageIds = pages
  spec.rendered = ok
  return JSON.stringify({ spec })
}

/** `{status, bind, keys}` of a call_api result — what happened, without the body. */
function stubApiResult(content: string): string {
  const parsed = parseObject(content)
  if (!parsed || !('status' in parsed) || parsed.elided) return content
  const data = parsed.data
  const out: Record<string, unknown> = { status: parsed.status }
  if (parsed.bind !== undefined) out.bind = parsed.bind
  if (Array.isArray(data)) {
    out.keys = ['[]']
    out.length = data.length
  } else if (data && typeof data === 'object') {
    out.keys = Object.keys(data as Record<string, unknown>).slice(0, 20)
  }
  if (parsed.error !== undefined) out.error = parsed.error
  out.elided = true
  return JSON.stringify(out)
}

/** Stub one old turn: specs, payloads and long prose become markers. */
function stubTurn(turn: ChatMessage[]): ChatMessage[] {
  // Which render_ui calls succeeded, read off their tool results.
  const okById = new Map<string, boolean>()
  for (const m of turn) {
    if (m.role === 'tool' && m.toolName === 'render_ui' && m.toolCallId) {
      okById.set(m.toolCallId, parseObject(m.content)?.ok === true)
    }
  }
  return turn.map((m): ChatMessage => {
    if (m.role === 'assistant') {
      const next: ChatMessage = { ...m, content: clipText(m.content) }
      // Old thinking blocks are dead weight: providers only need them on the
      // current tool loop's last assistant message.
      delete (next as { providerBlocks?: unknown }).providerBlocks
      if (m.toolCalls) {
        next.toolCalls = m.toolCalls.map(
          (c): ToolCall =>
            c.name === 'render_ui' ? { ...c, args: stubRenderArgs(c.args, okById.get(c.id) ?? false) } : c
        )
      }
      return next
    }
    if (m.role === 'tool') {
      if (m.toolName === 'call_api') return { ...m, content: stubApiResult(m.content) }
      if (m.toolName === 'render_ui') {
        const ok = parseObject(m.content)?.ok === true
        return { ...m, content: JSON.stringify({ ok }) }
      }
      return m
    }
    if (m.role === 'user' && m.content.length > OLD_TEXT_CHARS) {
      return { ...m, content: clipText(m.content) }
    }
    return m
  })
}

/**
 * Bound the history for the next request (and for persistence):
 * 1. whole turns drop from the front until at most `maxMessages` remain (the
 *    newest turn always survives, whatever its size);
 * 2. every turn older than the last `keepTurns` is stubbed — render_ui args
 *    become `{"spec":{"page":"<id>","rendered":true}}` (valid JSON: adapters
 *    re-parse tool args), call_api results become `{status, bind, keys}`
 *    without data, long prose is clipped, old thinking blocks dropped;
 * 3. more whole turns drop while the total exceeds `maxChars`.
 * The result is sanitized, so it is always safe to send.
 */
export function compactHistory(
  msgs: ChatMessage[],
  opts?: { maxMessages?: number; keepTurns?: number; maxChars?: number }
): ChatMessage[] {
  const maxMessages = Math.max(1, opts?.maxMessages ?? DEFAULT_MAX_MESSAGES)
  const keepTurns = Math.max(0, opts?.keepTurns ?? DEFAULT_KEEP_TURNS)
  const maxChars = Math.max(1, opts?.maxChars ?? DEFAULT_MAX_CHARS)

  const clean = sanitizeHistory(msgs)
  const system = clean.filter((m) => m.role === 'system')
  let turns = splitTurns(clean.filter((m) => m.role !== 'system'))

  const count = (ts: ChatMessage[][]): number => ts.reduce((n, t) => n + t.length, 0)
  while (turns.length > 1 && count(turns) > maxMessages) turns = turns.slice(1)

  turns = turns.map((t, i) => (i < turns.length - keepTurns ? stubTurn(t) : t))

  const chars = (ts: ChatMessage[][]): number =>
    ts.reduce((n, t) => n + t.reduce((k, m) => k + size(m), 0), 0)
  while (turns.length > 1 && chars(turns) > maxChars) turns = turns.slice(1)

  return sanitizeHistory([...system, ...turns.flat()])
}
