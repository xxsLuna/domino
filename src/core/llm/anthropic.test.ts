import { afterEach, describe, expect, it } from 'vitest'
import { setHttpFetch } from '../net'
import { runAgentTurn } from '../agent/engine'
import {
  anthropicThinkingPlan,
  closeToolLoop,
  createAnthropicAdapter,
  toAnthropic,
  toolLoopLacksThinking
} from './anthropic'
import type { ChatMessage, ChatRequest, LLMConfig, StreamDelta } from './types'

const CFG: LLMConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  apiKey: 'k',
  baseUrl: 'https://llm.test'
}

function sse(events: unknown[]): Response {
  return new Response(events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}

/** Stub fetch with a queue of responses; records every posted body. */
function stub(...responses: Array<Response | (() => Response | Promise<Response>)>): {
  bodies: any[]
} {
  const bodies: any[] = []
  setHttpFetch(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    const next = responses.shift() ?? sse([])
    return typeof next === 'function' ? next() : next
  })
  return { bodies }
}

async function collect(cfg: LLMConfig, req: ChatRequest): Promise<StreamDelta[]> {
  const out: StreamDelta[] = []
  for await (const d of createAnthropicAdapter(cfg).chat(req)) out.push(d)
  return out
}

afterEach(() => {
  setHttpFetch((input, init) => globalThis.fetch(input, init))
})

const THINKING = { type: 'thinking', thinking: 'plan the call', signature: 'sig-abc' }

const TOOL_LOOP: ChatMessage[] = [
  { role: 'system', content: 'STABLE' },
  { role: 'user', content: 'open orders' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 't1', name: 'call_api', args: '{"method":"GET","path":"/orders"}' }]
  },
  { role: 'tool', content: '{"ok":true}', toolCallId: 't1', toolName: 'call_api' }
]

describe('anthropic request shape', () => {
  it('sends system as blocks with a cache breakpoint on the stable block only', async () => {
    const { bodies } = stub()
    await collect(CFG, {
      messages: [
        { role: 'system', content: 'STABLE' },
        { role: 'system', content: 'VOLATILE' },
        { role: 'user', content: 'hi' }
      ],
      tools: [
        { name: 'a', description: 'A', parameters: {} },
        { name: 'b', description: 'B', parameters: {} }
      ]
    })
    const b = bodies[0]
    expect(b.system).toEqual([
      { type: 'text', text: 'STABLE', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'VOLATILE' }
    ])
    expect(b.tools[0].cache_control).toBeUndefined()
    expect(b.tools[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(b.messages.at(-1).content.at(-1)).toEqual({
      type: 'text',
      text: 'hi',
      cache_control: { type: 'ephemeral' }
    })
  })

  it('puts the history breakpoint on a trailing tool_result', async () => {
    const { bodies } = stub()
    await collect(CFG, { messages: TOOL_LOOP })
    const last = bodies[0].messages.at(-1)
    expect(last.content.at(-1).type).toBe('tool_result')
    expect(last.content.at(-1).cache_control).toEqual({ type: 'ephemeral' })
  })

  it('merges parallel tool results into one user message, results first', () => {
    const wire = toAnthropic([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'a', name: 'call_api', args: '{}' },
          { id: 'b', name: 'call_api', args: '{}' }
        ]
      },
      { role: 'tool', content: 'A', toolCallId: 'a' },
      { role: 'tool', content: 'B', toolCallId: 'b' },
      { role: 'user', content: 'note' }
    ])
    expect(wire.messages).toHaveLength(3)
    expect(wire.messages[2].content.map((b) => b.type)).toEqual([
      'tool_result',
      'tool_result',
      'text'
    ])
  })

  it('drops empty assistant turns instead of sending an empty text block', () => {
    const wire = toAnthropic([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'b' }
    ])
    expect(wire.messages).toHaveLength(1)
    expect(wire.messages[0].content.map((b) => b.text)).toEqual(['a', 'b'])
  })
})

