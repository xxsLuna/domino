import { afterEach, describe, expect, it } from 'vitest'
import { setHttpFetch } from '../net'
import { createAdapter } from './index'
import { modelTakesReasoning, nextReasoningLevel } from './reasoning'
import type { ChatRequest, LLMConfig } from './types'

/** Captures the JSON body each adapter posts, and replies with a bare done stream. */
function captureBody(): { body: () => any } {
  let captured: any = null
  setHttpFetch(async (_input, init) => {
    captured = JSON.parse(String(init?.body))
    // An empty SSE body ends the stream without emitting deltas.
    return new Response('', { status: 200 })
  })
  return { body: () => captured }
}

const REQ: ChatRequest = { messages: [{ role: 'user', content: 'hi' }], tools: [] }

async function drain(cfg: LLMConfig): Promise<void> {
  for await (const _ of createAdapter(cfg).chat(REQ)) void _
}

afterEach(() => {
  setHttpFetch((input, init) => globalThis.fetch(input, init))
})

describe('modelTakesReasoning', () => {
  it('accepts reasoning-capable ids across providers', () => {
    for (const m of [
      'o3',
      'o4-mini',
      'gpt-5',
      'deepseek-r1',
      'qwen3-qwq',
      'claude-sonnet-4-5',
      'claude-3-7-sonnet',
      'gemini-2.5-flash-thinking'
    ]) {
      expect(modelTakesReasoning(m), m).toBe(true)
    }
  })

  it('rejects classic models that would 400 on the knob', () => {
    for (const m of ['gpt-4o', 'gpt-4o-mini', 'claude-3-5-sonnet', 'llama-3.1-70b']) {
      expect(modelTakesReasoning(m), m).toBe(false)
    }
  })
})

describe('nextReasoningLevel', () => {
  it('climbs one notch and saturates at high', () => {
    expect(nextReasoningLevel(undefined)).toBe('low')
    expect(nextReasoningLevel('none')).toBe('low')
    expect(nextReasoningLevel('low')).toBe('medium')
    expect(nextReasoningLevel('medium')).toBe('high')
    expect(nextReasoningLevel('high')).toBe('high')
  })
})

describe('chat_completions adapter reasoning_effort', () => {
  it('sends reasoning_effort for a reasoning model', async () => {
    const { body } = captureBody()
    await drain({
      provider: 'chat_completions',
      model: 'gpt-5',
      apiKey: 'k',
      baseUrl: 'https://llm.test/v1',
      reasoning: 'medium'
    })
    expect(body().reasoning_effort).toBe('medium')
  })

  it('omits the knob for classic models even when set', async () => {
    const { body } = captureBody()
    await drain({
      provider: 'chat_completions',
      model: 'gpt-4o',
      apiKey: 'k',
      baseUrl: 'https://llm.test/v1',
      reasoning: 'high'
    })
    expect(body().reasoning_effort).toBeUndefined()
  })

  it('omits the knob when reasoning is unset', async () => {
    const { body } = captureBody()
    await drain({
      provider: 'chat_completions',
      model: 'gpt-5',
      apiKey: 'k',
      baseUrl: 'https://llm.test/v1'
    })
    expect(body().reasoning_effort).toBeUndefined()
  })

  it('maps an explicit none to minimal (o-series floor)', async () => {
    const { body } = captureBody()
    await drain({
      provider: 'chat_completions',
      model: 'o3',
      apiKey: 'k',
      baseUrl: 'https://llm.test/v1',
      reasoning: 'none'
    })
    expect(body().reasoning_effort).toBe('minimal')
  })
})

describe('responses adapter reasoning', () => {
  it('nests effort under reasoning for a reasoning model', async () => {
    const { body } = captureBody()
    await drain({
      provider: 'responses',
      model: 'o3',
      apiKey: 'k',
      baseUrl: 'https://llm.test/v1',
      reasoning: 'low'
    })
    expect(body().reasoning).toEqual({ effort: 'low' })
  })

  it('omits the knob for classic models', async () => {
    const { body } = captureBody()
    await drain({
      provider: 'responses',
      model: 'gpt-4o',
      apiKey: 'k',
      baseUrl: 'https://llm.test/v1',
      reasoning: 'high'
    })
    expect(body().reasoning).toBeUndefined()
  })
})

describe('anthropic adapter extended thinking', () => {
  it('enables a budget, forces temperature 1, and widens max_tokens', async () => {
    const { body } = captureBody()
    await drain({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
      baseUrl: 'https://llm.test',
      reasoning: 'medium',
      temperature: 0.3
    })
    const b = body()
    expect(b.thinking).toEqual({ type: 'enabled', budget_tokens: 4_096 })
    expect(b.temperature).toBe(1)
    expect(b.max_tokens).toBeGreaterThan(4_096)
  })

  it('sends no thinking block for a classic Claude or when unset', async () => {
    const classic = captureBody()
    await drain({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      apiKey: 'k',
      baseUrl: 'https://llm.test',
      reasoning: 'high'
    })
    expect(classic.body().thinking).toBeUndefined()

    const unset = captureBody()
    await drain({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
      baseUrl: 'https://llm.test'
    })
    expect(unset.body().thinking).toBeUndefined()
    expect(unset.body().temperature).toBe(0.7)
  })
})
