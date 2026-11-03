import { describe, expect, it, vi } from 'vitest'
import type { PageSpec, UiSpec } from '../spec'
import type { KeyValueStorage } from './prefs'
import { MAX_SCREENS, ScreenStore, depsFresh, screensKey, viewKey } from './screenStore'
import { pageIndexKey } from './pageStore'

function memStorage(initial: Record<string, string> = {}): KeyValueStorage & {
  map: Map<string, string>
  sets: string[]
} {
  const map = new Map(Object.entries(initial))
  const sets: string[] = []
  return {
    map,
    sets,
    async get(key: string) {
      return map.get(key) ?? null
    },
    async set(key: string, value: string) {
      sets.push(key)
      map.set(key, value)
    },
    async remove(key: string) {
      map.delete(key)
    }
  }
}

const FAST = { viewDebounceMs: 0 }

const page = (id: string, text = id): PageSpec => ({
  id,
  name: id,
  layout: [{ name: 'Heading', props: { text } }]
})

const spec = (id: string, pad = ''): UiSpec => ({
  version: 1,
  page: id,
  nav: [{ id, label: id }],
  pages: [{ id, name: `${id}${pad}`, layout: [] }]
})

/** A whole app: `count` pages, showing `current`. */
const app = (count: number, current = 'p0', tag = ''): UiSpec => ({
  version: 1,
  page: current,
  pages: Array.from({ length: count }, (_, i) => page(`p${i}`, `page ${i}${tag}`))
})

const pageKeys = (storage: { map: Map<string, string> }): string[] =>
  [...storage.map.keys()].filter((k) => k.startsWith('domino:page:'))

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

    const reopened = await ScreenStore.open(memStorageFrom(storage), 'crm')
    const hit = reopened.get('home::ctx1', { 'GET /leads': 'h1' })
    expect(hit?.spec.pages[0].id).toBe('home')
    expect(hit?.spec.nav).toEqual([{ id: 'home', label: 'home' }])
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
    const raw = JSON.parse(storage.map.get(screensKey('crm'))!) as { entries: unknown[] }
    expect(raw.entries).toHaveLength(1)
    expect(store.get('k')?.spec.pages[0].name).toBe('new')
  })

  it(`keeps the newest ${MAX_SCREENS} and drops older screens`, async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm')
    for (let i = 0; i < MAX_SCREENS + 5; i++) await store.put(`k${i}`, spec(`p${i}`))
    expect(store.get('k0')).toBeNull()
    expect(store.get('k4')).toBeNull()
    expect(store.get('k5')).not.toBeNull()
    expect(store.get(`k${MAX_SCREENS + 4}`)).not.toBeNull()
    const raw = JSON.parse(storage.map.get(screensKey('crm'))!) as { entries: unknown[] }
    expect(raw.entries).toHaveLength(MAX_SCREENS)
    // dropped screens release their pages too
    expect(pageKeys(storage)).toHaveLength(MAX_SCREENS)
  })

  it('stores each page version once however many entries show it', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm')
    const big = app(30)
    for (let i = 0; i < 30; i++) await store.put(`k${i}`, { ...big, page: `p${i}` })
    // 30 entries × 30 pages used to be 900 page copies; now one blob per page
    expect(pageKeys(storage)).toHaveLength(30)
    const listChars = storage.map.get(screensKey('crm'))!.length
    const appChars = JSON.stringify(big).length
    expect(listChars).toBeLessThan(appChars * 30)
  })

  it('a spec larger than the old budget is kept (no silent size skip)', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm')
    await store.put('huge', spec('huge', 'y'.repeat(1_600_000)))
    expect(store.get('huge')).not.toBeNull()
  })

  it('reports a failed write instead of swallowing it', async () => {
    const storage = memStorage()
    const errors: Error[] = []
    const store = await ScreenStore.open(storage, 'crm', { onPersistError: (e) => errors.push(e) })
    storage.set = async () => {
      throw Object.assign(new Error('full'), { name: 'QuotaExceededError' })
    }
    await store.put('k', spec('p'))
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].name).toBe('QuotaExceededError')
    // the in-memory cache keeps working
    expect(store.get('k')).not.toBeNull()
  })

  it('tolerates corrupt storage and starts empty', async () => {
    const storage = memStorage({ [screensKey('crm')]: '{not json' })
    const store = await ScreenStore.open(storage, 'crm')
    expect(store.get('anything')).toBeNull()
    await store.put('k', spec('p'))
    expect((await ScreenStore.open(memStorageFrom(storage), 'crm')).get('k')).not.toBeNull()
  })

  it('keeps different dominos apart', async () => {
    const storage = memStorage()
    const crm = await ScreenStore.open(storage, 'crm')
    const hr = await ScreenStore.open(storage, 'hr')
    await crm.put('k', spec('p'))
    expect(hr.get('k')).toBeNull()
  })

  it('other pages of an entry resolve to their newest stored version', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm', FAST)
    await store.put('k', app(3, 'p0'))
    // p1 changes later (an edit) and the view pins the new version
    const edited = app(3, 'p1', ' edited')
    await store.saveView(true, { page: 'p1', known: edited })

    const reopened = await ScreenStore.open(memStorageFrom(storage), 'crm')
    const hit = reopened.get('k')!
    expect(hit.spec.page).toBe('p0')
    expect(hit.spec.pages.find((p) => p.id === 'p1')?.layout[0].props?.text).toBe('page 1 edited')
  })
})