describe('anthropic extended thinking in tool loops', () => {
  it('replays captured thinking blocks first on the assistant turn', async () => {
    const { bodies } = stub()
    const history = TOOL_LOOP.map((m) =>
      m.role === 'assistant' ? { ...m, providerBlocks: [THINKING] } : m
    )
    await collect({ ...CFG, reasoning: 'low' }, { messages: history })
    const b = bodies[0]
    expect(b.thinking).toEqual({ type: 'enabled', budget_tokens: 2_048 })
    expect(b.messages[1].content[0]).toEqual(THINKING)
    expect(b.messages[1].content[1].type).toBe('tool_use')
  })

  it('closes a loop begun without thinking so the request can think', async () => {
    const { bodies } = stub()
    await collect({ ...CFG, reasoning: 'low' }, { messages: TOOL_LOOP })
    const b = bodies[0]
    expect(b.thinking).toEqual({ type: 'enabled', budget_tokens: 2_048 })
    expect(b.temperature).toBeUndefined()
    expect(b.max_tokens).toBe(16_384 + 2_048)
    // The loop is replayed as text: no tool_use / tool_result left, ends on a user turn.
    const types = b.messages.flatMap((m: any) => m.content.map((c: any) => c.type))
    expect(types).not.toContain('tool_use')
    expect(types).not.toContain('tool_result')
    expect(b.messages.at(-1).role).toBe('user')
    expect(JSON.stringify(b.messages)).toContain('[called call_api')
    expect(JSON.stringify(b.messages)).toContain('[call_api result]')
  })

  it('a user note merged into the tool results is folded with the loop', async () => {
    const { bodies } = stub()
    await collect(
      { ...CFG, reasoning: 'low' },
      { messages: [...TOOL_LOOP, { role: 'user', content: 'fix the spec' }] }
    )
    expect(bodies[0].thinking).toEqual({ type: 'enabled', budget_tokens: 2_048 })
    expect(JSON.stringify(bodies[0].messages.at(-1))).toContain('fix the spec')
  })

  it('only the loop opener needs thinking: a later pass without it keeps thinking on', async () => {
    const { bodies } = stub()
    const loop: ChatMessage[] = [
      { role: 'user', content: 'open orders' },
      {
        role: 'assistant',
        content: '',
        providerBlocks: [THINKING],
        toolCalls: [{ id: 't1', name: 'call_api', args: '{"path":"/orders"}' }]
      },
      { role: 'tool', content: '{"ok":true}', toolCallId: 't1' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't2', name: 'call_api', args: '{"path":"/x"}' }]
      },
      { role: 'tool', content: '{"ok":true}', toolCallId: 't2' }
    ]
    await collect({ ...CFG, reasoning: 'low' }, { messages: loop })
    const b = bodies[0]
    expect(b.thinking).toEqual({ type: 'enabled', budget_tokens: 2_048 })
    expect(b.messages[1].content[0]).toEqual(THINKING)
    expect(b.messages[3].content[0].type).toBe('tool_use')
  })

  it('folds only up to the first thinking-led turn of the loop', () => {
    const wire = toAnthropic(
      [
        ...TOOL_LOOP.slice(1),
        {
          role: 'assistant',
          content: '',
          providerBlocks: [THINKING],
          toolCalls: [{ id: 't2', name: 'render_ui', args: '{"spec":{}}' }]
        },
        { role: 'tool', content: '{"ok":true}', toolCallId: 't2' }
      ],
      { withThinking: true }
    ).messages
    const closed = closeToolLoop(wire)
    expect(toolLoopLacksThinking(closed)).toBe(false)
    expect(closed.at(-2)?.content[0]).toEqual(THINKING)
    expect(closed.at(-1)?.content[0].type).toBe('tool_result')
  })

  it('replays thinking only inside the open loop, never on finished turns', () => {
    const wire = toAnthropic(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'done', providerBlocks: [THINKING] },
        { role: 'user', content: 'second' },
        {
          role: 'assistant',
          content: '',
          providerBlocks: [THINKING],
          toolCalls: [{ id: 't1', name: 'call_api', args: '{}' }]
        },
        { role: 'tool', content: '{}', toolCallId: 't1' }
      ],
      { withThinking: true }
    )
    expect(wire.messages[1].content).toEqual([{ type: 'text', text: 'done' }])
    expect(wire.messages[3].content[0]).toEqual(THINKING)
  })

  it('keeps thinking once a fresh user turn starts', async () => {
    const { bodies } = stub()
    await collect(
      { ...CFG, reasoning: 'low' },
      {
        messages: [
          ...TOOL_LOOP,
          { role: 'assistant', content: 'done' },
          { role: 'user', content: 'next screen' }
        ]
      }
    )
    expect(bodies[0].thinking).toEqual({ type: 'enabled', budget_tokens: 2_048 })
  })

  it('never replays foreign or malformed provider blocks', () => {
    const wire = toAnthropic(
      [
        { role: 'user', content: 'x' },
        {
          role: 'assistant',
          content: 'ok',
          providerBlocks: [{ type: 'reasoning', text: 'openai' }, { type: 'thinking' }, THINKING]
        }
      ],
      { withThinking: true }
    )
    expect(wire.messages[1].content).toEqual([THINKING, { type: 'text', text: 'ok' }])
  })

  it('detects the loop boundary on the wire', () => {
    expect(toolLoopLacksThinking(toAnthropic(TOOL_LOOP).messages)).toBe(true)
    expect(toolLoopLacksThinking(toAnthropic([{ role: 'user', content: 'hi' }]).messages)).toBe(
      false
    )
  })
})

