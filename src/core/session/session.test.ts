import { describe, expect, it } from 'vitest'
import { MAX_HISTORY, SessionStore, hashContext } from './session'
import type { UiSpec } from '../spec'

const spec = (page: string): UiSpec => ({
  version: 1,
  page,
  pages: [{ id: page, name: page, layout: [{ name: 'Heading', props: { text: page } }] }]
})

describe('SessionStore history', () => {
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

describe('hashContext', () => {
  it('is stable for equal input and differs otherwise', () => {
    expect(hashContext({ a: 1 })).toBe(hashContext({ a: 1 }))
    expect(hashContext({ a: 1 })).not.toBe(hashContext({ a: 2 }))
  })
})
