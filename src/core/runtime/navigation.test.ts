import { describe, expect, it } from 'vitest'
import type { GraphEdge } from '../pageGraph'
import { SessionStore } from '../session/session'
import type { UiSpec } from '../spec'
import {
  adoptDeclaredId,
  alignHistoryWithView,
  answerEdge,
  backView,
  keepCanonicalPage,
  cacheableAnswer,
  messagesWrite,
  writerKey,
  dismissesPage,
  namedDestination,
  navWithPlan,
  nodeContext,
  planPress,
  pressDataKey,
  recordPagesFromHistory,
  replayView,
  turnKnownPages,
  mergeEmbeddedEdges,
  type PressInput
} from './navigation'

const known: UiSpec = {
  version: 1,
  page: 'list',
  nav: [
    { id: 'list', label: 'Orders' },
    { id: 'stats', label: 'Stats' }
  ],
  pages: [
    {
      id: 'list',
      name: 'Orders',
      layout: [
        {
          name: 'PageHeader',
          id: 'hdr',
          children: [{ name: 'Button', id: 'go-new', props: { text: 'New order' } }]
        },
        { name: 'Table', id: 'rows', props: { rowAction: true } },
        { name: 'Button', id: 'refresh-list', props: { text: 'Refresh' } },
        { name: 'Button', id: 'next-page', props: { text: 'Next' } },
        { name: 'Button', id: 'stats', props: { text: 'See stats' } },
        { name: 'Button', id: 'cta', props: { text: 'Start' } },
        { name: 'Button', id: 'help', props: { text: 'Help', to: 'help-center' } },
        {
          name: 'Form',
          id: 'filter',
          children: [{ name: 'Button', id: 'apply', props: { text: 'Apply' } }]
        }
      ]
    },
    { id: 'new', name: 'New order', layout: [] },
    {
      id: 'order-detail',
      name: 'Order',
      layout: [{ name: 'Button', id: 'edit-order', props: { text: 'Edit' } }]
    },
    { id: 'stats', name: 'Stats', layout: [] }
  ]
}

const base = (over: Partial<PressInput> = {}): PressInput => ({
  e: { event: 'click', nodeId: 'go-new' },
  pageId: 'list',
  spec: known,
  known,
  nav: known.nav ?? [],
  plan: [],
  edges: [],
  recordPages: new Map(),
  ...over
})

describe('nodeContext', () => {
  it('finds nested nodes and knows when they sit in a Form', () => {
    expect(nodeContext(known, 'go-new')).toMatchObject({ node: { id: 'go-new' }, inForm: false })
    expect(nodeContext(known, 'apply')).toMatchObject({ node: { id: 'apply' }, inForm: true })
    expect(nodeContext(known, 'nope')).toEqual({ node: null, inForm: false })
    expect(nodeContext(null, 'go-new')).toEqual({ node: null, inForm: false })
  })
})

describe('answerEdge learning', () => {
  const press = {
    from: 'main',
    action: 'add-item',
    label: '품목 추가',
    event: 'click',
    learn: 'item_add'
  }
  it('marks a pure switch to the learnable page, and nothing else', () => {
    expect(answerEdge(press, 'item_add', false, true)).toMatchObject({ reused: true })
    expect(answerEdge(press, 'item_add', false, false)).not.toHaveProperty('reused')
    expect(answerEdge(press, 'stores', false, true)).not.toHaveProperty('reused')
    expect(answerEdge(press, 'item_add', true, true)).toMatchObject({ kind: 'form' })
    expect(answerEdge({ ...press, learn: undefined }, 'item_add', false, true)).not.toHaveProperty(
      'reused'
    )
  })
})

