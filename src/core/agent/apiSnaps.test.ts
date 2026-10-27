import { describe, expect, it } from 'vitest'
import type { KeyValueStorage } from '../session/prefs'
import { apiSnapsKey, loadApiSnaps, putApiSnap, saveApiSnaps, type ApiSnaps } from './apiSnaps'

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

describe('putApiSnap', () => {
  it('compacts a big body so one snapshot cannot outgrow its screen', () => {
    const out = putApiSnap({}, 'GET /leads', bigRows(500))
    const snap = out['GET /leads'] as { rows: unknown[] }
    // Head kept, tail collapsed to a marker — the whole thing stays a bound object.
    expect(snap.rows).toHaveLength(41)
    expect(snap.rows[0]).toEqual({ id: 0 })
    expect(snap.rows[40]).toBe('…+460 more')
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
