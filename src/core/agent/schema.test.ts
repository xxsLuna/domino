import { describe, expect, it } from 'vitest'
import type { KeyValueStorage } from '../session/prefs'
import {
  bookFields,
  describeApiSchema,
  diffApiSchema,
  endpointKey,
  formatKnownSchemas,
  hashSchema,
  hasSchemaChange,
  loadSchemaBook,
  rememberSchema,
  saveSchemaBook,
  schemasKey,
  type SchemaBook
} from './schema'

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

describe('describeApiSchema', () => {
  it('maps root keys to type labels', () => {
    expect(
      describeApiSchema({ id: 1, name: 'a', active: true, note: null, score: 1.5 })
    ).toEqual({
      id: 'number',
      name: 'string',
      active: 'boolean',
      note: 'null',
      score: 'number'
    })
  })

  it('labels arrays by their first element and expands object fields one level', () => {
    const schema = describeApiSchema({
      total: 3,
      rows: [{ id: 7, status: 'open', tags: ['a'] }],
      meta: { page: 1 }
    })
    expect(schema.rows).toBe('array<object>')
    expect(schema['rows[].id']).toBe('number')
    expect(schema['rows[].status']).toBe('string')
    expect(schema['rows[].tags']).toBe('array<string>')
    expect(schema['meta.page']).toBe('number')
    expect(schema.total).toBe('number')
  })

  it('keeps empty and primitive arrays readable', () => {
    expect(describeApiSchema({ ids: [], names: ['x'] })).toEqual({
      ids: 'array',
      names: 'array<string>'
    })
  })

  it('caps the map at 50 keys', () => {
    const big: Record<string, number> = {}
    for (let i = 0; i < 120; i++) big[`k${i}`] = i
    expect(Object.keys(describeApiSchema(big)).length).toBe(50)
  })

  it('stops expanding beyond the depth budget instead of recursing forever', () => {
    // a.b.c.d is deeper than the budget: the subtree records as "object".
    const schema = describeApiSchema({ a: { b: { c: { d: 1 } } } })
    expect(schema['a.b.c']).toBe('object')
    expect(schema['a.b.c.d']).toBeUndefined()
  })

  it('describes a top-level array response', () => {
    const schema = describeApiSchema([{ id: 1, email: 'x' }])
    expect(schema['value']).toBe('array<object>')
    expect(schema['value[].id']).toBe('number')
    expect(schema['value[].email']).toBe('string')
  })

  it('does not follow the first array element when it is not an object', () => {
    expect(describeApiSchema({ counts: [1, 2, 3] })).toEqual({ counts: 'array<number>' })
  })
})

describe('hashSchema', () => {
  it('is stable across key order', () => {
    expect(hashSchema({ a: 'number', b: 'string' })).toBe(hashSchema({ b: 'string', a: 'number' }))
  })

  it('changes when a key or a type changes', () => {
    const base = { id: 'number', name: 'string' }
    expect(hashSchema(base)).not.toBe(hashSchema({ id: 'number', name: 'string', tag: 'string' }))
    expect(hashSchema(base)).not.toBe(hashSchema({ id: 'string', name: 'string' }))
  })
})

describe('diffApiSchema', () => {
  it('reports added, removed and changed keys', () => {
    const prev = { id: 'number', name: 'string', legacy: 'boolean' }
    const next = { id: 'number', name: 'string', email: 'string' }
    expect(diffApiSchema(prev, next)).toEqual({
      added: ['email'],
      removed: ['legacy'],
      changed: []
    })
  })

  it('reports type changes separately from key changes', () => {
    const diff = diffApiSchema({ total: 'number' }, { total: 'string' })
    expect(diff.changed).toEqual(['total'])
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(hasSchemaChange(diff)).toBe(true)
  })

  it('is empty for identical shapes', () => {
    const fields = { id: 'number', rows: 'array<object>' }
    const diff = diffApiSchema(fields, { ...fields })
    expect(hasSchemaChange(diff)).toBe(false)
  })
})