describe('messagesWrite', () => {
  const call = (args: string) => ({
    role: 'assistant' as const,
    content: '',
    toolCalls: [{ id: 'c1', name: 'call_api', args }]
  })
  it('spots any non-GET call_api a turn sent, readable or not', () => {
    expect(messagesWrite([call('{"path":"/x","method":"POST"}')])).toBe(true)
    expect(messagesWrite([call('{"path":"/x","method":"delete"}')])).toBe(true)
    expect(messagesWrite([call('{"path":"/x"')])).toBe(true)
    expect(messagesWrite([call('{"path":"/x"}')])).toBe(false)
    expect(messagesWrite([call('{"path":"/x","method":"GET"}')])).toBe(false)
    expect(
      messagesWrite([
        { role: 'assistant', content: '', toolCalls: [{ id: 'n', name: 'navigate', args: '{}' }] }
      ])
    ).toBe(false)
    expect(messagesWrite([{ role: 'user', content: 'hi' }])).toBe(false)
  })
})

describe('answerEdge', () => {
  const press = { from: 'list', action: 'go-new', label: 'New', event: 'click' }
  it('records no edge for an answer that stayed on its page', () => {
    expect(answerEdge(press, 'list', false)).toBeNull()
  })
  it('plain read-only opens are links, data and writes are data actions', () => {
    expect(answerEdge(press, 'new', false)?.kind).toBe('action')
    expect(answerEdge(press, 'new', true)?.kind).toBe('form')
    expect(
      answerEdge({ ...press, event: 'select', dataKey: 'k' }, 'order-detail', false)?.kind
    ).toBe('form')
    expect(answerEdge({ ...press, event: 'submit' }, 'list2', false)?.kind).toBe('form')
  })
})

describe('cacheableAnswer', () => {
  it('caches only replayable, read-only answers that left the page', () => {
    expect(cacheableAnswer({ replayable: true, mutated: false, from: 'a', landed: 'b' })).toBe(true)
    expect(cacheableAnswer({ replayable: true, mutated: false, from: 'a', landed: 'a' })).toBe(
      false
    )
    expect(cacheableAnswer({ replayable: true, mutated: true, from: 'a', landed: 'b' })).toBe(false)
    expect(cacheableAnswer({ replayable: false, mutated: false, from: 'a', landed: 'b' })).toBe(
      false
    )
    expect(cacheableAnswer({ replayable: true, mutated: false, landed: 'a' })).toBe(true)
  })
})

describe('pressDataKey', () => {
  it('identifies data-carrying presses only', () => {
    expect(pressDataKey({ event: 'click' })).toBeUndefined()
    expect(pressDataKey({ event: 'click', data: {} })).toBeUndefined()
    expect(pressDataKey({ event: 'navigate', data: { page: 'x' } })).toBeUndefined()
    const a = pressDataKey({ event: 'select', data: { id: 1 } })
    expect(a).toBeTypeOf('string')
    expect(pressDataKey({ event: 'select', data: { id: 2 } })).not.toBe(a)
  })
})

describe('namedDestination', () => {
  const ctx = { known, nav: known.nav ?? [], plan: [], currentPage: 'list' }
  const node = (id: string, props: Record<string, unknown> = {}) => ({ name: 'Button', id, props })
  it('reads an explicit to, a decorated page id, or an exact page name', () => {
    expect(namedDestination(node('x', { to: 'stats' }), ctx)).toEqual({
      pageId: 'stats',
      built: true
    })
    expect(namedDestination(node('x', { to: '#stats' }), ctx)).toEqual({
      pageId: 'stats',
      built: true
    })
    expect(namedDestination(node('go-stats'), ctx)).toEqual({ pageId: 'stats', built: true })
    expect(namedDestination(node('x', { text: 'stats' }), ctx)).toEqual({
      pageId: 'stats',
      built: true
    })
  })
  it('falls back to the plan, and trusts an explicit to even when nothing matches', () => {
    const plan = [{ id: 'settings', name: 'Settings', nav: true }]
    expect(namedDestination(node('open-settings'), { ...ctx, plan })).toEqual({
      pageId: 'settings',
      built: false
    })
    expect(namedDestination(node('x', { to: 'help-center' }), ctx)).toEqual({
      pageId: 'help-center',
      built: false
    })
  })
  it('never matches fuzzily, mutating controls, the current page or other widgets', () => {
    expect(namedDestination(node('x', { text: 'View all orders' }), ctx)).toBeNull()
    expect(namedDestination(node('delete-stats'), ctx)).toBeNull()
    expect(namedDestination(node('list'), ctx)).toBeNull()
    expect(namedDestination({ name: 'Card', id: 'stats' }, ctx)).toBeNull()
  })
})

