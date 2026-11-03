import { describe, expect, it } from 'vitest'
import {
  MAX_HISTORY,
  SessionStore,
  dominoIdOfHistoryKey,
  hashContext,
  historyKey,
  legacyHistoryKey
} from './session'
import { ScreenStore } from './screenStore'
import type { UiSpec } from '../spec'

const spec = (page: string): UiSpec => ({
  version: 1,
  page,
  pages: [{ id: page, name: page, layout: [{ name: 'Heading', props: { text: page } }] }]
})

describe('SessionStore history', () => {
  it('replaceTop overwrites the newest current moment only', () => {
    const s = new SessionStore()
    s.push(spec('a'))
    s.push(spec('b'), { kind: 'edit', note: 'n' })
    expect(s.replaceTop(1, spec('c'))).toBe(true)
    expect(s.historySize).toBe(2)
    expect(s.current?.spec.page).toBe('c')
    expect(s.entries()[1]).toMatchObject({ kind: 'edit', note: 'n' })
    s.back()
    expect(s.replaceTop(1, spec('d'))).toBe(false)
    expect(s.replaceTop(0, spec('d'))).toBe(false)
  })

  it('pushes and reads the current snapshot', () => {
    const s = new SessionStore()
    expect(s.current).toBeNull()
    s.push(spec('a'))
    expect(s.current?.spec.page).toBe('a')
    expect(s.canBack).toBe(false)
    expect(s.canForward).toBe(false)
  })

  it('goes back and forward', () => {
    const s = new SessionStore()
    s.push(spec('a'))
    s.push(spec('b'))
    s.push(spec('c'))
    expect(s.current?.spec.page).toBe('c')
    expect(s.back()?.spec.page).toBe('b')
    expect(s.back()?.spec.page).toBe('a')
    expect(s.back()).toBeNull()
    expect(s.forward()?.spec.page).toBe('b')
    expect(s.forward()?.spec.page).toBe('c')
    expect(s.forward()).toBeNull()
  })

  it('truncates the forward branch on a new push', () => {
    const s = new SessionStore()
    s.push(spec('a'))
    s.push(spec('b'))
    s.back()
    s.push(spec('d'))
    expect(s.canForward).toBe(false)
    expect(s.current?.spec.page).toBe('d')
    expect(s.historySize).toBe(2)
  })
})

describe('SessionStore render cache', () => {
  it('stores and retrieves by key', () => {
    const s = new SessionStore()
    expect(s.cacheGet('k')).toBeNull()
    s.cacheSet('k', spec('cached'))
    expect(s.cacheGet('k')?.page).toBe('cached')
    expect(s.cacheSize).toBe(1)
  })

  it('is per-instance (a restart creates a fresh store)', () => {
    const first = new SessionStore()
    first.cacheSet('k', spec('old'))
    const afterRestart = new SessionStore()
    expect(afterRestart.cacheGet('k')).toBeNull()
  })
})

describe('SessionStore reset', () => {
  it('drops the back stack and every cached render', () => {
    const s = new SessionStore()
    s.push(spec('a'))
    s.push(spec('b'))
    s.cacheSet('k', spec('cached'))
    s.reset()
    expect(s.current).toBeNull()
    expect(s.canBack).toBe(false)
    expect(s.canForward).toBe(false)
    expect(s.historySize).toBe(0)
    expect(s.cacheGet('k')).toBeNull()
    expect(s.cacheSize).toBe(0)
    // usable again after the reset
    s.push(spec('fresh'))
    expect(s.current?.spec.page).toBe('fresh')
  })
})

