import { describe, expect, it } from 'vitest'
import {
  applyEviction,
  auditStorage,
  clearDominoData,
  clearTextCache,
  dominoKeys,
  matchDominoKey,
  planEviction,
  protectDomino,
  withQuotaRelief
} from './storageAudit'
import { ScreenStore } from './screenStore'
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

  it('dominoKeys covers both view and history auth variants', () => {
    const keys = dominoKeys('A|x')
    expect(keys).toContain('domino:view:A|x::auth:false')
    // The token part covers the sign-in session variables too.
    expect(keys).toContain('domino:token:A|x')
    expect(keys).toContain('domino:sessionvars:A|x')
    expect(matchDominoKey('domino:sessionvars:A|x')).toEqual(['token', 'A|x'])
    expect(keys).toContain('domino:history:A|x::auth:true')
    expect(keys).toContain('domino:history:A|x') // the pre-partition key
    expect(keys).toContain('domino:pageindex:A|x')
    expect(keys).toContain('domino:apisnaps:A|x')
    expect(keys).toContain('domino:feeds:A|x')
    expect(keys).toContain('domino:llm-config:A|x')
  })

  it('attributes snaps, feeds, the per-domino LLM override and page blobs to the domino', () => {
    const audit = auditStorage([
      ['domino:apisnaps:A|x', '{"GET /a":{}}'],
      ['domino:feeds:A|x', '[]'],
      ['domino:llm-config:A|x', '{}'],
      ['domino:llm-config', '{}'],
      ['domino:pageindex:A|x', '{}'],
      ['domino:page:A|x::v:abc123', '{}'],
      ['domino:history:A|x::auth:true', '{}']
    ])
    expect(audit.dominoes).toHaveLength(1)
    const a = audit.dominoes[0]
    expect(a.id).toBe('A|x')
    expect(a.parts.snaps?.keys).toBe(1)
    expect(a.parts.feeds?.keys).toBe(1)
    expect(a.parts.llm?.keys).toBe(1)
    expect(a.parts.screens?.keys).toBe(2)
    expect(a.parts.history?.keys).toBe(1)
    expect(audit.globals.keys).toBe(1) // the bare global llm-config
  })

  it('matchDominoKey survives ids with colons and IPv6 hosts', () => {
    expect(matchDominoKey('domino:page:App|http://[::1]:8080::v:k2j3')).toEqual([
      'screens',
      'App|http://[::1]:8080'
    ])
    expect(matchDominoKey('domino:history:App|https://x::auth:false')).toEqual([
      'history',
      'App|https://x'
    ])
  })

  it('clearDominoData removes snaps, feeds and page blobs but keeps both LLM configs', async () => {
    const storage = fakeStorage()
    const screens = await ScreenStore.open(storage, 'A|x', { viewDebounceMs: 0 })
    await screens.put('k', {
      version: 1,
      page: 'p',
      pages: [{ id: 'p', name: 'p', layout: [] }]
    })
    await storage.set('domino:apisnaps:A|x', '{}')
    await storage.set('domino:feeds:A|x', '[]')
    await storage.set('domino:llm-config:A|x', '{}')
    await storage.set('domino:llm-config', '{}')
    await storage.set('domino:history:A|x::auth:true', '{}')
    expect(Object.keys(storage.dump()).some((k) => k.startsWith('domino:page:'))).toBe(true)

    await clearDominoData(storage, 'A|x')
    expect(Object.keys(storage.dump()).sort()).toEqual([
      'domino:llm-config',
      'domino:llm-config:A|x'
    ])

    await clearDominoData(storage, 'A|x', { includeLlm: true })
    expect(Object.keys(storage.dump())).toEqual(['domino:llm-config'])
  })

  it('finds page blobs through the index when the store cannot enumerate', async () => {
    const base = fakeStorage()
    const storage = { get: base.get, set: base.set, remove: base.remove }
    const screens = await ScreenStore.open(storage, 'A|x')
    await screens.put('k', { version: 1, page: 'p', pages: [{ id: 'p', name: 'p', layout: [] }] })
    await clearDominoData(storage, 'A|x')
    expect(Object.keys(base.dump())).toEqual([])
  })
})

describe('eviction', () => {
  it('drops the text cache first, then other dominoes oldest-first, never the one being written', () => {
    const audit = auditStorage([
      ['domino:text:h', 'x'],
      ['domino:screens:Old|', '{}'],
      ['domino:view:Old|::auth:false', JSON.stringify({ at: 1 })],
      ['domino:screens:New|', '{}'],
      ['domino:view:New|::auth:false', JSON.stringify({ at: 9 })],
      ['domino:screens:Me|', '{}'],
      ['domino:token:TokenOnly|', 't']
    ])
    expect(planEviction(audit, 'Me|')).toEqual([
      { kind: 'texts' },
      { kind: 'domino', id: 'Old|' },
      { kind: 'domino', id: 'New|' }
    ])
  })

  it('evicting a domino keeps its token, graph and snaps', async () => {
    const storage = fakeStorage({
      'domino:screens:A|': '{}',
      'domino:view:A|::auth:true': '{}',
      'domino:history:A|::auth:true': '{}',
      'domino:token:A|': 't',
      'domino:graph:A|': '{}',
      'domino:apisnaps:A|': '{}'
    })
    await applyEviction(storage, { kind: 'domino', id: 'A|' })
    expect(Object.keys(storage.dump()).sort()).toEqual([
      'domino:apisnaps:A|',
      'domino:graph:A|',
      'domino:token:A|'
    ])
  })
})

