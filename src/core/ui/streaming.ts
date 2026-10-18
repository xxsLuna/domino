import type { CardNode, PageSpec, UiSpec } from '../spec'

/**
 * What to show while a render_ui call is still streaming.
 *
 * - A different page streams in from scratch: completed nodes render, the
 *   node still being written is a placeholder (`pending`), or nothing at all
 *   until its `grid` arrives (`hidden`) so it can't flash in a wrong spot.
 * - The same page re-rendering (a filter, a save) keeps the current screen and
 *   swaps nodes in by id as their new versions complete — the way a real app
 *   updates in place instead of blanking and rebuilding the page.
 */
export interface StreamView {
  spec: UiSpec
  /** The node still being written; render a placeholder in its slot. */
  pending?: CardNode
  /** Still-streaming node with no position yet; leave it out for now. */
  hidden?: CardNode
}

const pageOf = (spec: UiSpec): PageSpec | undefined =>
  spec.pages.find((p) => p.id === spec.page) ?? spec.pages[0]

export function streamView(current: UiSpec | null, preview: UiSpec): StreamView {
  const next = pageOf(preview)
  if (!next) return { spec: preview }
  const last = next.layout[next.layout.length - 1]
  const prev = current && current.page === preview.page ? pageOf(current) : undefined

  if (!prev) {
    const hidden = last && !last.grid && next.layout.some((n) => n.grid) ? last : undefined
    return { spec: preview, pending: hidden ? undefined : last, hidden }
  }

  // In-place update: keep every current node, replace those whose new version
  // has fully arrived, append brand-new ones.
  const known = new Set(prev.layout.map((n) => n.id).filter(Boolean))
  const arrived = new Map<string, CardNode>()
  for (const n of next.layout) if (n.id && n !== last) arrived.set(n.id, n)
  const layout = prev.layout.map((n) => (n.id && arrived.get(n.id)) || n)
  const fresh = next.layout.filter((n) => !n.id || !known.has(n.id))
  // The streaming node either still shows its current version (known id) or is new.
  const lastIsNew = last !== undefined && fresh.includes(last)
  const hidden = lastIsNew && !last.grid ? last : undefined
  layout.push(...fresh.filter((n) => n !== hidden))

  return {
    spec: {
      ...preview,
      nav: preview.nav ?? current?.nav,
      pages: preview.pages.map((p) => (p === next ? { ...next, layout } : p))
    },
    pending: lastIsNew && !hidden ? last : undefined,
    hidden
  }
}