describe('SessionStore history entries', () => {
  it('labels entries from their page and marks the current one', () => {
    const s = new SessionStore()
    s.push(spec('leads'), { kind: 'start' })
    s.push(spec('settings'), { kind: 'action' })
    const entries = s.entries()
    expect(entries.map((e) => e.label)).toEqual(['leads', 'settings'])
    expect(entries.map((e) => e.kind)).toEqual(['start', 'action'])
    expect(entries.map((e) => e.current)).toEqual([false, true])
    s.back()
    expect(s.entries().map((e) => e.current)).toEqual([true, false])
  })

  it('accepts an explicit label and defaults kind to action', () => {
    const s = new SessionStore()
    s.push(spec('home'))
    expect(s.entries()[0].kind).toBe('action')
    s.push(spec('home'), { kind: 'edit', label: '수정 · home' })
    expect(s.entries()[1]).toMatchObject({ kind: 'edit', label: '수정 · home' })
  })

  it('jumpTo moves to an arbitrary moment without pushing', () => {
    const s = new SessionStore()
    s.push(spec('a'))
    s.push(spec('b'))
    s.push(spec('c'))
    expect(s.jumpTo(1)?.spec.page).toBe('b')
    expect(s.historySize).toBe(3)
    expect(s.current?.spec.page).toBe('b')
    // back/forward continue from the jumped-to spot
    expect(s.forward()?.spec.page).toBe('c')
    expect(s.jumpTo(-1)).toBeNull()
    expect(s.jumpTo(3)).toBeNull()
    expect(s.jumpTo(1.5)).toBeNull()
  })

  it('caps the stack, dropping the oldest moments first', () => {
    const s = new SessionStore()
    for (let i = 0; i < MAX_HISTORY + 5; i++) s.push(spec(`p${i}`))
    expect(s.historySize).toBe(MAX_HISTORY)
    const entries = s.entries()
    expect(entries[0].pageId).toBe('p5') // oldest five fell off
    expect(entries.at(-1)?.current).toBe(true)
    expect(s.jumpTo(0)?.spec.page).toBe('p5')
    expect(s.jumpTo(MAX_HISTORY)).toBeNull() // pre-cap indices are gone
  })
})

describe('SessionStore persistence', () => {
  const memStorage = () => {
    const m = new Map<string, string>()
    return {
      async get(k: string) {
        return m.get(k) ?? null
      },
      async set(k: string, v: string) {
        m.set(k, v)
      },
      async remove(k: string) {
        m.delete(k)
      }
    }
  }
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 900))

  it('round-trips the stack, kinds and edit notes across instances', async () => {
    const storage = memStorage()
    const first = new SessionStore()
    first.attach(storage, 'domino:history:test')
    first.push(spec('one'), { kind: 'edit', note: 'do the thing' })
    first.push(spec('two'))
    await flush()

    const second = new SessionStore()
    second.attach(storage, 'domino:history:test')
    expect(await second.load()).toBe(true)
    expect(second.historySize).toBe(2)
    const entries = second.entries()
    expect(entries[0]).toMatchObject({ kind: 'edit', note: 'do the thing', pageId: 'one' })
    expect(entries[1].current).toBe(true)
    // navigation continues from the restored position
    expect(second.back()?.spec.page).toBe('one')
    expect(second.canForward).toBe(true)
  })

  it('reset persists the cleared stack', async () => {
    const storage = memStorage()
    const a = new SessionStore()
    a.attach(storage, 'domino:history:reset')
    a.push(spec('gone'))
    await flush()
    a.reset()
    await flush()
    const b = new SessionStore()
    b.attach(storage, 'domino:history:reset')
    expect(await b.load()).toBe(false) // empty stack = nothing to restore
    expect(b.historySize).toBe(0)
  })

  it('a corrupt payload starts fresh instead of crashing', async () => {
    const storage = memStorage()
    await storage.set('domino:history:bad', '{not json')
    const s = new SessionStore()
    s.attach(storage, 'domino:history:bad')
    expect(await s.load()).toBe(false)
    expect(s.historySize).toBe(0)
  })
})