describe('planPress', () => {
  it('auto-links a plain click along an observed edge to a built page', () => {
    const edges: GraphEdge[] = [
      { from: 'list', to: 'new', action: 'go-new', label: 'New', kind: 'action' }
    ]
    const plan = planPress(base({ edges }))
    expect(plan.switchTo).toBe('new')
    expect(plan.replayable).toBe(true)
    expect(plan.recordDependent).toBe(false)
  })

  it('never follows a self-loop or a data-action edge', () => {
    const edges: GraphEdge[] = [
      { from: 'list', to: 'list', action: 'next-page', label: 'Next', kind: 'action' },
      { from: 'list', to: 'new', action: 'cta', label: 'Start', kind: 'form' }
    ]
    expect(
      planPress(base({ e: { event: 'click', nodeId: 'next-page' }, edges })).switchTo
    ).toBeNull()
    const p = planPress(base({ e: { event: 'click', nodeId: 'cta' }, edges }))
    expect(p.switchTo).toBeNull()
    expect(p.guidedTo).toBe('new')
  })

  it('switches on the first press when the button names a built page', () => {
    const p = planPress(base({ e: { event: 'click', nodeId: 'stats' } }))
    expect(p.switchTo).toBe('stats')
  })

  it('guides (but does not switch) toward a named page that is not built', () => {
    const p = planPress(base({ e: { event: 'click', nodeId: 'help' } }))
    expect(p.switchTo).toBeNull()
    expect(p.guidedTo).toBe('help-center')
  })

  it('a mutating control is neither linked nor replayed', () => {
    const edges: GraphEdge[] = [
      { from: 'list', to: 'stats', action: 'refresh-list', label: 'Refresh', kind: 'action' }
    ]
    const p = planPress(base({ e: { event: 'click', nodeId: 'refresh-list' }, edges }))
    expect(p.switchTo).toBeNull()
    expect(p.replayable).toBe(false)
  })

  it('submits, searches and form presses are never replayable and are record-dependent', () => {
    const submit = planPress(base({ e: { event: 'submit', nodeId: 'filter', data: { q: 'x' } } }))
    expect(submit.replayable).toBe(false)
    expect(submit.recordDependent).toBe(true)
    expect(planPress(base({ e: { event: 'click', nodeId: 'apply' } })).replayable).toBe(false)
  })

  it('a row select replays per record, carries its identity and never auto-links', () => {
    const edges: GraphEdge[] = [
      { from: 'list', to: 'order-detail', action: 'rows', label: 'Row', kind: 'form' }
    ]
    const p = planPress(base({ e: { event: 'select', nodeId: 'rows', data: { id: 7 } }, edges }))
    expect(p.replayable).toBe(true)
    expect(p.recordDependent).toBe(true)
    expect(p.answer.dataKey).toBeTypeOf('string')
    expect(p.switchTo).toBeNull()
    expect(p.guidedTo).toBe('order-detail')
  })

  it('a plain click on a record page is tied to that record', () => {
    const recordPages = new Map([['order-detail', 'rec-7']])
    const spec = { ...known, page: 'order-detail' }
    const edges: GraphEdge[] = [
      { from: 'order-detail', to: 'new', action: 'edit-order', label: 'Edit', kind: 'action' }
    ]
    const p = planPress(
      base({
        e: { event: 'click', nodeId: 'edit-order' },
        pageId: 'order-detail',
        spec,
        edges,
        recordPages
      })
    )
    expect(p.switchTo).toBeNull()
    expect(p.replayable).toBe(false)
    expect(p.recordDependent).toBe(true)
    expect(p.answer.dataKey).toBeTypeOf('string')
  })

  it('never auto-links into a page whose canonical copy shows one record', () => {
    const edges: GraphEdge[] = [
      { from: 'list', to: 'order-detail', action: 'cta', label: 'Start', kind: 'action' }
    ]
    const recordPages = new Map([['order-detail', 'rec-1']])
    expect(
      planPress(base({ e: { event: 'click', nodeId: 'cta' }, edges, recordPages })).switchTo
    ).toBeNull()
  })

  describe('an "add" button that opens an entry form', () => {
    // The shape a real build produced: the sidebar's "추가" and the header's
    // "품목 추가" both open item_add, and only the form's Save writes.
    const inventory: UiSpec = {
      version: 1,
      page: 'main',
      nav: [
        { id: 'main', label: '재고' },
        { id: 'item_add', label: '추가' }
      ],
      pages: [
        {
          id: 'main',
          name: '재고 홈',
          layout: [
            {
              name: 'PageHeader',
              id: 'main-header',
              children: [
                { name: 'Button', id: 'add-item', props: { text: '품목 추가', to: 'item_add' } },
                { name: 'Button', id: 'add-quick', props: { text: '빠른 추가' } }
              ]
            }
          ]
        },
        {
          id: 'item_add',
          name: '생필품 추가',
          layout: [
            {
              name: 'Form',
              id: 'item-add-form',
              children: [{ name: 'Button', id: 'save', props: { text: '저장' } }]
            }
          ]
        }
      ]
    }
    const press = (nodeId: string, edges: GraphEdge[] = [], over: Partial<PressInput> = {}) =>
      planPress(
        base({
          e: { event: 'click', nodeId },
          pageId: 'main',
          spec: inventory,
          known: inventory,
          nav: inventory.nav ?? [],
          edges,
          ...over
        })
      )
    const landed = (action: string, extra: Partial<GraphEdge> = {}): GraphEdge => ({
      from: 'main',
      to: 'item_add',
      action,
      label: action,
      kind: 'action',
      ...extra
    })

    it('first press: a model turn told to reuse the built form, never to rebuild it', () => {
      const p = press('add-item')
      expect(p.switchTo).toBeNull()
      expect(p.replayable).toBe(false)
      expect(p.reuse).toBe('item_add')
      expect(p.guidedTo).toBe('item_add')
    })

    it('every later press is still a turn: an earlier landing only steers it to reuse', () => {
      const p = press('add-item', [landed('add-item')])
      expect(p.switchTo).toBeNull()
      expect(p.reuse).toBe('item_add')
      // Without `to`, the landing alone names the page to reuse.
      expect(press('add-quick', [landed('add-quick')]).reuse).toBe('item_add')
      expect(press('add-quick').reuse).toBeNull()
    })

    it('never sends a control that always acts to the reuse prompt', () => {
      const shop: UiSpec = {
        ...inventory,
        pages: [
          {
            id: 'main',
            name: '재고 홈',
            layout: [
              { name: 'Button', id: 'pay', props: { text: '결제', to: 'item_add' } },
              {
                name: 'Button',
                id: 'wipe',
                props: { text: 'Add', to: 'item_add', variant: 'danger' }
              }
            ]
          },
          inventory.pages[1]
        ]
      }
      const at = (nodeId: string) =>
        press(nodeId, [landed(nodeId)], { spec: shop, known: shop }).reuse
      expect(at('pay')).toBeNull()
      expect(at('wipe')).toBeNull()
    })

    it('after a write, the turn re-renders: no switch and no reuse', () => {
      const p = press('add-item', [landed('add-item', { kind: 'form' })])
      expect(p.switchTo).toBeNull()
      expect(p.reuse).toBeNull()
      expect(p.guidedTo).toBe('item_add')
    })

    it("a nav edge sharing the id does not hide the press's own answer", () => {
      const nav: GraphEdge = { ...landed('add-item'), kind: 'nav' }
      expect(press('add-item', [landed('add-item', { kind: 'form' }), nav]).reuse).toBeNull()
    })

    it('never reuses or switches into a record page', () => {
      const recordPages = new Map([['item_add', 'rec-1']])
      const p = press('add-item', [landed('add-item')], { recordPages })
      expect(p.switchTo).toBeNull()
      expect(p.reuse).toBeNull()
    })

    describe('learning the link', () => {
      const learned = landed('add-item', { reused: true })

      it('the first press may be learned: its `to` names the built form', () => {
        const p = press('add-item')
        expect(p.answer.learn).toBe('item_add')
        expect(p.answer.writes).toBeUndefined()
        // Without `to` there is nothing to learn.
        expect(press('add-quick', [landed('add-quick')]).answer.learn).toBeUndefined()
      })

      it('a learned link switches instantly and stays learned', () => {
        const p = press('add-item', [learned])
        expect(p.switchTo).toBe('item_add')
        expect(p.confirmed).toBe(true)
        expect(answerEdge(p.answer, 'item_add', false, p.confirmed)).toMatchObject({
          kind: 'action',
          reused: true
        })
      })

      it('an edit that drops or changes the `to` drops the link', () => {
        const withProps = (props: Record<string, unknown>): UiSpec => ({
          ...inventory,
          pages: [
            {
              ...inventory.pages[0],
              layout: [{ name: 'Button', id: 'add-item', props: { text: '품목 추가', ...props } }]
            },
            inventory.pages[1],
            { id: 'item_wizard', name: 'Wizard', layout: [] }
          ]
        })
        for (const spec of [withProps({}), withProps({ to: 'item_wizard' })]) {
          const p = press('add-item', [learned], { spec, known: spec })
          expect(p.switchTo).toBeNull()
          expect(p.confirmed).toBe(false)
        }
      })

      it('a press seen writing is never learned, but keeps the reuse prompt', () => {
        const p = press('add-item', [landed('add-item', { kind: 'form' })])
        expect(p.answer.writes).toBe(true)
        expect(p.answer.learn).toBeUndefined()
        // Its next write-free answer is a plain link again, never a learned one…
        const next = answerEdge(p.answer, 'item_add', false, true)
        expect(next).toMatchObject({ kind: 'action' })
        expect(next).not.toHaveProperty('reused')
        // …so the press after it is steered to reuse the built page.
        expect(press('add-item', [next!], { writers: new Set(['add-item']) }).reuse).toBe(
          'item_add'
        )
      })

      it('an action ever seen sending a write, on any page, is never learned or followed', () => {
        // Marks are kept per action id: one action keeps one id on every page.
        const writers = new Set([writerKey({ action: 'add-item' })])
        const p = press('add-item', [learned], { writers })
        expect(p.answer.writes).toBe(true)
        expect(p.answer.learn).toBeUndefined()
        expect(p.switchTo).toBeNull()
        expect(p.reuse).toBe('item_add')
        // Other actions are unaffected.
        expect(press('add-item', [], { writers: new Set(['other']) }).answer.learn).toBe('item_add')
      })

      it('marks openers as such, and only openers', () => {
        expect(press('add-item').answer.opener).toBe(true)
        const plainSpec: UiSpec = {
          ...inventory,
          pages: [
            {
              ...inventory.pages[0],
              layout: [{ name: 'Button', id: 'go', props: { text: 'Go', to: 'stores' } }]
            },
            inventory.pages[1]
          ]
        }
        expect(press('go', [], { spec: plainSpec, known: plainSpec }).answer.opener).toBeUndefined()
      })

      it('never learned on a record page, nor toward one', () => {
        const recordPages = new Map([['main', 'rec-1']])
        expect(press('add-item', [], { recordPages }).answer.learn).toBeUndefined()
        const toRecord = new Map([['item_add', 'rec-1']])
        expect(press('add-item', [], { recordPages: toRecord }).answer.learn).toBeUndefined()
      })
    })

    it('before the page is built, the first build is guided to the declared id', () => {
      const unbuilt: UiSpec = { ...inventory, pages: inventory.pages.slice(0, 1) }
      const p = press('add-item', [], { spec: unbuilt, known: unbuilt, nav: [] })
      expect(p.switchTo).toBeNull()
      expect(p.reuse).toBeNull()
      expect(p.guidedTo).toBe('item_add')
    })

    it('resolves the declared page like any page reference (plan name, nav id)', () => {
      const unbuilt: UiSpec = { ...inventory, pages: inventory.pages.slice(0, 1) }
      const plan = [{ id: 'item_new', name: '생필품 추가', nav: false }]
      const named = { name: 'Button', id: 'add-x', props: { text: '추가', to: '생필품 추가' } }
      const spec: UiSpec = {
        ...unbuilt,
        pages: [{ ...unbuilt.pages[0], layout: [named] }]
      }
      const p = press('add-x', [], { spec, known: spec, nav: [], plan })
      expect(p.guidedTo).toBe('item_new')
      // A nav id whose page carries another id resolves to the built page.
      const aliased: UiSpec = {
        ...inventory,
        nav: [{ id: 'add', label: '생필품 추가' }],
        pages: [
          { ...inventory.pages[0], layout: [{ ...named, props: { text: '추가', to: 'add' } }] },
          inventory.pages[1]
        ]
      }
      const q = press('add-x', [], { spec: aliased, known: aliased, nav: aliased.nav })
      expect(q.reuse).toBe('item_add')
    })

    it('a `to` on a control that is not an opener steers nothing new', () => {
      const shop: UiSpec = {
        ...inventory,
        pages: [
          {
            id: 'main',
            name: '재고 홈',
            layout: [
              { name: 'Button', id: 'save-x', props: { text: '저장', to: 'item_add' } },
              {
                name: 'Form',
                id: 'f',
                children: [
                  { name: 'Button', id: 'back-list', props: { text: '목록', to: 'item_add' } }
                ]
              }
            ]
          },
          inventory.pages[1]
        ]
      }
      for (const id of ['save-x', 'back-list']) {
        const p = press(id, [], { spec: shop, known: shop })
        expect(p.guidedTo, id).toBeNull()
        expect(p.reuse, id).toBeNull()
      }
    })
  })

  it('labels the answer with the node text and keeps navigate targets as guidance', () => {
    expect(planPress(base()).answer).toMatchObject({
      from: 'list',
      action: 'go-new',
      label: 'New order'
    })
    const nav = planPress(
      base({ e: { event: 'navigate', nodeId: 'x', data: { page: 'reports' } } })
    )
    expect(nav.guidedTo).toBe('reports')
    expect(nav.replayable).toBe(true)
  })
})