describe('anthropic model generations', () => {
  const body = async (cfg: Partial<LLMConfig>): Promise<any> => {
    const { bodies } = stub()
    await collect({ ...CFG, ...cfg }, { messages: [{ role: 'user', content: 'hi' }] })
    return bodies[0]
  }

  it('never sends temperature to models that forbid sampling or take only the default', async () => {
    for (const model of [
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-fable-5',
      'claude-mythos-5-1'
    ]) {
      const b = await body({ model, temperature: 0.3 })
      expect(b.temperature, model).toBeUndefined()
    }
    expect((await body({ model: 'claude-sonnet-4-5', temperature: 0.3 })).temperature).toBe(0.3)
    expect((await body({ model: 'claude-opus-4-6', temperature: 0.3 })).temperature).toBe(0.3)
  })

  it('maps a level to adaptive thinking plus effort on 4.6+ — never budget_tokens', async () => {
    for (const model of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-7', 'claude-opus-5-5']) {
      const b = await body({ model, reasoning: 'medium' })
      expect(b.thinking, model).toEqual({ type: 'adaptive' })
      expect(b.output_config, model).toEqual({ effort: 'medium' })
      expect(b.temperature, model).toBeUndefined()
    }
  })

  it('keeps budget_tokens for 3.7 through 4.5 and Haiku 4.5', async () => {
    for (const model of ['claude-3-7-sonnet-20250219', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1']) {
      const b = await body({ model, reasoning: 'low' })
      expect(b.thinking, model).toEqual({ type: 'enabled', budget_tokens: 2_048 })
      expect(b.output_config, model).toBeUndefined()
    }
  })

  it('"none"/unset: no thinking where it is optional, lowest effort where it is always on', async () => {
    const optional = await body({ model: 'claude-opus-4-7', reasoning: 'none' })
    expect(optional.thinking).toBeUndefined()
    expect(optional.output_config).toBeUndefined()
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5']) {
      for (const reasoning of [undefined, 'none'] as const) {
        const b = await body({ model, reasoning })
        expect(b.thinking, model).toEqual({ type: 'adaptive' })
        expect(b.output_config, model).toEqual({ effort: 'low' })
        expect(JSON.stringify(b)).not.toContain('disabled')
      }
    }
  })

  it('adaptive thinking is not dropped mid-loop (no loop-opener requirement)', () => {
    expect(anthropicThinkingPlan({ model: 'claude-opus-4-7', reasoning: 'low' }).kind).toBe('adaptive')
  })

  it('the corrective round escalation reaches the wire with thinking on', async () => {
    const BAD = { spec: { version: 1, page: 'p', pages: [] } }
    const GOOD = {
      spec: {
        version: 1,
        page: 'p',
        pages: [{ id: 'p', name: 'P', layout: [{ name: 'Heading', props: { text: 'Hi' } }] }]
      }
    }
    const toolReply = (input: unknown): Response =>
      sse([
        { type: 'message_start', message: { usage: { input_tokens: 5 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tu${Math.random()}`, name: 'render_ui' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' }
      ])
    const { bodies } = stub(toolReply(BAD), toolReply(GOOD))
    const updates = []
    for await (const u of runAgentTurn({
      adapter: createAnthropicAdapter(CFG),
      escalateReasoning: () => createAnthropicAdapter({ ...CFG, reasoning: 'low' }),
      system: 's',
      history: [{ role: 'user', content: 'go' }],
      api: { allow: [], token: null }
    })) {
      updates.push(u)
    }
    expect(bodies).toHaveLength(2)
    expect(bodies[0].thinking).toBeUndefined()
    expect(bodies[1].thinking).toEqual({ type: 'enabled', budget_tokens: 2_048 })
    expect(bodies[1].messages.at(-1).role).toBe('user')
    expect(updates.some((u) => u.type === 'spec' && u.final)).toBe(true)
  })
})

describe('anthropic stream parsing', () => {
  const STREAM = [
    {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 4_000,
          cache_creation_input_tokens: 50
        }
      }
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'it' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 'tu1', name: 'render_ui' }
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"a":' }
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '1}' }
    },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } },
    { type: 'message_stop' }
  ]

  it('emits text, tool calls, provider blocks and full usage', async () => {
    stub(sse(STREAM))
    const out = await collect(
      { ...CFG, reasoning: 'low' },
      { messages: [{ role: 'user', content: 'x' }] }
    )
    expect(out).toEqual([
      { type: 'text', text: 'Hi' },
      { type: 'tool_call_start', id: 'tu1', name: 'render_ui' },
      { type: 'tool_call_args', id: 'tu1', argsDelta: '{"a":' },
      { type: 'tool_call_args', id: 'tu1', argsDelta: '1}' },
      { type: 'tool_call_end', id: 'tu1' },
      { type: 'usage', usage: { prompt: 4_150, completion: 30, total: 4_180, cached: 4_000 } },
      {
        type: 'provider_blocks',
        blocks: [{ type: 'thinking', thinking: 'plan it', signature: 'sig' }]
      },
      { type: 'done' }
    ])
  })

  it('still counts usage a gateway reports only on message_start', async () => {
    stub(
      sse([
        { type: 'message_start', message: { usage: { input_tokens: 70, output_tokens: 1 } } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
      ])
    )
    const out = await collect(CFG, { messages: [{ role: 'user', content: 'x' }] })
    expect(out).toContainEqual({ type: 'usage', usage: { prompt: 70, completion: 1, total: 71 } })
  })

  it('passes redacted thinking through untouched', async () => {
    stub(
      sse([
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'redacted_thinking', data: 'ENC' }
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }
      ])
    )
    const out = await collect(CFG, { messages: [{ role: 'user', content: 'x' }] })
    expect(out).toContainEqual({
      type: 'provider_blocks',
      blocks: [{ type: 'redacted_thinking', data: 'ENC' }]
    })
  })

  it('flags a max_tokens stop as truncated', async () => {
    stub(
      sse([
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't', name: 'render_ui' }
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"sp' }
        },
        {
          type: 'message_delta',
          delta: { stop_reason: 'max_tokens' },
          usage: { output_tokens: 16_384 }
        }
      ])
    )
    const out = await collect(CFG, { messages: [{ role: 'user', content: 'x' }] })
    expect(out.at(-1)).toEqual({ type: 'done', truncated: true })
    expect(out).toContainEqual({ type: 'tool_call_end', id: 't' })
  })

  it('reports the provider error text once output has started', async () => {
    stub(
      sse([
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } },
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
      ])
    )
    const out = await collect(CFG, { messages: [{ role: 'user', content: 'x' }] })
    expect(out).toContainEqual({ type: 'error', message: 'anthropic stream error: Overloaded' })
  })
})

describe('anthropic retries and cancellation', () => {
  const OK = (): Response =>
    sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
    ])

  it('retries a 529 honoring retry-after-ms, then streams', async () => {
    const { bodies } = stub(
      new Response('{"error":{"message":"Overloaded"}}', {
        status: 529,
        headers: { 'retry-after-ms': '0' }
      }),
      OK
    )
    const out = await collect(CFG, { messages: [{ role: 'user', content: 'x' }] })
    expect(bodies).toHaveLength(2)
    expect(out[0]).toEqual({ type: 'text', text: 'ok' })
  })

  it('retries an overloaded error event that arrives before any output', async () => {
    const { bodies } = stub(
      sse([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]),
      OK
    )
    // The stream-level overload has no retry-after; keep the backoff short.
    const out = await collect(CFG, { messages: [{ role: 'user', content: 'x' }] })
    expect(bodies).toHaveLength(2)
    expect(out[0]).toEqual({ type: 'text', text: 'ok' })
  }, 10_000)

  it('does not retry a 400 and reports the provider message', async () => {
    const { bodies } = stub(
      new Response('{"error":{"message":"bad tool schema"}}', {
        status: 400,
        statusText: 'Bad Request'
      })
    )
    await expect(collect(CFG, { messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(
      /LLM request failed: 400 Bad Request — bad tool schema/
    )
    expect(bodies).toHaveLength(1)
  })

  it('gives up after two retries', async () => {
    const busy = (): Response => new Response('', { status: 503, headers: { 'retry-after': '0' } })
    const { bodies } = stub(busy, busy, busy, OK)
    await expect(collect(CFG, { messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(
      /503/
    )
    expect(bodies).toHaveLength(3)
  })

  it('aborts promptly while waiting for the first byte', async () => {
    setHttpFetch(() => new Promise<Response>(() => {})) // never answers
    const ctl = new AbortController()
    const run = collect(CFG, { messages: [{ role: 'user', content: 'x' }], signal: ctl.signal })
    setTimeout(() => ctl.abort(new Error('superseded')), 5)
    await expect(run).rejects.toThrow('superseded')
  })

  it('never starts a request for an already-aborted signal', async () => {
    const { bodies } = stub(OK)
    const ctl = new AbortController()
    ctl.abort(new Error('gone'))
    await expect(
      collect(CFG, { messages: [{ role: 'user', content: 'x' }], signal: ctl.signal })
    ).rejects.toThrow('gone')
    expect(bodies).toHaveLength(0)
  })
})
