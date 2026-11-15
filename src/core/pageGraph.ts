import type { CardNode, NavItem, UiSpec } from './spec'
import { resolvePageId } from './pageLinks'
import type { KeyValueStorage } from './session/prefs'
import type { DominoFile } from './domino/types'

/**
 * pageGraph — the page ↔ action relationship model behind the mermaid view.
 *
 * Pages and their action widgets (buttons, form submits, row taps) are read
 * from the current known spec every time the graph is drawn; the DESTINATION
 * of each action is what accumulates: observed edges are recorded while the
 * app runs (a tap that switched pages, a runtime [actions] rule, a generation
 * turn landing a new page) and persisted per domino. An action with no known
 * destination is the "공갈버튼" case — shown dashed-red, wired to a
 * "실시간 생성" phantom, because pressing it generates the missing page live.
 */

export type GraphEdgeKind = 'nav' | 'action' | 'data' | 'state' | 'form'

export interface GraphEdge {
  /** Page the action sits on; `tabs` for the pseudo tab-bar node. */
  from: string
  /** Destination page id; `''` = unknown (live-generates on press). */
  to: string
  /** Acting node id (or `nav:<id>`). */
  action: string
  /** Human label: the button text, form title, tab label… */
  label: string
  kind: GraphEdgeKind
  /**
   * A learned link for an opener ("품목 추가" with `to`): the model answered
   * a press by switching, with no API call at all, to exactly the page the
   * button declares, and the press never wrote. canAutoLink follows it.
   */
  reused?: true
}

/** Observed-edge key — one destination per (page, action, kind). */
const edgeKey = (e: GraphEdge): string => `${e.from}|${e.action}|${e.kind}`

/** What a widget IS, independent of where it leads. */
export interface GraphAction {
  page: string
  id: string
  label: string
  kind: 'button' | 'form' | 'row' | 'state'
  /** Node id appears in the domino's [actions]: the runtime owns its steps. */
  bound: boolean
}

export interface PageGraphModel {
  /** Page ids in spec order. */
  pages: Array<{ id: string; name: string }>
  /** Tab-bar items pointing at pages (dashed pseudo node). */
  nav: Array<{ id: string; label: string; to: string }>
  /** Every action widget found on the known pages. */
  actions: GraphAction[]
  /** Observed/[actions]-derived destinations, deduped and sorted. */
  edges: GraphEdge[]
}

/** Collect every action-capable widget from the known pages of a spec. */
export function collectActions(spec: UiSpec, domino: DominoFile): GraphAction[] {
  const bound = new Set(domino.actions.map((a) => a.id))
  const out: GraphAction[] = []
  const push = (
    page: string,
    id: string,
    label: string,
    kind: GraphAction['kind'],
    nodeBound: boolean
  ): void => {
    out.push({ page, id, label, kind, bound: nodeBound })
  }
  const walk = (page: string, nodes: CardNode[], inForm: boolean): void => {
    for (const node of nodes) {
      if (node.name === 'Form') {
        // The form IS the action: its submit dispatches with the form's id,
        // so its child Buttons are never separate graph actions.
        const title = typeof node.props?.title === 'string' ? node.props.title : (node.id ?? '폼')
        push(page, node.id ?? title, `${title} 제출`, 'form', bound.has(node.id ?? ''))
        walk(page, node.children ?? [], true)
        continue
      }
      if (node.name === 'Button' && !inForm) {
        const text = typeof node.props?.text === 'string' ? node.props.text : (node.id ?? '버튼')
        const local = typeof node.props?.stateKey === 'string'
        push(page, node.id ?? text, text, local ? 'state' : 'button', bound.has(node.id ?? ''))
      } else if (node.name === 'Table' && node.props?.rowAction === true && !inForm) {
        push(page, node.id ?? 'table', '행 선택', 'row', false)
      }
      walk(page, node.children ?? [], inForm)
    }
  }
  for (const page of spec.pages) walk(page.id, page.layout, false)
  return out
}