describe('turnKnownPages', () => {
  it('offers every page to plain presses, only record-independent tabs to record presses', () => {
    const all = turnKnownPages(known, known.nav ?? [], new Map(), false)
    expect(all).toEqual(expect.arrayContaining(['list', 'new', 'order-detail', 'stats']))
    const some = turnKnownPages(known, known.nav ?? [], new Map([['stats', 'r']]), true)
    expect(some).toEqual(['list'])
    const plain = turnKnownPages(known, known.nav ?? [], new Map([['order-detail', 'r']]), false)
    expect(plain).not.toContain('order-detail')
    expect(plain).toContain('new')
  })
})

describe('replayView', () => {
  const edited: UiSpec = {
    ...known,
    pages: known.pages.map((p) => (p.id === 'new' ? { ...p, name: 'New order (edited)' } : p))
  }
  const hit: UiSpec = { ...known, page: 'new' }
  it('a plain replay shows the canonical (edited) copy', () => {
    const v = replayView(hit, edited, true)
    expect(v.page).toBe('new')
    expect(v.pages.find((p) => p.id === 'new')?.name).toBe('New order (edited)')
  })
  it('a data replay shows its own copy of the target only', () => {
    const v = replayView(hit, edited, false)
    expect(v.pages.find((p) => p.id === 'new')?.name).toBe('New order')
  })
})

