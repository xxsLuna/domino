import {
  anthropicAdaptiveThinking,
  anthropicMaxTokens,
  anthropicOmitsTemperature,
  anthropicThinkingAlwaysOn,
  anthropicThinkingBudget,
  effectiveReasoning,
  modelTakesReasoning,
  type ReasoningLevel
} from './reasoning'
import { LLMRequestError, withRetry } from './retry'
import { routingHeaders } from './routing'
import { openStream, sseData } from './sse'
import type { ChatMessage, ChatRequest, LLMAdapter, LLMConfig, StreamDelta, ToolDef } from './types'

/**
 * Anthropic Messages API streaming adapter (tool use via content blocks).
 *
 * Prompt caching: the request carries three cache breakpoints — the last
 * tool definition, the stable system block (the first system message) and
 * the last content block of the conversation. Iterations 2..N of a turn,
 * corrective rounds and background builds then re-read the shared prefix
 * from cache instead of paying for it again. Later system messages are
 * volatile context and sit after the stable breakpoint.
 *
 * Extended thinking: thinking blocks are captured from the stream and handed
 * out as `provider_blocks`, so the engine can store them on the assistant
 * message and they are replayed verbatim (signature intact) in front of that
 * message's text/tool_use — the API requires it inside a tool loop.
 */

const EPHEMERAL = { type: 'ephemeral' } as const

type Block = Record<string, unknown> & { type: string }
type WireMessage = { role: 'user' | 'assistant'; content: Block[] }

/** Thinking blocks this adapter itself produced — anything else is dropped, never replayed. */
function thinkingBlocks(blocks: unknown[] | undefined): Block[] {
  if (!blocks) return []
  return blocks.filter((b): b is Block => {
    if (!b || typeof b !== 'object') return false
    const block = b as Record<string, unknown>
    if (block.type === 'thinking') {
      return typeof block.thinking === 'string' && typeof block.signature === 'string'
    }
    return block.type === 'redacted_thinking' && typeof block.data === 'string'
  })
}

function parseInput(args: string): unknown {
  try {
    const v: unknown = args ? JSON.parse(args) : {}
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

/**
 * Serialize the conversation. `withThinking` replays captured thinking
 * blocks first on each assistant message of the OPEN tool loop (the only
 * place the API needs them); without thinking they are left out (an
 * assistant turn without thinking is always valid then). Blocks from
 * finished turns are dropped as a leading run: older turns get compacted
 * and rewritten between turns, and a thinking block replayed after an edit
 * to the history before it is rejected on models that bind thinking to the
 * conversation. Removing the oldest blocks first is always allowed.
 *
 * Consecutive same-role entries are merged into one message: the results of
 * parallel tool calls must all sit in the single user message after the
 * assistant turn, tool_result blocks first, any user text after them.
 */
export function toAnthropic(
  messages: ChatMessage[],
  opts: { withThinking?: boolean } = {}
): { system: Block[]; messages: WireMessage[] } {
  const system: Block[] = []
  for (const m of messages) {
    if (m.role !== 'system' || !m.content) continue
    system.push({ type: 'text', text: m.content })
  }

  const out: WireMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'assistant') {
      const content: Block[] = opts.withThinking ? thinkingBlocks(m.providerBlocks) : []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: parseInput(tc.args) })
      }
      if (!content.length) continue // an empty assistant turn is a 400; it carried nothing
      pushMerged(out, 'assistant', content)
    } else if (m.role === 'tool') {
      pushMerged(out, 'user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }])
    } else if (m.content) {
      pushMerged(out, 'user', [{ type: 'text', text: m.content }])
    }
  }
  // Anthropic requires the first message to be a user message.
  if (out.length && out[0].role === 'assistant') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: 'Start.' }] })
  }
  if (!opts.withThinking) return { system, messages: out }
  // Thinking only inside the open loop: strip it from every earlier turn.
  const start = openLoopStart(out)
  const trimmed: WireMessage[] = []
  out.forEach((m, i) => {
    const content =
      i < start && m.role === 'assistant' ? m.content.filter((b) => !isThinking(b)) : m.content
    if (content.length) pushMerged(trimmed, m.role, content)
  })
  return { system, messages: trimmed }
}

