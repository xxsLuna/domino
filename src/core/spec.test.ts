import { describe, expect, it } from 'vitest'
import {
  bindingGaps,
  describeUiSpecProblem,
  findNode,
  isBackEvent,
  isCancelEvent,
  isSignOutEvent,
  iterateNodes,
  normalizeGrid,
  referencedDataKeys,
  resolveDataBindings,
  resolveStateBindings,
  tryValidateUiSpec,
  validateUiSpec,
  withKnownPages,
  withTargetPage,
  type CardNode
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

describe('withTargetPage', () => {
  // `v` stamps a generation so tests can tell which side each page came from.
  const spec = (page: string, ids: string[], v: string) => ({
    version: 1 as const,
    page,
    pages: ids.map((id) => ({ id, name: `${id} v${v}`, layout: [] }))
  })
  it('lets the replayed page win but keeps other pages at their current version', () => {
    // stored earlier at v1 while 'settings' has moved on to v3 since
    const merged = withTargetPage(
      spec('leads', ['leads', 'settings'], '1'),
      spec('leads', ['settings'], '3')
    )
    expect(merged.pages.find((p) => p.id === 'leads')?.name).toBe('leads v1')
    expect(merged.pages.find((p) => p.id === 'settings')?.name).toBe('settings v3')
    expect(merged.page).toBe('leads')
  })
  it('still introduces pages the runtime has never seen', () => {
    const merged = withTargetPage(
      spec('leads', ['leads', 'newpage'], '1'),
      spec('main', ['main'], '2')
    )
    expect(merged.pages.map((p) => p.id).sort()).toEqual(['leads', 'main', 'newpage'])
  })
  it('passes the spec through when everything in it is authoritative', () => {
    const only = spec('main', ['main'], '2')
    expect(withTargetPage(only, spec('main', ['main'], '1'))).toBe(only)
  })
  it('passes the first spec through', () => {
    const first = spec('main', ['main'], '1')
    expect(withTargetPage(first, null)).toBe(first)
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

describe('isCancelEvent', () => {
  it('recognizes the ids models give cancel buttons', () => {
    for (const nodeId of ['cancel', 'nl-cancel', 'btn_cancel', 'form-cancel-2'])
      expect(isCancelEvent({ event: 'click', nodeId }), nodeId).toBe(true)
  })
  it('ignores other buttons and events', () => {
    expect(isCancelEvent({ event: 'click', nodeId: 'cancel-order' })).toBe(false)
    expect(isCancelEvent({ event: 'click', nodeId: 'cancels' })).toBe(false)
    expect(isCancelEvent({ event: 'submit', nodeId: 'cancel' })).toBe(false)
  })
})

describe('isBackEvent', () => {
  it('recognizes back buttons', () => {
    for (const nodeId of ['back', 'go-back', 'goback', 'detail-back', 'back-btn', 'form_back_2'])
      expect(isBackEvent({ event: 'click', nodeId }), nodeId).toBe(true)
  })
  it('ignores look-alikes and other events', () => {
    for (const nodeId of [
      'feedback',
      'back-order',
      'backup',
      'cashback',
      'send-back',
      'roll-back-btn',
      'cash-back',
      'call-back',
      'request_send_back'
    ])
      expect(isBackEvent({ event: 'click', nodeId }), nodeId).toBe(false)
    expect(isBackEvent({ event: 'submit', nodeId: 'back' })).toBe(false)
  })
})

describe('runaway nesting', () => {
  it('drops children past the depth cap instead of recursing forever', () => {
    let node: unknown = { name: 'Paragraph' }
    for (let i = 0; i < 200; i++) node = { name: 'Card', children: [node] }
    const spec = validateUiSpec(page([node]))
    let depth = 0
    let cur = spec.pages[0].layout[0]
    while (cur.children?.length) {
      cur = cur.children[0]
      depth++
    }
    expect(depth).toBe(32)
    // Iterative walk visits every surviving node without blowing the stack.
    expect([...iterateNodes(spec.pages[0].layout)].length).toBeGreaterThan(0)
  })

  it('iterateNodes keeps pre-order, child-by-child sequence', () => {
    const spec = validateUiSpec(
      page([
        { name: 'Card', id: 'a', children: [{ name: 'Paragraph', id: 'a1' }, { name: 'Button', id: 'a2' }] },
        { name: 'Card', id: 'b' }
      ])
    )
    expect([...iterateNodes(spec.pages[0].layout)].map((n) => n.id)).toEqual(['a', 'a1', 'a2', 'b'])
  })
})

describe('client-side state', () => {
  const withState = (state: unknown, extra: Record<string, unknown> = {}): unknown => ({
    version: 1,
    page: 'p',
    pages: [{ id: 'p', name: 'P', layout: [] }],
    ...extra,
    state
  })

  it('validates and round-trips a declared state (schema registration)', () => {
    const spec = validateUiSpec(withState({ trashCount: '3', dense: true }))
    expect(spec.state).toEqual({ trashCount: '3', dense: true })
    // Round-trip: a validated spec re-parses with state intact (history, cache).
    expect(validateUiSpec(JSON.parse(JSON.stringify(spec))).state).toEqual({ trashCount: '3', dense: true })
  })

  it('still strips unregistered top-level junk but drops a non-object state', () => {
    const spec = validateUiSpec(withState('nope', { junk: 1 }))
    expect(spec.state).toBeUndefined()
    expect((spec as unknown as Record<string, unknown>).junk).toBeUndefined()
    expect(validateUiSpec(withState(undefined, { junk: 1 })).state).toBeUndefined()
  })

  it('normalizeUiSpec carries state through (spread path)', () => {
    const spec = validateUiSpec({ page: 'p', state: { q: '1' }, pages: [{ id: 'p', name: 'P', layout: [] }] })
    expect(spec.state).toEqual({ q: '1' })
  })

  it('findNode locates a node by id at any depth of the current page', () => {
    const spec = validateUiSpec(
      page([
        { name: 'Card', id: 'a', children: [{ name: 'Button', id: 'deep', props: { text: 'Go' } }] },
        { name: 'StatCard', id: 'stat' }
      ])
    )
    expect(findNode(spec, 'deep')?.props).toEqual({ text: 'Go' })
    expect(findNode(spec, 'stat')?.name).toBe('StatCard')
    expect(findNode(spec, 'missing')).toBeNull()
  })

  const bound = (extra: Record<string, unknown> = {}): CardNode => ({
    name: 'Card',
    id: 'c',
    props: { title: 'Trash', value: { $state: 'trashCount' } },
    children: [{ name: 'Button', id: 'minus', props: { text: '-', stateKey: 'trashCount', delta: -1 } }],
    ...extra
  })

  it('substitutes {"$state"} props with the live value, recursively', () => {
    const out = resolveStateBindings(bound(), { trashCount: 7 })
    expect(out.props?.value).toBe(7)
    expect(out.children?.[0].props?.delta).toBe(-1)
  })

  it('resolves bindings inside nested objects and children', () => {
    const node: CardNode = {
      name: 'Card',
      id: 'c',
      props: { items: [{ label: { $state: 'name' } }], meta: { count: { $state: 'n' } } },
      children: [{ name: 'Label', props: { text: { $state: 'name' } } }]
    }
    const out = resolveStateBindings(node, { name: 'Ana', n: 3 })
    expect(out.props?.items).toEqual([{ label: 'Ana' }])
    expect(out.props?.meta).toEqual({ count: 3 })
    expect(out.children?.[0].props?.text).toBe('Ana')
  })

  it('a missing key resolves to undefined (prop disappears)', () => {
    const out = resolveStateBindings(bound(), {})
    expect(out.props?.value).toBeUndefined()
  })

  it('returns the SAME reference when nothing binds state (memo/signature stability)', () => {
    const plain: CardNode = {
      name: 'Card',
      id: 'c',
      props: { title: 'Static' },
      children: [{ name: 'Button', props: { text: 'OK' } }]
    }
    expect(resolveStateBindings(plain, { other: 1 })).toBe(plain)
    // The {$state} shape only swaps on an exact single-key object.
    const lookalike: CardNode = { name: 'Badge', props: { value: { $state: 'a', extra: 1 } } }
    expect(resolveStateBindings(lookalike, { a: 5 })).toBe(lookalike)
  })
})

describe('resolveDataBindings ({"$data"} → live/API snapshots)', () => {
  const node = (props: Record<string, unknown>): CardNode => ({ name: 'Table', id: 't', props })

  it('resolves a dotted path into the matching source', () => {
    const out = resolveDataBindings(node({ rows: { $data: 'feed.items' } }), {
      feed: { items: [{ title: 'A' }] }
    })
    expect(out.props?.rows).toEqual([{ title: 'A' }])
  })

  it('indexes arrays by numeric segments', () => {
    const out = resolveDataBindings(node({ title: { $data: 'feed.items.0.title' } }), {
      feed: { items: [{ title: 'First' }] }
    })
    expect(out.props?.title).toBe('First')
  })

  it('matches the LONGEST source key, so an endpoint key with dots resolves', () => {
    // "api:GET /feed.xml" contains a dot that is not a path separator — the
    // lookup must not split it away.
    const out = resolveDataBindings(
      node({ rows: { $data: 'api:GET /feed.xml.items' } }),
      { 'api:GET /feed.xml': { items: [{ title: 'T' }] } }
    )
    expect(out.props?.rows).toEqual([{ title: 'T' }])
  })

  it('prefers a longer key over a prefix that is also a key', () => {
    const sources = {
      api: { label: 'short' },
      'api:GET /leads': { label: 'long' }
    }
    const out = resolveDataBindings(node({ label: { $data: 'api:GET /leads.label' } }), sources)
    expect(out.props?.label).toBe('long')
    // A shorter path that is exactly a key still resolves to that key.
    const bare = resolveDataBindings(node({ label: { $data: 'api.label' } }), sources)
    expect(bare.props?.label).toBe('short')
  })

  it('an unknown key resolves to undefined (prop disappears)', () => {
    const out = resolveDataBindings(node({ rows: { $data: 'nope.items' } }), {})
    expect(out.props?.rows).toBeUndefined()
  })

  const tasks = {
    tasks: {
      tasks: [
        { id: '1', title: 'Write', status: 'new', done: false, email: 'a.b@x.dev', size: 10 },
        { id: '2', title: 'Ship', status: 'done', done: true, email: 'c@x.dev', size: 30 },
        { id: '3', title: 'Rest', status: 'new', done: false, email: 'd@x.dev', size: 20 }
      ]
    }
  }

  it('filters arrays with [?field==\'value\'] — the shape models emit for tab panels', () => {
    const out = resolveDataBindings(node({ items: { $data: "tasks.tasks[?status=='new']" } }), tasks)
    expect(out.props?.items).toEqual([tasks.tasks.tasks[0], tasks.tasks.tasks[2]])
  })

  it('filters with !=, truthiness and numeric comparisons', () => {
    const neq = resolveDataBindings(node({ rows: { $data: "tasks.tasks[?status!='new']" } }), tasks)
    expect(neq.props?.rows).toEqual([tasks.tasks.tasks[1]])
    const truthy = resolveDataBindings(node({ rows: { $data: 'tasks.tasks[?done]' } }), tasks)
    expect(truthy.props?.rows).toEqual([tasks.tasks.tasks[1]])
    const gt = resolveDataBindings(node({ rows: { $data: 'tasks.tasks[?size>15]' } }), tasks)
    expect(gt.props?.rows).toEqual([tasks.tasks.tasks[1], tasks.tasks.tasks[2]])
  })

  it('=~ is a case-insensitive substring match; a no-match filter yields []', () => {
    const like = resolveDataBindings(node({ rows: { $data: "tasks.tasks[?email=~'A.B@']" } }), tasks)
    expect(like.props?.rows).toEqual([tasks.tasks.tasks[0]])
    const none = resolveDataBindings(node({ rows: { $data: "tasks.tasks[?status=='gone']" } }), tasks)
    expect(none.props?.rows).toEqual([])
  })

  it('supports bracket indexes (incl. negative) after names and filters', () => {
    const head = resolveDataBindings(node({ rows: { $data: 'tasks.tasks[0].title' } }), tasks)
    expect(head.props?.rows).toBe('Write')
    const last = resolveDataBindings(node({ rows: { $data: 'tasks.tasks[-1].title' } }), tasks)
    expect(last.props?.rows).toBe('Rest')
    const chain = resolveDataBindings(
      node({ rows: { $data: "tasks.tasks[?status=='done'][0].title" } }),
      tasks
    )
    expect(chain.props?.rows).toBe('Ship')
  })

  it('projects a field over a list and keeps dots inside quoted values intact', () => {
    const titles = resolveDataBindings(node({ rows: { $data: 'tasks.tasks[?done].title' } }), tasks)
    expect(titles.props?.rows).toEqual(['Ship'])
    const dotted = resolveDataBindings(
      node({ rows: { $data: "tasks.tasks[?email=='a.b@x.dev']" } }),
      tasks
    )
    expect(dotted.props?.rows).toEqual([tasks.tasks.tasks[0]])
  })

  it('a filter on the FIRST segment still finds the source key', () => {
    const out = resolveDataBindings(node({ rows: { $data: "tasks[?n=='2']" } }), {
      tasks: [{ n: '1' }, { n: '2' }]
    })
    expect(out.props?.rows).toEqual([{ n: '2' }])
  })

  it('malformed brackets resolve to undefined instead of throwing', () => {
    const out = resolveDataBindings(node({ rows: { $data: 'tasks.tasks[[oops' } }), tasks)
    expect(out.props?.rows).toBeUndefined()
  })
})

describe('bindingGaps (a fresh render vs the snapshots the runtime holds)', () => {
  const specOf = (props: Record<string, unknown>): ReturnType<typeof validateUiSpec> =>
    validateUiSpec({ ...(page([{ name: 'Table', id: 't', props }]) as object) })
  const sources = { leads: { rows: [{ name: 'Ana', stage: 'new' }], total: 7 } }

  it('flags a guessed field on a held key and names the real ones', () => {
    const gaps = bindingGaps(specOf({ rows: { $data: 'leads.items' } }), sources)
    expect(gaps).toHaveLength(1)
    expect(gaps[0].path).toBe('leads.items')
    expect(gaps[0].key).toBe('leads')
    // container keys AND the row fields behind them — what to bind, exactly
    expect(gaps[0].fields).toEqual(['rows', 'total', 'rows[].name,stage'])
  })

  it('descends to the level the path broke at to report fields', () => {
    const gaps = bindingGaps(specOf({ rows: { $data: 'leads.rows.author' } }), sources)
    expect(gaps).toHaveLength(1)
    expect(gaps[0].fields).toEqual(['name', 'stage'])
  })

  it('skips keys the runtime does not hold yet (fetch may still land)', () => {
    expect(bindingGaps(specOf({ rows: { $data: 'orders.rows' } }), sources)).toEqual([])
  })

  it('passes paths that resolve, including filter paths yielding []', () => {
    expect(bindingGaps(specOf({ rows: { $data: 'leads.rows' } }), sources)).toEqual([])
    expect(bindingGaps(specOf({ rows: { $data: "leads.rows[?stage=='gone']" } }), sources)).toEqual([])
  })

  it('flags a Table column no row carries, naming the real fields', () => {
    const spec = validateUiSpec({
      ...(page([{ name: 'Table', id: 't', props: { columns: ['Name', 'Client'], rows: { $data: 'leads.rows' } } }]) as object)
    })
    const gaps = bindingGaps(spec, sources)
    expect(gaps).toHaveLength(1)
    expect(gaps[0].path).toContain('column "Client"')
    expect(gaps[0].key).toBe('leads')
    expect(gaps[0].fields).toEqual(['name', 'stage'])
  })

  it('column matching survives spelling variants (Plus ones ≡ plusOnes)', () => {
    const spec = validateUiSpec({
      ...(page([{ name: 'Table', id: 't', props: { columns: ['Plus ones', 'Plus-Ones'], rows: { $data: 'g.rows' } } }]) as object)
    })
    expect(bindingGaps(spec, { g: { rows: [{ plusOnes: 2 }] } })).toEqual([])
  })

  it('flags a filter on a field no item has; passes a legitimately empty filter', () => {
    const guess = specOf({ rows: { $data: 'leads.rows[?completed]' } })
    const gaps = bindingGaps(guess, sources)
    expect(gaps).toHaveLength(1)
    expect(gaps[0].path).toBe('leads.rows[?completed]')
    expect(gaps[0].fields).toEqual(['name', 'stage'])
    // Field exists, values simply do not match: not a gap.
    expect(bindingGaps(specOf({ rows: { $data: 'leads.rows[?name==\'nobody\']' } }), sources)).toEqual([])
  })
})

describe('nav badges', () => {
  it('accepts bound badges and keeps an item whose badge is malformed', () => {
    const spec = validateUiSpec({
      ...(page([]) as object),
      nav: [
        { id: 'inbox', label: 'Inbox', badge: { $data: 'inbox.unread' } },
        { id: 'cart', label: 'Cart', badge: { $state: 'cartCount' } },
        { id: 'odd', label: 'Odd', badge: { $data: 'x', extra: 1 } },
        { id: 'plain', label: 'Plain', badge: 3 }
      ]
    })
    expect(spec.nav).toEqual([
      { id: 'inbox', label: 'Inbox', badge: { $data: 'inbox.unread' } },
      { id: 'cart', label: 'Cart', badge: { $state: 'cartCount' } },
      { id: 'odd', label: 'Odd' },
      { id: 'plain', label: 'Plain', badge: 3 }
    ])
  })

  it('counts nav-bound sources as referenced (polling keeps them fresh)', () => {
    const spec = validateUiSpec({
      ...(page([]) as object),
      nav: [{ id: 'inbox', label: 'Inbox', badge: { $data: 'inbox.unread' } }]
    })
    expect([...referencedDataKeys(spec)]).toEqual(['inbox'])
  })
})
