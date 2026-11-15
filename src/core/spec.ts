import { z } from 'zod'

/**
 * UiSpec — the JSON tree the LLM emits to describe a rendered screen.
 * Every node has a `name` (the registered component name) and is laid out
 * on the 12-column card grid via `grid`.
 */

export const gridSchema = z.object({
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0).max(999),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(50)
})

export type GridPlacement = z.infer<typeof gridSchema>

export interface CardNode {
  /** Component name as registered (e.g. "Button", "Table", "StatCard"). */
  name: string
  /** Unique id inside a page. Generated when omitted. */
  id?: string
  props?: Record<string, unknown>
  grid?: GridPlacement
  children?: CardNode[]
}

export interface PageSpec {
  id: string
  /** Human-readable page name shown in the toolbar. */
  name: string
  layout: CardNode[]
}

/**
 * App-level primary navigation. The runtime renders it the way native apps
 * do: a sidebar on desktop, an icon rail on tablets, a bottom tab bar on
 * phones. Selecting an item sends `ACTION navigate` to the agent.
 */
export interface NavItem {
  id: string
  label: string
  /** Icon name from the runtime icon set (see prompt) or an emoji. */
  icon?: string
  /**
   * Small counter/label shown next to the item (e.g. unread count). May be a
   * binding — `{"$data": "<key>.<path>"}` or `{"$state": "<key>"}` — which
   * the runtime resolves on every render (resolveNavItems in core/ui/nav).
   */
  badge?: string | number | NavBadgeBinding
}

/** A nav badge bound to live data or to the screen's client-side state. */
export type NavBadgeBinding = { $data: string } | { $state: string }

export interface UiSpec {
  version: 1
  /** Current page id. */
  page: string
  pages: PageSpec[]
  /** Primary navigation; omit to keep the previous screen's, `[]` to hide it. */
  nav?: NavItem[]
  /**
   * Client-side screen state (React-useState style): keys the runtime updates
   * locally — no LLM round trip — bound into props via `{"$state": "<key>"}`.
   * Only keys the model declared here are handled locally; anything else keeps
   * the normal event → model flow (filters, search…).
   */
  state?: Record<string, unknown>
}

/** An interaction captured from a rendered component, sent to the agent. */
export interface ActionEvent {
  pageId: string
  nodeId: string
  nodeName: string
  event: string
  data?: Record<string, unknown>
}

/**
 * The sign-out convention is a Button with id "logout"; models write
 * "set-logout", "account-sign-out", "signout"… — all mean the same.
 */
export function isSignOutEvent(e: Pick<ActionEvent, 'event' | 'nodeId'>): boolean {
  return e.event === 'click' && /(?:^|[-_.])(?:log-?out|sign-?out)(?:[-_.](?:btn|button|\d+))?$/i.test(e.nodeId)
}

/**
 * Cancel buttons on create/edit forms: the prompt prescribes id "cancel" and
 * models prefix it ("nl-cancel", "btn_cancel") — same matching idea as sign-out.
 */
export function isCancelEvent(e: Pick<ActionEvent, 'event' | 'nodeId'>): boolean {
  return e.event === 'click' && /(?:^|[-_.])cancel(?:[-_.](?:btn|button|\d+))?$/i.test(e.nodeId)
}

/**
 * Words that turn "<word>-back" into an action of its own, not a Back button:
 * "send-back" returns a request, "roll-back" reverts a deploy, "cash-back",
 * "call-back", "pay-back", "write-back"… Treating those as Back would skip
 * their write and just show the previous page.
 */
const BACK_VERBS = new Set([
  'send',
  'roll',
  'call',
  'pay',
  'cash',
  'give',
  'write',
  'push',
  'play',
  'kick',
  'charge',
  'feed',
  'fall',
  'set',
  'hold',
  'bring',
  'take',
  'put',
  'get',
  'come',
  'turn',
  'claw',
  'buy',
  'draw',
  'post'
])

/**
 * Back buttons ("back", "go-back", "detail-back-btn"): the same id grammar as
 * cancel — an optional scope prefix naming WHERE ("detail", "form"), never a
 * verb naming WHAT ("send-back", "roll-back-btn"). The runtime steps back in
 * its own history instead of asking the model to redraw the previous page.
 * `feedback` / `back-order` stay plain.
 */
export function isBackEvent(e: Pick<ActionEvent, 'event' | 'nodeId'>): boolean {
  if (e.event !== 'click') return false
  const m = /(?:^|[-_.])(?:go-?)?back(?:[-_.](?:btn|button|\d+))?$/i.exec(e.nodeId)
  if (!m) return false
  const prefix = e.nodeId.slice(0, m.index)
  const before = prefix.split(/[-_.]/).filter(Boolean).pop()?.toLowerCase()
  return before === undefined || !BACK_VERBS.has(before)
}

/**
 * Feed-subscription conventions, handled by the runtime without a model round
 * trip for the store mutation itself (the follow-up screen still needs one).
 * A form submits "subscribe-feed" with a url field; the other two are buttons.
 */