/** Append, merging into the previous message when it has the same role. */
function pushMerged(out: WireMessage[], role: WireMessage['role'], content: Block[]): void {
  const last = out[out.length - 1]
  if (last && last.role === role) {
    if (role === 'user') {
      // tool_result blocks must lead the user message.
      const merged = [...last.content, ...content]
      last.content = [
        ...merged.filter((b) => b.type === 'tool_result'),
        ...merged.filter((b) => b.type !== 'tool_result')
      ]
    } else {
      last.content = [...last.content, ...content]
    }
  } else {
    out.push({ role, content: [...content] })
  }
}

function isThinking(b: Block | undefined): boolean {
  return b?.type === 'thinking' || b?.type === 'redacted_thinking'
}

/**
 * Index of the first message of the open tool loop: everything after the
 * last user message that is not a tool-result carrier. A user note merged
 * into the tool results does not end the loop.
 */
function openLoopStart(wire: WireMessage[]): number {
  for (let i = wire.length - 1; i >= 0; i--) {
    const m = wire[i]
    if (m.role === 'user' && !m.content.some((b) => b.type === 'tool_result')) return i + 1
  }
  return 0
}

/**
 * Whether the open tool loop starts without thinking. With a fixed thinking
 * budget the API demands that the FIRST assistant turn of an open tool loop
 * starts with its thinking block — a loop begun without thinking (reasoning
 * switched on by the corrective round, or a resumed history) would be a hard
 * 400. Later assistant turns of the same loop may lack thinking: without the
 * interleaved-thinking beta the model does not think after a tool result.
 */
export function toolLoopLacksThinking(wire: WireMessage[]): boolean {
  const first = wire.slice(openLoopStart(wire)).find((m) => m.role === 'assistant')
  return Boolean(
    first && first.content.some((b) => b.type === 'tool_use') && !isThinking(first.content[0])
  )
}

/** Longest tool input / result kept when a loop is folded into plain text. */
const FOLDED_CHARS = 1_500

/**
 * Close an open tool loop that began without thinking, so a request can
 * turn thinking on (the corrective round's escalation). Every message of
 * the loop before its first thinking-led assistant turn is replayed as
 * plain text: tool_use blocks become a short "called …" line, tool_result
 * blocks the result's head. The folded part then ends on a plain user
 * message — a fresh user turn — and what follows (if anything) is a loop
 * that starts with thinking.
 */
export function closeToolLoop(wire: WireMessage[]): WireMessage[] {
  const start = openLoopStart(wire)
  let end = wire.length
  for (let i = start; i < wire.length; i++) {
    const m = wire[i]
    if (m.role === 'assistant' && isThinking(m.content[0])) {
      end = i
      break
    }
  }
  if (end === start) return wire
  const names = new Map<string, string>()
  const head = (text: string): string =>
    text.length > FOLDED_CHARS ? `${text.slice(0, FOLDED_CHARS)}…` : text
  const out: WireMessage[] = wire.slice(0, start).map((m) => ({ ...m, content: m.content.slice() }))
  for (const m of wire.slice(start, end)) {
    const content: Block[] = []
    for (const b of m.content) {
      if (isThinking(b)) continue
      if (b.type === 'tool_use') {
        names.set(String(b.id), String(b.name))
        content.push({
          type: 'text',
          text: `[called ${String(b.name)} ${head(JSON.stringify(b.input ?? {}))}]`
        })
      } else if (b.type === 'tool_result') {
        const name = names.get(String(b.tool_use_id)) ?? 'tool'
        const body = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')
        content.push({ type: 'text', text: `[${name} result] ${head(body)}` })
      } else if (b.type !== 'text' || b.text) {
        content.push(b)
      }
    }
    if (content.length) pushMerged(out, m.role, content)
  }
  // The folded part must hand over on a user message.
  if (!out.length || out[out.length - 1].role !== 'user') {
    pushMerged(out, 'user', [{ type: 'text', text: 'Continue.' }])
  }
  for (const m of wire.slice(end)) pushMerged(out, m.role, m.content)
  return out
}

