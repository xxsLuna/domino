import { describe, expect, it } from 'vitest'
import { resolvePageId } from './pageLinks'
import type { NavItem, PageSpec } from './spec'

const page = (id: string, name = id): PageSpec => ({ id, name, layout: [] })
const navItem = (id: string, label: string): NavItem => ({ id, label })

describe('resolvePageId', () => {
  it('resolves the normal contract: nav id equals page id', () => {
    const nav = [navItem('leads', 'Leads')]
    expect(resolvePageId(nav, [page('leads')], 'leads')).toBe('leads')
  })

  it('bridges a nav id that drifted from the real page via its label', () => {
    // model gave the nav item id "stock" while the page it opens is named 재고
    const nav = [navItem('stock', '재고')]
    expect(resolvePageId(nav, [page('inv-1', '재고')], 'stock')).toBe('inv-1')
    // label matching the page id directly works too
    expect(resolvePageId(nav, [page('재고')], 'stock')).toBe('재고')
  })

  it('accepts a target that is a page name rather than an id', () => {
    expect(resolvePageId(undefined, [page('p1', '대시보드')], '대시보드')).toBe('p1')
  })

  it('matches loosely: case, padding and doubled spaces', () => {
    const nav = [navItem('Leads', '  Recent   Leads ')]
    expect(resolvePageId(nav, [page('leads-1', 'Recent Leads')], ' leads ')).toBe('leads-1')
    expect(resolvePageId(nav, [page('leads-1', 'Recent Leads')], 'LEADS')).toBe('leads-1')
  })

  it('returns null when nothing connects the target to a known page', () => {
    const nav = [navItem('reports', 'Reports')]
    expect(resolvePageId(nav, [page('leads')], 'reports')).toBeNull()
    expect(resolvePageId(nav, [page('leads')], 'ghost')).toBeNull()
    expect(resolvePageId(undefined, [page('leads')], '')).toBeNull()
  })
})
