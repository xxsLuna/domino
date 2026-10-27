import { describe, expect, it } from 'vitest'
import { feedsKey, loadFeeds, normalizeFeedUrl, saveFeeds, MAX_FEEDS, type FeedEntry } from './store'
import type { KeyValueStorage } from '../session/prefs'

function memStorage(initial: Record<string, string> = {}): KeyValueStorage {
  const map = new Map(Object.entries(initial))
  return {
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

describe('normalizeFeedUrl', () => {
  it('accepts https anywhere', () => {
    expect(normalizeFeedUrl('https://example.com/feed.xml')).toBe('https://example.com/feed.xml')
    expect(normalizeFeedUrl('  https://example.com/rss  ')).toBe('https://example.com/rss')
  })

  it('accepts plain http only on this machine (transport contract: loopback http)', () => {
    expect(normalizeFeedUrl('http://127.0.0.1:8787/feed.xml')).toBe('http://127.0.0.1:8787/feed.xml')
    expect(normalizeFeedUrl('http://localhost:5173/feed')).toBe('http://localhost:5173/feed')
    expect(normalizeFeedUrl('http://[::1]:8787/feed.xml')).toBe('http://[::1]:8787/feed.xml')
  })

  it('rejects public http and other protocols', () => {
    expect(normalizeFeedUrl('http://example.com/feed.xml')).toBeNull()
    expect(normalizeFeedUrl('http://192.168.1.5/feed.xml')).toBeNull()
    expect(normalizeFeedUrl('ftp://example.com/feed')).toBeNull()
    expect(normalizeFeedUrl('javascript:alert(1)')).toBeNull()
  })

  it('rejects garbage', () => {
    expect(normalizeFeedUrl('')).toBeNull()
    expect(normalizeFeedUrl('not a url')).toBeNull()
    expect(normalizeFeedUrl('example.com/feed.xml')).toBeNull()
  })
})

describe('feed store round-trip', () => {
  it('persists entries and drops malformed ones on load', async () => {
    const storage = memStorage({
      [feedsKey('app')]: JSON.stringify([
        { url: 'https://a.test/x', title: 'A' },
        { url: 'http://bad', title: 'B' }, // http to public host → dropped
        { title: 'no-url' },
        'junk'
      ])
    })
    const loaded = await loadFeeds(storage, 'app')
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toEqual({ url: 'https://a.test/x', title: 'A' })
  })

  it('caps subscriptions at MAX_FEEDS when loading', async () => {
    const many = Array.from({ length: MAX_FEEDS + 5 }, (_, i) => ({
      url: `https://f${i}.test/rss`,
      title: `f${i}`
    }))
    const storage = memStorage({ [feedsKey('app')]: JSON.stringify(many) })
    const loaded = await loadFeeds(storage, 'app')
    expect(loaded.length).toBeLessThanOrEqual(MAX_FEEDS)
  })

  it('a storage failure on save never rejects', async () => {
    const broken: KeyValueStorage = {
      async get() {
        return null
      },
      async set() {
        throw new Error('quota')
      },
      async remove() {}
    }
    const entries: FeedEntry[] = [{ url: 'https://a.test/x', title: 'A' }]
    await expect(saveFeeds(broken, 'app', entries)).resolves.toBeUndefined()
  })
})
