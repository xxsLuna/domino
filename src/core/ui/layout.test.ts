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
