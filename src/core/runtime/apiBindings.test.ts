import { describe, expect, it } from 'vitest'
import type { UiSpec } from '../spec'
import {
  API_BINDING_MAX_AGE_MS,
  apiKeyOfBinding,
  apiKeysToRefresh,
  boundApiKeys,
  keysStaleAfterWrite,
  parseEndpointKey,
  resourceRoot
} from './apiBindings'

const spec: UiSpec = {
  version: 1,
  page: 'leads',
  pages: [
    {
      id: 'leads',
      name: 'Leads',
      layout: [
        {
          name: 'Table',
          id: 'list',
          props: { rows: { $data: 'api:GET /leads.rows' }, total: { $data: 'stats.total' } }
        },
        {
          name: 'Card',
          id: 'c',
          children: [
            { name: 'Stat', id: 's', props: { value: { $data: 'api:GET /v1.0/stats.count' } } }
          ]
        }
      ]
    },
    {
      id: 'other',
      name: 'Other',
      layout: [{ name: 'List', id: 'o', props: { items: { $data: 'api:GET /feed.xml.items' } } }]
    }
  ]
}

describe('parseEndpointKey', () => {
  it('splits the schema.ts endpoint format', () => {
    expect(parseEndpointKey('GET /leads?x=1')).toEqual({ method: 'GET', path: '/leads?x=1' })
    expect(parseEndpointKey('POST /leads')).toEqual({ method: 'POST', path: '/leads' })
    expect(parseEndpointKey('/leads')).toBeNull()
    expect(parseEndpointKey('FETCH /x')).toBeNull()
  })
})

describe('apiKeyOfBinding', () => {
  it('cuts the endpoint at the first dot after the last slash', () => {
    expect(apiKeyOfBinding('api:GET /leads.rows.0.name')).toBe('api:GET /leads')
    expect(apiKeyOfBinding('api:GET /v1.0/stats.count')).toBe('api:GET /v1.0/stats')
    expect(apiKeyOfBinding('api:GET /leads')).toBe('api:GET /leads')
  })

  it('prefers the longest key the runtime already holds', () => {
    expect(apiKeyOfBinding('api:GET /feed.xml.items', ['api:GET /feed.xml', 'api:GET /feed'])).toBe(
      'api:GET /feed.xml'
    )
  })

  it('ignores non-api and malformed bindings', () => {
    expect(apiKeyOfBinding('stats.total')).toBeNull()
    expect(apiKeyOfBinding('api:nothing.here')).toBeNull()
  })
})

describe('boundApiKeys', () => {
  it('collects api keys from every page, nested nodes included', () => {
    expect(boundApiKeys(spec)).toEqual(['api:GET /leads', 'api:GET /v1.0/stats', 'api:GET /feed'])
  })

  it('limits to the given pages and uses known keys for dotted paths', () => {
    expect(boundApiKeys(spec, ['other'], ['api:GET /feed.xml'])).toEqual(['api:GET /feed.xml'])
    expect(boundApiKeys(spec, ['leads'])).toEqual(['api:GET /leads', 'api:GET /v1.0/stats'])
  })
})

describe('apiKeysToRefresh', () => {
  const now = 1_000_000
  it('fetches missing and aged GET snapshots only', () => {
    const keys = ['api:GET /a', 'api:GET /b', 'api:GET /c', 'api:POST /d']
    expect(
      apiKeysToRefresh(keys, {
        fetchedAt: { 'api:GET /b': now - 1_000, 'api:GET /c': now - API_BINDING_MAX_AGE_MS - 1 },
        inflight: new Set(),
        now
      })
    ).toEqual(['api:GET /a', 'api:GET /c'])
  })

  it('skips keys in flight or that just failed', () => {
    expect(
      apiKeysToRefresh(['api:GET /a', 'api:GET /b', 'api:GET /c'], {
        fetchedAt: {},
        failedAt: { 'api:GET /b': now - 2_000, 'api:GET /c': now - 60_000 },
        inflight: new Set(['api:GET /a']),
        now
      })
    ).toEqual(['api:GET /c'])
  })
})

describe('write invalidation', () => {
  it('reads the resource past any API prefix', () => {
    expect(resourceRoot('/orders/5')).toBe('orders')
    expect(resourceRoot('/api/v1/Orders?page=2')).toBe('orders')
    expect(resourceRoot('https://api.example.com/v2/leads/7')).toBe('leads')
    expect(resourceRoot('/api')).toBeNull()
  })

  it('stales the GET snapshots and [data] sources of the written resource only', () => {
    const keys = ['api:GET /orders', 'api:GET /orders?page=2', 'api:GET /me', 'leads']
    const data = [
      { key: 'orders', path: '/orders?status=open', method: 'GET' },
      { key: 'news', path: 'https://x.test/feed.xml', method: 'FEED' },
      { key: 'me', path: '/me', method: 'GET' }
    ]
    expect(keysStaleAfterWrite('/orders/5', keys, data)).toEqual([
      'api:GET /orders',
      'api:GET /orders?page=2',
      'orders'
    ])
  })

  it('a write with no resource segment stales every read', () => {
    expect(keysStaleAfterWrite('/', ['api:GET /a', 'api:GET /b'])).toEqual([
      'api:GET /a',
      'api:GET /b'
    ])
  })
})