describe('ScreenStore legacy migration', () => {
  it('reads the old whole-spec array and rewrites it by reference', async () => {
    const legacy = [
      { key: 'a', spec: app(4, 'p1'), deps: { 'GET /x': 'h' }, at: 5 },
      { key: 'bad', spec: { version: 1, page: 'p', pages: [{ id: 'p', layout: 'x' }] }, at: 6 }
    ]
    const storage = memStorage({ [screensKey('crm')]: JSON.stringify(legacy) })
    const store = await ScreenStore.open(storage, 'crm')
    const hit = store.get('a', { 'GET /x': 'h' })
    expect(hit?.spec.page).toBe('p1')
    expect(hit?.spec.pages).toHaveLength(4)
    await store.flush()
    const raw = JSON.parse(storage.map.get(screensKey('crm'))!) as { v: number; entries: unknown[] }
    expect(raw.v).toBe(2)
    expect(storage.map.has(pageIndexKey('crm'))).toBe(true)
  })

  it('drops a legacy entry that fails validation', async () => {
    const legacy = [
      {
        key: 'bad',
        spec: { version: 1, page: 'q', pages: [{ id: 'p', name: 'p', layout: [] }] },
        at: 1
      }
    ]
    const storage = memStorage({ [screensKey('crm')]: JSON.stringify(legacy) })
    const store = await ScreenStore.open(storage, 'crm')
    expect(store.get('bad')).toBeNull() // its page pointer dangles
  })

  it('keeps the legacy screen list while the migrated pages cannot be written', async () => {
    const legacy = [{ key: 'a', spec: app(4, 'p1'), at: 5 }]
    const raw = JSON.stringify(legacy)
    const storage = memStorage({ [screensKey('crm')]: raw })
    const realSet = storage.set.bind(storage)
    storage.set = async (k: string, v: string) => {
      if (k.startsWith('domino:page:')) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' })
      return realSet(k, v)
    }
    const store = await ScreenStore.open(storage, 'crm')
    await store.flush()
    expect(storage.map.get(screensKey('crm'))).toBe(raw)
    storage.set = realSet
    await store.flush()
    expect(JSON.parse(storage.map.get(screensKey('crm'))!).v).toBe(2)
  })

  it('does not overwrite a stored view when its pages did not land', async () => {
    const storage = memStorage({
      [viewKey('crm', true)]: JSON.stringify({ page: 'p2', known: app(3), at: 7 })
    })
    const before = storage.map.get(viewKey('crm', true))
    const realSet = storage.set.bind(storage)
    storage.set = async (k: string, v: string) => {
      if (k.startsWith('domino:page:')) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' })
      return realSet(k, v)
    }
    const store = await ScreenStore.open(storage, 'crm', FAST)
    await store.loadView(true)
    await store.flush()
    expect(storage.map.get(viewKey('crm', true))).toBe(before)
    storage.set = realSet
    await store.flush()
    expect(JSON.parse(storage.map.get(viewKey('crm', true))!).v).toBe(2)
  })

  it('stamps migrated legacy entries with the opening definition', async () => {
    const legacy = [{ key: 'a', spec: app(2, 'p1'), at: 5 }]
    const storage = memStorage({ [screensKey('crm')]: JSON.stringify(legacy) })
    const store = await ScreenStore.open(storage, 'crm', { fingerprint: 'def1' })
    expect(store.get('a')?.spec.page).toBe('p1')
    await store.flush()
    const reopened = await ScreenStore.open(memStorage(Object.fromEntries(storage.map)), 'crm', {
      fingerprint: 'def2'
    })
    expect(reopened.get('a')).toBeNull()
    expect(reopened.get('a', {}, { allowStale: true })?.stale).toBe(true)
  })

  it('migrates a legacy view snapshot', async () => {
    const storage = memStorage({
      [viewKey('crm', true)]: JSON.stringify({ page: 'p2', known: app(3), at: 7 })
    })
    const store = await ScreenStore.open(storage, 'crm', FAST)
    const view = await store.loadView(true)
    expect(view?.page).toBe('p2')
    expect(view?.known.page).toBe('p2')
    expect(view?.known.pages).toHaveLength(3)
    await store.flush()
    const raw = JSON.parse(storage.map.get(viewKey('crm', true))!) as Record<string, unknown>
    expect(raw.v).toBe(2)
    expect(raw.known).toBeUndefined()
  })
})

