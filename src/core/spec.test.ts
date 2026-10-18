import { describe, expect, it } from 'vitest'
import {
  describeUiSpecProblem,
  isSignOutEvent,
  normalizeGrid,
  tryValidateUiSpec,
  validateUiSpec,
  withKnownPages
} from './spec'

const page = (layout: unknown[]): unknown => ({
  version: 1,
  page: 'p',
  pages: [{ id: 'p', name: 'P', layout }]
})

describe('normalizeGrid', () => {
  it('clamps out-of-range values instead of rejecting them', () => {
    expect(normalizeGrid({ x: 4, y: 0, w: 4, h: 0 })).toEqual({ x: 4, y: 0, w: 4, h: 1 })
    expect(normalizeGrid({ x: 12, y: 1, w: 6, h: 2 })).toEqual({ x: 11, y: 1, w: 1, h: 2 })
    expect(normalizeGrid({ x: 8, y: 1, w: 6, h: 2 })).toEqual({ x: 8, y: 1, w: 4, h: 2 })
  })
  it('coerces numeric strings and floats', () => {
    expect(normalizeGrid({ x: '2', y: '3', w: 7.6, h: '2' })).toEqual({ x: 2, y: 3, w: 8, h: 2 })
  })
  it('fills x and h, but needs y and w to place a node', () => {
    expect(normalizeGrid({ y: 2, w: 6 })).toEqual({ x: 0, y: 2, w: 6, h: 1 })
    expect(normalizeGrid({ x: 0, y: 1 })).toBeUndefined()
    expect(normalizeGrid('full')).toBeUndefined()
  })
})

describe('validateUiSpec (model output)', () => {
  it('accepts h: 0 and other near-misses that used to blank the screen', () => {
    const spec = validateUiSpec(page([{ name: 'Form', id: 'f', grid: { x: 4, y: 0, w: 4, h: 0 } }]))
    expect(spec.pages[0].layout[0].grid).toEqual({ x: 4, y: 0, w: 4, h: 1 })
  })

  it('reads `type`/`component` as the name and folds stray keys into props', () => {
    const spec = validateUiSpec(
      page([
        { type: 'Button', id: 'b', text: 'Save', props: { variant: 'primary' } },
        { component: 'Badge', id: 7, text: 'New' }
      ])
    )
    expect(spec.pages[0].layout[0]).toEqual({
      name: 'Button',
      id: 'b',
      props: { text: 'Save', variant: 'primary' }
    })
    expect(spec.pages[0].layout[1]).toMatchObject({ name: 'Badge', id: '7', props: { text: 'New' } })
  })

  it('keeps a node-level `type` as a prop when the node has a name', () => {
    const spec = validateUiSpec(page([{ name: 'Input', id: 'e', type: 'email', props: { name: 'email' } }]))
    expect(spec.pages[0].layout[0].props).toEqual({ type: 'email', name: 'email' })
  })

  it('drops nodes it cannot understand instead of rejecting the screen', () => {
    const spec = validateUiSpec(
      page([{ name: 'Heading', props: { text: 'Hi' } }, 'oops', { props: {} }, null])
    )
    expect(spec.pages[0].layout.map((n) => n.name)).toEqual(['Heading'])
  })

  it('fills version, page name and layout defaults', () => {
    const spec = validateUiSpec({ page: 'home', pages: [{ id: 'home' }] })
    expect(spec).toMatchObject({ version: 1, page: 'home', pages: [{ id: 'home', name: 'home', layout: [] }] })
  })

  it('keeps nav items that use `page` or lack a label', () => {
    const spec = validateUiSpec({ ...(page([]) as object), nav: [{ page: 'leads' }, { id: 'main', title: 'Home' }] })
    expect(spec.nav).toEqual([
      { id: 'leads', label: 'leads' },
      { id: 'main', label: 'Home' }
    ])
  })

  it('still returns null while nothing coherent has streamed', () => {
    expect(tryValidateUiSpec({ version: 1 })).toBeNull()
    expect(tryValidateUiSpec({ version: 1, page: 'p', pages: [] })).toBeNull()
  })

  it('explains what is still wrong in terms the model can fix', () => {
    expect(describeUiSpecProblem({ version: 1, page: 'p', pages: [] })).toMatch(/^pages: /)
    expect(describeUiSpecProblem(page([]))).toBeNull()
  })
})

describe('withKnownPages', () => {
  const spec = (page: string, ids: string[]) => ({
    version: 1 as const,
    page,
    pages: ids.map((id) => ({ id, name: `${id} v${page}`, layout: [] }))
  })
  it('keeps pages from earlier turns that the new spec does not resend', () => {
    const merged = withKnownPages(spec('leads', ['leads']), spec('main', ['main', 'settings']))
    expect(merged.page).toBe('leads')
    expect(merged.pages.map((p) => p.id)).toEqual(['leads', 'main', 'settings'])
  })
  it('lets a resent page replace its earlier version', () => {
    const merged = withKnownPages(spec('2', ['main']), spec('1', ['main']))
    expect(merged.pages).toEqual([{ id: 'main', name: 'main v2', layout: [] }])
  })
  it('passes the first spec through', () => {
    const first = spec('main', ['main'])
    expect(withKnownPages(first, null)).toBe(first)
  })
})

describe('isSignOutEvent', () => {
  it('recognizes the ids models give sign-out buttons', () => {
    for (const nodeId of ['logout', 'set-logout', 'account-sign-out', 'signout', 'btn_log-out_1'])
      expect(isSignOutEvent({ event: 'click', nodeId }), nodeId).toBe(true)
  })
  it('ignores other buttons and events', () => {
    expect(isSignOutEvent({ event: 'click', nodeId: 'logout-history' })).toBe(false)
    expect(isSignOutEvent({ event: 'click', nodeId: 'catalog' })).toBe(false)
    expect(isSignOutEvent({ event: 'submit', nodeId: 'logout' })).toBe(false)
  })
})
