import {
  canAutoLink,
  declaredPageLink,
  isMutatingControl,
  isOpenerControl,
  isReplayableEvent
} from '../actionPolicy'
import type { PlannedPage } from '../agent/pregen'
import type { GraphEdge } from '../pageGraph'
import { resolvePageId } from '../pageLinks'
import { hashContext, type SessionStore } from '../session/session'
import {
  findPage,
  isBackEvent,
  isCancelEvent,
  iterateNodes,
  withTargetPage,
  type CardNode,
  type NavItem,
  type UiSpec
} from '../spec'
import { knownPageIds } from './turn'

/**
 * Navigation continuity — what a press does to the page graph, the screen
 * caches and the back stack, decided without React so every rule is tested.
 *
 * The runtime's shortcuts past the model (an instant switch to a built page,
 * a cached or stored replay, an auto-link along an observed edge) are only
 * right for presses that merely OPEN a page whose content does not depend on
 * what was pressed. Everything else — a submit, a row select, a press on a
 * record's detail page, a Delete — must reach the model (and the API) fresh,
 * and its answer must never be replayed for a different press.
 */

/** The press a turn (or replay) answers — its landing page becomes a graph edge. */
export interface PressAnswer {
  /** Page the press happened on. */
  from: string
  /** Pressed node id. */
  action: string
  /** Human label (button text, form title…). */
  label: string
  event: string
  /**
   * Identity of the record the answer shows: set for data-carrying presses
   * (row select, submit, search…) and for presses on a record's page — the
   * destination's content then depends on WHICH record, not just the button.
   */
  dataKey?: string
}

/** The pressed node on the current page, and whether it sits inside a Form. */
export function nodeContext(
  spec: UiSpec | null,
  nodeId: string
): { node: CardNode | null; inForm: boolean } {
  const page = spec ? findPage(spec, spec.page) : undefined
  if (!page) return { node: null, inForm: false }
  // Iterative, in layout order (the first match wins, like findNode).
  const stack: Array<{ node: CardNode; inForm: boolean; depth: number }> = page.layout
    .map((node) => ({ node, inForm: false, depth: 0 }))
    .reverse()
  while (stack.length) {
    const { node, inForm, depth } = stack.pop()!
    if (node.id === nodeId) return { node, inForm }
    if (depth > 32 || !node.children) continue
    const childInForm = inForm || node.name === 'Form'
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i], inForm: childInForm, depth: depth + 1 })
    }
  }
  return { node: null, inForm: false }
}