/** Merge pages, nav, widgets and observed edges into the drawable model. */
export function buildPageGraph(
  spec: UiSpec,
  nav: NavItem[],
  domino: DominoFile,
  observed: GraphEdge[]
): PageGraphModel {
  const seen = new Map<string, GraphEdge>()
  for (const e of observed) seen.set(edgeKey(e), e)

  const actions = collectActions(spec, domino)
  const declFor = (id: string): string | null => {
    const decl = domino.actions.find((a) => a.id === id)
    return decl ? decl.steps.map((s) => s.kind).join('+') : null
  }

  const edges: GraphEdge[] = []
  const known = new Set(spec.pages.map((p) => p.id))
  const nodeLabel = (pageId: string, actionId: string, fallback: string): string =>
    actions.find((a) => a.page === pageId && a.id === actionId)?.label ?? fallback

  // Nav: the tab bar itself is a node; each item resolves to a known page or
  // stays a live-generation target.
  for (const item of nav) {
    const to = resolvePageId(nav, spec.pages, item.id) ?? (known.has(item.id) ? item.id : '')
    edges.push({
      from: 'tabs',
      to,
      action: `nav:${item.id}`,
      label: `탭 ${item.label}`,
      kind: 'nav'
    })
  }

  // One edge per widget: observed destination wins, then the [actions] decl,
  // then unknown (공갈 → 실시간 생성).
  for (const a of actions) {
    const obs = seen.get(`${a.page}|${a.id}|action`) ?? seen.get(`${a.page}|${a.id}|form`)
    if (a.kind === 'state') {
      edges.push({
        from: a.page,
        to: a.page,
        action: a.id,
        label: `${a.label} (상태)`,
        kind: 'state'
      })
      continue
    }
    if (obs) {
      edges.push({ ...obs, label: nodeLabel(a.page, a.id, obs.label) })
      continue
    }
    const decl = declFor(a.id)
    if (decl) {
      const gotoStep = domino.actions
        .find((d) => d.id === a.id)
        ?.steps.find((s) => s.kind === 'goto')
      if (gotoStep && gotoStep.kind === 'goto') {
        const to =
          resolvePageId(nav, spec.pages, gotoStep.page) ??
          (known.has(gotoStep.page) ? gotoStep.page : '')
        edges.push({
          from: a.page,
          to,
          action: a.id,
          label: nodeLabel(a.page, a.id, a.label),
          kind: 'action'
        })
        continue
      }
      // refresh/set only: stays on the page, data updates in place.
      edges.push({
        from: a.page,
        to: a.page,
        action: a.id,
        label: nodeLabel(a.page, a.id, a.label),
        kind: 'data'
      })
      continue
    }
    edges.push({
      from: a.page,
      to: '',
      action: a.id,
      label: nodeLabel(a.page, a.id, a.label),
      kind: a.kind === 'form' ? 'form' : 'action'
    })
  }

  // Observed edges whose widget is no longer on any page (an old screen):
  // keep them only when both ends still exist — the graph mirrors the app as
  // it stands, not as it once was.
  const actionIds = new Set(actions.map((a) => `${a.page}|${a.id}`))
  for (const e of seen.values()) {
    if (e.from === 'tabs') continue // nav edges were re-derived above
    if (e.kind === 'nav') continue
    if (!actionIds.has(`${e.from}|${e.action}`)) continue
    if (edges.some((x) => edgeKey(x) === edgeKey(e))) continue
    edges.push(e)
  }

  edges.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)))
  return {
    pages: spec.pages.map((p) => ({ id: p.id, name: p.name })),
    nav: nav.map((n) => ({
      id: n.id,
      label: n.label,
      to: resolvePageId(nav, spec.pages, n.id) ?? (known.has(n.id) ? n.id : '')
    })),
    actions,
    edges
  }
}

/**
 * The compact "app map" the MODEL sees each turn: which pages exist, which
 * actions are already wired to a page, and which buttons still have no page.
 * Derived from the same model as the mermaid view (structured lines instead —
 * token-cheap and unambiguous).
 */
export function pageMapLines(
  spec: UiSpec,
  nav: NavItem[],
  domino: DominoFile,
  observed: GraphEdge[]
): string[] {
  const model = buildPageGraph(spec, nav, domino, observed)
  const lines: string[] = []
  lines.push(
    `Pages (id: name) — ${model.pages.map((p) => `${p.id}: ${p.name}`).join(', ') || '(none yet)'}`
  )
  // A press that stayed on its page updated it in place — never a link. A
  // row select or form submit lands on a page whose CONTENT depends on the
  // press: the model must re-render it, so those go on their own line.
  const widgetKind = (e: GraphEdge): GraphAction['kind'] | undefined =>
    model.actions.find((a) => a.page === e.from && a.id === e.action)?.kind
  const moves = model.edges.filter(
    (e) => e.from !== 'tabs' && e.to && e.to !== e.from && e.kind !== 'state' && e.kind !== 'nav'
  )
  const isData = (e: GraphEdge): boolean =>
    e.kind === 'form' || widgetKind(e) === 'row' || widgetKind(e) === 'form'
  const linked = moves.filter((e) => !isData(e)).map((e) => `${e.from}/${e.label} → ${e.to}`)
  if (linked.length > 0) lines.push(`Connected actions — ${linked.join('; ')}`)
  const data = moves.filter(isData).map((e) => `${e.from}/${e.label} → ${e.to}`)
  if (data.length > 0) {
    lines.push(
      `Data actions (destination layout exists — re-render that page id with the pressed record / fresh data, keep its layout and ids; never navigate) — ${data.join('; ')}`
    )
  }
  const loose = model.actions
    .filter(
      (a) =>
        a.kind !== 'state' &&
        !a.bound &&
        !model.edges.some(
          (e) => e.action === a.id && e.from === a.page && e.to !== '' && e.kind !== 'data'
        )
    )
    .map((a) => `${a.page}/${a.label} (${a.id})`)
  if (loose.length > 0)
    lines.push(`Buttons with no page yet (a press generates it) — ${loose.join('; ')}`)
  // Hard cap: a huge app must never crowd the rules out of the prompt.
  return lines.map((l) => (l.length > 700 ? `${l.slice(0, 700)}…(trimmed)` : l)).slice(0, 12)
}

