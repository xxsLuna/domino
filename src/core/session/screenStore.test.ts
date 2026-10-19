import { describe, expect, it } from 'vitest'
import type { UiSpec } from '../spec'
import type { KeyValueStorage } from './prefs'
import { ScreenStore, depsFresh, screensKey, viewKey } from './screenStore'

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

const spec = (id: string, pad = ''): UiSpec => ({
  version: 1,
  page: id,
  nav: [{ id, label: id }],
  pages: [{ id, name: `${id}${pad}`, layout: [] }]
})

describe('depsFresh', () => {
  it('is fresh while every endpoint kept its shape hash', () => {
    expect(depsFresh({ 'GET /a': 'h1', 'GET /b': 'h2' }, { 'GET /a': 'h1', 'GET /b': 'h2' })).toBe(
      true
    )
  })

  it('is stale when one endpoint changed shape', () => {
    expect(depsFresh({ 'GET /a': 'h1' }, { 'GET /a': 'other' })).toBe(false)
  })

  it('is stale when an endpoint is missing from the memory', () => {
    expect(depsFresh({ 'GET /a': 'h1' }, {})).toBe(false)
    expect(depsFresh({ 'GET /a': 'h1' }, { 'GET /b': 'h2' })).toBe(false)
  })

  it('an empty deps map is always fresh (no API, no invalidation)', () => {
    expect(depsFresh({}, {})).toBe(true)
  })
})

describe('ScreenStore screens', () => {
  it('round-trips a spec with its deps across a reopen', async () => {
    const storage = memStorage()
    const first = await ScreenStore.open(storage, 'crm')
    await first.put('home::ctx1', spec('home'), { 'GET /leads': 'h1' })

    const reopened = await ScreenStore.open(storage, 'crm')
    const hit = reopened.get('home::ctx1', { 'GET /leads': 'h1' })
    expect(hit?.spec.pages[0].id).toBe('home')
    expect(hit?.deps).toEqual({ 'GET /leads': 'h1' })
  })

  it('demotes a hit to a miss when an endpoint shape moved', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm')
    await store.put('k', spec('p'), { 'GET /leads': 'h1' })
    expect(store.get('k', { 'GET /leads': 'h2' })).toBeNull()
    expect(store.get('k', { 'GET /leads': 'h1' })).not.toBeNull()
    expect(store.get('k', {})).toBeNull()
  })

  it('screens without deps hit regardless of schema memory', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm')
    await store.put('k', spec('p'))
    expect(store.get('k', {})).not.toBeNull()
    expect(store.get('k', { 'GET /x': 'h' })).not.toBeNull()
  })

  it('a re-put without deps keeps the provenance the earlier turn recorded', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm')
    await store.put('k', spec('p'), { 'GET /a': 'h1' })
    await store.put('k', spec('p2')) // same key, no API called this time
    expect(store.get('k', { 'GET /a': 'h1' })).not.toBeNull()
    expect(store.get('k', { 'GET /a': 'h2' })).toBeNull()
  })

  it('a put replaces the same key instead of duplicating it', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm')
    await store.put('k', spec('old'))
    await store.put('k', spec('new'))
    const raw = JSON.parse(storage.map.get(screensKey('crm'))!) as unknown[]
    expect(raw).toHaveLength(1)
    expect((raw[0] as { spec: UiSpec }).spec.pages[0].name).toBe('new')
  })

  it('keeps the newest 20 and drops older screens', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm')
    for (let i = 0; i < 25; i++) await store.put(`k${i}`, spec(`p${i}`))
    expect(store.get('k0')).toBeNull()
    expect(store.get('k4')).toBeNull()
    expect(store.get('k5')).not.toBeNull()
    expect(store.get('k24')).not.toBeNull()
    const raw = JSON.parse(storage.map.get(screensKey('crm'))!) as unknown[]
    expect(raw).toHaveLength(20)
  })

  it('drops oldest first once the serialized total passes the budget', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm')
    const pad = 'x'.repeat(800_000)
    await store.put('big1', spec('p1', pad))
    await store.put('big2', spec('p2', pad))
    // 1.6M > 1.5M budget: the newest survives alone
    expect(store.get('big1')).toBeNull()
    expect(store.get('big2')).not.toBeNull()
    expect(store.get('fresh', {})).toBeNull()
    await store.put('fresh', spec('p3'))
    expect(store.get('fresh')).not.toBeNull()
    expect(store.get('big2')).not.toBeNull()
  })

  it('refuses a single spec larger than the whole budget and keeps the cache', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm')
    await store.put('keep', spec('p'))
    await store.put('huge', spec('huge', 'y'.repeat(1_600_000)))
    expect(store.get('huge')).toBeNull()
    expect(store.get('keep')).not.toBeNull()
  })

  it('tolerates corrupt storage and starts empty', async () => {
    const storage = memStorage({ [screensKey('crm')]: '{not json' })
    const store = await ScreenStore.open(storage, 'crm')
    expect(store.get('anything')).toBeNull()
    await store.put('k', spec('p'))
    expect((await ScreenStore.open(storage, 'crm')).get('k')).not.toBeNull()
  })

  it('keeps different dominos apart', async () => {
    const storage = memStorage()
    const crm = await ScreenStore.open(storage, 'crm')
    const hr = await ScreenStore.open(storage, 'hr')
    await crm.put('k', spec('p'))
    expect(hr.get('k')).toBeNull()
  })
})

describe('ScreenStore view snapshot', () => {
  it('round-trips the last view for the matching auth flag', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm')
    await store.saveView(true, { page: 'leads', known: spec('leads') })

    const restored = await store.loadView(true)
    expect(restored?.page).toBe('leads')
    expect(restored?.known.pages[0].id).toBe('leads')

    // a logged-out session must not restore the logged-in view
    expect(await store.loadView(false)).toBeNull()
    expect(storage.map.has(viewKey('crm', false))).toBe(false)
  })

  it('stores logged-out views under their own key', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm')
    await store.saveView(false, { page: 'login', known: spec('login') })
    expect((await store.loadView(false))?.page).toBe('login')
    expect(await store.loadView(true)).toBeNull()
  })

  it('keeps the previous snapshot when a new one is too large', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm')
    await store.saveView(true, { page: 'good', known: spec('good') })
    await store.saveView(true, { page: 'huge', known: spec('huge', 'z'.repeat(900_000)) })
    expect((await store.loadView(true))?.page).toBe('good')
  })

  it('ignores corrupt or malformed snapshots', async () => {
    const storage = memStorage({
      [viewKey('crm', true)]: JSON.stringify({ page: 42, known: {} })
    })
    const store = await ScreenStore.open(storage, 'crm')
    expect(await store.loadView(true)).toBeNull()
  })
})
