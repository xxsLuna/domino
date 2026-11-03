import { afterEach, describe, expect, it } from 'vitest'
import { setHttpFetch } from '../net'
import { createResponsesAdapter } from './responses'
import type { LLMConfig, StreamDelta } from './types'

const CFG: LLMConfig = {
  provider: 'responses',
  model: 'gpt-4o',
  apiKey: 'k',
  baseUrl: 'https://llm.test/v1'
}

function stub(events: unknown[]): { bodies: any[] } {
  const bodies: any[] = []
  setHttpFetch(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
      status: 200
    })
  })
  return { bodies }
}

async function collect(cfg: LLMConfig = CFG, cacheKey?: string): Promise<StreamDelta[]> {
  const out: StreamDelta[] = []
  for await (const d of createResponsesAdapter(cfg).chat({
    messages: [{ role: 'user', content: 'x' }],
    ...(cacheKey ? { cacheKey } : {})
  })) {
    out.push(d)
  }
  return out
}

afterEach(() => {
  setHttpFetch((input, init) => globalThis.fetch(input, init))
})

describe('responses adapter stream end', () => {
  it('flags an incomplete max_output_tokens response as truncated, with usage', async () => {
    stub([
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'render_ui' }
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"spec":' },
      {
        type: 'response.incomplete',
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          usage: {
            input_tokens: 900,
            output_tokens: 100,
            total_tokens: 1_000,
            input_tokens_details: { cached_tokens: 512 }
          }
        }
      }
    ])
    const out = await collect()
    expect(out).toContainEqual({
      type: 'usage',
      usage: { prompt: 900, completion: 100, total: 1_000, cached: 512 }
    })
    expect(out).toContainEqual({ type: 'tool_call_end', id: 'c1' })
    expect(out.at(-1)).toEqual({ type: 'done', truncated: true })
  })

  it('ends a completed response without the truncated flag', async () => {
    stub([
      { type: 'response.output_text.delta', delta: 'hi' },
      {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } }
      }
    ])
    expect((await collect()).at(-1)).toEqual({ type: 'done' })
  })

  it('reports the provider message of a failed response', async () => {
    stub([
      { type: 'response.output_text.delta', delta: 'a' },
      {
        type: 'response.failed',
        response: { status: 'failed', error: { code: 'invalid_prompt', message: 'bad input' } }
      }
    ])
    expect(await collect()).toContainEqual({ type: 'error', message: 'bad input' })
  })

  it('sends prompt_cache_key only to OpenAI itself', async () => {
    const openai = stub([])
    await collect({ ...CFG, baseUrl: 'https://api.openai.com/v1' }, 'domino:abc')
    expect(openai.bodies[0].prompt_cache_key).toBe('domino:abc')

    const other = stub([])
    await collect(CFG, 'domino:abc')
    expect('prompt_cache_key' in other.bodies[0]).toBe(false)
  })
})