/** The graph label of a node: its text / title / label, else the fallback. */
export function nodeLabel(node: CardNode | null, fallback: string): string {
  const props = node?.props ?? {}
  for (const k of ['text', 'title', 'label'] as const) {
    const v = props[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return fallback
}

/** Record identity of a data-carrying press (none for plain clicks and navigation). */
export function pressDataKey(e: {
  event: string
  data?: Record<string, unknown>
}): string | undefined {
  if (e.event === 'navigate') return undefined
  if (!e.data || Object.keys(e.data).length === 0) return undefined
  return hashContext({ ev: e.event, d: e.data })
}

/**
 * The graph edge a press's answer records: none when the answer stayed on
 * the page it was pressed on (an in-place update — recording it as a link
 * would turn the button into a dead self-link), a plain `action` link only
 * for a data-free, read-only open of another page, and a `form` (data
 * action) edge for everything else — those are never auto-linked, and the
 * model's app map lists them as "re-render with fresh data".
 */
export function answerEdge(press: PressAnswer, landed: string, mutated: boolean): GraphEdge | null {
  if (!landed || landed === press.from) return null
  const plain =
    !mutated &&
    press.dataKey === undefined &&
    (press.event === 'click' || press.event === 'navigate')
  return {
    from: press.from,
    to: landed,
    action: press.action,
    label: press.label,
    kind: plain ? 'action' : 'form'
  }
}

/**
 * Whether a turn's answer may be cached for the same press later: only a
 * replayable press, only when the turn wrote nothing, and never an answer
 * that stayed on the page it was pressed on (Next, Refresh, Mark done
 * re-render their page with new data — a cached copy would freeze them).
 */
export function cacheableAnswer(opts: {
  replayable: boolean
  mutated: boolean
  from?: string
  landed: string
}): boolean {
  if (!opts.replayable || opts.mutated) return false
  return opts.from === undefined || opts.landed !== opts.from
}

/** Loose comparison for ids and labels: trim, collapse whitespace, case-insensitive. */
const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase()

/** Id decorations around a page id: `go-orders`, `open_settings`, `orders-btn`. */
const ID_PREFIX = /^(?:go|goto|go-to|open|view|show|nav|to|btn|link)[-_.]/i
const ID_SUFFIX = /[-_.](?:btn|button|link|page)$/i

interface DestinationContext {
  known: UiSpec | null
  nav: readonly NavItem[]
  plan: readonly PlannedPage[]
  currentPage: string
}

/**
 * The page a Button/Link `to` names, resolved like any page reference: a
 * built page (by id, nav id or name) first, then a [pages] plan entry (by id
 * or name); an explicit `to` is trusted even when nothing matches yet.
 */
export function declaredDestination(
  node: CardNode | null,
  ctx: Pick<DestinationContext, 'known' | 'nav' | 'plan'>
): { pageId: string; built: boolean } | null {
  const target = declaredPageLink(node)
  if (!target) return null
  const built = resolvePageId([...ctx.nav], ctx.known?.pages ?? [], target)
  if (built) return { pageId: built, built: true }
  const planned =
    ctx.plan.find((p) => norm(p.id) === norm(target)) ??
    ctx.plan.find((p) => norm(p.name) === norm(target))
  return { pageId: planned?.id ?? target, built: false }
}

/**
 * The page a plain control names itself, before any press was observed:
 * an explicit `to` prop (Button/Link), an id that IS a page id once the
 * usual decorations are stripped (`go-orders` → `orders`), or a label equal
 * to a page's name. Exact matches only — fuzzy text ("View all orders")
 * would misroute action buttons like "Add order". Built pages win over the
 * [pages] plan; an explicit `to` is trusted even when nothing matches yet.
 */
export function namedDestination(
  node: CardNode | null,
  ctx: DestinationContext
): { pageId: string; built: boolean } | null {
  if (!node || (node.name !== 'Button' && node.name !== 'Link')) return null
  if (isMutatingControl(node)) return null
  const pages = ctx.known?.pages ?? []
  const nav = [...ctx.nav]
  const accept = (pageId: string, built: boolean): { pageId: string; built: boolean } | null =>
    pageId === ctx.currentPage || pageId === 'login' ? null : { pageId, built }
  const builtById = (raw: string): string | null => {
    const t = norm(raw)
    if (!t) return null
    const page = pages.find((p) => norm(p.id) === t)
    if (page) return page.id
    const item = nav.find((i) => norm(i.id) === t)
    return item ? resolvePageId(nav, pages, item.id) : null
  }
  const plannedById = (raw: string): string | null =>
    ctx.plan.find((p) => norm(p.id) === norm(raw))?.id ?? null

  const declared = declaredDestination(node, ctx)
  if (declared) return accept(declared.pageId, declared.built)

  if (node.id) {
    const stem = node.id.replace(ID_PREFIX, '').replace(ID_SUFFIX, '')
    for (const candidate of new Set([node.id, stem])) {
      const built = builtById(candidate)
      if (built) return accept(built, true)
      const planned = plannedById(candidate)
      if (planned) return accept(planned, false)
    }
  }

  const label = node.props?.text
  if (typeof label === 'string' && label.trim()) {
    const t = norm(label)
    const page = pages.find((p) => norm(p.name) === t)
    if (page) return accept(page.id, true)
    const planned = ctx.plan.find((p) => norm(p.name) === t)
    if (planned) {
      const built = resolvePageId(nav, pages, planned.id)
      return accept(built ?? planned.id, built !== null)
    }
  }
  return null
}

export interface PressInput {
  e: { event: string; nodeId: string; data?: Record<string, unknown> }
  /** Page the press happened on. */
  pageId: string
  /** The settled screen (the pressed node lives on its current page). */
  spec: UiSpec | null
  /** Everything the runtime knows (background-built pages included). */
  known: UiSpec | null
  nav: readonly NavItem[]
  plan: readonly PlannedPage[]
  edges: readonly GraphEdge[]
  /** Pages whose canonical copy shows one record (page id → record identity). */
  recordPages: ReadonlyMap<string, string>
  /** The [actions] goto this press declares (not built yet). */
  declaredTarget?: string
}

export interface PressPlan {
  /** A built page to switch to right now — no model turn. */
  switchTo: string | null
  /** The press's answer may be read from / written to the screen caches. */
  replayable: boolean
  /** Its destination depends on the press (record, query, write). */
  recordDependent: boolean
  /** Destination hint for the turn prompt (declared, named, or observed). */
  guidedTo: string | null
  /**
   * A built page the turn should switch to (after any write) instead of
   * designing it again — set only when the press still needs a turn.
   */
  reuse: string | null
  /** What the answer records on landing. */
  answer: PressAnswer
}

/**
 * Decide what one press does before any model turn:
 *
 * - **Instant switch** — a plain, read-only click (not in a Form, not on a
 *   record's page) switches to a built page when an observed edge says it
 *   leads there (canAutoLink) or the control names the page itself (`to`,
 *   its id, its label). A destination whose canonical copy shows one record
 *   is never auto-linked: that copy belongs to another press.
 * - **Reuse** — an opener press ("추가", "Add": it may write, so it still
 *   needs a turn) heading for a built, record-independent page: the turn
 *   makes its write, if any, and switches to that page instead of
 *   designing it again.
 * - **Replayable** — only isReplayableEvent presses on non-mutating
 *   controls, and never a plain click on a record's page (the same button
 *   on another record's detail page must not replay the first record's
 *   answer).
 * - **Record-dependent** — a press whose data, or whose page's record,
 *   decides the destination's content: the turn may not navigate to a
 *   stored copy (it would show the previous record) and must re-render.
 */
export function planPress(input: PressInput): PressPlan {
  const { e, pageId, known, nav, plan, edges, recordPages } = input
  const { node, inForm } = nodeContext(input.spec, e.nodeId)
  const fromRecord = recordPages.get(pageId)
  const plainClick = e.event === 'click' && (!e.data || Object.keys(e.data).length === 0)
  const dataKey =
    pressDataKey(e) ??
    (fromRecord !== undefined && e.event !== 'navigate'
      ? hashContext({ rec: fromRecord, id: e.nodeId })
      : undefined)
  const recordDependent = dataKey !== undefined || !isReplayableEvent(e)
  const navigation = e.event === 'navigate' || e.event === 'select'
  const replayable =
    isReplayableEvent(e) &&
    (navigation || !isMutatingControl(node, { inForm })) &&
    !(fromRecord !== undefined && e.event === 'click')
  const answer: PressAnswer = {
    from: pageId,
    action: e.nodeId,
    label: nodeLabel(node, e.nodeId),
    event: e.event,
    ...(dataKey !== undefined ? { dataKey } : {})
  }
  const pages = known?.pages ?? []
  const builtTarget = (id: string): string | null => {
    const resolved = resolvePageId([...nav], pages, id)
    return resolved && resolved !== pageId ? resolved : null
  }

  let switchTo: string | null = null
  let named: { pageId: string; built: boolean } | null = null
  if (plainClick && !inForm && fromRecord === undefined) {
    // Newest observation first: the latest answer is what the button does now.
    for (let i = edges.length - 1; i >= 0 && !switchTo; i--) {
      const edge = edges[i]
      if (edge.from !== pageId || edge.action !== e.nodeId) continue
      if (!canAutoLink(edge, node, pageId)) continue
      const target = builtTarget(edge.to)
      if (target && !recordPages.has(target)) switchTo = target
    }
    if (!switchTo) {
      named = namedDestination(node, { known, nav, plan, currentPage: pageId })
      if (named?.built && !recordPages.has(named.pageId)) switchTo = named.pageId
    }
  }

  const observed = [...edges]
    .reverse()
    .find(
      (x) =>
        x.from === pageId &&
        x.action === e.nodeId &&
        (x.kind === 'action' || x.kind === 'form') &&
        x.to !== '' &&
        x.to !== pageId
    )
  const navTarget = e.event === 'navigate' ? String(e.data?.page ?? e.nodeId) : null
  // An opener's own `to` names its page although the press may write
  // (namedDestination skips it): the first build then lands under that id.
  const opener = isOpenerControl(node, { inForm })
  const declared = opener ? declaredDestination(node, { known, nav, plan }) : null
  const guidedTo =
    input.declaredTarget ??
    navTarget ??
    (named ? named.pageId : null) ??
    observed?.to ??
    (declared && declared.pageId !== pageId ? declared.pageId : null) ??
    null

  // An opener still needs a turn (it may write), but its page is already
  // built: where its latest answer landed without writing, or the page its
  // `to` names. Never after a write (that page may have to show new data),
  // never a record's page, never for a control that always acts (Pay,
  // Delete, a danger or confirm button).
  let reuse: string | null = null
  if (!switchTo && !recordDependent && plainClick && !input.declaredTarget && opener) {
    const candidate = observed
      ? observed.kind === 'action'
        ? observed.to
        : null
      : (declared?.pageId ?? null)
    const target = candidate ? builtTarget(candidate) : null
    if (target && !recordPages.has(target)) reuse = target
  }
  return { switchTo, replayable, recordDependent, guidedTo, reuse, answer }
}

/**
 * Page ids a turn may `navigate` to. A page whose canonical copy shows one
 * record is never offered (switching to it would show whichever record was
 * opened last) — the model re-renders it instead. A record-dependent press
 * may only switch to the tabs; any other press to every other built page.
 */
export function turnKnownPages(
  known: UiSpec | null,
  nav: readonly NavItem[],
  recordPages: ReadonlyMap<string, string>,
  recordDependent: boolean
): string[] {
  const all = knownPageIds(known, nav)
  if (!known) return all
  return all.filter((id) => {
    const resolved = resolvePageId([...nav], known.pages, id) ?? id
    if (recordPages.has(resolved)) return false
    return !recordDependent || nav.some((i) => i.id === id || i.id === resolved)
  })
}

/**
 * The screen a cached/stored replay shows. A plain press's destination does
 * not depend on the press, so the canonical (possibly edited since) copy is
 * shown when the runtime has one; a data press shows the copy it cached —
 * its content belongs to that record — merged so it replaces only its own
 * page (withTargetPage).
 */
export function replayView(hit: UiSpec, known: UiSpec | null, preferCanonical: boolean): UiSpec {
  const merged = withTargetPage(hit, known)
  if (!preferCanonical || !known) return merged
  const canonical = findPage(known, hit.page)
  if (!canonical) return merged
  return { ...merged, pages: merged.pages.map((p) => (p.id === hit.page ? canonical : p)) }
}

/**
 * Back/forward pick WHICH page to show, normally its current canonical copy
 * ("which, not when": an edit made since stays). Pages reused across records
 * (one `order-detail` for every order) are the exception: a moment that
 * showed record A comes back as record A, not as whichever record the
 * canonical copy shows now. A page the canonical set lacks (rebuilt away)
 * falls back to the snapshot's own copy.
 */
export function backView(
  snap: { spec: UiSpec; dataKey?: string; recordLanding?: boolean },
  known: UiSpec | null,
  recordPages: ReadonlyMap<string, string>
): { spec: UiSpec; usedSnapshotCopy: boolean } {
  if (!known) return { spec: snap.spec, usedSnapshotCopy: true }
  const target = snap.spec.page
  const own = findPage(snap.spec, target)
  const canonical = findPage(known, target)
  // Only a press that LANDED on this page from another one gave it a record
  // identity; an in-place data press (search, filter, next page) left a
  // plain list behind, which comes back as the canonical list.
  const record = snap.recordLanding === true ? snap.dataKey : undefined
  if (canonical) {
    if (record !== undefined && recordPages.get(target) !== record && own) {
      return {
        spec: {
          ...known,
          page: target,
          pages: known.pages.map((p) => (p.id === target ? own : p))
        },
        usedSnapshotCopy: true
      }
    }
    return { spec: { ...known, page: target }, usedSnapshotCopy: false }
  }
  if (!own) return { spec: known, usedSnapshotCopy: false }
  return { spec: { ...known, page: target, pages: [...known.pages, own] }, usedSnapshotCopy: true }
}

/**
 * Which record each reused page showed last, rebuilt from a restored back
 * stack (oldest first): a moment that LANDED on its page with a record
 * identity marks that page; a press or start moment without one — an
 * in-place data press (search, pagination) included — shows a plain copy.
 * Instant switches and edits don't change which record a page shows. Pages
 * `isNavPage` names (the tabs) are lists, never record pages.
 */
export function recordPagesFromHistory(
  entries: ReadonlyArray<{
    pageId: string
    kind: string
    dataKey?: string
    recordLanding?: boolean
  }>,
  isNavPage: (pageId: string) => boolean = () => false
): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of entries) {
    if (m.dataKey !== undefined && m.recordLanding === true && !isNavPage(m.pageId)) {
      out.set(m.pageId, m.dataKey)
    } else if (m.kind === 'action' || m.kind === 'start') {
      out.delete(m.pageId)
    }
  }
  return out
}

