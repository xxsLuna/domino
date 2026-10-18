import { describe, expect, it } from 'vitest'
import type { CardNode, UiSpec } from '../spec'
import { streamView } from './streaming'

const node = (
  id: string,
  y: number,
  props: Record<string, unknown> = {},
  grid = true
): CardNode => ({
  name: 'Card',
  id,
  props,
  ...(grid ? { grid: { x: 0, y, w: 12, h: 1 } } : {})
})
const spec = (page: string, layout: CardNode[]): UiSpec => ({
  version: 1,
  page,
  pages: [{ id: page, name: page, layout }]
})
const ids = (v: ReturnType<typeof streamView>) => v.spec.pages[0].layout.map((n) => n.id)

describe('streamView', () => {
  it('streams a new page from scratch with the last node pending', () => {
    const preview = spec('leads', [node('a', 0), node('b', 1)])
    const v = streamView(spec('main', [node('x', 0)]), preview)
    expect(ids(v)).toEqual(['a', 'b'])
    expect(v.pending?.id).toBe('b')
  })

  it('hides a streaming node until its grid position arrives', () => {
    const preview = spec('leads', [node('a', 0), node('b', 1, {}, false)])
    const v = streamView(null, preview)
    expect(v.hidden?.id).toBe('b')
    expect(v.pending).toBeUndefined()
  })

  it('keeps the current screen during a same-page update', () => {
    const current = spec('leads', [
      node('head', 0),
      node('table', 1, { rows: 8 }),
      node('pages', 2)
    ])
    // Only the header has streamed so far, and the table is mid-way.
    const preview = spec('leads', [
      node('head', 0, { title: 'new' }),
      node('table', 1, { rows: 2 })
    ])
    const v = streamView(current, preview)
    expect(ids(v)).toEqual(['head', 'table', 'pages'])
    const layout = v.spec.pages[0].layout
    expect(layout[0].props).toEqual({ title: 'new' })
    // The half-streamed table keeps showing its complete current version.
    expect(layout[1].props).toEqual({ rows: 8 })
    expect(v.pending).toBeUndefined()
  })

  it('appends new nodes of a same-page update, placeholder for the streaming one', () => {
    const current = spec('leads', [node('head', 0)])
    const preview = spec('leads', [node('head', 0), node('alert', 1), node('table', 2)])
    const v = streamView(current, preview)
    expect(ids(v)).toEqual(['head', 'alert', 'table'])
    expect(v.pending?.id).toBe('table')
  })
})