export function isSubscribeFeedEvent(e: Pick<ActionEvent, 'event' | 'nodeId'>): boolean {
  return (
    e.event === 'submit' &&
    /(?:^|[-_.])subscribe-?feed(?:[-_.](?:form|btn|button|\d+))?$/i.test(e.nodeId)
  )
}

export function isUnsubscribeFeedEvent(e: Pick<ActionEvent, 'event' | 'nodeId'>): boolean {
  return (
    e.event === 'click' &&
    /(?:^|[-_.])unsubscribe-?feed(?:[-_.](?:btn|button|\d+))?$/i.test(e.nodeId)
  )
}

export function isRefreshFeedsEvent(e: Pick<ActionEvent, 'event' | 'nodeId'>): boolean {
  return (
    e.event === 'click' &&
    /(?:^|[-_.])refresh-?feeds?(?:[-_.](?:btn|button|\d+))?$/i.test(e.nodeId)
  )
}

const cardNodeSchema: z.ZodType<CardNode> = z.lazy(() =>
  // Key order matters: parsed specs go back into the conversation, and models
  // copy the order they see there (grid before props streams placement first).
  z.object({
    name: z.string().min(1),
    id: z.string().optional(),
    grid: gridSchema.optional(),
    props: z.record(z.unknown()).optional(),
    children: z.array(cardNodeSchema).optional()
  })
)

export const pageSpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  layout: z.array(cardNodeSchema)
})

const navItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  icon: z.string().optional(),
  badge: z
    .union([
      z.string(),
      z.number(),
      z.object({ $data: z.string().min(1) }).strict(),
      z.object({ $state: z.string().min(1) }).strict()
    ])
    .optional()
})

/**
 * Nav items are decorative: drop malformed/half-streamed ones instead of
 * rejecting the spec. An item whose only problem is its badge keeps its tab
 * (badge dropped) — a bad counter must never delete a section of the app.
 */
const navSchema = z.array(z.unknown()).transform((items) =>
  items.flatMap((item) => {
    const parsed = navItemSchema.safeParse(item)
    if (parsed.success) return [parsed.data]
    if (item && typeof item === 'object' && 'badge' in item) {
      const retry = navItemSchema.safeParse({ ...item, badge: undefined })
      if (retry.success) {
        const rest = { ...retry.data }
        delete rest.badge
        return [rest]
      }
    }
    return []
  })
)

export const uiSpecSchema = z.object({
  version: z.literal(1),
  page: z.string().min(1),
  nav: navSchema.optional(),
  // Registered so the validated spec carries `state` (z.object strips unknown
  // keys) — the engine then records it in history and the model sees it.
  state: z.record(z.unknown()).optional(),
  pages: z.array(pageSpecSchema).min(1)
})

/* ------------------------- normalizing model output ------------------------- */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 3, 3.4, "3" → 3; anything else → undefined. */
function toInt(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : undefined
}

const clampInt = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/**
 * Models get the grid "almost" right: h: 0, x: 12, w: 13, "4", 2.5. Clamp into
 * range instead of rejecting the screen. A grid without y or w (e.g. still
 * streaming) is dropped so the node can't flash in a wrong spot.
 */
export function normalizeGrid(raw: unknown): GridPlacement | undefined {
  if (!isRecord(raw)) return undefined
  const y = toInt(raw.y)
  const w = toInt(raw.w)
  if (y === undefined || w === undefined) return undefined
  const x = clampInt(toInt(raw.x) ?? 0, 0, 11)
  return {
    x,
    y: clampInt(y, 0, 999),
    w: clampInt(w, 1, 12 - x),
    h: clampInt(toInt(raw.h) ?? 1, 1, 50)
  }
}

const NODE_KEYS = new Set(['id', 'grid', 'props', 'children'])
const NAME_KEYS = ['name', 'component', 'type'] as const

/**
 * Children past this depth are dropped: real screens nest a handful of levels,
 * while runaway nesting (or a hostile payload) must not blow the stack in
 * normalize → zod → renderer recursion.
 */
export const MAX_NODE_DEPTH = 32

/**
 * One node, coerced: `component`/`type` stand in for a missing `name`, props
 * written next to `name` (e.g. an Input's "type": "email") are folded into
 * `props`, a numeric id becomes a string. Returns null for something that
 * isn't a node at all.
 */
function normalizeNode(raw: unknown, depth: number): CardNode | null {
  if (!isRecord(raw)) return null
  const nameKey = NAME_KEYS.find((k) => typeof raw[k] === 'string' && (raw[k] as string).trim() !== '')
  if (!nameKey) return null
  const node: CardNode = { name: (raw[nameKey] as string).trim() }
  if (typeof raw.id === 'string' || typeof raw.id === 'number') node.id = String(raw.id)
  const grid = normalizeGrid(raw.grid)
  if (grid) node.grid = grid
  const stray = Object.entries(raw).filter(([k]) => k !== nameKey && !NODE_KEYS.has(k))
  const props = isRecord(raw.props) ? raw.props : undefined
  if (props || stray.length) node.props = { ...Object.fromEntries(stray), ...props }
  if (Array.isArray(raw.children) && depth < MAX_NODE_DEPTH) {
    node.children = normalizeNodes(raw.children, depth + 1)
  }
  return node
}