/**
 * A press that just leaves the current page — Back anywhere, Cancel on a
 * page that holds a form (a create/edit screen): the runtime steps back in
 * its own history instead of asking the model to redraw the previous page.
 * A cancel-suffixed id elsewhere ("order-cancel" on a detail page) may
 * cancel a RECORD, so it still goes to the model.
 */
export function dismissesPage(e: { event: string; nodeId: string }, spec: UiSpec | null): boolean {
  if (isBackEvent(e)) return true
  if (!isCancelEvent(e) || !spec) return false
  const page = findPage(spec, spec.page)
  if (!page) return false
  for (const node of iterateNodes(page.layout)) if (node.name === 'Form') return true
  return false
}

/**
 * Reopen: the view snapshot (where the user was) and the history stack are
 * written by separate debounced writes, so after a crash or a kill they can
 * disagree. The view wins — it is what was on screen — and the stack is
 * moved to its newest moment on that page, or gets one pushed for it, so
 * Back/Forward continue from the screen actually shown.
 */
export function alignHistoryWithView(
  session: Pick<SessionStore, 'current' | 'lastIndexOf' | 'jumpTo' | 'push'>,
  view: { page: string; known: UiSpec }
): 'aligned' | 'jumped' | 'pushed' {
  if (session.current?.spec.page === view.page) return 'aligned'
  const i = session.lastIndexOf(view.page)
  if (i >= 0 && session.jumpTo(i)) return 'jumped'
  session.push({ ...view.known, page: view.page }, { kind: 'restore' })
  return 'pushed'
}

