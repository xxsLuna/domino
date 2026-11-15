import { describe, expect, it } from 'vitest'
import { parseDomino } from '../domino/parse'
import type { DominoFile } from '../domino/types'
import type { GraphEdge } from '../pageGraph'
import type { CardNode, UiSpec } from '../spec'
import {
  MAX_PREGEN_TARGETS,
  PREGEN_CONCURRENCY,
  mergeBuiltPage,
  mergeKnownPage,
  plannedPages,
  pregenClickTargets,
  pregenPagePrompt,
  pregenTargets
} from './pregen'

const domino = (source: string) => parseDomino(source).domino!

/** A parsed definition with a [pages] plan attached (independent of the parser's support). */
const withPlan = (
  d: DominoFile,
  pages: Array<{ id: string; name: string; purpose?: string; nav: boolean }>
): DominoFile => ({ ...d, pages }) as DominoFile

const spec = (page: string, pages: string[], nav: string[] = []): UiSpec => ({
  version: 1,
  page,
  nav: nav.map((id) => ({ id, label: id })),
  pages: pages.map((id) => ({ id, name: id, layout: [] }))
})

describe('pregenTargets', () => {
  it('takes nav tabs first, then scripted goto/render pages, minus known ones', () => {
    const d = domino(
      '[meta]\nname = X\n[script]\nwhen error == "billing" -> goto upgrade\non logout -> render feedback\n'
    )
    const targets = pregenTargets(d, spec('main', ['main'], ['main', 'leads', 'reports']), true)
    expect(targets).toEqual(['leads', 'reports', 'upgrade', 'feedback'])
  })

  it('caps at MAX_PREGEN_TARGETS (six)', () => {
    const d = domino('[meta]\nname = X\n')
    const targets = pregenTargets(
      d,
      spec('a', ['a'], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']),
      true
    )
    expect(MAX_PREGEN_TARGETS).toBe(6)
    expect(PREGEN_CONCURRENCY).toBe(2)
    expect(targets).toEqual(['b', 'c', 'd', 'e', 'f', 'g'])
  })

  it('dedupes pages that appear in both nav and script', () => {
    const d = domino('[meta]\nname = X\n[script]\nwhen logged_in -> goto settings\n')
    const targets = pregenTargets(d, spec('main', ['main'], ['settings', 'main']), true)
    expect(targets).toEqual(['settings'])
  })

  it('never targets the login page', () => {
    const d = domino('[meta]\nname = X\n[script]\non auth_failed -> goto login\n')
    expect(pregenTargets(d, spec('main', ['main'], ['main']), true)).toEqual([])
  })

  it('builds nothing while signed out of an auth-required app', () => {
    const d = domino(
      '[meta]\nname = X\n[auth]\nrequired = true\nlogin_endpoint = /login\n[script]\nwhen logged_in -> goto main\n'
    )
    expect(pregenTargets(d, spec('login', ['login']), false)).toEqual([])
    expect(pregenTargets(d, spec('login', ['login']), true)).toEqual(['main'])
  })

  it('skips everything when nothing is missing', () => {
    const d = domino('[meta]\nname = X\n')
    expect(pregenTargets(d, spec('a', ['a', 'b'], ['a', 'b']), true)).toEqual([])
  })

  it('takes observed-graph pages after nav and script targets', () => {
    const d = domino('[meta]\nname = X\n[script]\nwhen logged_in -> goto home\n')
    const targets = pregenTargets(
      d,
      spec('main', ['main'], ['main', 'leads']),
      true,
      ['settings', 'main', 'lead-detail']
    )
    // nav first, script next, observed last; known pages and dupes drop out.
    expect(targets).toEqual(['leads', 'home', 'settings', 'lead-detail'])
  })

  it('still caps even with more observed pages', () => {
    const d = domino('[meta]\nname = X\n')
    const many = ['p', 'q', 'r', 's', 't', 'u', 'v', 'w']
    expect(pregenTargets(d, spec('a', ['a'], ['a']), true, many)).toEqual(many.slice(0, 6))
  })

  it('observed pages alone are enough to pre-generate', () => {
    const d = domino('[meta]\nname = X\n')
    expect(pregenTargets(d, spec('a', ['a'], []), true, ['edit-form'])).toEqual(['edit-form'])
  })

  it('skips a nav id that drifted from a page the runtime already has', () => {
    const d = domino('[meta]\nname = X\n')
    // nav item "orders" (label "Orders") — the built page is "order-list" named "Orders".
    const known: UiSpec = {
      version: 1,
      page: 'main',
      nav: [
        { id: 'main', label: 'Home' },
        { id: 'orders', label: 'Orders' }
      ],
      pages: [
        { id: 'main', name: 'Home', layout: [] },
        { id: 'order-list', name: 'Orders', layout: [] }
      ]
    }
    expect(pregenTargets(d, known, true)).toEqual([])
  })

  it('never retries a target already tried this session', () => {
    const d = domino('[meta]\nname = X\n')
    const tried = new Set(['b'])
    expect(pregenTargets(d, spec('a', ['a'], ['a', 'b', 'c']), true, [], tried)).toEqual(['c'])
  })

  it('includes the [pages] plan: nav pages first, then nav/script, then the rest', () => {
    const d = withPlan(domino('[meta]\nname = X\n[script]\nwhen logged_in -> goto upgrade\n'), [
      { id: 'dash', name: 'Dashboard', nav: true },
      { id: 'lead-detail', name: 'Lead', purpose: 'one lead', nav: false },
      { id: 'leads', name: 'Leads', nav: true }
    ])
    const targets = pregenTargets(d, spec('dash', ['dash'], ['dash', 'leads']), true)
    expect(targets).toEqual(['leads', 'upgrade', 'lead-detail'])
  })

  it('maps a drifted nav item onto its planned id instead of building both', () => {
    const d = withPlan(domino('[meta]\nname = X\n'), [
      { id: 'dash', name: 'Dashboard', nav: true },
      { id: 'order-list', name: 'Orders', nav: true }
    ])
    const known: UiSpec = {
      version: 1,
      page: 'dash',
      nav: [
        { id: 'dash', label: 'Dashboard' },
        { id: 'orders', label: 'Orders' }
      ],
      pages: [{ id: 'dash', name: 'Dashboard', layout: [] }]
    }
    expect(pregenTargets(d, known, true)).toEqual(['order-list'])
  })
})

describe('plannedPages / pregenPagePrompt', () => {
  it('reads a missing plan as empty', () => {
    const d = { ...domino('[meta]\nname = X\n') } as Partial<DominoFile>
    delete d.pages
    expect(plannedPages(d as DominoFile)).toEqual([])
  })

  it('puts the planned name and purpose into the build prompt', () => {
    const d = withPlan(domino('[meta]\nname = X\n'), [
      { id: 'leads', name: 'Leads', purpose: 'every open lead with stage', nav: true }
    ])
    const prompt = pregenPagePrompt(d, 'leads')
    expect(prompt).toContain('INITIAL SCREEN. Show the "leads" page')
    expect(prompt).toContain('"Leads" — every open lead with stage')
    expect(pregenPagePrompt(d, 'other')).not.toContain('It is')
  })
})

describe('mergeKnownPage', () => {
  const base = spec('dash', ['dash', 'leads'], ['dash', 'leads'])

  it('inserts the new page and keeps page/nav/other pages untouched', () => {
    const built = spec('reports', ['reports'], ['dash', 'reports'])
    const merged = mergeKnownPage(base, built, 'reports')
    expect(merged.pages.map((p) => p.id)).toEqual(['reports', 'dash', 'leads'])
    expect(merged.page).toBe('dash')
    expect(merged.nav).toEqual(base.nav)
  })

  it('replaces an existing page of the same id', () => {
    const rebuilt = { ...spec('leads', ['leads']), pages: [{ id: 'leads', name: 'v2', layout: [] }] }
    const merged = mergeKnownPage(base, rebuilt, 'leads')
    expect(merged.pages.map((p) => p.id)).toEqual(['leads', 'dash'])
    expect(merged.pages[0].name).toBe('v2')
  })

  it('discards a build that rendered some other page', () => {
    const wrong = spec('other', ['other'])
    expect(mergeKnownPage(base, wrong, 'reports')).toEqual(base)
  })
})

describe('mergeBuiltPage (drift-aware)', () => {
  const base = spec('dash', ['dash', 'leads'], ['dash', 'leads'])

  it('inserts an exact-id build without touching page/nav', () => {
    const merged = mergeBuiltPage(base, spec('reports', ['reports']), 'reports')
    expect(merged?.pageId).toBe('reports')
    expect(merged?.spec.pages.map((p) => p.id)).toEqual(['reports', 'dash', 'leads'])
    expect(merged?.spec.page).toBe('dash')
  })

  it('keeps a drifted build under its own id', () => {
    const built: UiSpec = {
      version: 1,
      page: 'order-list',
      nav: [{ id: 'orders', label: 'Orders' }],
      pages: [{ id: 'order-list', name: 'Orders', layout: [] }]
    }
    const merged = mergeBuiltPage(base, built, 'orders')
    expect(merged?.pageId).toBe('order-list')
    expect(merged?.spec.pages[0].id).toBe('order-list')
  })

  it('never shadows a page the runtime already has', () => {
    expect(mergeBuiltPage(base, spec('leads', ['leads']), 'leads')).toBeNull()
    // A build for "x" that came back as the known "leads" page is discarded too.
    expect(mergeBuiltPage(base, spec('leads', ['leads']), 'x')).toBeNull()
  })
})

describe('pregenClickTargets', () => {
  const d = domino('[meta]\nname = X\n[actions]\nopen-bound = goto settings\n')
  const btn = (id: string, props: Record<string, unknown> = {}): CardNode => ({
    name: 'Button',
    id,
    props: { text: id, ...props }
  })
  const known: UiSpec = {
    version: 1,
    page: 'leads',
    pages: [
      {
        id: 'leads',
        name: 'Leads',
        layout: [
          { name: 'Card', id: 'side', children: [btn('view-report'), btn('delete-all')] },
          {
            name: 'PageHeader',
            id: 'hdr',
            children: [btn('export'), btn('new-lead', { variant: 'primary' })]
          },
          {
            name: 'Form',
            id: 'filter',
            children: [btn('apply-filter')]
          },
          btn('logout'),
          btn('cancel'),
          btn('open-bound'),
          btn('counter', { stateKey: 'n', delta: 1 }),
          btn('docs', { href: 'https://example.com' })
        ]
      },
      { id: 'detail', name: 'Detail', layout: [btn('new-lead'), btn('edit-lead')] }
    ]
  }

  it('lists safe plain buttons, PageHeader first, one per id', () => {
    const out = pregenClickTargets(known, [], d, 10)
    expect(out.map((t) => t.nodeId)).toEqual(['export', 'new-lead', 'view-report', 'edit-lead'])
    expect(out.find((t) => t.nodeId === 'edit-lead')?.pageId).toBe('detail')
  })

  it('skips buttons that already have an observed edge from their page', () => {
    const edges: GraphEdge[] = [
      { from: 'leads', to: 'new', action: 'new-lead', label: 'New', kind: 'action' }
    ]
    const out = pregenClickTargets(known, edges, d, 10)
    // "new-lead" on leads is explored; the detail page's copy is still a candidate.
    expect(out.map((t) => `${t.pageId}/${t.nodeId}`)).toEqual([
      'leads/export',
      'leads/view-report',
      'detail/new-lead',
      'detail/edit-lead'
    ])
  })

  it('respects the limit', () => {
    expect(pregenClickTargets(known, [], d, 2)).toHaveLength(2)
    expect(pregenClickTargets(known, [], d, 0)).toEqual([])
  })

  it('never presses an "add" button in the background, with or without `to`', () => {
    const inventory: UiSpec = {
      version: 1,
      page: 'main',
      pages: [
        {
          id: 'main',
          name: 'Main',
          layout: [
            btn('add-item', { text: '품목 추가', to: 'item_add' }),
            btn('add-to-cart', { text: 'Add to cart' })
          ]
        }
      ]
    }
    expect(pregenClickTargets(inventory, [], d, 10)).toEqual([])
  })
})
