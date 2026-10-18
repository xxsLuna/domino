import { describe, expect, it } from 'vitest'
import type { CardNode } from '../spec'
import { breakpointFor, placeNodes } from './layout'

const n = (name: string, id: string, x: number, y: number, w: number, h = 1): CardNode => ({
  name,
  id,
  grid: { x, y, w, h }
})

const dashboard: CardNode[] = [
  n('Heading', 'title', 0, 0, 8),
  n('Button', 'refresh', 10, 0, 2),
  n('StatCard', 's1', 0, 1, 4, 2),
  n('StatCard', 's2', 4, 1, 4, 2),
  n('StatCard', 's3', 8, 1, 4, 2),
  n('Table', 'table', 0, 3, 8, 4),
  n('Card', 'side', 8, 3, 4, 4)
]

const byId = (placed: ReturnType<typeof placeNodes>) =>
  Object.fromEntries(placed.map((p) => [p.node.id, p.placement]))

describe('breakpointFor', () => {
  it('maps container widths to breakpoints', () => {
    expect(breakpointFor(375)).toBe('sm')
    expect(breakpointFor(768)).toBe('md')
    expect(breakpointFor(1280)).toBe('lg')
  })
})

describe('placeNodes', () => {
  it('keeps the desktop layout as written', () => {
    const p = byId(placeNodes(dashboard, 'lg'))
    expect(p.title.column).toBe('1 / span 8')
    expect(p.refresh).toMatchObject({
      column: '11 / span 2',
      justifySelf: 'end',
      alignSelf: 'center'
    })
    expect(p.table).toMatchObject({ column: '1 / span 8', row: 'span 4' })
  })

  it('sorts by row then column regardless of array order', () => {
    const shuffled = [dashboard[6], dashboard[2], dashboard[0], dashboard[1]]
    expect(placeNodes(shuffled, 'lg').map((p) => p.node.id)).toEqual([
      'title',
      'refresh',
      's1',
      'side'
    ])
  })

  it('keeps KPI rows together and stacks wide splits on tablets', () => {
    const p = byId(placeNodes(dashboard, 'md'))
    expect([p.s1.column, p.s2.column, p.s3.column]).toEqual(['span 4', 'span 4', 'span 4'])
    expect(p.table.column).toBe('span 12')
    expect(p.side.column).toBe('span 12')
    expect(p.table.row).toBeUndefined()
  })

  it('goes single column on phones but pairs KPI cards and title + action', () => {
    const p = byId(placeNodes(dashboard, 'sm'))
    expect(p.s1.column).toBe('span 6')
    expect(p.table.column).toBe('span 12')
    expect(p.title.column).toBe('span 7')
    expect(p.refresh).toMatchObject({ column: 'span 5', justifySelf: 'end' })
  })

  it('moves several header actions under the title on phones', () => {
    const nodes = [
      n('Heading', 'h', 0, 0, 6),
      n('Button', 'a', 8, 0, 2),
      n('Button', 'b', 10, 0, 2)
    ]
    const p = byId(placeNodes(nodes, 'sm'))
    expect(p.h.column).toBe('span 12')
    expect(p.a).toMatchObject({ column: 'span 6', fill: true })
  })

  it('centers narrow forms and caps their width by the requested span', () => {
    const login = [n('Heading', 'h', 3, 0, 6), n('Form', 'f', 3, 1, 6, 4)]
    expect(byId(placeNodes(login, 'lg')).f).toMatchObject({ justifySelf: 'center', maxWidth: 600 })
    expect(byId(placeNodes(login, 'md')).f.column).toBe('3 / span 8')
    expect(byId(placeNodes(login, 'sm')).f).toMatchObject({ column: 'span 12', maxWidth: 600 })
    expect(byId(placeNodes([n('Form', 'f', 4, 0, 4)], 'lg')).f.maxWidth).toBe(440)
  })

  it('splits four small cards two-up on tablets', () => {
    const four = [0, 3, 6, 9].map((x, i) => n('Card', `c${i}`, x, 0, 3))
    expect(placeNodes(four, 'md').map((p) => p.placement.column)).toEqual(Array(4).fill('span 6'))
  })

  it('keeps a search + filter row side by side on tablets, stacked on phones', () => {
    const filters = [n('SearchField', 'q', 0, 1, 8), n('Select', 'stage', 8, 1, 4)]
    expect(placeNodes(filters, 'md').map((p) => p.placement.column)).toEqual(['span 8', 'span 4'])
    expect(placeNodes(filters, 'sm').map((p) => p.placement.column)).toEqual(['span 12', 'span 12'])
  })

  describe('main column beside a side column', () => {
    // Shape of a real-model (mimo-v2.6-flash) settings page: forms on the left,
    // cards on the right, the side column running past the main one.
    const settings = [
      n('PageHeader', 'header', 0, 0, 12),
      n('Form', 'profile', 0, 1, 8),
      n('Form', 'notifications', 0, 2, 8),
      n('Card', 'plan', 8, 1, 4, 2),
      n('Card', 'account', 8, 3, 4, 2),
      n('Card', 'danger', 8, 5, 4, 2)
    ]
    const order = (nodes: CardNode[], bp: 'sm' | 'md' | 'lg') =>
      placeNodes(nodes, bp).map((p) => p.node.id)

    it('stacks the whole main column before the side column on phones and tablets', () => {
      const stacked = ['header', 'profile', 'notifications', 'plan', 'account', 'danger']
      expect(order(settings, 'sm')).toEqual(stacked)
      expect(order(settings, 'md')).toEqual(stacked)
      for (const bp of ['sm', 'md'] as const) {
        expect(placeNodes(settings, bp).every((p) => p.placement.column === 'span 12')).toBe(true)
      }
    })

    it('keeps the desktop layout row by row', () => {
      expect(order(settings, 'lg')).toEqual([
        'header',
        'profile',
        'plan',
        'notifications',
        'account',
        'danger'
      ])
      expect(byId(placeNodes(settings, 'lg')).plan).toMatchObject({ column: '9 / span 4', row: 'span 2' })
    })

    it('stacks rows with both columns filled the same way', () => {
      const pairs = [
        n('Form', 'a', 0, 0, 9),
        n('Card', 'b', 9, 0, 3),
        n('Table', 'c', 0, 1, 9),
        n('Card', 'd', 9, 1, 3)
      ]
      expect(order(pairs, 'sm')).toEqual(['a', 'c', 'b', 'd'])
    })

    it("reflows rows inside a column at the column's own scale", () => {
      const nodes = [
        n('Heading', 'title', 0, 0, 6),
        n('Button', 'edit', 6, 0, 2),
        n('StatCard', 'k1', 8, 0, 2),
        n('StatCard', 'k2', 10, 0, 2),
        n('Form', 'form', 0, 1, 8),
        n('Card', 'side', 8, 1, 4)
      ]
      const placed = placeNodes(nodes, 'sm')
      expect(placed.map((p) => p.node.id)).toEqual(['title', 'edit', 'form', 'k1', 'k2', 'side'])
      const p = byId(placed)
      expect(p.title.column).toBe('span 7')
      expect(p.edit).toMatchObject({ column: 'span 5', justifySelf: 'end' })
      expect([p.k1.column, p.k2.column]).toEqual(['span 6', 'span 6'])
    })

    it('does not tear apart card, KPI, filter or title rows above a split', () => {
      const split = [n('Table', 'main', 0, 9, 8), n('Card', 'side', 8, 9, 4), n('Form', 'more', 0, 10, 8)]
      const rows: Record<string, CardNode[]> = {
        cards: [n('Card', 'r1', 0, 0, 4), n('Card', 'r2', 4, 0, 4), n('Card', 'r3', 8, 0, 4)],
        kpis: [n('StatCard', 'r1', 0, 0, 3), n('StatCard', 'r2', 3, 0, 5), n('StatCard', 'r3', 8, 0, 4)],
        filters: [n('SearchField', 'r1', 0, 0, 5), n('Select', 'r2', 5, 0, 3), n('Select', 'r3', 8, 0, 4)],
        title: [n('Heading', 'r1', 0, 0, 7), n('Badge', 'r2', 7, 0, 1), n('Button', 'r3', 10, 0, 2)]
      }
      for (const [kind, row] of Object.entries(rows)) {
        expect(order([...row, ...split], 'sm'), kind).toEqual(['r1', 'r2', 'r3', 'main', 'more', 'side'])
      }
    })

    it('leaves centered stacks and full-width rows alone', () => {
      const centered = [n('Heading', 'h', 3, 0, 6), n('Form', 'f', 3, 1, 6), n('Card', 'c', 0, 2, 12)]
      expect(order(centered, 'sm')).toEqual(['h', 'f', 'c'])
      expect(byId(placeNodes(centered, 'md')).f.column).toBe('3 / span 8')
    })
  })

  it('treats nodes without grid as full-width rows in array order', () => {
    const nodes: CardNode[] = [
      { name: 'Heading', id: 'a' },
      { name: 'Paragraph', id: 'b' }
    ]
    const placed = placeNodes(nodes, 'lg')
    expect(placed.map((p) => p.node.id)).toEqual(['a', 'b'])
    expect(placed[0].placement.column).toBe('1 / span 12')
  })
})
