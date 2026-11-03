import { afterEach, describe, expect, it } from 'vitest'
import { setHttpFetch } from '../net'
import { createOpenAIAdapter, ToolCallTracker } from './openai'
import type { LLMConfig, StreamDelta } from './types'

const CFG: LLMConfig = {
  provider: 'chat_completions',
  model: 'gpt-4o',
  apiKey: 'k',
  baseUrl: 'https://llm.test/v1'
}

function sse(chunks: unknown[]): Response {
  return new Response(
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
    { status: 200 }
  )
}

function stub(...responses: Array<() => Response>): { bodies: any[] } {
  const bodies: any[] = []
  setHttpFetch(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return (responses.shift() ?? (() => sse([])))()
  })
  return { bodies }
}

async function collect(cfg: LLMConfig = CFG, cacheKey?: string): Promise<StreamDelta[]> {
  const out: StreamDelta[] = []
  for await (const d of createOpenAIAdapter(cfg).chat({
    messages: [{ role: 'user', content: 'x' }],
    ...(cacheKey ? { cacheKey } : {})
  })) {
    out.push(d)
  }
  return out
}

/** Rebuild finished calls from the normalized deltas, as the engine does. */
function calls(deltas: StreamDelta[]): Array<{ id: string; name: string; args: string }> {
  const map = new Map<string, { id: string; name: string; args: string }>()
  for (const d of deltas) {
    if (d.type === 'tool_call_start') {
      const c = map.get(d.id)
      if (c) c.name ||= d.name
      else map.set(d.id, { id: d.id, name: d.name, args: '' })
    } else if (d.type === 'tool_call_args') map.get(d.id)!.args += d.argsDelta
  }
  return [...map.values()]
}

const tc = (t: Record<string, unknown>): unknown => ({ choices: [{ delta: { tool_calls: [t] } }] })

afterEach(() => {
  setHttpFetch((input, init) => globalThis.fetch(input, init))
})

describe('chat-completions tool-call identity', () => {
  it('keeps the standard OpenAI shape (id on the first chunk, args by index)', async () => {
    stub(() =>
      sse([
        tc({ index: 0, id: 'call_a', function: { name: 'render_ui', arguments: '' } }),
        tc({ index: 0, function: { arguments: '{"x":' } }),
        tc({ index: 0, function: { arguments: '1}' } }),
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
      ])
    )
    expect(calls(await collect())).toEqual([{ id: 'call_a', name: 'render_ui', args: '{"x":1}' }])
  })

  it('synthesizes an id for a call that never carries one', async () => {
    stub(() =>
      sse([
        tc({ index: 0, function: { name: 'render_ui', arguments: '{"a"' } }),
        tc({ index: 0, function: { arguments: ':' } }),
        tc({ index: 0, function: { arguments: '2}' } })
      ])
    )
    const out = calls(await collect())
    expect(out).toHaveLength(1)
    expect(out[0].id).toMatch(/^call_0_/)
    expect(out[0].args).toBe('{"a":2}')
  })

  it('separates complete calls that omit the index', async () => {
    stub(() =>
      sse([
        tc({ id: 'c1', function: { name: 'call_api', arguments: '{"p":1}' } }),
        tc({ id: 'c2', function: { name: 'render_ui', arguments: '{"p":2}' } })
      ])
    )
    expect(calls(await collect())).toEqual([
      { id: 'c1', name: 'call_api', args: '{"p":1}' },
      { id: 'c2', name: 'render_ui', args: '{"p":2}' }
    ])
  })

  it('never merges two calls sent at the same index with distinct ids', async () => {
    stub(() =>
      sse([
        tc({ index: 0, id: 'c1', function: { name: 'call_api', arguments: '{"p":1}' } }),
        tc({ index: 0, id: 'c2', function: { name: 'render_ui', arguments: '{"p":' } }),
        tc({ index: 0, function: { arguments: '2}' } })
      ])
    )
    const deltas = await collect()
    expect(calls(deltas)).toEqual([
      { id: 'c1', name: 'call_api', args: '{"p":1}' },
      { id: 'c2', name: 'render_ui', args: '{"p":2}' }
    ])
    const endFirst = deltas.findIndex((d) => d.type === 'tool_call_end' && d.id === 'c1')
    const startSecond = deltas.findIndex((d) => d.type === 'tool_call_start' && d.id === 'c2')
    expect(endFirst).toBeGreaterThan(-1)
    expect(endFirst).toBeLessThan(startSecond)
  })

  it('continues an id-less, index-less chunk on the previous call', async () => {
    stub(() =>
      sse([
        tc({ id: 'c1', function: { name: 'render_ui', arguments: '{"a"' } }),
        tc({ function: { arguments: ':1}' } })
      ])
    )
    expect(calls(await collect())).toEqual([{ id: 'c1', name: 'render_ui', args: '{"a":1}' }])
  })

  it('gives synthesized ids that differ between responses', () => {
    const a = [...new ToolCallTracker().push({ index: 0, function: { name: 'x' } })]
    const b = [...new ToolCallTracker().push({ index: 0, function: { name: 'x' } })]
    const idOf = (d: StreamDelta[]): string => (d[0] as { id: string }).id
    expect(idOf(a)).not.toBe(idOf(b))
  })
})

