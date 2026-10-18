import { describe, expect, it } from 'vitest'
import { isAllowed, resolveEndpoint } from './api'
import { extractPartialSpec, parsePartialJson } from './partialJson'

describe('isAllowed (domino allow list)', () => {
  it('exact match', () => {
    expect(isAllowed('/login', ['/login', '/me'])).toBe(true)
    expect(isAllowed('/nope', ['/login'])).toBe(false)
  })

  it('trailing /* wildcard', () => {
    expect(isAllowed('/leads', ['/leads/*'])).toBe(true)
    expect(isAllowed('/leads/42', ['/leads/*'])).toBe(true)
    expect(isAllowed('/leads/42/stage', ['/leads/*'])).toBe(true)
    expect(isAllowed('/other/42', ['/leads/*'])).toBe(false)
  })

  it('full URLs are matched by pathname', () => {
    expect(isAllowed('https://api.example.com/login', ['/login'])).toBe(true)
    expect(isAllowed('https://evil.example.com/x', ['/login'])).toBe(false)
  })

  it('empty allow list denies everything', () => {
    expect(isAllowed('/login', [])).toBe(false)
  })
})

describe('resolveEndpoint', () => {
  it('joins base_url and path', () => {
    expect(resolveEndpoint('/leads', 'https://api.example.com/v1')).toBe(
      'https://api.example.com/v1/leads'
    )
    expect(resolveEndpoint('leads', 'https://api.example.com/v1')).toBe(
      'https://api.example.com/v1/leads'
    )
  })
  it('keeps absolute urls', () => {
    expect(resolveEndpoint('https://x.test/a', 'https://api.example.com')).toBe('https://x.test/a')
  })
})

describe('parsePartialJson', () => {
  it('parses complete json', () => {
    expect(parsePartialJson<{ a: number }>('{"a": 1}')).toEqual({ a: 1 })
  })
  it('closes unterminated objects/strings', () => {
    expect(parsePartialJson('{"a": "he')).toEqual({ a: 'he' })
    expect(parsePartialJson('{"a": {"b": 1')).toEqual({ a: { b: 1 } })
  })
  it('drops dangling commas/keys', () => {
    expect(parsePartialJson('{"a": 1,')).toEqual({ a: 1 })
    expect(parsePartialJson('{"a": 1, "b"')).toEqual({ a: 1 })
    expect(parsePartialJson('{"a": 1, "b":')).toEqual({ a: 1 })
  })
  it('keeps a value string mid-escape without breaking', () => {
    expect(parsePartialJson('{"a": "x\\')).toEqual({ a: 'x' })
    expect(parsePartialJson('{"a": "x\\u00')).toEqual({ a: 'x' })
    expect(parsePartialJson('{"a": "say \\"hi')).toEqual({ a: 'say "hi' })
  })
  it('closes nested arrays and objects mid-stream', () => {
    expect(parsePartialJson('{"a": [1, 2, {"b": "c')).toEqual({ a: [1, 2, { b: 'c' }] })
    expect(parsePartialJson('{"a": [1, tr')).toEqual({ a: [1] })
    expect(parsePartialJson('[{"a": 1}, {')).toEqual([{ a: 1 }, {}])
  })
  it('stays linear on long streams', () => {
    const big = JSON.stringify({
      rows: Array.from({ length: 4000 }, (_, i) => ({ id: i, name: `row ${i}` }))
    })
    const t0 = performance.now()
    for (let cut = 1000; cut < big.length; cut += 997) parsePartialJson(big.slice(0, cut))
    expect(performance.now() - t0).toBeLessThan(1500)
    expect(parsePartialJson(big)).toEqual(JSON.parse(big))
  })
  it('returns null for hopeless input', () => {
    expect(parsePartialJson('not json')).toBeNull()
    expect(parsePartialJson('')).toBeNull()
  })
})

describe('extractPartialSpec', () => {
  it('extracts a nested spec mid-stream', () => {
    const args =
      '{"spec": {"version": 1, "page": "p1", "pages": [{"id": "p1", "name": "P", "layout": [{"name": "Heading", "props": {"text": "Hel'
    const parsed = extractPartialSpec(args) as { version: number; page: string } | null
    expect(parsed?.version).toBe(1)
    expect(parsed?.page).toBe('p1')
  })
  it('accepts a bare spec as the whole argument', () => {
    expect(extractPartialSpec('{"version": 1')).toEqual({ version: 1 })
  })
  it('returns null before any brace appears', () => {
    expect(extractPartialSpec('{"spe')).toBeNull()
  })
})
