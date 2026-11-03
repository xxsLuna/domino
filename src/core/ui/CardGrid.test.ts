import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CardGrid, PageSkeleton } from './CardGrid'
import type { CardNode, UiSpec } from '../spec'

const grid = (y: number, w = 12) => ({ x: 0, y, w, h: 1 })

function html(
  layout: CardNode[],
  extra: Partial<UiSpec> = {},
  data?: Record<string, unknown>
): string {
  const spec: UiSpec = { version: 1, page: 'p', pages: [{ id: 'p', name: 'P', layout }], ...extra }
  return renderToStaticMarkup(
    createElement(CardGrid, { page: spec.pages[0], spec, onEvent: () => {}, data })
  )
}

const CHECKED_SWITCH = /<input[^>]*(?:role="switch"[^>]*checked=""|checked=""[^>]*role="switch")/g

describe('CardGrid binding resolution', () => {
  it('never renders raw binding objects, even without state or data', () => {
    const out = html([
      { name: 'Paragraph', id: 'a', grid: grid(0), props: { text: { $state: 'count' } } },
      {
        name: 'StatCard',
        id: 'b',
        grid: grid(1),
        props: { label: 'Leads', value: { $data: 'leads.total' } }
      },
      { name: 'Input', id: 'c', grid: grid(2), props: { label: 'Q', value: { $state: 'q' } } }
    ])
    expect(out).not.toContain('$state')
    expect(out).not.toContain('$data')
  })

  it('substitutes state and data values', () => {
    const out = html(
      [
        { name: 'Paragraph', id: 'a', grid: grid(0), props: { text: { $state: 'count' } } },
        {
          name: 'StatCard',
          id: 'b',
          grid: grid(1),
          props: { label: 'Leads', value: { $data: 'leads.total' } }
        }
      ],
      { state: { count: 'seven' } },
      { leads: { total: 1234 } }
    )
    expect(out).toContain('seven')
    expect(out).toContain('1234')
  })

  it('two switches bound to one key both show its value (controlled)', () => {
    const sw = (id: string, y: number): CardNode => ({
      name: 'Switch',
      id,
      grid: grid(y),
      props: { label: id, name: 'dark', checked: { $state: 'dark' } }
    })
    const on = html([sw('s1', 0), sw('s2', 1)], { state: { dark: true } })
    expect(on.match(CHECKED_SWITCH)?.length).toBe(2)
    const off = html([sw('s1', 0), sw('s2', 1)], { state: { dark: false } })
    expect(off.match(CHECKED_SWITCH)).toBeNull()
  })
})

describe('PageSkeleton', () => {
  it('shows the destination title and placeholders, busy and inert', () => {
    const out = renderToStaticMarkup(
      createElement(PageSkeleton, { title: 'Reports', label: 'Loading' })
    )
    expect(out).toContain('Reports')
    expect(out).toContain('aria-busy="true"')
    expect(out).toContain('inert')
    expect(out).toContain('data-skeleton="true"')
  })

  it('lays a known page out as placeholders without its stale content', () => {
    const page = {
      id: 'lead',
      name: 'Lead',
      layout: [
        { name: 'PageHeader', id: 'h', grid: grid(0), props: { title: 'Old Acme' } },
        { name: 'Paragraph', id: 'p', grid: grid(1), props: { text: 'stale body text' } }
      ]
    }
    const out = renderToStaticMarkup(createElement(PageSkeleton, { page, title: 'Lead detail' }))
    expect(out).toContain('Lead detail')
    expect(out).not.toContain('Old Acme')
    expect(out).not.toContain('stale body text')
  })

  it('without a title, a known page keeps its own header title', () => {
    const page = {
      id: 'leads',
      name: 'Leads',
      layout: [{ name: 'PageHeader', id: 'h', grid: grid(0), props: { title: 'All leads' } }]
    }
    expect(renderToStaticMarkup(createElement(PageSkeleton, { page }))).toContain('All leads')
  })
})