/**
 * The tab bar the [pages] plan implies: its `nav` entries, used when a
 * screen arrives with no navigation (and appended for planned tabs the
 * model's nav left out), so every planned section is reachable — and gets
 * pre-built — even when the model forgot the bar.
 */
export function navWithPlan(items: readonly NavItem[], plan: readonly PlannedPage[]): NavItem[] {
  const planned = plan.filter((p) => p.nav)
  if (planned.length === 0) return [...items]
  const missing = planned.filter(
    (p) =>
      !items.some(
        (i) =>
          norm(i.id) === norm(p.id) || norm(i.label) === norm(p.name) || norm(i.id) === norm(p.name)
      )
  )
  if (missing.length === 0) return [...items]
  return [...items, ...missing.map((p) => ({ id: p.id, label: p.name }))]
}

/**
 * A press whose [actions] route is `goto <declared>` (a page not built yet)
 * reached the model, which designed the page under another id. The declared
 * id is the contract — the next press resolves it by id and switches with no
 * model turn — so a NEW landing page is renamed to it (page entry, nav item,
 * pointer). An answer that stayed on the pressed page, landed on a page that
 * already existed, or left the declared page elsewhere in the spec is kept.
 */
export function adoptDeclaredId(
  spec: UiSpec,
  declared: string,
  before: UiSpec | null,
  from: string
): UiSpec {
  const landed = spec.page
  if (landed === declared || landed === from) return spec
  if (findPage(spec, declared)) return spec
  if (before && findPage(before, landed)) return spec
  if (!/^[A-Za-z0-9_-]+$/.test(declared)) return spec
  return {
    ...spec,
    page: declared,
    pages: spec.pages.map((p) => (p.id === landed ? { ...p, id: declared } : p)),
    ...(spec.nav
      ? { nav: spec.nav.map((i) => (i.id === landed ? { ...i, id: declared } : i)) }
      : {})
  }
}