describe('endpointKey', () => {
  it('uppercases the method and defaults to GET', () => {
    expect(endpointKey('get', '/leads')).toBe('GET /leads')
    expect(endpointKey(undefined, '/leads')).toBe('GET /leads')
  })
})

describe('formatKnownSchemas', () => {
  it('renders one sorted line per endpoint', () => {
    const text = formatKnownSchemas(
      bookFields({
        'GET /leads': { fields: { id: 'number', name: 'string' }, at: 1 },
        'GET /deals': { fields: { amount: 'number' }, at: 2 }
      })
    )
    expect(text.split('\n')).toEqual([
      '- GET /deals → {amount: number}',
      '- GET /leads → {id: number, name: string}'
    ])
  })

  it('stops at the char budget', () => {
    const fields: Record<string, Record<string, string>> = {}
    for (let i = 0; i < 50; i++) fields[`GET /e${i}`] = { k: 'string' }
    expect(formatKnownSchemas(fields, 200).length).toBeLessThanOrEqual(200)
  })

  it('truncates a single oversized entry', () => {
    const wide: Record<string, string> = {}
    for (let i = 0; i < 60; i++) wide[`key_with_long_name_${i}`] = 'array<object>'
    const text = formatKnownSchemas({ 'GET /wide': wide }, 2000)
    expect(text).toContain('…}')
    expect(text.length).toBeLessThanOrEqual(301)
  })
})

describe('schema book persistence', () => {
  it('saves and loads a book under the per-domino key', async () => {
    const storage = memStorage()
    const book: SchemaBook = { 'GET /leads': { fields: { id: 'number' }, at: 5 } }
    await saveSchemaBook(storage, 'crm', book)
    expect(storage.map.has(schemasKey('crm'))).toBe(true)
    expect(await loadSchemaBook(storage, 'crm')).toEqual(book)
    expect(await loadSchemaBook(storage, 'hr')).toEqual({})
  })

  it('drops malformed entries and corrupt json', async () => {
    const storage = memStorage({
      [schemasKey('crm')]: JSON.stringify({
        'GET /ok': { fields: { id: 'number' }, at: 1 },
        'GET /bad-shape': 7,
        'GET /no-fields': { at: 2 },
        'GET /bad-at': { fields: { id: 'number' }, at: 'yesterday' }
      }),
      [schemasKey('broken')]: '{oops'
    })
    expect(await loadSchemaBook(storage, 'crm')).toEqual({
      'GET /ok': { fields: { id: 'number' }, at: 1 }
    })
    expect(await loadSchemaBook(storage, 'broken')).toEqual({})
  })

  it('survives a failing storage', async () => {
    const storage: KeyValueStorage = {
      async get() {
        throw new Error('nope')
      },
      async set() {},
      async remove() {}
    }
    expect(await loadSchemaBook(storage, 'crm')).toEqual({})
  })

  it('evicts the least recently seen endpoint past the 60-endpoint cap', () => {
    let book: SchemaBook = {}
    for (let i = 0; i < 60; i++) book = rememberSchema(book, `GET /e${i}`, { id: 'number' })
    book = rememberSchema(book, 'GET /e60', { id: 'number' })
    expect(Object.keys(book)).toHaveLength(60)
    expect(book['GET /e0']).toBeUndefined()
    expect(book['GET /e60']).toBeDefined()
    expect(book['GET /e59']).toBeDefined()
  })

  it('re-remembering an endpoint refreshes it instead of duplicating', () => {
    let book: SchemaBook = { 'GET /a': { fields: { id: 'number' }, at: 1 } }
    book = rememberSchema(book, 'GET /a', { id: 'string' })
    expect(Object.keys(book)).toEqual(['GET /a'])
    expect(book['GET /a'].fields).toEqual({ id: 'string' })
    expect(book['GET /a'].at).toBeGreaterThan(1)
  })
})
