import { describe, expect, it } from 'vitest'
import { hashContext } from '../session/session'
import type { UiSpec } from '../spec'
import {
  actionCacheKey,
  clickPregenPrompt,
  editTurnPrompt,
  knownPageIds,
  promptCacheKey,
  turnTransientContext,
  usageStep,
  usageTotal
} from './turn'

const known: UiSpec = {
  version: 1,
  page: 'home',
  nav: [
    { id: 'home', label: 'Home' },
    { id: 'orders', label: 'Orders' },
    { id: 'ghost', label: 'Ghost' }
  ],
  pages: [
    { id: 'home', name: 'Home', layout: [{ name: 'Text', id: 't', props: { text: 'hi' } }] },
    { id: 'order-list', name: 'Orders', layout: [] }
  ]
}

describe('promptCacheKey', () => {
  it('is stable, short and free of the raw id', () => {
    const a = promptCacheKey('CRM|https://api.example.com', 'gpt-5')
    expect(a).toBe(promptCacheKey('CRM|https://api.example.com', 'gpt-5'))
    expect(a).not.toContain('https')
    expect(a.length).toBeLessThan(32)
    expect(promptCacheKey('CRM|https://api.example.com', 'gpt-5-mini')).not.toBe(a)
  })
})

describe('knownPageIds', () => {
  it('lists built pages plus nav ids that resolve to one', () => {
    expect(knownPageIds(known, known.nav!)).toEqual(['home', 'order-list', 'orders'])
    expect(knownPageIds(null, [])).toEqual([])
  })
})

describe('turnTransientContext', () => {
  it('carries live state and the moment list', () => {
    const ctx = turnTransientContext({ tab: 'open' }, [
      { index: 0, kind: 'start', label: 'Home', at: 0 },
      { index: 1, kind: 'nav', label: 'Orders', at: 0 }
    ])
    expect(ctx).toContain('Current screen state')
    expect(ctx).toContain('"tab":"open"')
    expect(ctx).toContain('current = 1')
    expect(ctx).toContain('0) [start] Home')
  })

  it('is empty when there is nothing to add', () => {
    expect(turnTransientContext({}, [{ index: 0, kind: 'start', label: 'Home', at: 0 }])).toBe('')
  })

  it('names the moment on screen as current after a Back, and keeps it in the window', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({
      index: i,
      kind: 'nav' as const,
      label: `P${i}`,
      at: 0,
      current: i === 3
    }))
    const ctx = turnTransientContext({}, entries)
    expect(ctx).toContain('current = 3')
    expect(ctx).toContain('3) [nav] P3')
    expect(ctx).toContain('0) [nav] P0')
    expect(ctx).not.toContain('39) [nav]')
  })
})

describe('editTurnPrompt', () => {
  it('inlines the edited page and names the others', () => {
    const p = editTurnPrompt('home', known)
    expect(p).toContain('Current spec of page "home"')
    expect(p).toContain('"text":"hi"')
    expect(p).toContain('order-list ("Orders")')
  })

  it('falls back to the plain request when the page is unknown', () => {
    expect(editTurnPrompt('nope', known)).not.toContain('Current spec')
    expect(editTurnPrompt('home', null)).toContain('EDIT REQUEST')
  })
})

describe('actionCacheKey', () => {
  it('matches the legacy key for data-free and data events', () => {
    expect(actionCacheKey({ nodeId: 'b', event: 'click' })).toBe(
      hashContext({ id: 'b', ev: 'click', d: undefined })
    )
    expect(actionCacheKey({ nodeId: 'b', event: 'select', data: { id: 1 } })).toBe(
      hashContext({ id: 'b', ev: 'select', d: { id: 1 } })
    )
  })

  it('partitions replayable keys by auth state', () => {
    const e = { nodeId: 'help', event: 'click' }
    expect(actionCacheKey(e, true)).not.toBe(actionCacheKey(e, false))
    expect(actionCacheKey(e, false)).toBe(`${actionCacheKey(e)}::auth:false`)
    expect(actionCacheKey({ ...e, data: {} }, true)).toBe(actionCacheKey(e, true))
  })

  it('treats an empty payload as none (predicted clicks share the slot)', () => {
    expect(actionCacheKey({ nodeId: 'b', event: 'click', data: {} })).toBe(
      actionCacheKey({ nodeId: 'b', event: 'click' })
    )
  })
})

describe('usage accounting', () => {
  it('totals prompt + completion when no total is given', () => {
    expect(usageTotal({ prompt: 10, completion: 5 })).toBe(15)
    expect(usageTotal({ total: 40, prompt: 10 })).toBe(40)
  })

  it('adds only growth of the turn-cumulative total', () => {
    let last = 0
    let sum = 0
    for (const total of [100, 100, 250, 240, 400]) {
      const step = usageStep(last, { total })
      last = step.total
      sum += step.add
    }
    expect(sum).toBe(400)
    expect(last).toBe(400)
    expect(usageStep(50, {})).toEqual({ total: 50, add: 0 })
  })
})

describe('clickPregenPrompt', () => {
  it('carries the ACTION line and the page context', () => {
    const p = clickPregenPrompt(known, { pageId: 'home', nodeId: 'new-order', label: 'New order' })
    expect(p.startsWith('ACTION click from Button/new-order (page "home")')).toBe(true)
    expect(p).toContain('"text":"hi"')
    expect(p).toContain('"New order"')
  })
})
