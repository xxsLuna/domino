import { describe, expect, it } from 'vitest'
import { SessionStore, hashContext } from './session'
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

describe('hashContext', () => {
  it('is stable for equal input and differs otherwise', () => {
    expect(hashContext({ a: 1 })).toBe(hashContext({ a: 1 }))
    expect(hashContext({ a: 1 })).not.toBe(hashContext({ a: 2 }))
  })
})