describe('backView', () => {
  const detailA: UiSpec = {
    ...known,
    page: 'order-detail',
    pages: known.pages.map((p) => (p.id === 'order-detail' ? { ...p, name: 'Order A' } : p))
  }
  const now: UiSpec = {
    ...known,
    pages: known.pages.map((p) => (p.id === 'order-detail' ? { ...p, name: 'Order B' } : p))
  }
  it('shows the canonical copy of plain pages', () => {
    const v = backView({ spec: { ...detailA, page: 'list' } }, now, new Map())
    expect(v.usedSnapshotCopy).toBe(false)
    expect(v.spec.page).toBe('list')
  })
  it('a record page comes back as the record that moment showed', () => {
    const v = backView(
      { spec: detailA, dataKey: 'A', recordLanding: true },
      now,
      new Map([['order-detail', 'B']])
    )
    expect(v.usedSnapshotCopy).toBe(true)
    expect(v.spec.pages.find((p) => p.id === 'order-detail')?.name).toBe('Order A')
    const same = backView(
      { spec: detailA, dataKey: 'B', recordLanding: true },
      now,
      new Map([['order-detail', 'B']])
    )
    expect(same.spec.pages.find((p) => p.id === 'order-detail')?.name).toBe('Order B')
  })
  it('an in-place data moment (search on a list) comes back as the canonical page', () => {
    const v = backView({ spec: detailA, dataKey: 'q=a' }, now, new Map([['order-detail', 'B']]))
    expect(v.usedSnapshotCopy).toBe(false)
    expect(v.spec.pages.find((p) => p.id === 'order-detail')?.name).toBe('Order B')
  })
  it('falls back to the snapshot copy for a page the canonical set lacks', () => {
    const lacking: UiSpec = { ...now, pages: now.pages.filter((p) => p.id !== 'order-detail') }
    const v = backView({ spec: detailA }, lacking, new Map())
    expect(v.spec.pages.find((p) => p.id === 'order-detail')?.name).toBe('Order A')
  })
})

