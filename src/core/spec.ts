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
  /** Small counter/label shown next to the item (e.g. unread count). */
  badge?: string | number
}

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
  badge: z.union([z.string(), z.number()]).optional()
})

/** Nav items are decorative: drop malformed/half-streamed ones instead of rejecting the spec. */
const navSchema = z.array(z.unknown()).transform((items) =>
  items.flatMap((item) => {
    const parsed = navItemSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
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

/** Walk a `key.a.b` path into the source map (numeric segments index arrays). */
function lookupDataPath(sources: Record<string, unknown>, path: string): unknown {
  const [key, ...rest] = path.split('.')
  let cur: unknown = sources[key]
  for (const seg of rest) {
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) {
      const idx = Number(seg)
      cur = Number.isInteger(idx) ? cur[idx] : undefined
    } else if (isRecord(cur)) {
      cur = cur[seg]
    } else {
      return undefined
    }
  }
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

/** Source keys a spec's props reference via `{"$data": "key.path"}` bindings. */
export function referencedDataKeys(spec: UiSpec): Set<string> {
  const keys = new Set<string>()
  for (const page of spec.pages) {
    for (const node of iterateNodes(page.layout)) {
      const walk = (v: unknown): void => {
        const path = dataBinding(v)
        if (path !== null) {
          keys.add(path.split('.')[0])
          return
        }
        if (Array.isArray(v)) v.forEach(walk)
        else if (isRecord(v)) Object.values(v).forEach(walk)
      }
      walk(node.props)
    }
  }
  return keys
}

/** Stable key describing "which screen this is" for the session render cache. */
export function screenCacheKey(pageId: string, contextHash: string): string {
  return `${pageId}::${contextHash}`
}