describe('SessionStore persistence by reference', () => {
  const memStorage = (initial: Record<string, string> = {}) => {
    const m = new Map(Object.entries(initial))
    return {
      m,
      async get(k: string) {
        return m.get(k) ?? null
      },
      async set(k: string, v: string) {
        m.set(k, v)
      },
      async remove(k: string) {
        m.delete(k)
      }
    }
  }
  /** Same bytes, fresh storage object: a restart (the page table is rebuilt). */
  const restart = (s: { m: Map<string, string> }) => memStorage(Object.fromEntries(s.m))
  const bigApp = (count: number, current: string, tag = ''): UiSpec => ({
    version: 1,
    page: current,
    nav: [{ id: 'p0', label: 'Home' }],
    pages: Array.from({ length: count }, (_, i) => ({
      id: `p${i}`,
      name: `Page ${i}`,
      layout: [{ name: 'Paragraph', props: { text: `content ${i}${tag} ${'x'.repeat(200)}` } }]
    }))
  })
  const key = historyKey('crm', true)

  it('a 30-page app keeps every page and its back history across a restart', async () => {
    const storage = memStorage()
    const a = new SessionStore()
    a.attach(storage, key, { debounceMs: 0 })
    const base = bigApp(30, 'p0')
    for (let i = 0; i < 30; i++) a.push({ ...base, page: `p${i}` }, { kind: 'nav' })
    a.back()
    a.back()
    await a.flush()

    // stored once per page, not once per moment
    const historyChars = storage.m.get(key)!.length
    expect(historyChars).toBeLessThan(JSON.stringify(base).length)

    const b = new SessionStore()
    b.attach(restart(storage), key)
    expect(await b.load()).toBe(true)
    expect(b.historySize).toBe(30)
    expect(b.current?.spec.page).toBe('p27')
    expect(b.current?.spec.pages).toHaveLength(30)
    expect(b.current?.spec.nav).toEqual([{ id: 'p0', label: 'Home' }])
    expect(b.canForward).toBe(true)
    expect(b.back()?.spec.page).toBe('p26')
  })

  it('restores a moment as it was (time travel keeps old page versions)', async () => {
    const storage = memStorage()
    const a = new SessionStore()
    a.attach(storage, key, { debounceMs: 0 })
    a.push(bigApp(3, 'p1'), { kind: 'action' })
    a.push(bigApp(3, 'p1', ' edited'), { kind: 'edit', note: 'make it pop' })
    await a.flush()

    const b = new SessionStore()
    b.attach(restart(storage), key)
    expect(await b.load()).toBe(true)
    const before = b.jumpTo(0)!
    expect(before.spec.pages[1].layout[0].props?.text).toMatch(/^content 1 x/)
    expect(b.jumpTo(1)!.spec.pages[1].layout[0].props?.text).toMatch(/^content 1 edited/)
    expect(b.entries()[1]).toMatchObject({ kind: 'edit', note: 'make it pop' })
  })

  it('shares page blobs with the screen store (one copy per version)', async () => {
    const storage = memStorage()
    const screens = await ScreenStore.open(storage, 'crm', { viewDebounceMs: 0 })
    const s = new SessionStore()
    s.attach(storage, key, { debounceMs: 0 })
    const known = bigApp(10, 'p0')
    s.push(known)
    await screens.saveView(true, { page: 'p0', known })
    await screens.put('k', known)
    await s.flush()
    const blobs = [...storage.m.keys()].filter((k) => k.startsWith('domino:page:'))
    expect(blobs).toHaveLength(10)
  })

  it('migrates a legacy whole-spec stack and drops the bad snapshot, clamping idx', async () => {
    const legacy = {
      v: 1,
      idx: 2,
      stack: [
        { spec: spec('a'), at: 1, kind: 'start', label: 'a' },
        {
          spec: { version: 1, page: 'zz', pages: [{ id: 'b', name: 'b', layout: [] }] },
          at: 2,
          kind: 'nav',
          label: 'b'
        },
        { spec: spec('c'), at: 3, kind: 'nav', label: 'c' },
        { spec: spec('d'), at: 4, kind: 'nav', label: 'd' }
      ]
    }
    const storage = memStorage({ [key]: JSON.stringify(legacy) })
    const s = new SessionStore()
    s.attach(storage, key, { debounceMs: 0 })
    expect(await s.load()).toBe(true)
    expect(s.entries().map((e) => e.pageId)).toEqual(['a', 'c', 'd'])
    expect(s.current?.spec.page).toBe('c') // stored idx 2 → same moment after the drop
    await s.flush()
    expect((JSON.parse(storage.m.get(key)!) as { v: number }).v).toBe(2)
  })

  it('migrates the pre-partition key only when asked, then removes it', async () => {
    const old = legacyHistoryKey('crm')
    const legacy = {
      v: 1,
      idx: 0,
      stack: [{ spec: spec('home'), at: 1, kind: 'start', label: 'home' }]
    }
    const storage = memStorage({ [old]: JSON.stringify(legacy) })

    const without = new SessionStore()
    without.attach(storage, key)
    expect(await without.load()).toBe(false) // a mixed-auth stack is never adopted silently

    const s = new SessionStore()
    s.attach(storage, historyKey('crm', false), { legacyKey: old, debounceMs: 0 })
    expect(await s.load()).toBe(true)
    expect(s.current?.spec.page).toBe('home')
    await s.flush()
    await new Promise((r) => setTimeout(r, 10))
    expect(storage.m.has(old)).toBe(false)
    expect(storage.m.has(historyKey('crm', false))).toBe(true)
  })

  it('drops a stack saved under another definition', async () => {
    const storage = memStorage()
    const a = new SessionStore()
    a.attach(storage, key, { fingerprint: 'def1', debounceMs: 0 })
    a.push(spec('home'))
    await a.flush()

    const changed = new SessionStore()
    changed.attach(restart(storage), key, { fingerprint: 'def2' })
    expect(await changed.load()).toBe(false)
    const same = new SessionStore()
    same.attach(restart(storage), key, { fingerprint: 'def1' })
    expect(await same.load()).toBe(true)
  })

  it('keeps signed-in and signed-out stacks apart across rebind', async () => {
    const storage = memStorage()
    const s = new SessionStore()
    s.attach(storage, historyKey('crm', false), { debounceMs: 0 })
    s.push(spec('login'))
    s.cacheSet('k', spec('login'))
    // sign in
    expect(await s.rebind(historyKey('crm', true))).toBe(false)
    expect(s.historySize).toBe(0)
    expect(s.cacheGet('k')).toBeNull() // renders of the other auth state never answer
    s.push(spec('dashboard'))
    s.push(spec('private'))
    // sign out: the signed-in stack is forgotten for good
    await s.rebind(historyKey('crm', false))
    await s.forget(historyKey('crm', true))
    expect(s.entries().map((e) => e.pageId)).toEqual(['login'])
    expect(storage.m.has(historyKey('crm', true))).toBe(false)

    const after = new SessionStore()
    after.attach(restart(storage), historyKey('crm', true))
    expect(await after.load()).toBe(false)
  })

  it('flush writes a pending debounced persist immediately', async () => {
    const storage = memStorage()
    const s = new SessionStore()
    s.attach(storage, key, { debounceMs: 60_000 })
    s.push(spec('a'))
    expect(storage.m.has(key)).toBe(false)
    await s.flush()
    expect(storage.m.has(key)).toBe(true)
  })

  it('keeps the legacy pre-partition stack when the page blobs do not land', async () => {
    const old = legacyHistoryKey('crm')
    const legacy = {
      v: 1,
      idx: 0,
      stack: [{ spec: spec('home'), at: 1, kind: 'start', label: 'home' }]
    }
    const storage = memStorage({ [old]: JSON.stringify(legacy) })
    const realSet = storage.set.bind(storage)
    storage.set = async (k: string, v: string) => {
      if (k.startsWith('domino:page:')) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' })
      return realSet(k, v)
    }
    const s = new SessionStore()
    s.attach(storage, historyKey('crm', false), { legacyKey: old, debounceMs: 0 })
    expect(await s.load()).toBe(true)
    await s.flush()
    await new Promise((r) => setTimeout(r, 10))
    // The only full copy stays, and no ref stack pointing at missing pages was written.
    expect(storage.m.has(old)).toBe(true)
    expect(storage.m.has(historyKey('crm', false))).toBe(false)
    // Room again: the retried write migrates it.
    storage.set = realSet
    await s.flush()
    await new Promise((r) => setTimeout(r, 10))
    expect(storage.m.has(historyKey('crm', false))).toBe(true)
  })

  it('drops a leftover pre-partition stack once the partitioned one is in use', async () => {
    const old = legacyHistoryKey('crm')
    const storage = memStorage({
      [old]: JSON.stringify({ v: 1, idx: 0, stack: [{ spec: spec('old'), at: 1, kind: 'start', label: 'old' }] })
    })
    const a = new SessionStore()
    a.attach(storage, historyKey('crm', false), { debounceMs: 0 })
    a.push(spec('home'))
    await a.flush()
    const b = new SessionStore()
    b.attach(storage, historyKey('crm', false), { legacyKey: old })
    expect(await b.load()).toBe(true)
    expect(b.current?.spec.page).toBe('home')
    await new Promise((r) => setTimeout(r, 10))
    expect(storage.m.has(old)).toBe(false)
  })

  it('persists recordLanding with the moment', async () => {
    const storage = memStorage()
    const a = new SessionStore()
    a.attach(storage, key, { debounceMs: 0 })
    a.push(spec('list'), { kind: 'action', dataKey: 'q=a' })
    a.push(spec('detail'), { kind: 'action', dataKey: 'id=1', recordLanding: true })
    await a.flush()
    const b = new SessionStore()
    b.attach(restart(storage), key)
    expect(await b.load()).toBe(true)
    expect(b.entries().map((e) => e.recordLanding ?? false)).toEqual([false, true])
  })

  it('reports a failed write instead of swallowing it', async () => {
    const storage = memStorage()
    const errors: Error[] = []
    const s = new SessionStore()
    s.attach(storage, key, { debounceMs: 0, onPersistError: (e) => errors.push(e) })
    storage.set = async () => {
      throw new Error('QuotaExceededError')
    }
    s.push(spec('a'))
    await s.flush()
    expect(errors.length).toBeGreaterThan(0)
    expect(s.current?.spec.page).toBe('a') // in-memory history keeps working
  })

  it('a moment whose page vanished from storage is dropped, not crashed on', async () => {
    const storage = memStorage()
    const a = new SessionStore()
    a.attach(storage, key, { debounceMs: 0 })
    a.push(spec('a'))
    a.push(spec('b'))
    await a.flush()
    const copy = restart(storage)
    for (const k of [...copy.m.keys()]) {
      if (k.startsWith('domino:page:') && copy.m.get(k)!.includes('"id":"a"')) copy.m.delete(k)
    }
    const b = new SessionStore()
    b.attach(copy, key)
    expect(await b.load()).toBe(true)
    expect(b.entries().map((e) => e.pageId)).toEqual(['b'])
  })
})