describe('ScreenStore view snapshot', () => {
  it('round-trips the last view for the matching auth flag', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm', FAST)
    await store.saveView(true, { page: 'leads', known: spec('leads') })

    const restored = await (await ScreenStore.open(memStorageFrom(storage), 'crm')).loadView(true)
    expect(restored?.page).toBe('leads')
    expect(restored?.known.pages[0].id).toBe('leads')
    expect(restored?.known.nav).toEqual([{ id: 'leads', label: 'leads' }])

    // a logged-out session must not restore the logged-in view
    expect(await store.loadView(false)).toBeNull()
    expect(storage.map.has(viewKey('crm', false))).toBe(false)
  })

  it('stores logged-out views under their own key', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm', FAST)
    await store.saveView(false, { page: 'login', known: spec('login') })
    expect((await store.loadView(false))?.page).toBe('login')
    expect(await store.loadView(true)).toBeNull()
  })

  it('keeps live state with the view', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm', FAST)
    await store.saveView(true, { page: 'p0', known: { ...app(2), state: { tab: 'b' } } })
    const view = await (await ScreenStore.open(memStorageFrom(storage), 'crm')).loadView(true)
    expect(view?.known.state).toEqual({ tab: 'b' })
  })

  it('saves a large app (no silent size skip)', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm', FAST)
    await store.saveView(true, { page: 'huge', known: spec('huge', 'z'.repeat(900_000)) })
    expect((await store.loadView(true))?.page).toBe('huge')
  })

  it('coalesces a burst of saves into one write', async () => {
    vi.useFakeTimers()
    try {
      const storage = memStorage()
      const store = await ScreenStore.open(storage, 'crm')
      const known = app(5)
      for (let i = 0; i < 20; i++) {
        void store.saveView(true, { page: 'p0', known: { ...known, state: { n: i } } })
      }
      expect(storage.sets.filter((k) => k === viewKey('crm', true))).toHaveLength(0)
      // reads see the pending snapshot before it is written
      expect((await store.loadView(true))?.known.state).toEqual({ n: 19 })
      await vi.advanceTimersByTimeAsync(400)
      expect(storage.sets.filter((k) => k === viewKey('crm', true))).toHaveLength(1)
      // page blobs were written once, not per save
      expect(storage.sets.filter((k) => k.startsWith('domino:page:'))).toHaveLength(5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('flush writes a pending view immediately', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm', { viewDebounceMs: 60_000 })
    void store.saveView(true, { page: 'p0', known: app(2) })
    expect(storage.map.has(viewKey('crm', true))).toBe(false)
    await store.flush()
    expect(storage.map.has(viewKey('crm', true))).toBe(true)
  })

  it('a 30-page app survives a restart with every page', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm', FAST)
    await store.saveView(true, { page: 'p17', known: app(30, 'p17') })
    const view = await (await ScreenStore.open(memStorageFrom(storage), 'crm')).loadView(true)
    expect(view?.page).toBe('p17')
    expect(view?.known.pages.map((p) => p.id)).toEqual(app(30).pages.map((p) => p.id))
  })

  it('ignores corrupt or malformed snapshots', async () => {
    const storage = memStorage({
      [viewKey('crm', true)]: JSON.stringify({ page: 42, known: {} })
    })
    const store = await ScreenStore.open(storage, 'crm')
    expect(await store.loadView(true)).toBeNull()
  })

  it('drops a snapshot whose stored page is not among its validated pages', async () => {
    const storage = memStorage({
      [viewKey('crm', true)]: JSON.stringify({ page: 'gone', known: app(2), at: 1 })
    })
    const store = await ScreenStore.open(storage, 'crm')
    expect(await store.loadView(true)).toBeNull()
    expect(storage.map.has(viewKey('crm', true))).toBe(false)
  })

  it('drops a snapshot whose layout is not a list', async () => {
    const storage = memStorage({
      [viewKey('crm', true)]: JSON.stringify({
        page: 'p',
        known: { version: 1, page: 'p', pages: [{ id: 'p', name: 'p', layout: 'x' }] }
      })
    })
    const store = await ScreenStore.open(storage, 'crm')
    const view = await store.loadView(true)
    // normalization repairs the layout instead of crashing the renderer
    expect(view === null || Array.isArray(view.known.pages[0].layout)).toBe(true)
  })
})

