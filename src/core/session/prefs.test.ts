import { describe, expect, it } from 'vitest'
import type { LLMConfig } from '../llm/types'
import {
  defaultLlmConfig,
  loadDominoLlmConfig,
  loadLlmConfig,
  loadSessionVars,
  saveDominoLlmConfig,
  saveLlmConfig,
  saveSessionVars,
  clearSessionVars,
  type KeyValueStorage
} from './prefs'

function memory(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
    remove: async (k) => void data.delete(k)
  }
}

const FULL: LLMConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  apiKey: 'sk-ant',
  baseUrl: 'https://api.anthropic.com',
  temperature: 0.4,
  reasoning: 'medium',
  maxOutputTokens: 24_000
}

describe('llm config round trip', () => {
  it('keeps reasoning and the output budget in the global config', async () => {
    const s = memory()
    await saveLlmConfig(s, FULL)
    expect(await loadLlmConfig(s)).toEqual(FULL)
  })

  it('keeps reasoning and the output budget in a per-domino override', async () => {
    const s = memory()
    await saveDominoLlmConfig(s, 'app', FULL)
    expect(await loadDominoLlmConfig(s, 'app')).toEqual(FULL)
  })
})

describe('llm config validation', () => {
  const stored = {
    provider: 'chat_completions',
    model: 'gpt-5',
    apiKey: 'sk',
    baseUrl: 'https://api.openai.com/v1',
    temperature: 0.2
  }

  it('drops an invalid reasoning level but loads the rest', async () => {
    for (const reasoning of ['extreme', 3, null, { level: 'low' }]) {
      const s = memory()
      s.data.set('domino:llm-config', JSON.stringify({ ...stored, reasoning }))
      s.data.set('domino:llm-config:app', JSON.stringify({ ...stored, reasoning }))
      const global = await loadLlmConfig(s)
      const local = await loadDominoLlmConfig(s, 'app')
      for (const cfg of [global, local]) {
        expect(cfg).toEqual(stored)
        expect(cfg && 'reasoning' in cfg).toBe(false)
      }
    }
  })

  it('drops a non-positive or non-numeric output budget', async () => {
    for (const maxOutputTokens of [0, -5, 'big', Number.NaN]) {
      const s = memory()
      s.data.set('domino:llm-config', JSON.stringify({ ...stored, maxOutputTokens }))
      expect(await loadLlmConfig(s)).toEqual(stored)
    }
  })

  it('type-checks every field of a per-domino override', async () => {
    const s = memory()
    s.data.set(
      'domino:llm-config:app',
      JSON.stringify({
        provider: 'responses',
        model: 'o3',
        apiKey: 42,
        baseUrl: false,
        temperature: 'hot'
      })
    )
    expect(await loadDominoLlmConfig(s, 'app')).toEqual({ provider: 'responses', model: 'o3' })
  })

  it('falls back to defaults for an unknown provider', async () => {
    const s = memory()
    s.data.set('domino:llm-config', JSON.stringify({ ...stored, provider: 'constructor' }))
    expect(await loadLlmConfig(s)).toEqual(defaultLlmConfig())
    s.data.set('domino:llm-config:app', JSON.stringify({ ...stored, provider: 'constructor' }))
    expect(await loadDominoLlmConfig(s, 'app')).toBeNull()
  })
})

describe('session vars', () => {
  it('round-trips, clears on an empty save and tolerates garbage', async () => {
    const s = memory()
    expect(await loadSessionVars(s, 'app')).toEqual({})
    await saveSessionVars(s, 'app', { plan: 'pro', user: { role: 'admin' } })
    expect(s.data.get('domino:sessionvars:app')).toBeDefined()
    expect(await loadSessionVars(s, 'app')).toEqual({ plan: 'pro', user: { role: 'admin' } })
    await saveSessionVars(s, 'app', {})
    expect(s.data.has('domino:sessionvars:app')).toBe(false)
    s.data.set('domino:sessionvars:app', '[1,2]')
    expect(await loadSessionVars(s, 'app')).toEqual({})
    s.data.set('domino:sessionvars:app', '{oops')
    expect(await loadSessionVars(s, 'app')).toEqual({})
    await clearSessionVars(s, 'app')
    expect(s.data.has('domino:sessionvars:app')).toBe(false)
  })
})
