import { describe, expect, it } from 'vitest'
import type { UiSpec } from '../spec'
import { pendingDestination, shouldIgnorePress, type PressContext } from './interaction'

const idle: PressContext = {
  turnActive: false,
  turnKind: null,
  turnAction: null,
  previewPage: null,
  currentPage: 'home'
}

const running = (over: Partial<PressContext> = {}): PressContext => ({
  turnActive: true,
  turnKind: 'user',
  turnAction: { nodeId: 'save', event: 'submit', pageId: 'home' },
  previewPage: null,
  currentPage: 'home',
  ...over
})

describe('shouldIgnorePress', () => {
  it('lets everything through when no user turn runs', () => {
    expect(shouldIgnorePress({ event: 'submit', nodeId: 'save' }, idle)).toBe(false)
    expect(
      shouldIgnorePress({ event: 'submit', nodeId: 'save' }, running({ turnKind: 'edit' }))
    ).toBe(false)
  })

  it('drops a duplicate submit or click of the running action', () => {
    expect(shouldIgnorePress({ event: 'submit', nodeId: 'save', pageId: 'home' }, running())).toBe(
      true
    )
    const click = running({ turnAction: { nodeId: 'go', event: 'click', pageId: 'home' } })
    expect(shouldIgnorePress({ event: 'click', nodeId: 'go' }, click)).toBe(true)
  })

  it('lets other controls supersede (latest intent wins)', () => {
    expect(shouldIgnorePress({ event: 'click', nodeId: 'cancel', pageId: 'home' }, running())).toBe(
      false
    )
    expect(shouldIgnorePress({ event: 'select', nodeId: 'save' }, running())).toBe(false)
  })

  it('drops presses on a new page that is still streaming in', () => {
    const ctx = running({ turnAction: null, previewPage: 'detail' })
    expect(shouldIgnorePress({ event: 'click', nodeId: 'x', pageId: 'detail' }, ctx)).toBe(true)
    // …but not on the page still settled underneath, nor an in-place update.
    expect(shouldIgnorePress({ event: 'click', nodeId: 'x', pageId: 'home' }, ctx)).toBe(false)
    const inPlace = running({ turnAction: null, previewPage: 'home' })
    expect(shouldIgnorePress({ event: 'click', nodeId: 'x', pageId: 'home' }, inPlace)).toBe(false)
  })
})

describe('pendingDestination', () => {
  const known: UiSpec = {
    version: 1,
    page: 'home',
    nav: [
      { id: 'home', label: 'Home' },
      { id: 'orders', label: 'Orders' }
    ],
    pages: [
      { id: 'home', name: 'Home', layout: [] },
      { id: 'order-list', name: 'Orders', layout: [] }
    ]
  }

  it('names a built page and finds its drifted tab', () => {
    expect(pendingDestination('order-list', { nav: known.nav!, known })).toEqual({
      pageId: 'order-list',
      name: 'Orders',
      navId: 'orders'
    })
  })

  it('uses the plan, then the nav label, then the id', () => {
    const plan = [{ id: 'reports', name: 'Reports', nav: true }]
    expect(pendingDestination('reports', { nav: [], known, plan })).toEqual({
      pageId: 'reports',
      name: 'Reports',
      navId: null
    })
    expect(pendingDestination('team', { nav: [{ id: 'team', label: 'Team' }], known })).toEqual({
      pageId: 'team',
      name: 'Team',
      navId: 'team'
    })
    expect(pendingDestination('x', { nav: [], known: null })).toEqual({
      pageId: 'x',
      name: 'x',
      navId: null
    })
  })
})