describe('ScreenStore definition fingerprint', () => {
  it('a changed definition makes stored screens stale', async () => {
    const storage = memStorage()
    const v1 = await ScreenStore.open(storage, 'crm', { ...FAST, fingerprint: 'def1' })
    await v1.put('k', spec('home'))
    await v1.saveView(true, { page: 'home', known: spec('home') })

    const v2 = await ScreenStore.open(memStorageFrom(storage), 'crm', { fingerprint: 'def2' })
    expect(v2.get('k')).toBeNull()
    expect(v2.get('k', {}, { allowStale: true })?.stale).toBe(true)
    const view = await v2.loadView(true)
    expect(view?.stale).toBe(true) // the caller decides

    const same = await ScreenStore.open(memStorageFrom(storage), 'crm', { fingerprint: 'def1' })
    expect(same.get('k')?.stale).toBeUndefined()
    expect((await same.loadView(true))?.stale).toBeUndefined()
  })

  it('entries written before fingerprints existed are not stale', async () => {
    const storage = memStorage({
      [screensKey('crm')]: JSON.stringify([{ key: 'k', spec: spec('p'), at: 1 }])
    })
    const store = await ScreenStore.open(storage, 'crm', { fingerprint: 'def' })
    expect(store.get('k')).not.toBeNull()
  })
})

describe('ScreenStore clear', () => {
  it('erases stored screens and the view so a reopen starts from the LLM', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm', FAST)
    await store.put('k', spec('home'))
    await store.saveView(true, { page: 'home', known: spec('home') })

    await store.clear(true)
    expect(store.get('k')).toBeNull()
    expect(await store.loadView(true)).toBeNull()
    expect(storage.map.has(screensKey('crm'))).toBe(false)
    expect(storage.map.has(viewKey('crm', true))).toBe(false)
    expect(pageKeys(storage)).toHaveLength(0)
    expect((await ScreenStore.open(memStorageFrom(storage), 'crm')).get('k')).toBeNull()
  })

  it('clears both auth flags (the other view holds the same thrown-away app)', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm', FAST)
    await store.saveView(false, { page: 'login', known: spec('login') })
    await store.saveView(true, { page: 'home', known: spec('home') })
    await store.clear(true)
    expect(await store.loadView(false)).toBeNull()
    expect(storage.map.has(viewKey('crm', false))).toBe(false)
  })

  it('a pending view write cannot resurrect a cleared view', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm', { viewDebounceMs: 20 })
    const pending = store.saveView(true, { page: 'home', known: spec('home') })
    await store.clear()
    await pending
    await new Promise((r) => setTimeout(r, 40))
    expect(storage.map.has(viewKey('crm', true))).toBe(false)
  })
})

/**
 * A "restart": same stored bytes, a fresh storage object — so the shared
 * page-table instance (keyed by storage) is rebuilt from what was written.
 */
function memStorageFrom(storage: { map: Map<string, string> }): ReturnType<typeof memStorage> {
  return memStorage(Object.fromEntries(storage.map))
}

describe('ScreenStore.evictPage (edits invalidate replays)', () => {
  it('drops entries landing on the edited page, keeps the edit and others, after a reopen', async () => {
    const storage = memStorage()
    const store = await ScreenStore.open(storage, 'crm')
    await store.put('action-a', spec('detail'))
    await store.put('action-b', spec('list'))
    await store.put('edit::detail::h', spec('detail', ' (edited)'))
    await store.evictPage('detail', 'edit::detail::h')
    expect(store.get('action-a')).toBeNull()
    expect(store.get('action-b')).not.toBeNull()
    expect(store.get('edit::detail::h')).not.toBeNull()
    const reopened = await ScreenStore.open(memStorageFrom(storage), 'crm')
    expect(reopened.get('action-a')).toBeNull()
    expect(reopened.get('edit::detail::h')?.spec.pages[0].name).toBe('detail (edited)')
  })
})
