import { describe, expect, it } from 'vitest'
import type { DominoSource, KeyValueStorage } from './prefs'
import { pushRecent } from './prefs'
import { clearCachedText, getCachedText, putCachedText, sourceKey } from './registry'

function memStorage(): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    async get(k) {
      return map.get(k) ?? null
    },
    async set(k, v) {
      map.set(k, v)
    },
    async remove(k) {
      map.delete(k)
    }
  }
}

const url = (u: string): DominoSource => ({ type: 'url', url: u })
const file = (p: string): DominoSource => ({ type: 'file', path: p })
const text = (t: string): DominoSource => ({ type: 'text', text: t })

describe('sourceKey', () => {
  it('gives each distinct text upload its own key (old code collided on "text")', () => {
    expect(sourceKey(text('a'))).not.toBe(sourceKey(text('b')))
    expect(sourceKey(text('a'))).toBe(sourceKey(text('a')))
  })

  it('separates url and file sources by address', () => {
    expect(sourceKey(url('https://x/a.domino'))).toBe(sourceKey(url('https://x/a.domino')))
    expect(sourceKey(url('https://x/a.domino'))).not.toBe(sourceKey(url('https://x/b.domino')))
    expect(sourceKey(file('/p/a.domino'))).not.toBe(sourceKey(file('/p/b.domino')))
    expect(sourceKey(url('https://x/a.domino'))).not.toBe(sourceKey(file('https://x/a.domino')))
  })
})

describe('text cache', () => {
  it('round-trips cached text per source', async () => {
    const s = memStorage()
    expect(await getCachedText(s, url('https://x/a.domino'))).toBeNull()
    await putCachedText(s, url('https://x/a.domino'), '[meta]\nname = A')
    expect(await getCachedText(s, url('https://x/a.domino'))).toBe('[meta]\nname = A')
    expect(await getCachedText(s, url('https://x/other.domino'))).toBeNull()
  })

  it('never caches text sources (they live in recents already) or inline domino:// payloads', async () => {
    const s = memStorage()
    await putCachedText(s, text('hello'), 'hello')
    await putCachedText(s, url('domino://app?c=AAAA'), 'AAAA')
    expect(s.map.size).toBe(0)
  })

  it('evicts the least recently used entry beyond the cap', async () => {
    const s = memStorage()
    for (let i = 0; i < 12; i++) {
      await putCachedText(s, url(`https://x/${i}.domino`), `body-${i}`)
    }
    expect(await getCachedText(s, url('https://x/0.domino'))).toBeNull()
    expect(await getCachedText(s, url('https://x/1.domino'))).toBeNull()
    expect(await getCachedText(s, url('https://x/2.domino'))).toBe('body-2')
    expect(await getCachedText(s, url('https://x/11.domino'))).toBe('body-11')
  })

  it('reuses one slot when the same source is re-fetched with new text', async () => {
    const s = memStorage()
    await putCachedText(s, url('https://x/a.domino'), 'v1')
    await putCachedText(s, url('https://x/a.domino'), 'v2')
    expect(await getCachedText(s, url('https://x/a.domino'))).toBe('v2')
    // the old blob was removed, not left behind
    expect([...s.map.keys()].filter((k) => k.startsWith('domino:text:')).length).toBe(1)
  })

  it('drops oversized texts instead of blowing the storage budget', async () => {
    const s = memStorage()
    await putCachedText(s, url('https://x/big.domino'), 'x'.repeat(512_001))
    expect(await getCachedText(s, url('https://x/big.domino'))).toBeNull()
    expect(s.map.size).toBe(0)
  })

  it('shares blobs between sources with identical content and keeps them while referenced', async () => {
    const s = memStorage()
    await putCachedText(s, url('https://x/a.domino'), 'same body')
    await putCachedText(s, url('https://x/b.domino'), 'same body')
    expect([...s.map.keys()].filter((k) => k.startsWith('domino:text:')).length).toBe(1)
    await clearCachedText(s, url('https://x/a.domino'))
    // b still needs it
    expect(await getCachedText(s, url('https://x/b.domino'))).toBe('same body')
    await clearCachedText(s, url('https://x/b.domino'))
    expect(await getCachedText(s, url('https://x/b.domino'))).toBeNull()
    // only the (now empty) index may remain — no blobs
    expect([...s.map.keys()].filter((k) => k.startsWith('domino:text:'))).toEqual([])
  })

  it('tolerates a corrupt index by treating the cache as cold', async () => {
    const s = memStorage()
    s.map.set('domino:text-index', '{not json')
    expect(await getCachedText(s, url('https://x/a.domino'))).toBeNull()
    await putCachedText(s, url('https://x/a.domino'), 'body')
    expect(await getCachedText(s, url('https://x/a.domino'))).toBe('body')
  })

  it('ignores malformed index entries', async () => {
    const s = memStorage()
    s.map.set('domino:text-index', JSON.stringify([{ key: 1, hash: null }, null, 'x']))
    expect(await getCachedText(s, url('https://x/a.domino'))).toBeNull()
    await putCachedText(s, url('https://x/a.domino'), 'body')
    expect(await getCachedText(s, url('https://x/a.domino'))).toBe('body')
  })
})

describe('pushRecent identity', () => {
  it('keeps two different text uploads as two recents entries', async () => {
    const s = memStorage()
    await pushRecent(s, { source: text('app one'), name: 'One' })
    const list = await pushRecent(s, { source: text('app two'), name: 'Two' })
    expect(list.map((e) => e.name)).toEqual(['Two', 'One'])
  })

  it('still dedupes the same text content into one slot', async () => {
    const s = memStorage()
    await pushRecent(s, { source: text('same'), name: 'A' })
    const list = await pushRecent(s, { source: text('same'), name: 'B' })
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('B')
  })
})