describe('recordPagesFromHistory', () => {
  it('replays record identities in stack order', () => {
    const map = recordPagesFromHistory([
      { pageId: 'detail', kind: 'action', dataKey: 'A', recordLanding: true },
      { pageId: 'list', kind: 'nav' },
      { pageId: 'detail', kind: 'nav' },
      { pageId: 'other', kind: 'action', dataKey: 'B', recordLanding: true },
      { pageId: 'other', kind: 'action' }
    ])
    expect([...map]).toEqual([['detail', 'A']])
  })

  it('an in-place data press never marks its page, and tabs are never record pages', () => {
    const map = recordPagesFromHistory(
      [
        { pageId: 'orders', kind: 'action', dataKey: 'q=search' },
        { pageId: 'leads', kind: 'action', dataKey: 'form', recordLanding: true }
      ],
      (id) => id === 'leads'
    )
    expect([...map]).toEqual([])
  })
})

describe('dismissesPage', () => {
  it('back always dismisses; cancel only on a page with a form', () => {
    expect(dismissesPage({ event: 'click', nodeId: 'go-back' }, known)).toBe(true)
    expect(dismissesPage({ event: 'click', nodeId: 'form-cancel' }, known)).toBe(true)
    const detail = { ...known, page: 'order-detail' }
    expect(dismissesPage({ event: 'click', nodeId: 'order-cancel' }, detail)).toBe(false)
    expect(dismissesPage({ event: 'click', nodeId: 'go-new' }, known)).toBe(false)
    expect(dismissesPage({ event: 'submit', nodeId: 'cancel' }, known)).toBe(false)
  })
})

