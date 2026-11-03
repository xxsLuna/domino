import { isMutatingControl } from '../actionPolicy'
import type { DominoFile } from '../domino/types'
import type { GraphEdge } from '../pageGraph'
import { resolvePageId } from '../pageLinks'
import { isCancelEvent, isSignOutEvent, type CardNode, type PageSpec, type UiSpec } from '../spec'

/**
 * Background pre-generation: after the first screen settles, the pages a tap
 * would otherwise generate live — planned pages, nav tabs, [script]
 * goto/render targets and pages earlier presses led to — are built a couple
 * at a time while the app is idle, then merged into what the runtime already
 * knows so selecting them switches instantly (no LLM).
 */

/** Background build budget per batch: enough for a typical tab bar plus its first links. */
export const MAX_PREGEN_TARGETS = 6

/** Builds in flight at once — overlaps model latency without flooding the provider. */
export const PREGEN_CONCURRENCY = 2

/** One [pages] plan entry, normalized (the section may be absent: always an array). */
export interface PlannedPage {
  id: string
  name: string
  purpose?: string
  nav: boolean
}

/**
 * The author's page plan, read defensively: files without [pages] (and
 * definitions built by hand in tests) simply have none.
 */
export function plannedPages(domino: DominoFile): PlannedPage[] {
  const raw = (domino as { pages?: unknown }).pages
  if (!Array.isArray(raw)) return []
  const out: PlannedPage[] = []
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue
    const r = p as Record<string, unknown>
    if (typeof r.id !== 'string' || !r.id.trim()) continue
    const id = r.id.trim()
    if (out.some((x) => x.id === id)) continue
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : id
    const purpose = typeof r.purpose === 'string' && r.purpose.trim() ? r.purpose.trim() : undefined
    out.push({ id, name, ...(purpose ? { purpose } : {}), nav: r.nav === true })
  }
  return out
}

/** Plan entries as page stubs, so pageLinks can resolve nav labels against planned names. */
function planAsPages(plan: PlannedPage[]): PageSpec[] {
  return plan.map((p) => ({ id: p.id, name: p.name, layout: [] }))
}

/**
 * Candidate pages, in tap likelihood: planned nav pages first (canonical
 * ids), then the screen's nav items (mapped onto a planned id when their id
 * or label names one), then scripted targets, the rest of the plan, and
 * finally pages the observed action graph led to.
 *
 * A target is skipped when it already resolves to a known page — by id, or
 * through nav-id drift (`orders` → the page named "Orders") — so a page the
 * user has is never rebuilt under a second id; when it was already tried
 * this session (a build that never merges must not be retried on every
 * navigation); and for the login page or, for an auth-required app while
 * signed out, everything — those would be built against the wrong context.
 */
export function pregenTargets(
  domino: DominoFile,
  known: UiSpec,
  loggedIn: boolean,
  observedPages?: string[],
  tried?: Set<string>
): string[] {
  if (domino.auth.required && !loggedIn) return []
  const plan = plannedPages(domino)
  const planPages = planAsPages(plan)
  const targets: string[] = []
  const add = (id: string | undefined): void => {
    if (!id || id === 'login' || targets.includes(id)) return
    if (tried?.has(id)) return
    if (resolvePageId(known.nav, known.pages, id) !== null) return
    targets.push(id)
  }
  for (const p of plan) if (p.nav) add(p.id)
  for (const item of known.nav ?? []) {
    // A drifted nav id that names a planned page builds under the plan's id.
    add(plan.length ? (resolvePageId(known.nav, planPages, item.id) ?? item.id) : item.id)
  }
  for (const rule of domino.script) {
    if (rule.command.kind === 'goto' || rule.command.kind === 'render') add(rule.command.page)
  }
  for (const p of plan) add(p.id)
  for (const pageId of observedPages ?? []) add(pageId)
  return targets.slice(0, MAX_PREGEN_TARGETS)
}

/**
 * The scratch user message for building one page in the background: the
 * plan's name and purpose when the page is declared, so a build from a bare
 * id doesn't guess the wrong content.
 */
export function pregenPagePrompt(domino: DominoFile, pageId: string): string {
  const planned = plannedPages(domino).find((p) => p.id === pageId)
  const about = planned
    ? ` It is "${planned.name}"${planned.purpose ? ` — ${planned.purpose}` : ''}.`
    : ''
  return `INITIAL SCREEN. Show the "${pageId}" page following the screen patterns.${about} Use exactly the page id "${pageId}".`
}

