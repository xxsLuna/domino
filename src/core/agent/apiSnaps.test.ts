import { describe, expect, it } from 'vitest'
import type { KeyValueStorage } from '../session/prefs'
import { apiSnapBindings, apiSnapsKey, loadApiSnaps, putApiSnap, saveApiSnaps, type ApiSnaps } from './apiSnaps'

function memStorage(initial: Record<string, string> = {}): KeyValueStorage & {
  map: Map<string, string>
} {
  const map = new Map(Object.entries(initial))
  return {
    map,
    async get(key: string) {
      return map.get(key) ?? null
    },
    async set(key: string, value: string) {
      map.set(key, value)
    },
    async remove(key: string) {
      map.delete(key)
    }
  }
}

/** A big response: over the per-snapshot budget so compaction must kick in. */
function bigRows(n: number): { rows: Array<{ id: number }> } {
  return { rows: Array.from({ length: n }, (_, id) => ({ id })) }
}

describe('persisted snapshot shapes', () => {
  it('drops the old {truncated, head} form and legacy marker rows on load', async () => {
    const storage = memStorage({
      [apiSnapsKey('d')]: JSON.stringify({
        'GET /old': { truncated: true, chars: 30_000, head: '{"rows"' },
        'GET /list': { rows: [{ id: 1 }, '…+60 more'] }
      })
    })
    const snaps = await loadApiSnaps(storage, 'd')
    expect(snaps['GET /old']).toBeUndefined()
    expect(snaps['GET /list']).toEqual({ rows: [{ id: 1 }] })
  })

  it('leaves a body too big to persist out of storage only', async () => {
    const storage = memStorage()
    const snaps = { 'GET /big': { blob: 'x'.repeat(500_000) }, 'GET /small': { a: 1 } }
    await saveApiSnaps(storage, 'd', snaps)
    expect(JSON.parse(storage.map.get(apiSnapsKey('d'))!)).toEqual({ 'GET /small': { a: 1 } })
  })
})

describe('putApiSnap', () => {
  it('caps a big list without marker rows: every element stays a row', () => {
    const out = putApiSnap({}, 'GET /leads', bigRows(500))
    const snap = out['GET /leads'] as { rows: unknown[] }
    expect(snap.rows).toHaveLength(200)
    expect(snap.rows.every((r) => typeof r === 'object')).toBe(true)
  })

  it('keeps 100 rows whole (bindings see every record, not the model-facing 40)', () => {
    const out = putApiSnap({}, 'GET /leads', bigRows(100))
    expect((out['GET /leads'] as { rows: unknown[] }).rows).toHaveLength(100)
  })

  it('never replaces the root of a wide body', () => {
    const wide = {
      rows: Array.from({ length: 30 }, (_, id) => ({ id, blob: 'w'.repeat(2_000) }))
    }
    const snap = putApiSnap({}, 'GET /wide', wide)['GET /wide'] as { rows: unknown[] }
    expect(snap.rows).toHaveLength(30)
  })

  it('evicts the oldest endpoint once the horizon is exceeded', () => {
    let snaps: ApiSnaps = {}
    for (let i = 1; i <= 14; i++) snaps = putApiSnap(snaps, `GET /e${i}`, { i })
    const keys = Object.keys(snaps)
    expect(keys).toHaveLength(12)
    expect(keys).toEqual(
      Array.from({ length: 12 }, (_, i) => `GET /e${i + 3}`)
    )
  })

  it('refreshing an endpoint keeps it and bumps it to newest', () => {
    let snaps: ApiSnaps = {}
    for (let i = 1; i <= 4; i++) snaps = putApiSnap(snaps, `GET /e${i}`, { i })
    snaps = putApiSnap(snaps, 'GET /e1', { i: 'again' })
    const keys = Object.keys(snaps)
    expect(keys).toEqual(['GET /e2', 'GET /e3', 'GET /e4', 'GET /e1'])
    expect((snaps['GET /e1'] as { i: string }).i).toBe('again')
  })
})

describe('apiSnaps round-trip', () => {
  it('saves and reloads snapshots for the right domino only', async () => {
    const storage = memStorage()
    const snaps = putApiSnap({}, 'GET /leads', { rows: [{ id: 1 }] })
    await saveApiSnaps(storage, 'crm', snaps)
    expect(storage.map.has(apiSnapsKey('crm'))).toBe(true)
    expect(await loadApiSnaps(storage, 'crm')).toEqual(snaps)
    expect(await loadApiSnaps(storage, 'hr')).toEqual({})
  })

  it('drops malformed payloads instead of throwing', async () => {
    const storage = memStorage({
      [apiSnapsKey('crm')]: JSON.stringify([1, 2, 3]) // an array, not a map
    })
    expect(await loadApiSnaps(storage, 'crm')).toEqual({})
  })

  it('a storage failure on save never rejects', async () => {
    const broken: KeyValueStorage = {
      async get() {
        return null
      },
      async set() {
        throw new Error('quota')
      },
      async remove() {}
    }
    await expect(saveApiSnaps(broken, 'crm', {})).resolves.toBeUndefined()
  })
})

describe('apiSnaps error reporting and bindings', () => {
  it('reports a failed save through onError without rejecting', async () => {
    const broken: KeyValueStorage = {
      async get() {
        return null
      },
      async set() {
        throw new Error('quota')
      },
      async remove() {}
    }
    const seen: string[] = []
    await expect(
      saveApiSnaps(broken, 'crm', {}, (err) => seen.push(err.message))
    ).resolves.toBeUndefined()
    expect(seen).toEqual(['quota'])
  })

  it('exposes snapshots under their api:<endpoint> binding keys', () => {
    const snaps = putApiSnap({}, 'GET /leads', { rows: [] })
    expect(apiSnapBindings(snaps)).toEqual({ 'api:GET /leads': { rows: [] } })
    expect(apiSnapBindings({ 'api:GET /x': 1 })).toEqual({ 'api:GET /x': 1 })
  })
})