describe('alignHistoryWithView', () => {
  const s = (page: string): UiSpec => ({
    version: 1,
    page,
    pages: [{ id: page, name: page, layout: [] }]
  })
  it('leaves a matching stack, jumps to the newest matching moment, or pushes one', () => {
    const session = new SessionStore()
    session.push(s('a'))
    session.push(s('b'))
    expect(alignHistoryWithView(session, { page: 'b', known: s('b') })).toBe('aligned')
    expect(alignHistoryWithView(session, { page: 'a', known: s('a') })).toBe('jumped')
    expect(session.current?.spec.page).toBe('a')
    expect(alignHistoryWithView(session, { page: 'c', known: s('c') })).toBe('pushed')
    expect(session.current?.spec.page).toBe('c')
    expect(session.entries().at(-1)?.kind).toBe('restore')
  })
})

describe('navWithPlan', () => {
  const plan = [
    { id: 'home', name: 'Home', nav: true },
    { id: 'orders', name: 'Orders', nav: true },
    { id: 'order-detail', name: 'Order', nav: false }
  ]
  it('builds a tab bar from the plan when the screen has none', () => {
    expect(navWithPlan([], plan)).toEqual([
      { id: 'home', label: 'Home' },
      { id: 'orders', label: 'Orders' }
    ])
  })
  it('appends only planned tabs the nav does not already cover (by id or label)', () => {
    expect(navWithPlan([{ id: 'main', label: 'Home' }], plan)).toEqual([
      { id: 'main', label: 'Home' },
      { id: 'orders', label: 'Orders' }
    ])
    const full = [
      { id: 'home', label: 'Start' },
      { id: 'x', label: 'Orders' }
    ]
    expect(navWithPlan(full, plan)).toEqual(full)
    expect(navWithPlan(full, [])).toEqual(full)
  })
})