describe('history keys', () => {
  it('partitions by auth and parses back to the domino id', () => {
    expect(historyKey('A|https://x', true)).toBe('domino:history:A|https://x::auth:true')
    expect(dominoIdOfHistoryKey(historyKey('A|https://x', false))).toBe('A|https://x')
    expect(dominoIdOfHistoryKey(legacyHistoryKey('A|'))).toBe('A|')
    expect(dominoIdOfHistoryKey('custom')).toBe('custom')
  })
})

describe('hashContext', () => {
  it('is stable for equal input and differs otherwise', () => {
    expect(hashContext({ a: 1 })).toBe(hashContext({ a: 1 }))
    expect(hashContext({ a: 1 })).not.toBe(hashContext({ a: 2 }))
  })
})

describe('SessionStore record identity and cache eviction', () => {
  const memStorage = () => {
    const m = new Map<string, string>()
    return {
      async get(k: string) {
        return m.get(k) ?? null
      },
      async set(k: string, v: string) {
        m.set(k, v)
      },
      async remove(k: string) {
        m.delete(k)
      }
    }
  }

  it('persists a moment dataKey across a restart', async () => {
    const storage = memStorage()
    const a = new SessionStore()
    a.attach(storage, 'domino:history:dk-test', { debounceMs: 0 })
    a.push(spec('list'), { kind: 'start' })
    a.push(spec('detail'), { kind: 'action', dataKey: 'rec-42' })
    await a.flush()
    const b = new SessionStore()
    b.attach(storage, 'domino:history:dk-test')
    expect(await b.load()).toBe(true)
    expect(b.current?.dataKey).toBe('rec-42')
    expect(b.entries().map((e) => e.dataKey)).toEqual([undefined, 'rec-42'])
    expect(b.back()?.dataKey).toBeUndefined()
  })

  it('cacheEvictPage drops renders landing on the page except the kept key', () => {
    const s = new SessionStore()
    s.cacheSet('a', spec('detail'))
    s.cacheSet('b', spec('detail'))
    s.cacheSet('edit::detail::x', spec('detail'))
    s.cacheSet('c', spec('list'))
    s.cacheEvictPage('detail', 'edit::detail::x')
    expect(s.cacheGet('a')).toBeNull()
    expect(s.cacheGet('b')).toBeNull()
    expect(s.cacheGet('edit::detail::x')).not.toBeNull()
    expect(s.cacheGet('c')).not.toBeNull()
    s.cacheClear()
    expect(s.cacheSize).toBe(0)
    expect(s.historySize).toBe(0)
  })
})