/**
 * How one request thinks, decided from the model's generation:
 * - adaptive (4.6 and later): `thinking: {type: 'adaptive'}` plus
 *   `output_config.effort` — never `budget_tokens`, which those models
 *   reject; models that always think get effort "low" for "none"/unset and
 *   never a `disabled` (Opus 5.5 and Sonnet 5.5 reject it);
 * - budget (3.7 through 4.5, Haiku 4.5): a fixed `budget_tokens`;
 * - off: no thinking parameter at all.
 * `room` is extra output headroom on top of the visible tokens: thinking
 * counts against max_tokens either way.
 */
export type AnthropicThinkingPlan =
  | { kind: 'off' }
  | { kind: 'budget'; budget: number }
  | { kind: 'adaptive'; effort: Exclude<ReasoningLevel, 'none'>; room: number }

export function anthropicThinkingPlan(
  config: Pick<LLMConfig, 'model' | 'reasoning'>
): AnthropicThinkingPlan {
  const level = effectiveReasoning({
    provider: 'anthropic',
    model: config.model,
    reasoning: config.reasoning
  })
  if (anthropicAdaptiveThinking(config.model)) {
    if (!level || level === 'none') {
      if (!anthropicThinkingAlwaysOn(config.model)) return { kind: 'off' }
      return { kind: 'adaptive', effort: 'low', room: anthropicThinkingBudget('low') ?? 0 }
    }
    return { kind: 'adaptive', effort: level, room: anthropicThinkingBudget(level) ?? 0 }
  }
  const budget = level && modelTakesReasoning(config.model) ? anthropicThinkingBudget(level) : null
  return budget === null ? { kind: 'off' } : { kind: 'budget', budget }
}

/**
 * Place the cache breakpoints: stable system block, last tool, last content
 * block of the last message (the incremental history cache). Three of the
 * four allowed. Empty text blocks cannot carry one and are skipped.
 */
function withCacheBreakpoints(
  system: Block[],
  tools: Array<Record<string, unknown>>,
  messages: WireMessage[]
): { system: Block[]; tools: Array<Record<string, unknown>>; messages: WireMessage[] } {
  const sys = system.map((b, i) => (i === 0 ? { ...b, cache_control: EPHEMERAL } : b))
  const tl = tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: EPHEMERAL } : t))
  const msgs = messages.slice()
  const last = msgs[msgs.length - 1]
  if (last) {
    const content = last.content.slice()
    for (let i = content.length - 1; i >= 0; i--) {
      const b = content[i]
      if (b.type === 'thinking' || b.type === 'redacted_thinking') break
      if (b.type === 'text' && !b.text) continue
      content[i] = { ...b, cache_control: EPHEMERAL }
      break
    }
    msgs[msgs.length - 1] = { ...last, content }
  }
  return { system: sys, tools: tl, messages: msgs }
}

function toolDefs(tools: ToolDef[] | undefined): Array<Record<string, unknown>> {
  return (tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }))
}

/** Error types the API reports for transient trouble, sometimes as the first stream event. */
const TRANSIENT_STREAM_ERRORS = new Set(['overloaded_error', 'api_error', 'rate_limit_error'])

/** Stop reasons meaning "the output was cut off by a token limit". */
const TRUNCATING_STOPS = new Set(['max_tokens', 'model_context_window_exceeded'])

interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

interface AnthropicEvent {
  type?: string
  index?: number
  message?: { usage?: AnthropicUsage }
  content_block?: {
    type?: string
    id?: string
    name?: string
    thinking?: string
    signature?: string
    data?: string
  }
  delta?: {
    type?: string
    text?: string
    partial_json?: string
    thinking?: string
    signature?: string
    stop_reason?: string | null
  }
  usage?: AnthropicUsage
  error?: { type?: string; message?: string }
}

