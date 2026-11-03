import { describe, expect, it } from 'vitest'
import type { PageSpec, UiSpec } from '../spec'
import {
  PageStore,
  assembleSpec,
  pageBlobKey,
  pageIndexKey,
  pageVersion,
  restorePage,
  restoreShell
} from './pageStore'
import { getMany, isQuotaError } from './kv'

function memStorage(initial: Record<string, string> = {}) {
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

const page = (id: string, text = id): PageSpec => ({
  id,
  name: id,
  layout: [{ name: 'Heading', props: { text } }]
})

const blobKeys = (s: { map: Map<string, string> }): string[] =>
  [...s.map.keys()].filter((k) => k.startsWith('domino:page:'))

describe('pageVersion', () => {
  it('is stable per content and differs when the page changes', () => {
    expect(pageVersion(page('a'))).toBe(pageVersion(page('a')))
    expect(pageVersion(page('a'))).not.toBe(pageVersion(page('a', 'changed')))
    expect(pageVersion(page('a'))).toMatch(/^[a-z0-9]+$/)
  })
})

describe('PageStore', () => {
  it('writes only pinned versions, each once', async () => {
    const storage = memStorage()
    const store = await PageStore.open(storage, 'crm')
    const a = store.put(page('a'))
    store.put(page('b')) // nobody pins it
    store.retain('view', [a])
    expect(await store.flush()).toBe(true)
    expect(blobKeys(storage)).toEqual([pageBlobKey('crm', a)])
    storage.sets.length = 0
    store.put(page('a'))
    store.retain('view', [a])
    await store.flush()
    expect(storage.sets).toEqual([]) // nothing changed, nothing written
  })

  it('collects versions no owner pins any more', async () => {
    const storage = memStorage()
    const store = await PageStore.open(storage, 'crm')
    const v1 = store.put(page('a', 'one'))
    store.retain('view', [v1])
    await store.flush()
    const v2 = store.put(page('a', 'two'))
    store.retain('view', [v2])
    await store.flush()
    expect(blobKeys(storage)).toEqual([pageBlobKey('crm', v2)])
  })

  it('keeps pins of owners that are not loaded across a restart', async () => {
    const storage = memStorage()
    const first = await PageStore.open(storage, 'crm')
    const login = first.put(page('login'))
    first.retain('view:false', [login])
    const home = first.put(page('home'))
    first.retain('view:true', [home])
    await first.flush()

    const restarted = memStorage(Object.fromEntries(storage.map))
    const second = await PageStore.open(restarted, 'crm')
    // only the signed-in view re-declares its pins this session
    second.retain('view:true', [second.put(page('home', 'new'))])
    await second.flush()
    expect(second.page(login)?.id).toBe('login')
    expect(restarted.map.has(pageBlobKey('crm', login))).toBe(true)
    expect(restarted.map.has(pageBlobKey('crm', home))).toBe(false)
  })

  it('a vanished version resolves to the newest stored version of that page', async () => {
    const storage = memStorage()
    const store = await PageStore.open(storage, 'crm')
    const old = store.put(page('a', 'old'))
    const cur = store.put(page('a', 'cur'))
    store.retain('view', [cur])
    await store.flush()
    const reopened = await PageStore.open(memStorage(Object.fromEntries(storage.map)), 'crm')
    expect(reopened.page(old)).toBeUndefined()
    expect(reopened.resolve([['a', old]])[0].layout[0].props?.text).toBe('cur')
    expect(reopened.resolve([['missing', 'x']])).toEqual([])
  })

  it('restored pages map back to their stored version (no rewrite on reopen)', async () => {
    const storage = memStorage()
    const store = await PageStore.open(storage, 'crm')
    const v = store.put(page('a'))
    store.retain('o', [v])
    await store.flush()
    const restarted = memStorage(Object.fromEntries(storage.map))
    const reopened = await PageStore.open(restarted, 'crm')
    const restored = reopened.page(v)!
    expect(reopened.put(restored)).toBe(v)
  })

  it('drops an unreadable blob and stops listing it', async () => {
    const storage = memStorage()
    const store = await PageStore.open(storage, 'crm')
    const v = store.put(page('a'))
    store.retain('o', [v])
    await store.flush()
    const broken = memStorage({ ...Object.fromEntries(storage.map), [pageBlobKey('crm', v)]: '{x' })
    const reopened = await PageStore.open(broken, 'crm')
    expect(reopened.page(v)).toBeUndefined()
    reopened.retain('o', [])
    await reopened.flush()
    const index = JSON.parse(broken.map.get(pageIndexKey('crm'))!) as { blobs: string[] }
    expect(index.blobs).toEqual([])
  })

  it('reports a failed write to its listeners', async () => {
    const storage = memStorage()
    const store = await PageStore.open(storage, 'crm')
    const errors: Error[] = []
    store.onError((e) => errors.push(e))
    storage.set = async () => {
      throw 'disk full'
    }
    store.retain('o', [store.put(page('a'))])
    expect(await store.flush()).toBe(false)
    expect(errors[0]).toBeInstanceOf(Error)
  })

  it('is shared per storage and domino', async () => {
    const storage = memStorage()
    expect(await PageStore.open(storage, 'a')).toBe(await PageStore.open(storage, 'a'))
    expect(await PageStore.open(storage, 'a')).not.toBe(await PageStore.open(storage, 'b'))
    const before = await PageStore.open(storage, 'a')
    PageStore.forget(storage, 'a')
    expect(await PageStore.open(storage, 'a')).not.toBe(before)
  })
})

describe('restore helpers', () => {
  it('restorePage validates and normalizes a stored page', () => {
    expect(restorePage({ id: 'p', name: 'P', layout: [] })?.id).toBe('p')
    expect(restorePage({ id: 'p', layout: 'x' })?.layout).toEqual([])
    expect(restorePage({ name: 'no id' })).toBeNull()
    expect(restorePage('junk')).toBeNull()
  })

  it('restoreShell keeps nav and state, rejects junk', () => {
    const shell = restoreShell({ nav: [{ id: 'a', label: 'A' }], state: { x: 1 } }, 'a')
    expect(shell?.nav).toEqual([{ id: 'a', label: 'A' }])
    expect(shell?.state).toEqual({ x: 1 })
    expect(restoreShell({}, '')).toBeNull()
  })

  it('assembleSpec needs the current page among the pages', () => {
    const spec: UiSpec | null = assembleSpec({ nav: [] }, 'a', [page('a'), page('b')])
    expect(spec?.page).toBe('a')
    expect(spec?.pages).toHaveLength(2)
    expect(assembleSpec({}, 'zz', [page('a')])).toBeNull()
  })
})

describe('kv helpers', () => {
  it('getMany uses a batch read when the storage has one', async () => {
    const storage = {
      ...memStorage({ a: '1' }),
      async getMany(keys: string[]) {
        return keys.map((k) => (k === 'a' ? 'batched' : null))
      }
    }
    expect(await getMany(storage, ['a', 'b'])).toEqual(['batched', null])
    expect(await getMany(memStorage({ a: '1' }), ['a', 'b'])).toEqual(['1', null])
  })

  it('recognizes quota errors across platforms', () => {
    expect(isQuotaError({ name: 'QuotaExceededError' })).toBe(true)
    expect(isQuotaError({ code: 22 })).toBe(true)
    expect(isQuotaError(new Error('Storage quota exceeded'))).toBe(true)
    expect(isQuotaError(new Error('network down'))).toBe(false)
    expect(isQuotaError(null)).toBe(false)
  })
})
