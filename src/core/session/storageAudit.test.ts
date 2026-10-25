import { describe, expect, it } from 'vitest'
import { auditStorage, clearDominoData, clearTextCache, dominoKeys } from './storageAudit'
import type { KeyValueStorage } from './prefs'

function fakeStorage(initial: Record<string, string> = {}): KeyValueStorage & {
  dump(): Record<string, string>
} {
  const map = new Map(Object.entries(initial))
  return {
    async get(key) {
      return map.get(key) ?? null
    },
    async set(key, value) {
      map.set(key, value)
    },
    async remove(key) {
      map.delete(key)
    },
    async entries() {
      return [...map.entries()]
    },
    dump() {
      return Object.fromEntries(map)
    }
  }
}

describe('auditStorage', () => {
  it('groups per-domino parts, texts and globals with byte sizes', () => {
    const audit = auditStorage([
      ['domino:screens:A|x', '{"a":1}'],
      ['domino:view:A|x::auth:true', JSON.stringify({ at: 100 })],
      ['domino:view:A|x::auth:false', JSON.stringify({ at: 50 })],
      ['domino:history:A|x', '[]'],
      ['domino:graph:A|x', '{"edges":[]}'],
      ['domino:schemas:A|x', '{}'],
      ['domino:token:A|x', 'tok'],
      ['domino:screens:B|y', '12345'],
      ['domino:text-index', '[{"hash":"h1"}]'],
      ['domino:text:h1', 'raw source text'],
      ['domino:llm-config', '{"provider":"chat_completions"}'],
      ['domino:handle-pos', '{"side":"right"}'],
      ['unrelated-key', 'ignored entirely']
    ])
    expect(audit.dominoes).toHaveLength(2)
    const a = audit.dominoes.find((d) => d.id === 'A|x')!
    expect(a.name).toBe('A')
    expect(a.parts.screens?.keys).toBe(1)
    expect(a.parts.views?.keys).toBe(2) // both auth variants under one domino
    expect(a.parts.token?.keys).toBe(1)
    expect(a.lastUsed).toBe(100) // newest snapshot wins
    const b = audit.dominoes[0]
    expect(b.id).toBe('A|x') // sorted by bytes desc
    expect(audit.texts.keys).toBe(2)
    expect(audit.globals.keys).toBe(2) // llm-config + handle-pos; unrelated ignored
    expect(audit.totalBytes).toBeGreaterThan(0)
  })

  it('survives a corrupted view snapshot', () => {
    const audit = auditStorage([['domino:view:X|z::auth:true', '{broken']])
    expect(audit.dominoes[0].lastUsed).toBeNull()
    expect(audit.dominoes[0].bytes).toBeGreaterThan(0)
  })
})

describe('clear helpers', () => {
  it('clearDominoData removes every part of one domino only', async () => {
    const storage = fakeStorage({
      'domino:screens:A|x': '{}',
      'domino:view:A|x::auth:true': '{}',
      'domino:view:A|x::auth:false': '{}',
      'domino:history:A|x': '[]',
      'domino:graph:A|x': '{}',
      'domino:schemas:A|x': '{}',
      'domino:token:A|x': 't',
      'domino:screens:B|y': 'keep-me',
      'domino:llm-config': 'keep-me-too'
    })
    await clearDominoData(storage, 'A|x')
    const left = storage.dump()
    expect(Object.keys(left).sort()).toEqual(['domino:llm-config', 'domino:screens:B|y'])
  })

  it('dominoKeys covers both view auth variants', () => {
    expect(dominoKeys('A|x')).toContain('domino:view:A|x::auth:false')
    expect(dominoKeys('A|x')).toHaveLength(7)
  })

  it('clearTextCache drops text entries and the index, keeps everything else', async () => {
    const storage = fakeStorage({
      'domino:text-index': '[]',
      'domino:text:h1': 'raw',
      'domino:screens:A|x': '{}',
      'domino:llm-config': '{}'
    })
    await clearTextCache(storage)
    expect(Object.keys(storage.dump()).sort()).toEqual(['domino:llm-config', 'domino:screens:A|x'])
  })
})