describe('adoptDeclaredId', () => {
  const spec = (page: string, ids: string[], nav?: string[]): UiSpec => ({
    version: 1,
    page,
    ...(nav ? { nav: nav.map((id) => ({ id, label: id })) } : {}),
    pages: ids.map((id) => ({ id, name: id, layout: [] }))
  })

  it('renames a new landing page (and its tab) to the declared id', () => {
    const out = adoptDeclaredId(
      spec('new-note-page', ['home', 'new-note-page'], ['home', 'new-note-page']),
      'note-new',
      spec('home', ['home']),
      'home'
    )
    expect(out.page).toBe('note-new')
    expect(out.pages.map((p) => p.id)).toEqual(['home', 'note-new'])
    expect(out.nav?.map((i) => i.id)).toEqual(['home', 'note-new'])
  })

  it('keeps in-place answers, existing pages and specs that already hold the id', () => {
    const before = spec('home', ['home', 'list'])
    const inPlace = spec('home', ['home'])
    expect(adoptDeclaredId(inPlace, 'note-new', before, 'home')).toBe(inPlace)
    const existing = spec('list', ['home', 'list'])
    expect(adoptDeclaredId(existing, 'note-new', before, 'home')).toBe(existing)
    const holds = spec('other', ['other', 'note-new'])
    expect(adoptDeclaredId(holds, 'note-new', before, 'home')).toBe(holds)
    const exact = spec('note-new', ['note-new'])
    expect(adoptDeclaredId(exact, 'note-new', before, 'home')).toBe(exact)
  })
})

describe('mergeEmbeddedEdges', () => {
  it('adds embedded answers only where the local graph has none', () => {
    const local: GraphEdge[] = [
      { from: 'home', to: 'list', action: 'open', label: 'Open', kind: 'action' }
    ]
    const embedded: GraphEdge[] = [
      { from: 'home', to: 'other', action: 'open', label: 'Open', kind: 'action' },
      { from: 'home', to: 'detail', action: 'row', label: 'Row', kind: 'form' },
      { from: 'home', to: 'home', action: 'refresh', label: 'Refresh', kind: 'action' }
    ]
    const out = mergeEmbeddedEdges(local, embedded)
    expect(out).toEqual([local[0], embedded[1]])
  })

  it("never imports a learned link: it was learned in someone else's state", () => {
    const embedded: GraphEdge[] = [
      { from: 'g', to: 'chat', action: 'join', label: '참여', kind: 'action', reused: true }
    ]
    const [edge] = mergeEmbeddedEdges([], embedded)
    expect(edge).toEqual({ from: 'g', to: 'chat', action: 'join', label: '참여', kind: 'action' })
  })
})

describe('keepCanonicalPage', () => {
  it('a record moment shown on Back never replaces the edited canonical copy', () => {
    const edited: UiSpec = {
      ...known,
      pages: known.pages.map((p) => (p.id === 'order-detail' ? { ...p, name: 'Edited' } : p))
    }
    const shown: UiSpec = {
      ...known,
      page: 'order-detail',
      pages: known.pages.map((p) => (p.id === 'order-detail' ? { ...p, name: 'Old A' } : p))
    }
    const kept = keepCanonicalPage(shown, edited, 'order-detail')
    expect(kept.pages.find((p) => p.id === 'order-detail')?.name).toBe('Edited')
    expect(keepCanonicalPage(shown, edited, undefined)).toBe(shown)
    expect(keepCanonicalPage(shown, null, 'order-detail')).toBe(shown)
  })
})