describe('more clear helpers', () => {
  it('clearDominoData tolerates a failing removal', async () => {
    const storage = fakeStorage({ 'domino:screens:A|x': '{}', 'domino:graph:A|x': '{}' })
    const remove = storage.remove
    storage.remove = async (key: string) => {
      if (key === 'domino:screens:A|x') throw new Error('locked')
      return remove(key)
    }
    await clearDominoData(storage, 'A|x')
    expect(Object.keys(storage.dump())).toEqual(['domino:screens:A|x'])
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

describe('withQuotaRelief', () => {
  /** A store that refuses writes while more than `cap` chars are stored. */
  function cappedStorage(initial: Record<string, string>, cap: number) {
    const base = fakeStorage(initial)
    const size = (): number =>
      Object.entries(base.dump()).reduce((n, [k, v]) => n + k.length + v.length, 0)
    return {
      ...base,
      async set(key: string, value: string) {
        const prev = base.dump()[key] ?? ''
        if (size() - prev.length + value.length > cap) {
          throw Object.assign(new Error('full'), { name: 'QuotaExceededError' })
        }
        await base.set(key, value)
      }
    }
  }

  it('makes room by evicting other dominoes and retries the write', async () => {
    const inner = cappedStorage(
      {
        'domino:text:h': 'x'.repeat(100),
        'domino:screens:Other|': 'y'.repeat(400),
        'domino:view:Other|::auth:false': JSON.stringify({ at: 1 }),
        'domino:token:Other|': 't'
      },
      500
    )
    const events: Array<{ recovered: boolean; evicted: string[] }> = []
    const storage = withQuotaRelief(inner, (e) => events.push(e))
    await storage.set('domino:screens:Me|', 'z'.repeat(300))
    expect(inner.dump()['domino:screens:Me|']).toHaveLength(300)
    expect(inner.dump()['domino:token:Other|']).toBe('t') // tokens never evicted
    expect(inner.dump()['domino:screens:Other|']).toBeUndefined()
    expect(events).toEqual([
      expect.objectContaining({ recovered: true, evicted: ['texts', 'Other|'] })
    ])
  })

  it('reports and rethrows when nothing frees enough room', async () => {
    const inner = cappedStorage({ 'domino:token:Me|': 't' }, 10)
    const events: Array<{ recovered: boolean; quota: boolean }> = []
    const storage = withQuotaRelief(inner, (e) => events.push(e))
    await expect(storage.set('domino:screens:Me|', 'z'.repeat(50))).rejects.toThrow('full')
    expect(events).toEqual([expect.objectContaining({ recovered: false, quota: true })])
  })

  it('a text-cache write never evicts any domino (nor the text cache)', async () => {
    const inner = cappedStorage(
      { 'domino:text:h': 'x'.repeat(100), 'domino:screens:Other|': 'y'.repeat(300) },
      450
    )
    const storage = withQuotaRelief(inner, () => undefined)
    await expect(storage.set('domino:text:new', 'z'.repeat(200))).rejects.toThrow('full')
    expect(inner.dump()['domino:screens:Other|']).toHaveLength(300)
    expect(inner.dump()['domino:text:h']).toHaveLength(100)
  })

  it('a global key may clear the text cache, never a domino', async () => {
    const inner = cappedStorage(
      { 'domino:text:h': 'x'.repeat(100), 'domino:screens:Other|': 'y'.repeat(300) },
      450
    )
    const storage = withQuotaRelief(inner, () => undefined)
    await storage.set('domino:recents', 'r'.repeat(80))
    expect(inner.dump()['domino:text:h']).toBeUndefined()
    await expect(storage.set('domino:handle-pos', 'p'.repeat(200))).rejects.toThrow('full')
    expect(inner.dump()['domino:screens:Other|']).toHaveLength(300)
  })

  it('never evicts an open (protected) domino for another domino write', async () => {
    const inner = cappedStorage(
      {
        'domino:screens:Open|': 'y'.repeat(300),
        'domino:view:Open|::auth:false': JSON.stringify({ at: 1 })
      },
      400
    )
    const release = protectDomino('Open|')
    try {
      const storage = withQuotaRelief(inner, () => undefined)
      await expect(storage.set('domino:screens:Me|', 'z'.repeat(200))).rejects.toThrow('full')
      expect(inner.dump()['domino:screens:Open|']).toHaveLength(300)
    } finally {
      release()
    }
  })

  it('reports non-quota failures without evicting anything', async () => {
    const inner = fakeStorage({ 'domino:text:h': 'keep' })
    inner.set = async () => {
      throw new Error('disk gone')
    }
    const events: Array<{ quota: boolean }> = []
    const storage = withQuotaRelief(inner, (e) => events.push(e))
    await expect(storage.set('k', 'v')).rejects.toThrow('disk gone')
    expect(events[0].quota).toBe(false)
    expect(inner.dump()['domino:text:h']).toBe('keep')
  })
})
