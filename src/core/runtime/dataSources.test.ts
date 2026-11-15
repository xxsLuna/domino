import { describe, expect, it } from 'vitest'
import type { DataSourceDecl } from '../domino/types'
import {
  isErrorSnapshot,
  isUrlTemplate,
  missingSourceVars,
  planSourceFetch,
  settleWithin,
  sourcesReadingState,
  SOURCE_MAX_AGE_MS
} from './dataSources'

const decl = (key: string, path = `/${key}`, everySec?: number): DataSourceDecl =>
  ({ key, method: 'GET', path, ...(everySec ? { everySec } : {}) }) as DataSourceDecl

describe('planSourceFetch', () => {
  const now = 10_000_000
  it('waits only for sources with no snapshot; aged ones refresh behind', () => {
    const plan = planSourceFetch(
      [decl('a'), decl('b'), decl('c'), decl('d')],
      { b: 1, c: 2, d: 3 },
      { b: now - 1_000, c: now - SOURCE_MAX_AGE_MS - 1 },
      now
    )
    expect(plan).toEqual({ missing: ['a'], stale: ['c', 'd'] })
  })

  it('honours a slower poll interval as the staleness window', () => {
    const plan = planSourceFetch([decl('a', '/a', 120)], { a: 1 }, { a: now - 60_000 }, now)
    expect(plan).toEqual({ missing: [], stale: [] })
  })
})

describe('settleWithin', () => {
  it('reports a settled promise', async () => {
    expect(await settleWithin(Promise.resolve(1), 50)).toBe(true)
    expect(await settleWithin(Promise.reject(new Error('x')), 50)).toBe(true)
  })

  it('gives up at the cap without waiting for the promise', async () => {
    const never = new Promise(() => {})
    const started = Date.now()
    expect(await settleWithin(never, 20)).toBe(false)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('sourcesReadingState', () => {
  it('finds the sources whose path interpolates the key', () => {
    const decls = [decl('a', '/leads?q={query}'), decl('b', '/x'), decl('c', '/y/{query}/{page}')]
    expect(sourcesReadingState(decls, 'query')).toEqual(['a', 'c'])
    expect(sourcesReadingState(decls, 'page')).toEqual(['c'])
    expect(sourcesReadingState(decls, 'other')).toEqual([])
  })
})

describe('isUrlTemplate', () => {
  it('recognizes absolute-literal and whole-URL-template paths', () => {
    expect(isUrlTemplate('https://api.open-meteo.com/v1/forecast?lat=1')).toBe(true)
    expect(isUrlTemplate('HTTP://{host}/health')).toBe(true)
    expect(isUrlTemplate('{rssUrl}')).toBe(true)
    expect(isUrlTemplate('{proxyHost}/feed?url={rssUrl}')).toBe(true)
    expect(isUrlTemplate('{host}/feed')).toBe(true) // a leading token supplies the host
  })
  it('leaves base-relative paths (even with {state}) alone', () => {
    expect(isUrlTemplate('/leads?q={query}')).toBe(false)
    expect(isUrlTemplate('/feeds/{id}')).toBe(false)
    expect(isUrlTemplate('items/{id}/feed')).toBe(false)
    expect(isUrlTemplate('feed')).toBe(false)
  })
})

describe('isErrorSnapshot', () => {
  it('recognizes error-only snapshots', () => {
    expect(isErrorSnapshot({ error: 'HTTP 400' })).toBe(true)
    expect(isErrorSnapshot({ error: 'unreachable', items: [] })).toBe(false)
    expect(isErrorSnapshot({ title: 'T', items: [] })).toBe(false)
    expect(isErrorSnapshot(null)).toBe(false)
    expect(isErrorSnapshot([])).toBe(false)
  })
})

describe('missingSourceVars', () => {
  it('lists the placeholders a source cannot resolve yet', () => {
    expect(missingSourceVars('{rssUrl}', {})).toEqual(['rssUrl'])
    expect(missingSourceVars('{rssUrl}', { rssUrl: '  ' })).toEqual(['rssUrl'])
    expect(missingSourceVars('{rssUrl}', { rssUrl: null })).toEqual(['rssUrl'])
    expect(missingSourceVars('/leads?q={query}&page={page}', { query: 'a' })).toEqual(['page'])
  })
  it('says nothing about sources that CAN be fetched', () => {
    expect(missingSourceVars('{rssUrl}', { rssUrl: 'https://x.dev/rss' })).toEqual([])
    expect(missingSourceVars('/leads', {})).toEqual([])
    expect(missingSourceVars('/feeds/{id}', { id: 7 })).toEqual([])
  })
})