function normalizeNodes(raw: unknown, depth: number): CardNode[] {
  return Array.isArray(raw)
    ? raw.flatMap((n) => {
        const node = normalizeNode(n, depth)
        return node ? [node] : []
      })
    : []
}

/**
 * Bring a model-written spec into contract shape before validation: fill in
 * what has an obvious default (version, a page's name, an empty layout) and
 * drop what can't be understood, so one odd node doesn't blank the screen.
 */
export function normalizeUiSpec(input: unknown): unknown {
  if (!isRecord(input)) return input
  const rawPages = Array.isArray(input.pages) ? input.pages : []
  const page = typeof input.page === 'string' && input.page ? input.page : undefined
  const pages = rawPages.flatMap((p): PageSpec[] => {
    if (!isRecord(p)) return []
    const id =
      typeof p.id === 'string' || typeof p.id === 'number'
        ? String(p.id)
        : rawPages.length === 1
          ? page
          : undefined
    if (!id) return []
    const name = typeof p.name === 'string' && p.name ? p.name : typeof p.title === 'string' && p.title ? p.title : id
    return [{ id, name, layout: normalizeNodes(p.layout, 0) }]
  })
  // Nav items keyed by `page` or missing a label still say where they go.
  const nav = Array.isArray(input.nav)
    ? input.nav.map((item) => {
        if (!isRecord(item)) return item
        const id = item.id ?? item.page
        const label = item.label ?? item.title ?? item.name ?? id
        return { ...item, id: id === undefined ? id : String(id), label: label === undefined ? label : String(label) }
      })
    : input.nav
  // Client-side state: only an object survives; anything else is dropped so
  // one odd value can't fail validation (bindings then simply resolve stale).
  const state = isRecord(input.state) ? input.state : undefined
  return {
    ...input,
    version: 1,
    page: page ?? pages[0]?.id,
    pages,
    nav,
    state
  }
}

/**
 * Tolerant parse used for LLM output: the spec is normalized first (see
 * normalizeUiSpec), then structural problems throw. Ensures `page` exists in `pages`.
 */
export function validateUiSpec(input: unknown): UiSpec {
  const spec = uiSpecSchema.parse(normalizeUiSpec(input)) as UiSpec
  if (!spec.pages.some((p) => p.id === spec.page)) {
    spec.page = spec.pages[0].id
  }
  return spec
}