/**
 * An exported app's action graph (its [screens] embed) seeds this device's
 * map without overwriting what this device observed itself: an embedded
 * answer is added only for a (page, action) the local graph has no answer
 * for, and plain-link self-loops are never taken over.
 */
export function mergeEmbeddedEdges(
  local: readonly GraphEdge[],
  embedded: readonly GraphEdge[]
): GraphEdge[] {
  const out = [...local]
  const seen = new Set(local.map((e) => `${e.from}|${e.action}`))
  for (const e of embedded) {
    if (e.kind === 'action' && e.from === e.to) continue
    const key = `${e.from}|${e.action}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out
}

/**
 * The known pages after showing another record's own copy of `pageId`
 * (Back/Forward onto that record's moment): the merge keeps the CANONICAL
 * copy `previous` holds for that page, so an edit made to the page since is
 * never reverted by the older copy — in memory, the saved view, or after a
 * restart. Without a canonical copy (or no page to keep) `merged` stands.
 */
export function keepCanonicalPage(
  merged: UiSpec,
  previous: UiSpec | null,
  pageId: string | undefined
): UiSpec {
  if (!pageId) return merged
  const canonical = previous ? findPage(previous, pageId) : null
  if (!canonical) return merged
  return { ...merged, pages: merged.pages.map((p) => (p.id === pageId ? canonical : p)) }
}
