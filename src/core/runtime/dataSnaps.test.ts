import { describe, expect, it } from 'vitest'
import type { KeyValueStorage } from '../session/prefs'
import { matchDominoKey } from '../session/storageAudit'
import { planSourceFetch } from './dataSources'
import {
  dataSnapsKey,
  loadDataSnaps,
  MAX_DATA_SNAP_CHARS,
  persistableDataSnaps,
  saveDataSnaps
} from './dataSnaps'

function memory(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
    remove: async (k) => void data.delete(k)
  }
}

const decls = [{ key: 'leads' }, { key: 'me' }, { key: 'feed' }]

describe('persistableDataSnaps', () => {
  it('keeps declared sources only, never api: bodies, errors or oversized values', () => {
    const out = persistableDataSnaps(
      {
        leads: { rows: [{ id: 1 }] },
        me: { error: 'HTTP 500' },
        feed: { items: ['x'.repeat(MAX_DATA_SNAP_CHARS)] },
        'api:GET /leads': { rows: [] },
        stray: 1
      },
      decls
    )
    expect(out).toEqual({ leads: { rows: [{ id: 1 }] } })
  })
})

describe('load/save', () => {
  it('round-trips, drops sources the file no longer declares and removes an empty set', async () => {
    const s = memory()
    await saveDataSnaps(s, 'A|x', { leads: { rows: [1] }, gone: { v: 1 } })
    expect(await loadDataSnaps(s, 'A|x', decls)).toEqual({ leads: { rows: [1] } })
    await saveDataSnaps(s, 'A|x', {})
    expect(s.data.has(dataSnapsKey('A|x'))).toBe(false)
    s.data.set(dataSnapsKey('A|x'), '{nope')
    expect(await loadDataSnaps(s, 'A|x', decls)).toEqual({})
  })

  it('reports a failed write instead of throwing', async () => {
    const s = memory()
    s.set = async () => {
      throw new Error('quota')
    }
    const errors: string[] = []
    await saveDataSnaps(s, 'A|x', { leads: 1 }, (e) => errors.push(e.message))
    expect(errors).toEqual(['quota'])
  })

  it('restored values refresh in the background instead of holding a turn', () => {
    const plan = planSourceFetch(
      [{ key: 'leads', method: 'GET', path: '/leads' }],
      { leads: {} },
      {},
      0
    )
    expect(plan).toEqual({ missing: [], stale: ['leads'] })
  })

  it('is attributed to the domino in the storage audit', () => {
    expect(matchDominoKey(dataSnapsKey('A|x'))).toEqual(['snaps', 'A|x'])
  })
})