/** Why a spec fails validation, in a form the model can act on (null when valid). */
export function describeUiSpecProblem(input: unknown): string | null {
  const result = uiSpecSchema.safeParse(normalizeUiSpec(input))
  if (result.success) return null
  return result.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'spec'}: ${i.message}`)
    .join('; ')
}

/** Best-effort parse for streaming deltas (returns null until coherent). */
export function tryValidateUiSpec(input: unknown): UiSpec | null {
  try {
    return validateUiSpec(input)
  } catch {
    return null
  }
}

/**
 * Pages delivered in earlier turns stay available (newer versions win), so
 * the model only has to send the page it is showing — re-sending every page
 * each turn multiplied output (and latency) for no visible change.
 */
export function withKnownPages(next: UiSpec, prev: UiSpec | null): UiSpec {
  if (!prev) return next
  const ids = new Set(next.pages.map((p) => p.id))
  const kept = prev.pages.filter((p) => !ids.has(p.id))
  return kept.length ? { ...next, pages: [...next.pages, ...kept] } : next
}

/**
 * Replay merge for a stored screen: only the page the replay is about
 * (`next.page`) replaces what the runtime knows — every other page in the
 * stored spec was captured alongside it and must not drag other pages back to
 * that moment. Pages not known yet still come along.
 */
export function withTargetPage(next: UiSpec, prev: UiSpec | null): UiSpec {
  if (!prev) return next
  const known = new Set(prev.pages.map((p) => p.id))
  const wins = next.pages.filter((p) => p.id === next.page || !known.has(p.id))
  const winIds = new Set(wins.map((p) => p.id))
  const kept = prev.pages.filter((p) => !winIds.has(p.id))
  if (kept.length === 0) return next // next already supersedes every known page
  return { ...next, pages: [...wins, ...kept] }
}

export function findPage(spec: UiSpec, pageId: string): PageSpec | undefined {
  return spec.pages.find((p) => p.id === pageId)
}

export function* iterateNodes(nodes: CardNode[]): Generator<CardNode> {
  // Iterative (explicit stack): a recursive generator over a caller-supplied
  // tree would reintroduce the unbounded stack depth normalizeNode caps.
  const stack: CardNode[] = []
  for (let i = nodes.length - 1; i >= 0; i--) stack.push(nodes[i])
  while (stack.length) {
    const node = stack.pop()!
    yield node
    if (node.children) {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i])
    }
  }
}

/** First node in the current page's layout with this id (any depth). */
export function findNode(spec: UiSpec, id: string): CardNode | null {
  const page = findPage(spec, spec.page)
  if (!page) return null
  for (const node of iterateNodes(page.layout)) if (node.id === id) return node
  return null
}

/**
 * A [pages] purpose that promises a collection ("Table of notes", "list of
 * leads") whose built page shows neither Table nor List — the silent
 * stats-only home, caught deterministically. Only the explicit "<kind> of"
 * phrasing is a promise; a page that never claimed a list is never blamed
 * for not having one.
 */
export function promisedCollectionGap(
  decl: { name: string; purpose?: string },
  layout: CardNode[]
): 'Table' | 'List' | null {
  const claimed = /\b(table|list)\s+of\b/.exec(`${decl.name} ${decl.purpose ?? ''}`.toLowerCase())
  if (!claimed) return null
  for (const node of iterateNodes(layout)) {
    if (node.name === 'Table' || node.name === 'List') return null
  }
  return claimed[1] === 'table' ? 'Table' : 'List'
}

/** True for the single-key binding object `{"$state": "<key>"}`. */
const stateBinding = (v: unknown): string | null =>
  isRecord(v) &&
  Object.keys(v).length === 1 &&
  typeof v['$state'] === 'string' &&
  (v['$state'] as string).length > 0
    ? (v['$state'] as string)
    : null

function resolveValue(v: unknown, state: Record<string, unknown>): unknown {
  const key = stateBinding(v)
  if (key !== null) return state[key]
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, state))
  if (isRecord(v)) {
    let replaced = false
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      const next = resolveValue(val, state)
      if (next !== val) replaced = true
      out[k] = next
    }
    return replaced ? out : v
  }
  return v
}

/**
 * Substitute `{"$state": "<key>"}` prop bindings with the live values of the
 * spec's client-side `state` (missing key → undefined). Recursive into props
 * and children; returns the ORIGINAL node reference when nothing was replaced,
 * so stateless screens keep their WeakMap signatures and memoized cells.
 */
export function resolveStateBindings(node: CardNode, state: Record<string, unknown>): CardNode {
  let replaced = false
  const props =
    node.props === undefined
      ? undefined
      : (resolveValue(node.props, state) as Record<string, unknown> | undefined)
  if (props !== node.props) replaced = true
  const children = node.children?.map((c) => {
    const next = resolveStateBindings(c, state)
    if (next !== c) replaced = true
    return next
  })
  return replaced ? { ...node, props, children: children ?? node.children } : node
}

/** True for the single-key binding object `{"$data": "<key>.<path>"}`. */
const dataBinding = (v: unknown): string | null =>
  isRecord(v) &&
  Object.keys(v).length === 1 &&
  typeof v['$data'] === 'string' &&
  (v['$data'] as string).length > 0
    ? (v['$data'] as string)
    : null

/**
 * Split a data path into steps at dots that sit outside brackets — a quoted
 * predicate value may hold dots (`[?email=='a.b@x.dev']`).
 */
function splitDataPath(rest: string): string[] {
  const steps: string[] = []
  let cur = ''
  let depth = 0
  let quote = ''
  for (const ch of rest) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === '[') {
      depth++
      cur += ch
    } else if (ch === ']') {
      depth--
      cur += ch
    } else if (ch === '.' && depth === 0) {
      steps.push(cur)
      cur = ''
    } else cur += ch
  }
  steps.push(cur)
  return steps
}

/** `tasks[0][?status=='new']` → name "tasks", brackets ["0", "?status=='new'"]. */
function parseStep(step: string): { name: string; brackets: string[] | null } {
  const i = step.indexOf('[')
  if (i === -1) return { name: step, brackets: [] }
  const name = step.slice(0, i)
  const brackets: string[] = []
  let inner = ''
  let depth = 0
  let quote = ''
  for (const ch of step.slice(i)) {
    if (quote) {
      inner += ch
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
      if (depth > 0) inner += ch
    } else if (ch === '[') {
      depth++
      if (depth > 1) inner += ch
    } else if (ch === ']') {
      depth--
      if (depth === 0) {
        brackets.push(inner)
        inner = ''
      } else inner += ch
    } else if (depth > 0) inner += ch
  }
  // An unterminated bracket is a malformed path, not a truncated one.
  if (depth !== 0 || quote) return { name, brackets: null }
  return { name, brackets }
}

const PRED_RE = /^([\w$][\w$.]*|'[^']*'|"[^"]*")\s*(==|!=|>=|<=|=~|>|<)?\s*([\s\S]*)$/

/** `[?x=='y']` right-hand side: quoted text, true/false/null, number, bare word. */
function filterValue(raw: string): unknown {
  const t = raw.trim()
  const q = t[0]
  if ((q === "'" || q === '"') && t.length > 1 && t.endsWith(q)) return t.slice(1, -1)
  if (t === 'true') return true
  if (t === 'false') return false
  if (t === 'null') return null
  const n = Number(t)
  return t !== '' && Number.isFinite(n) ? n : t
}

function eqLoose(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) return false
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b)
  if (typeof a === 'boolean' || typeof b === 'boolean')
    return String(a).toLowerCase() === String(b).toLowerCase()
  return String(a) === String(b)
}

/** One `[?field op value]` predicate against a list item (no op → truthy; `!` negates). */
function matchesPredicate(item: unknown, expr: string): boolean {
  const ex = expr.trim()
  // `[?!done]` — the open-side half of a done/todo split. Models write it
  // unbidden; without support the "open items" list would silently empty.
  if (ex.startsWith('!')) return !matchesPredicate(item, ex.slice(1))
  const m = PRED_RE.exec(ex)
  if (!m) return false
  const field = m[1].replace(/^(['"])([\s\S]*)\1$/, '$2')
  let val: unknown = item
  for (const seg of field.split('.')) {
    if (val === null || val === undefined) break
    if (isRecord(val)) val = val[seg]
    else if (Array.isArray(val)) {
      const i = Number(seg)
      val = Number.isInteger(i) ? val[i] : undefined
    } else val = undefined
  }
  const op = m[2]
  if (!op) return Boolean(val)
  const lit = filterValue(m[3])
  switch (op) {
    case '==':
      return eqLoose(val, lit)
    case '!=':
      return !eqLoose(val, lit)
    case '=~':
      return (
        val !== null &&
        val !== undefined &&
        String(val)
          .toLowerCase()
          .includes(String(lit).toLowerCase())
      )
    default: {
      // ISO date-strings compare lexicographically; anything else numerically.
      if (
        typeof val === 'string' &&
        typeof lit === 'string' &&
        /^\d{4}-\d{2}/.test(val) &&
        /^\d{4}-\d{2}/.test(lit)
      ) {
        return op === '>' ? val > lit : op === '>=' ? val >= lit : op === '<' ? val < lit : val <= lit
      }
      const a = typeof val === 'number' ? val : Number(val)
      const b = typeof lit === 'number' ? lit : Number(lit)
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false
      return op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : a <= b
    }
  }
}

/** Apply one bracket suffix: `[N]`/`[-N]` index, `[?... ]` filter on arrays. */
function applyBracket(cur: unknown, inner: string): unknown {
  const t = inner.trim()
  if (t.startsWith('?')) {
    if (!Array.isArray(cur)) return undefined
    return cur.filter((it) => matchesPredicate(it, t.slice(1)))
  }
  if (!Array.isArray(cur)) return undefined
  const idx = Number(t)
  if (!Number.isInteger(idx)) return undefined
  return cur[idx < 0 ? cur.length + idx : idx]
}

/** One dot-step: named field (arrays index by number, else project fields). */
function applyStep(cur: unknown, step: string): unknown {
  const { name, brackets } = parseStep(step)
  if (brackets === null) return undefined
  if (name) {
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) {
      const idx = Number(name)
      if (name.trim() !== '' && Number.isInteger(idx)) {
        cur = cur[idx < 0 ? cur.length + idx : idx]
      } else {
        // JMESPath-style projection: field access on a list maps over items.
        const vals = cur.map((it) => (isRecord(it) ? it[name] : undefined))
        cur = vals.some((v) => v !== undefined) ? vals : undefined
      }
    } else if (isRecord(cur)) cur = cur[name]
    else return undefined
  }
  for (const b of brackets) {
    if (cur === null || cur === undefined) return undefined
    cur = applyBracket(cur, b)
  }
  return cur
}

/**
 * Walk a `key.a.b` path into the source map. Segments may carry bracket
 * suffixes — `[0]`, `[-1]`, and JMESPath-ish filters (`[?status=='new']`,
 * `!=`, `>`, `<=`, `=~`, bare field = truthy) — the syntax models naturally
 * emit when asked to show a subset of a bound collection.
 */
function lookupDataPath(sources: Record<string, unknown>, path: string): unknown {
  // The key is the longest prefix that names a source — keys may themselves
  // contain dots ("api:GET /feed.xml"), and brackets may follow the first
  // segment ("tasks[?done]") without the key holding them. A key the map
  // lacks falls back to the leading segment and misses the map → undefined.
  const base = /^[^[.]*/.exec(path)?.[0] ?? ''
  let key = base
  for (const candidate of Object.keys(sources)) {
    if (
      candidate.length > key.length &&
      (path === candidate || path.startsWith(`${candidate}.`) || path.startsWith(`${candidate}[`))
    ) {
      key = candidate
    }
  }
  if (path.length <= key.length) return sources[key]
  const rest = path[key.length] === '[' ? path.slice(key.length) : path.slice(key.length + 1)
  let cur: unknown = sources[key]
  for (const step of splitDataPath(rest)) cur = applyStep(cur, step)
  return cur
}

function resolveDataValue(v: unknown, sources: Record<string, unknown>): unknown {
  const path = dataBinding(v)
  if (path !== null) return lookupDataPath(sources, path)
  if (Array.isArray(v)) return v.map((x) => resolveDataValue(x, sources))
  if (isRecord(v)) {
    let replaced = false
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      const next = resolveDataValue(val, sources)
      if (next !== val) replaced = true
      out[k] = next
    }
    return replaced ? out : v
  }
  return v
}

/**
 * Substitute `{"$data": "<key>.<path>"}` prop bindings with the latest
 * snapshots of the domino's [data] sources — the runtime refreshes those
 * without the model, so bound props stay live. Same identity contract as
 * resolveStateBindings (original node when nothing was replaced).
 */
export function resolveDataBindings(node: CardNode, sources: Record<string, unknown>): CardNode {
  let replaced = false
  const props =
    node.props === undefined
      ? undefined
      : (resolveDataValue(node.props, sources) as Record<string, unknown> | undefined)
  if (props !== node.props) replaced = true
  const children = node.children?.map((c) => {
    const next = resolveDataBindings(c, sources)
    if (next !== c) replaced = true
    return next
  })
  return replaced ? { ...node, props, children: children ?? node.children } : node
}

/** A `{"$data"}` path that misses its (already-held) source's actual shape. */
export interface BindingGap {
  path: string
  /** Source key the path starts with — the snapshot the runtime already holds. */
  key: string
  /** Field names visible one level under where the path stopped matching. */
  fields: string[]
  /** Value-mismatch filters: the real sentence for the model ("no record has X==y; values: …"). */
  note?: string
}

/** How one gap reads to the model (shared by the in-turn warning and the repair turn). */
export function gapMessage(g: BindingGap): string {
  return (
    g.note ??
    `${g.path} resolves to nothing — "${g.key}" holds: ${g.fields.join(', ') || '(no fields)'}`
  )
}

/**
 * Top-level source keys bound by any {"$data"} path inside a node tree.
 * The first-data design pass asks "does the shown page bind source X?" with it.
 */
export function boundSourceKeys(node: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 24 || node === null || typeof node !== 'object') return out
  const path = dataBinding(node)
  if (path !== null) {
    out.add(/^[^[.]*/.exec(path)?.[0] ?? '')
    return out
  }
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    boundSourceKeys(v, out, depth + 1)
  }
  return out
}

/** Field names of a value: object keys, or the first row's keys for arrays. */
function shapeFields(v: unknown): string[] {
  if (Array.isArray(v)) return v.length && isRecord(v[0]) ? Object.keys(v[0]) : []
  if (isRecord(v)) return Object.keys(v)
  return []
}

/**
 * `{"$data"}` paths on a freshly rendered spec that resolve to nothing even
 * though the runtime HOLDS their source — the model guessed a field name the
 * API does not have. Paths whose source key is not held yet are skipped (the
 * runtime is still fetching them, so they are not gaps). Reported with the
 * real field names so a corrective round can re-bind instead of shipping a
 * screen full of "—".
 */
export function bindingGaps(spec: UiSpec, sources: Record<string, unknown>, limit = 4): BindingGap[] {
  const gaps: BindingGap[] = []
  const held = Object.keys(sources)
  const seen = new Set<string>()
  const check = (v: unknown, depth: number): void => {
    if (gaps.length >= limit || depth > 24) return
    const path = dataBinding(v)
    if (path !== null) {
      if (seen.has(path)) return
      seen.add(path)
      // Only sources the runtime already holds can be a genuine gap.
      let key = /^[^[.]*/.exec(path)?.[0] ?? ''
      for (const candidate of held) {
        if (
          candidate.length > key.length &&
          (path === candidate || path.startsWith(`${candidate}.`) || path.startsWith(`${candidate}[`))
        ) {
          key = candidate
        }
      }
      if (!held.includes(key)) return
      if (lookupDataPath(sources, path) !== undefined) return
      // Walk the plain dotted prefix as deep as the data allows and report
      // the fields found there — what the model should have bound.
      let cur: unknown = sources[key]
      const rest = path.length > key.length ? path.slice(key.length + 1) : ''
      const base = /^[^[.]*/.exec(rest)?.[0] ?? ''
      let fields = shapeFields(cur)
      if (base) {
        for (const seg of base.split('.')) {
          const next = isRecord(cur) ? cur[seg] : Array.isArray(cur) ? cur[Number(seg)] : undefined
          if (next === undefined) break
          cur = next
          fields = shapeFields(cur)
        }
      }
      // A list source is shaped by its ROWS: when the visible fields are just
      // container keys, name the row fields too — "rows[].name,city" tells
      // the model what an item actually carries, not just where the list is.
      if (isRecord(cur)) {
        for (const [k, v] of Object.entries(cur)) {
          if (fields.length >= 20) break
          if (Array.isArray(v) && v.length > 0 && isRecord(v[0]))
            fields.push(`${k}[].${Object.keys(v[0]).slice(0, 10).join(',')}`)
        }
      }
      gaps.push({ path, key, fields: fields.slice(0, 24) })
      return
    }
    if (Array.isArray(v)) v.forEach((x) => check(x, depth + 1))
    else if (isRecord(v)) Object.values(v).forEach((x) => check(x, depth + 1))
  }
  for (const page of spec.pages) for (const node of iterateNodes(page.layout)) check(node.props, 0)
  for (const item of spec.nav ?? []) check(item.badge, 0)
  // Silent-failure classes that resolve "fine" but render empty forever.
  // They keep their OWN dedup sets: `seen` already holds every path the main
  // walk touched, including the clean-resolving `[]` filters these passes
  // exist to catch.
  checkTableColumns(spec, sources, gaps, limit)
  checkEmptyFilters(spec, sources, gaps, limit)
  checkOpaqueScalars(spec, sources, gaps, limit)
  return gaps.slice(0, limit)
}

/** Props that must carry a scalar to be readable; a whole object shows nothing. */
const SCALAR_PROPS: Record<string, string[]> = { StatCard: ['value'], Progress: ['value'] }

/** Keys the renderer can turn into text on its own (see components text()). */
const DISPLAYABLE_KEYS = ['text', 'label', 'title', 'name', 'value']

/**
 * A scalar prop (a StatCard's big number) bound to a WHOLE response object
 * resolves without complaint — and renders as blank space, because the
 * object has no key the renderer could read. Reports it with the object's
 * keys so the re-bind picks a real scalar (a count, a total).
 */
function checkOpaqueScalars(
  spec: UiSpec,
  sources: Record<string, unknown>,
  gaps: BindingGap[],
  limit: number
): void {
  const seen = new Set<string>()
  for (const page of spec.pages) {
    for (const node of iterateNodes(page.layout)) {
      if (gaps.length >= limit) return
      const props = SCALAR_PROPS[node.name]
      if (!props || !isRecord(node.props)) continue
      for (const prop of props) {
        if (gaps.length >= limit) return
        const path = dataBinding(node.props[prop])
        if (path === null) continue
        const held = Object.keys(sources).find(
          (k) => path === k || path.startsWith(`${k}.`) || path.startsWith(`${k}[`)
        )
        if (!held) continue
        const v = lookupDataPath(sources, path)
        if (!isRecord(v) || DISPLAYABLE_KEYS.some((k) => k in v)) continue
        const desc = `${node.name} "${node.id ?? node.name}" ${prop}`
        if (seen.has(desc)) continue
        seen.add(desc)
        gaps.push({ path: desc, key: held, fields: Object.keys(v).slice(0, 24) })
      }
    }
  }
}

/** Same spelling fusion the table renderer uses for column↔field matching. */
const gapKeyNorm = (s: unknown): string => String(s).toLowerCase().replace(/[\s_-]+/g, '')

/** Table columns no row carries — every cell of that column would be "—". */
function checkTableColumns(
  spec: UiSpec,
  sources: Record<string, unknown>,
  gaps: BindingGap[],
  limit: number
): void {
  const seen = new Set<string>()
  for (const page of spec.pages) {
    for (const node of iterateNodes(page.layout)) {
      if (gaps.length >= limit) return
      if (node.name !== 'Table' || !isRecord(node.props)) continue
      const rowsPath = dataBinding(node.props.rows)
      const rows = rowsPath !== null ? lookupDataPath(sources, rowsPath) : node.props.rows
      if (!Array.isArray(rows) || rows.length === 0) continue
      const first = rows.find((r) => isRecord(r))
      if (!isRecord(first)) continue
      const held = Object.keys(sources).find(
        (k) => rowsPath !== null && (rowsPath === k || rowsPath.startsWith(`${k}.`) || rowsPath.startsWith(`${k}[`))
      )
      if (!held) continue // rows come from elsewhere (inline / unfetched) — not a gap we can name
      const fieldKeys = new Set(Object.keys(first).map(gapKeyNorm))
      const cols = Array.isArray(node.props.columns) ? node.props.columns : []
      for (const c of cols) {
        if (gaps.length >= limit) return
        const label = isRecord(c) ? String(c.label ?? c.key ?? '') : String(c)
        const key = isRecord(c) ? String(c.key ?? c.label ?? '') : String(c)
        if (!label && !key) continue
        if (fieldKeys.has(gapKeyNorm(key)) || fieldKeys.has(gapKeyNorm(label))) continue
        const desc = `Table "${node.id ?? node.name}" column "${label || key}"`
        if (seen.has(desc)) continue
        seen.add(desc)
        gaps.push({ path: desc, key: held, fields: Object.keys(first).slice(0, 24) })
      }
    }
  }
}

/**
 * Filters like `items[?completed]` whose field NO item has resolve to `[]` —
 * legal, defined, and an empty panel forever. Also catches the twin case:
 * the field exists but NO record ever equals the `==` literal (a guessed
 * enum value). Never reports a filter that simply matches nothing right now
 * (a legitimately empty list) or whose values DO appear.
 */
function checkEmptyFilters(
  spec: UiSpec,
  sources: Record<string, unknown>,
  gaps: BindingGap[],
  limit: number
): void {
  if (gaps.length >= limit) return
  const seen = new Set<string>()
  const walk = (v: unknown, depth: number): void => {
    if (gaps.length >= limit || depth > 24) return
    const path = dataBinding(v)
    if (path !== null) {
      const open = path.indexOf('[')
      if (open > 0 && path.includes('[') && path.includes(']') && !seen.has(path)) {
        const base = path.slice(0, open)
        let key = /^[^[.]*/.exec(base)?.[0] ?? ''
        for (const candidate of Object.keys(sources)) {
          if (candidate.length > key.length && (base === candidate || base.startsWith(`${candidate}.`)))
            key = candidate
        }
        const baseVal = lookupDataPath(sources, base)
        if (Array.isArray(baseVal) && baseVal.length > 0) {
          const firstItem = baseVal.find((r) => isRecord(r))
          const resolved = lookupDataPath(sources, path)
          if (isRecord(firstItem) && resolved !== undefined) {
            const fieldKeys = new Set<string>()
            for (const it of baseVal) if (isRecord(it)) for (const k of Object.keys(it)) fieldKeys.add(gapKeyNorm(k))
            const emptyResult = Array.isArray(resolved) && resolved.length === 0
            for (const m of path.matchAll(/\[\?\s*([^\]]*)\]/g)) {
              if (gaps.length >= limit) return
              let expr = m[1].trim()
              const negated = expr.startsWith('!')
              if (negated) expr = expr.slice(1).trim()
              const pm = PRED_RE.exec(expr)
              if (!pm) continue
              const field = pm[1].replace(/^(['"])([\s\S]*)\1$/, '$2')
              const last = field.split('.').pop() ?? field
              if (!fieldKeys.has(gapKeyNorm(last))) {
                if (seen.has(path)) continue
                seen.add(path)
                gaps.push({ path, key, fields: [...fieldKeys].slice(0, 24) })
                break
              }
              // The field EXISTS but no record ever equals the tested value:
              // a guessed enum ("category=='Breakfast'" over company data) —
              // the panel is empty forever for a reason the model can fix,
              // and the note hands it the values the records really hold.
              if (emptyResult && !negated && pm[2] === '==') {
                const lit = filterValue(pm[3])
                const values: string[] = []
                let matched = false
                for (const it of baseVal) {
                  if (!isRecord(it)) continue
                  const v = it[last]
                  if (!matched && eqLoose(v, lit)) matched = true
                  const s = typeof v === 'string' || typeof v === 'number' ? String(v) : null
                  if (s !== null && !values.includes(s) && values.length < 12) values.push(s)
                }
                if (!matched) {
                  if (seen.has(path)) continue
                  seen.add(path)
                  gaps.push({
                    path,
                    key,
                    fields: values,
                    note: `${path} is empty forever — no record in "${key}" has ${last} == ${JSON.stringify(lit)}; real values: ${values.join(', ') || '(none)'}`
                  })
                  break
                }
              }
            }
          }
        }
      }
      return
    }
    if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1))
    else if (isRecord(v)) Object.values(v).forEach((x) => walk(x, depth + 1))
  }
  for (const page of spec.pages) for (const node of iterateNodes(page.layout)) walk(node.props, 0)
  for (const item of spec.nav ?? []) walk(item.badge, 0)
}

/** Source keys a spec's props reference via `{"$data": "key.path"}` bindings. */
export function referencedDataKeys(spec: UiSpec): Set<string> {
  const keys = new Set<string>()
  for (const page of spec.pages) {
    for (const node of iterateNodes(page.layout)) {
      const walk = (v: unknown): void => {
        const path = dataBinding(v)
        if (path !== null) {
          keys.add(path.split('.')[0].split('[')[0])
          return
        }
        if (Array.isArray(v)) v.forEach(walk)
        else if (isRecord(v)) Object.values(v).forEach(walk)
      }
      walk(node.props)
    }
  }
  // Bound nav badges read [data] too: polling keeps them fresh as well.
  for (const item of spec.nav ?? []) {
    const path = dataBinding(item.badge)
    if (path !== null) keys.add(path.split('.')[0].split('[')[0])
  }
  return keys
}

/** Stable key describing "which screen this is" for the session render cache. */
export function screenCacheKey(pageId: string, contextHash: string): string {
  return `${pageId}::${contextHash}`
}
