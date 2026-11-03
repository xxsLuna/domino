import { describe, expect, it } from 'vitest'
import { dominoFingerprint } from './fingerprint'
import { parseDomino } from './parse'
import { stripSection, withScreensSection } from './sections'

const spec = {
  version: 1 as const,
  page: 'main',
  pages: [{ id: 'main', name: 'Main', layout: [] }]
}

const TEMPLATE = [
  '[meta]',
  'name = X',
  '[data]',
  'feed = GET /feed',
  '[actions]',
  'feed-refresh = refresh feed',
  '[screens]',
  '; old export',
  `spec = ${JSON.stringify({ ...spec, page: 'old' })}`,
  '[guide]',
  'The brief. A [screens] mention inside prose stays.',
  '[screens]',
  'graph = []'
].join('\n')

describe('stripSection', () => {
  it('drops only the named section (every copy) and keeps what follows', () => {
    const out = stripSection(TEMPLATE, 'screens')
    expect(out).not.toContain('old export')
    expect(out).not.toContain('graph = []')
    expect(out).toContain('[guide]\nThe brief. A [screens] mention inside prose stays.')
    expect(out).toContain('[actions]\nfeed-refresh = refresh feed')
  })

  it('keeps a [screens] look-alike inside a comment line', () => {
    const out = stripSection('[meta]\nname = X\n; [screens] are below\n[guide]\ntext', 'screens')
    expect(out).toBe('[meta]\nname = X\n; [screens] are below\n[guide]\ntext')
  })
})

describe('withScreensSection', () => {
  it('replaces an earlier embed without losing [guide], [data] or [actions]', () => {
    const graph = [{ from: 'main', to: 'feed', action: 'go', label: 'Go', kind: 'action' }]
    const out = withScreensSection(TEMPLATE, { spec, graph }, ['exported'])
    expect(out.match(/^\[screens\]$/gm)).toHaveLength(1)
    expect(out.endsWith('\n')).toBe(true)
    const res = parseDomino(out)
    expect(res.errors).toEqual([])
    expect(res.domino?.guide).toBe('The brief. A [screens] mention inside prose stays.')
    expect(res.domino?.data.map((d) => d.key)).toEqual(['feed'])
    expect(res.domino?.actions.map((a) => a.id)).toEqual(['feed-refresh'])
    expect(res.domino?.screens?.spec.page).toBe('main')
    expect(res.domino?.screens?.graph).toEqual(graph)
  })

  it('stamps the embed with the definition fingerprint it was built against', () => {
    const out = withScreensSection(TEMPLATE, { spec, def: 'fp123' })
    const res = parseDomino(out)
    expect(res.errors).toEqual([])
    expect(res.domino?.screens?.def).toBe('fp123')
    // The stamp is not part of the definition: the fingerprint is unchanged.
    expect(dominoFingerprint(res.domino!)).toBe(dominoFingerprint(parseDomino(TEMPLATE).domino!))
    // An embed from an older build carries none.
    expect(parseDomino(withScreensSection(TEMPLATE, { spec })).domino?.screens?.def).toBeUndefined()
  })

  it('is idempotent for a file whose embed is already last', () => {
    const once = withScreensSection('[meta]\nname = X\n', { spec })
    expect(withScreensSection(once, { spec })).toBe(once)
  })
})
