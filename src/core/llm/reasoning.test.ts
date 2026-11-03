import { afterEach, describe, expect, it } from 'vitest'
import { setHttpFetch } from '../net'
import { createAdapter } from './index'
import {
  anthropicAdaptiveThinking,
  anthropicForbidsSampling,
  anthropicMaxOutput,
  anthropicOmitsTemperature,
  anthropicSamplingDefaultOnly,
  anthropicThinkingAlwaysOn,
  claudeModelInfo,
  anthropicMaxTokens,
  effectiveReasoning,
  isOpenAIReasoningModel,
  isReasoningLevel,
  modelTakesReasoning,
  nextReasoningLevel,
  openaiReasoningEffort
} from './reasoning'
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

  it('escalates an unset gpt-5 config from its effective low to medium', () => {
    const cfg: LLMConfig = { provider: 'chat_completions', model: 'gpt-5' }
    expect(nextReasoningLevel(effectiveReasoning(cfg))).toBe('medium')
  })
})

describe('isOpenAIReasoningModel', () => {
  it('matches o-series and gpt-5 families, with gateway prefixes', () => {
    for (const m of [
      'gpt-5',
      'gpt-5-mini',
      'gpt-5-nano',
      'gpt-5.1',
      'o1',
      'o3',
      'o3-mini',
      'o4-mini',
      'openai/o3'
    ]) {
      expect(isOpenAIReasoningModel(m), m).toBe(true)
    }
  })

  it('leaves classic and chat variants alone', () => {
    for (const m of [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4.1',
      'gpt-5-chat-latest',
      'claude-opus-4-1',
      'llama-3.1-70b'
    ]) {
      expect(isOpenAIReasoningModel(m), m).toBe(false)
    }
  })
})

describe('effectiveReasoning', () => {
  it('prefers the explicit level', () => {
    expect(
      effectiveReasoning({ provider: 'chat_completions', model: 'gpt-5', reasoning: 'high' })
    ).toBe('high')
  })

  it('defaults OpenAI reasoning models to low and nothing else', () => {
    expect(effectiveReasoning({ provider: 'responses', model: 'o3' })).toBe('low')
    expect(effectiveReasoning({ provider: 'chat_completions', model: 'gpt-4o' })).toBeUndefined()
    expect(
      effectiveReasoning({ provider: 'anthropic', model: 'claude-sonnet-4-5' })
    ).toBeUndefined()
  })
})