/**
 * Merge one freshly built page into a spec that carries more: the new page
 * wins for its id, every other page and the `page`/`nav` fields stay put —
 * a background build must never change what the user is looking at.
 */
export function mergeKnownPage(base: UiSpec, incoming: UiSpec, pageId: string): UiSpec {
  const page = incoming.pages.find((p) => p.id === pageId)
  if (!page) return base
  return { ...base, pages: [page, ...base.pages.filter((p) => p.id !== pageId)] }
}

/**
 * Drift-aware merge for background builds. The page is picked by exact id,
 * then through the build's own nav (id drift: asked for `orders`, the model
 * built `order-list` and named the nav item after it), then the page the
 * build was showing. When that page is already known to `base` — by id or
 * through drift — the build is discarded (null): a page the runtime has is
 * canonical, a background guess must never shadow it. Otherwise it is
 * inserted under its OWN id, which the returned `pageId` names.
 */
export function mergeBuiltPage(
  base: UiSpec,
  incoming: UiSpec,
  pageId: string
): { spec: UiSpec; pageId: string } | null {
  const resolved = resolvePageId(incoming.nav, incoming.pages, pageId)
  const page =
    incoming.pages.find((p) => p.id === pageId) ??
    (resolved ? incoming.pages.find((p) => p.id === resolved) : undefined) ??
    incoming.pages.find((p) => p.id === incoming.page)
  if (!page) return null
  if (base.pages.some((p) => p.id === page.id)) return null
  if (resolvePageId(base.nav, base.pages, pageId) !== null) return null
  if (resolvePageId(base.nav, base.pages, page.id) !== null) return null
  return { spec: { ...base, pages: [page, ...base.pages] }, pageId: page.id }
}

/** Ids the runtime handles itself or that only make sense on a live press. */
const RUNTIME_IDS = /(?:^|[-_.])(?:(?:un)?subscribe-?feed|refresh-?feeds?|cancel|back)(?:[-_.]|$)/i

/**
 * Buttons worth pre-building a destination for: plain, safe, unexplored.
 *
 * A candidate is a Button outside any Form with no `stateKey`, no data to
 * carry (no `href`/`data`/`url` prop), not bound by [actions], not a
 * sign-out/cancel/feed control, not mutating (see actionPolicy — a Delete
 * must never be "pressed" in the background), and with no observed edge
 * from its page yet. PageHeader buttons come first (the page's main action,
 * usually "New …"), then the rest in layout order; one id once (the same
 * action shares an id across pages).
 */
export function pregenClickTargets(
  known: UiSpec,
  edges: GraphEdge[],
  domino: DominoFile,
  limit: number
): Array<{ pageId: string; nodeId: string; label: string }> {
  if (limit <= 0) return []
  const bound = new Set(domino.actions.map((a) => a.id))
  const header: Array<{ pageId: string; nodeId: string; label: string }> = []
  const rest: Array<{ pageId: string; nodeId: string; label: string }> = []
  const seen = new Set<string>()

  const consider = (pageId: string, node: CardNode, inHeader: boolean): void => {
    if (node.name !== 'Button' || !node.id) return
    const props = node.props ?? {}
    if (typeof props.stateKey === 'string') return
    if (props.href !== undefined || props.data !== undefined || props.url !== undefined) return
    if (bound.has(node.id) || seen.has(node.id)) return
    const probe = { event: 'click', nodeId: node.id }
    if (isSignOutEvent(probe) || isCancelEvent(probe) || RUNTIME_IDS.test(node.id)) return
    if (isMutatingControl(node)) return
    if (edges.some((e) => e.from === pageId && e.action === node.id)) return
    seen.add(node.id)
    const label = typeof props.text === 'string' && props.text ? props.text : node.id
    ;(inHeader ? header : rest).push({ pageId, nodeId: node.id, label })
  }

  const walk = (pageId: string, nodes: CardNode[], inHeader: boolean, depth: number): void => {
    if (depth > 32) return
    for (const node of nodes) {
      if (node.name === 'Form') continue // every press inside a form is a submit or a field
      consider(pageId, node, inHeader)
      if (node.children) walk(pageId, node.children, inHeader || node.name === 'PageHeader', depth + 1)
    }
  }
  for (const page of known.pages) {
    if (page.id === 'login') continue
    walk(page.id, page.layout, false, 0)
  }
  return [...header, ...rest].slice(0, limit)
}