type OpenBlock =
  | { kind: 'tool'; id: string }
  | { kind: 'thinking'; thinking: string; signature: string }
  | { kind: 'other' }

export function createAnthropicAdapter(config: LLMConfig): LLMAdapter {
  const baseUrl = (config.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')

  async function* attempt(req: ChatRequest): AsyncGenerator<StreamDelta> {
    // Thinking is a hard contract per generation (see anthropicThinkingPlan).
    // With thinking on, `temperature` is left out (it must stay at its
    // default), and newer models reject sampling parameters entirely.
    const plan = anthropicThinkingPlan(config)
    let wire = toAnthropic(req.messages, { withThinking: plan.kind !== 'off' })
    if (plan.kind === 'budget' && toolLoopLacksThinking(wire.messages)) {
      // Mid tool loop without the loop's opening thinking block (reasoning
      // switched on by the corrective round, or a resumed history): replay
      // the loop's head as plain text so this request starts a fresh user
      // turn and can think — never a 400, and the escalation takes effect.
      wire = { system: wire.system, messages: closeToolLoop(wire.messages) }
    }
    const omitTemperature = plan.kind !== 'off' || anthropicOmitsTemperature(config.model)
    const cached = withCacheBreakpoints(wire.system, toolDefs(req.tools), wire.messages)
    const room = plan.kind === 'budget' ? plan.budget : plan.kind === 'adaptive' ? plan.room : null
    const body = {
      model: config.model,
      max_tokens: anthropicMaxTokens(config.model, room, config.maxOutputTokens),
      stream: true,
      ...(omitTemperature ? {} : { temperature: req.temperature ?? config.temperature ?? 0.7 }),
      ...(plan.kind === 'budget'
        ? { thinking: { type: 'enabled', budget_tokens: plan.budget } }
        : {}),
      ...(plan.kind === 'adaptive'
        ? { thinking: { type: 'adaptive' }, output_config: { effort: plan.effort } }
        : {}),
      ...(cached.system.length ? { system: cached.system } : {}),
      messages: cached.messages,
      ...(cached.tools.length ? { tools: cached.tools } : {})
    }
    const { res, guard } = await openStream(
      `${baseUrl}/v1/messages`,
      {
        headers: {
          'content-type': 'application/json',
          ...routingHeaders(baseUrl),
          'x-api-key': config.apiKey ?? '',
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
      },
      { signal: req.signal }
    )

    const open = new Map<number, OpenBlock>()
    const replay: Block[] = []
    let startUsage: AnthropicUsage = {}
    let truncated = false
    let emitted = false
    let usageSent = false

    try {
      for await (const payload of sseData(res, { idleMs: guard.idleMs, signal: guard.signal })) {
        let event: AnthropicEvent
        try {
          event = JSON.parse(payload)
        } catch {
          continue
        }
        const index = event.index ?? 0
        switch (event.type) {
          case 'message_start': {
            startUsage = event.message?.usage ?? {}
            break
          }
          case 'content_block_start': {
            const block = event.content_block
            if (block?.type === 'tool_use' && block.id) {
              open.set(index, { kind: 'tool', id: block.id })
              emitted = true
              yield { type: 'tool_call_start', id: block.id, name: block.name ?? '' }
            } else if (block?.type === 'thinking') {
              open.set(index, {
                kind: 'thinking',
                thinking: block.thinking ?? '',
                signature: block.signature ?? ''
              })
            } else if (block?.type === 'redacted_thinking' && typeof block.data === 'string') {
              replay.push({ type: 'redacted_thinking', data: block.data })
              open.set(index, { kind: 'other' })
            } else {
              open.set(index, { kind: 'other' })
            }
            break
          }
          case 'content_block_delta': {
            const d = event.delta
            const blk = open.get(index)
            if (d?.type === 'text_delta' && d.text) {
              emitted = true
              yield { type: 'text', text: d.text }
            } else if (d?.type === 'input_json_delta' && d.partial_json) {
              // Fall back to the only open tool when an index is missing.
              const tool =
                blk?.kind === 'tool'
                  ? blk
                  : [...open.values()].find(
                      (b): b is Extract<OpenBlock, { kind: 'tool' }> => b.kind === 'tool'
                    )
              if (tool) {
                emitted = true
                yield { type: 'tool_call_args', id: tool.id, argsDelta: d.partial_json }
              }
            } else if (d?.type === 'thinking_delta' && blk?.kind === 'thinking') {
              blk.thinking += d.thinking ?? ''
            } else if (d?.type === 'signature_delta' && blk?.kind === 'thinking') {
              blk.signature = d.signature ?? blk.signature
            }
            break
          }
          case 'content_block_stop': {
            const blk = open.get(index)
            open.delete(index)
            if (blk?.kind === 'tool') {
              emitted = true
              yield { type: 'tool_call_end', id: blk.id }
            } else if (blk?.kind === 'thinking') {
              replay.push({ type: 'thinking', thinking: blk.thinking, signature: blk.signature })
            }
            break
          }
          case 'message_delta': {
            const stop = event.delta?.stop_reason
            if (stop && TRUNCATING_STOPS.has(stop)) truncated = true
            const u = event.usage
            if (u) {
              // message_delta usage is cumulative for the response; input
              // fields may be absent there and only arrive with message_start.
              const input = u.input_tokens ?? startUsage.input_tokens ?? 0
              const cacheRead = u.cache_read_input_tokens ?? startUsage.cache_read_input_tokens ?? 0
              const cacheWrite =
                u.cache_creation_input_tokens ?? startUsage.cache_creation_input_tokens ?? 0
              const prompt = input + cacheRead + cacheWrite
              const completion = u.output_tokens ?? 0
              if (prompt || completion) {
                emitted = true
                usageSent = true
                yield {
                  type: 'usage',
                  usage: {
                    prompt,
                    completion,
                    total: prompt + completion,
                    ...(cacheRead ? { cached: cacheRead } : {})
                  }
                }
              }
            }
            break
          }
          case 'error': {
            const type = event.error?.type ?? 'error'
            const message = event.error?.message || type
            // Overload before any output: nothing reached the consumer yet, so
            // the whole request can be retried.
            if (!emitted && TRANSIENT_STREAM_ERRORS.has(type)) {
              throw new LLMRequestError(`LLM request failed: ${type} — ${message}`, {
                status: type === 'rate_limit_error' ? 429 : 529,
                retryable: true
              })
            }
            emitted = true
            yield { type: 'error', message: `anthropic stream error: ${message}` }
            break
          }
          default:
            break
        }
      }
    } finally {
      guard.release()
    }
    for (const blk of open.values()) {
      if (blk.kind === 'tool') yield { type: 'tool_call_end', id: blk.id }
    }
    // Gateways that report usage only on message_start still get counted.
    const startPrompt =
      (startUsage.input_tokens ?? 0) +
      (startUsage.cache_read_input_tokens ?? 0) +
      (startUsage.cache_creation_input_tokens ?? 0)
    if (!usageSent && startPrompt) {
      const completion = startUsage.output_tokens ?? 0
      const cacheRead = startUsage.cache_read_input_tokens ?? 0
      yield {
        type: 'usage',
        usage: {
          prompt: startPrompt,
          completion,
          total: startPrompt + completion,
          ...(cacheRead ? { cached: cacheRead } : {})
        }
      }
    }
    if (replay.length) yield { type: 'provider_blocks', blocks: replay }
    yield truncated ? { type: 'done', truncated: true } : { type: 'done' }
  }

  return {
    chat(req: ChatRequest): AsyncIterable<StreamDelta> {
      return withRetry(() => attempt(req), { signal: req.signal })
    }
  }
}