describe('claude model capabilities', () => {
  it('reads both id styles, gateway prefixes and date suffixes', () => {
    expect(claudeModelInfo('claude-opus-4-7')).toEqual({ family: 'opus', major: 4, minor: 7 })
    expect(claudeModelInfo('claude-sonnet-4-5-20250929')).toEqual({ family: 'sonnet', major: 4, minor: 5 })
    expect(claudeModelInfo('claude-opus-4-20250514')).toEqual({ family: 'opus', major: 4, minor: 0 })
    expect(claudeModelInfo('claude-3-7-sonnet-20250219')).toEqual({ family: 'sonnet', major: 3, minor: 7 })
    expect(claudeModelInfo('us.anthropic.claude-opus-5-5')).toEqual({ family: 'opus', major: 5, minor: 5 })
    expect(claudeModelInfo('claude-mythos-preview')?.family).toBe('mythos')
    expect(claudeModelInfo('gpt-5')).toBeNull()
  })

  it('knows which models reject sampling parameters', () => {
    for (const m of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-mythos-5-1']) {
      expect(anthropicForbidsSampling(m), m).toBe(true)
    }
    for (const m of ['claude-opus-4-6', 'claude-sonnet-4-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
      expect(anthropicForbidsSampling(m), m).toBe(false)
    }
    expect(anthropicSamplingDefaultOnly('claude-sonnet-5-5')).toBe(true)
    expect(anthropicSamplingDefaultOnly('claude-haiku-5-5')).toBe(true)
    expect(anthropicSamplingDefaultOnly('claude-haiku-4-5')).toBe(false)
    expect(anthropicOmitsTemperature('claude-sonnet-5-5')).toBe(true)
    expect(anthropicOmitsTemperature('claude-sonnet-4-6')).toBe(false)
  })

  it('splits adaptive thinking (4.6+) from budget thinking', () => {
    for (const m of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-5-5', 'claude-fable-5']) {
      expect(anthropicAdaptiveThinking(m), m).toBe(true)
    }
    for (const m of ['claude-3-7-sonnet-20250219', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1']) {
      expect(anthropicAdaptiveThinking(m), m).toBe(false)
    }
    expect(anthropicThinkingAlwaysOn('claude-opus-5-5')).toBe(true)
    expect(anthropicThinkingAlwaysOn('claude-opus-4-8')).toBe(false)
  })

  it('runs always-thinking Claude models at low when unset, so escalation climbs', () => {
    const cfg = { provider: 'anthropic' as const, model: 'claude-opus-5-5' }
    expect(effectiveReasoning(cfg)).toBe('low')
    expect(nextReasoningLevel(effectiveReasoning(cfg))).toBe('medium')
    expect(effectiveReasoning({ provider: 'anthropic', model: 'claude-opus-4-7' })).toBeUndefined()
  })
})

describe('openaiReasoningEffort', () => {
  it('maps none per family and passes other levels through', () => {
    expect(openaiReasoningEffort('none', 'o3')).toBe('low')
    expect(openaiReasoningEffort('none', 'gpt-5')).toBe('minimal')
    expect(openaiReasoningEffort('none', 'gpt-5.1')).toBe('none')
    expect(openaiReasoningEffort('medium', 'o3')).toBe('medium')
  })
})

describe('isReasoningLevel', () => {
  it('accepts only the four levels', () => {
    for (const v of ['none', 'low', 'medium', 'high']) expect(isReasoningLevel(v)).toBe(true)
    for (const v of ['extreme', '', 3, null, undefined]) expect(isReasoningLevel(v)).toBe(false)
  })
})

describe('anthropic output budget', () => {
  it('knows each family ceiling and leaves unknown ids unclamped', () => {
    expect(anthropicMaxOutput('claude-3-5-sonnet-20241022')).toBe(8_192)
    expect(anthropicMaxOutput('claude-3-haiku-20240307')).toBe(4_096)
    expect(anthropicMaxOutput('claude-3-7-sonnet')).toBe(64_000)
    expect(anthropicMaxOutput('claude-opus-4-1')).toBe(32_000)
    expect(anthropicMaxOutput('claude-opus-4-5')).toBe(64_000)
    expect(anthropicMaxOutput('claude-sonnet-4-5')).toBe(64_000)
    expect(anthropicMaxOutput('some-gateway-model')).toBeNull()
  })

  it('adds the thinking budget on top of 16k visible room, clamped to the ceiling', () => {
    expect(anthropicMaxTokens('claude-sonnet-4-5', null)).toBe(16_384)
    expect(anthropicMaxTokens('claude-sonnet-4-5', 4_096)).toBe(20_480)
    expect(anthropicMaxTokens('claude-3-5-sonnet', null)).toBe(8_192)
    expect(anthropicMaxTokens('claude-sonnet-4-5', null, 2_000)).toBe(2_000)
    expect(anthropicMaxTokens('gateway-model', 2_048)).toBe(18_432)
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

  it('runs an unset OpenAI reasoning model at low, not the slow provider default', async () => {
    const { body } = captureBody()
    await drain({
      provider: 'chat_completions',
      model: 'gpt-5',
      apiKey: 'k',
      baseUrl: 'https://llm.test/v1'
    })
    expect(body().reasoning_effort).toBe('low')
  })

  it('leaves the knob off other reasoning-capable models when unset', async () => {
    const { body } = captureBody()
    await drain({
      provider: 'chat_completions',
      model: 'deepseek-r1',
      apiKey: 'k',
      baseUrl: 'https://llm.test/v1'
    })
    expect(body().reasoning_effort).toBeUndefined()
  })

  it('maps an explicit none to the least each family accepts', async () => {
    const o3 = captureBody()
    await drain({
      provider: 'chat_completions',
      model: 'o3',
      apiKey: 'k',
      baseUrl: 'https://llm.test/v1',
      reasoning: 'none'
    })
    expect(o3.body().reasoning_effort).toBe('low')

    const gpt5 = captureBody()
    await drain({
      provider: 'chat_completions',
      model: 'gpt-5-mini',
      apiKey: 'k',
      baseUrl: 'https://llm.test/v1',
      reasoning: 'none'
    })
    expect(gpt5.body().reasoning_effort).toBe('minimal')
  })

  it('never sends temperature to OpenAI reasoning models', async () => {
    for (const model of ['gpt-5', 'o3', 'o4-mini']) {
      const { body } = captureBody()
      await drain({
        provider: 'chat_completions',
        model,
        apiKey: 'k',
        baseUrl: 'https://llm.test/v1',
        temperature: 0.2
      })
      expect('temperature' in body(), model).toBe(false)
    }
  })

  it('keeps temperature for classic models, request value first', async () => {
    const cfg = captureBody()
    await drain({
      provider: 'chat_completions',
      model: 'gpt-4o',
      apiKey: 'k',
      baseUrl: 'https://llm.test/v1',
      temperature: 0.2
    })
    expect(cfg.body().temperature).toBe(0.2)

    const req = captureBody()
    const adapter = createAdapter({
      provider: 'chat_completions',
      model: 'gpt-4o',
      apiKey: 'k',
      baseUrl: 'https://llm.test/v1'
    })
    for await (const _ of adapter.chat({ ...REQ, temperature: 0.3 })) void _
    expect(req.body().temperature).toBe(0.3)
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

  it('defaults an unset reasoning model to low and drops temperature', async () => {
    const { body } = captureBody()
    await drain({
      provider: 'responses',
      model: 'gpt-5',
      apiKey: 'k',
      baseUrl: 'https://llm.test/v1',
      temperature: 0.4
    })
    expect(body().reasoning).toEqual({ effort: 'low' })
    expect('temperature' in body()).toBe(false)
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
  it('enables a budget, leaves temperature at its default, and widens max_tokens', async () => {
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
    // Thinking requires the default temperature (1): leaving it out is that.
    expect(b.temperature).toBeUndefined()
    expect(b.max_tokens).toBe(16_384 + 4_096)
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
    expect(unset.body().max_tokens).toBe(16_384)
  })

  it('caps max_tokens for older Claude models that cannot emit 16k', async () => {
    const { body } = captureBody()
    await drain({
      provider: 'anthropic',
      model: 'claude-3-5-haiku',
      apiKey: 'k',
      baseUrl: 'https://llm.test'
    })
    expect(body().max_tokens).toBe(8_192)
  })
})