/* ------------------------------ persistence ------------------------------ */

const graphKey = (dominoId: string): string => `domino:graph:${dominoId}`
const MAX_EDGES = 300
const writersKey = (dominoId: string): string => `domino:writers:${dominoId}`
const MAX_WRITERS = 300

/**
 * Opener actions (by id) ever seen sending a write — kept across restarts,
 * since a write that re-rendered its own page, failed or was interrupted
 * leaves no data-action edge behind. Such an action is never learned as a
 * link. Newest last: the cap drops the marks least recently confirmed.
 */
export async function loadWriterPresses(
  storage: KeyValueStorage,
  dominoId: string
): Promise<Set<string>> {
  try {
    const raw = await storage.get(writersKey(dominoId))
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return new Set(Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : [])
  } catch {
    return new Set()
  }
}

export async function saveWriterPresses(
  storage: KeyValueStorage,
  dominoId: string,
  writers: ReadonlySet<string>
): Promise<void> {
  try {
    await storage.set(writersKey(dominoId), JSON.stringify([...writers].slice(-MAX_WRITERS)))
  } catch {
    /* a failed save never breaks the app */
  }
}

export async function loadPageGraph(
  storage: KeyValueStorage,
  dominoId: string
): Promise<GraphEdge[]> {
  try {
    const raw = await storage.get(graphKey(dominoId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as { edges?: unknown }
    if (!Array.isArray(parsed.edges)) return []
    return parsed.edges.filter(
      (e): e is GraphEdge =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as GraphEdge).from === 'string' &&
        typeof (e as GraphEdge).to === 'string' &&
        typeof (e as GraphEdge).action === 'string' &&
        typeof (e as GraphEdge).label === 'string' &&
        typeof (e as GraphEdge).kind === 'string' &&
        // Older builds recorded in-place updates (Delete, Refresh, Next) as
        // self-loop links, which froze those buttons for good: drop them.
        !((e as GraphEdge).kind === 'action' && (e as GraphEdge).from === (e as GraphEdge).to)
    )
  } catch {
    return []
  }
}

export async function savePageGraph(
  storage: KeyValueStorage,
  dominoId: string,
  edges: GraphEdge[]
): Promise<void> {
  const bounded = edges.slice(-MAX_EDGES)
  try {
    await storage.set(graphKey(dominoId), JSON.stringify({ v: 1, edges: bounded }))
  } catch {
    /* a failed graph save never breaks the app */
  }
}

/** Deduped append (same page+action+kind keeps one destination; newest wins). */
export function upsertEdge(edges: GraphEdge[], edge: GraphEdge): GraphEdge[] {
  const key = edgeKey(edge)
  return [...edges.filter((e) => edgeKey(e) !== key), edge]
}

/**
 * Record the answer to a press: one destination per (page, action) across
 * the plain-link and data-action kinds — a button that once linked and
 * later wrote data (or the reverse) keeps only its newest meaning, so a
 * stale 'action' edge can't keep auto-linking a press that now mutates.
 */
export function upsertAnswerEdge(edges: GraphEdge[], edge: GraphEdge): GraphEdge[] {
  const answers = (e: GraphEdge): boolean => e.kind === 'action' || e.kind === 'form'
  if (!answers(edge)) return upsertEdge(edges, edge)
  return [
    ...edges.filter((e) => !(e.from === edge.from && e.action === edge.action && answers(e))),
    edge
  ]
}

/**
 * After a page was edited, edges from it whose widget no longer exists on
 * the edited page are dropped: a removed (or reused) id must not keep
 * steering auto-links and the model's app map. Kept ids keep their edges.
 */
export function pruneEdgesForPage(
  edges: GraphEdge[],
  page: { id: string; layout: CardNode[] }
): GraphEdge[] {
  const ids = new Set<string>()
  const walk = (nodes: CardNode[], depth: number): void => {
    if (depth > 32) return
    for (const n of nodes) {
      if (n.id) ids.add(n.id)
      if (n.children) walk(n.children, depth + 1)
    }
  }
  walk(page.layout, 0)
  const next = edges
    .filter((e) => e.from !== page.id || e.kind === 'nav' || ids.has(e.action))
    // An edit may have changed what a kept button does: its learned link is
    // learned again (one turn) instead of trusted.
    .map((e) => (e.from === page.id && e.reused ? unlearned(e) : e))
  return next.length === edges.length && next.every((e, i) => e === edges[i]) ? edges : next
}

function unlearned(edge: GraphEdge): GraphEdge {
  const { reused: _reused, ...rest } = edge
  return rest
}

/**
 * The graph without learned links (`reused`): for an auth-state switch (one
 * user's "already joined" says nothing about the next) and for graphs that
 * travel in a file. Learning one again costs one model turn.
 */
export function withoutLearned(edges: GraphEdge[]): GraphEdge[] {
  return edges.some((e) => e.reused) ? edges.map((e) => (e.reused ? unlearned(e) : e)) : edges
}

/**
 * Pages the observed presses actually led to, unique and in first-seen order.
 * Pre-generation warms these after nav and script targets: a page the user
 * reached once is the likeliest next press. A press that stayed on its own
 * page (an in-place update) leads nowhere new.
 */
export function observedDests(edges: GraphEdge[]): string[] {
  return [
    ...new Set(
      edges.filter((e) => e.kind === 'action' && e.to !== '' && e.to !== e.from).map((e) => e.to)
    )
  ]
}

/* -------------------------------- mermaid -------------------------------- */

/** Mermaid node ids stay [A-Za-z0-9_]; labels drop mermaid-significant chars. */
const idOf = (prefix: string, raw: string, used: Set<string>): string => {
  const base = `${prefix}_${raw.replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 48)
  let id = base
  for (let n = 2; used.has(id); n++) id = `${base}${n}`
  used.add(id)
  return id
}
const labelOf = (raw: string): string =>
  raw
    .replace(/["`{}<>|\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24) || '?'

/**
 * The mermaid flowchart: tab bar → pages → every action button → its
 * destination (a page, itself for data/state, or the live-gen phantom).
 */
export function toMermaid(model: PageGraphModel): string {
  const used = new Set<string>()
  const lines: string[] = ['flowchart TD']
  const pageId = new Map<string, string>()
  for (const p of model.pages) pageId.set(p.id, idOf('p', p.id, used))
  for (const p of model.pages) lines.push(`  ${pageId.get(p.id)}["${labelOf(p.name)} (${p.id})"]`)

  const tabsId = model.nav.length > 0 ? idOf('t', 'tabs', used) : null
  if (tabsId) lines.push(`  ${tabsId}(["탭 바"])`)

  // Action nodes: page --> button --> destination. Unknown destination wires
  // to the shared 실시간 생성 phantom so the graph never shows dead ends.
  const live = idOf('g', 'live', used)
  let hasLive = false
  for (const e of model.edges) {
    const fromId = e.from === 'tabs' ? tabsId : pageId.get(e.from)
    if (!fromId) continue
    if (e.from === 'tabs') {
      // Nav edges: tab bar straight to the page.
      const to = e.to && pageId.has(e.to) ? pageId.get(e.to) : null
      if (to) {
        lines.push(`  ${fromId} -.->|"${labelOf(e.label)}"| ${to}`)
      } else {
        hasLive = true
        lines.push(`  ${fromId} -.->|"${labelOf(e.label)}"| ${live}`)
      }
      continue
    }
    if (e.kind === 'state') {
      lines.push(`  ${fromId} -->|"${labelOf(e.label)}"| ${fromId}`)
      continue
    }
    if (e.kind === 'data') {
      lines.push(`  ${fromId} -->|"${labelOf(e.label)} ↻ 데이터"| ${fromId}`)
      continue
    }
    const act = idOf('a', `${e.from}_${e.action}`, used)
    const dest = e.to && pageId.has(e.to) ? pageId.get(e.to) : null
    lines.push(`  ${act}("${labelOf(e.label)}")`)
    lines.push(`  ${fromId} --> ${act}`)
    if (dest) {
      lines.push(`  ${act} -->|${e.kind === 'form' ? '제출' : '이동'}| ${dest}`)
    } else {
      hasLive = true
      lines.push(`  ${act} -.->|실시간 생성| ${live}`)
    }
  }

  if (hasLive) {
    lines.push(`  ${live}{"⚡ 실시간 생성"}`)
    lines.push(`  classDef unresolved stroke:#f43f5e,color:#f43f5e,stroke-dasharray:4 3;`)
    lines.push(`  class ${live} unresolved;`)
  }
  return lines.join('\n')
}