describe('chat-completions stream end, usage and caching', () => {
  it('flags finish_reason length as truncated and closes open calls', async () => {
    stub(() =>
      sse([
        tc({ index: 0, id: 'c1', function: { name: 'render_ui', arguments: '{"spec":' } }),
        { choices: [{ delta: {}, finish_reason: 'length' }] }
      ])
    )
    const out = await collect()
    expect(out).toContainEqual({ type: 'tool_call_end', id: 'c1' })
    expect(out.at(-1)).toEqual({ type: 'done', truncated: true })
  })

  it('ends a normal stream without the truncated flag', async () => {
    stub(() => sse([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }]))
    expect((await collect()).at(-1)).toEqual({ type: 'done' })
  })

  it('reports cached prompt tokens', async () => {
    stub(() =>
      sse([
        {
          choices: [],
          usage: {
            prompt_tokens: 5_000,
            completion_tokens: 200,
            total_tokens: 5_200,
            prompt_tokens_details: { cached_tokens: 4_096 }
          }
        }
      ])
    )
    expect(await collect()).toContainEqual({
      type: 'usage',
      usage: { prompt: 5_000, completion: 200, total: 5_200, cached: 4_096 }
    })
  })

  it('sends prompt_cache_key only to OpenAI itself', async () => {
    const openai = stub()
    await collect({ ...CFG, baseUrl: 'https://api.openai.com/v1' }, 'domino:abc')
    expect(openai.bodies[0].prompt_cache_key).toBe('domino:abc')

    const other = stub()
    await collect(CFG, 'domino:abc')
    expect('prompt_cache_key' in other.bodies[0]).toBe(false)
  })

  it('keeps system messages in order, stable first', async () => {
    const { bodies } = stub()
    for await (const _ of createOpenAIAdapter(CFG).chat({
      messages: [
        { role: 'system', content: 'STABLE' },
        { role: 'system', content: 'VOLATILE' },
        { role: 'user', content: 'x' }
      ]
    }))
      void _
    expect(bodies[0].messages.slice(0, 2)).toEqual([
      { role: 'system', content: 'STABLE' },
      { role: 'system', content: 'VOLATILE' }
    ])
  })

  it('retries a mid-stream overload reported before any output', async () => {
    const { bodies } = stub(
      () => sse([{ error: { message: 'busy', type: 'server_error', code: 503 } }]),
      () => sse([{ choices: [{ delta: { content: 'ok' } }] }])
    )
    const out = await collect()
    expect(bodies).toHaveLength(2)
    expect(out[0]).toEqual({ type: 'text', text: 'ok' })
  }, 10_000)

  it('surfaces a mid-stream error after output as an error delta', async () => {
    stub(() =>
      sse([
        { choices: [{ delta: { content: 'a' } }] },
        { error: { message: 'busy', type: 'server_error' } }
      ])
    )
    expect(await collect()).toContainEqual({ type: 'error', message: 'busy' })
  })
})
