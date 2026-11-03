import type { PlannedPage } from '../agent/pregen'
import { resolvePageId } from '../pageLinks'
import type { NavItem, UiSpec } from '../spec'

/**
 * What a press does while a turn is running, and what the user sees while
 * the next screen is on its way.
 */

/** The control whose press the running user turn answers. */
export interface InflightAction {
  nodeId: string
  event: string
  pageId: string
}

export interface PressContext {
  /** Some turn owns the lane right now. */
  turnActive: boolean
  turnKind: 'user' | 'edit' | null
  /** What the running user turn was started by (null: boot, edit, palette…). */
  turnAction: InflightAction | null
  /** Page id of the streaming preview, when one is on screen. */
  previewPage: string | null
  /** Page the settled screen shows. */
  currentPage: string | null
}

/**
 * Presses the runtime drops instead of starting another turn:
 * - the same submit/click again while its own turn still runs (a double
 *   submit would send the write twice — the first one is already underway);
 * - a press on a NEW page that is still streaming in: its nodes are half
 *   written, and the action would be attributed to a page that doesn't
 *   exist yet. In-place updates of the current page stay interactive.
 * Every other press supersedes the running turn — the latest intent wins.
 */
export function shouldIgnorePress(
  e: { event: string; nodeId: string; pageId?: string },
  ctx: PressContext
): boolean {
  if (!ctx.turnActive || ctx.turnKind !== 'user') return false
  const a = ctx.turnAction
  if (
    a &&
    a.nodeId === e.nodeId &&
    a.event === e.event &&
    (e.event === 'submit' || e.event === 'click')
  ) {
    return true
  }
  if (
    ctx.previewPage !== null &&
    ctx.previewPage !== ctx.currentPage &&
    e.pageId !== undefined &&
    e.pageId === ctx.previewPage
  ) {
    return true
  }
  return false
}

/** A destination the user is heading to before its screen exists. */
export interface PendingDestination {
  pageId: string
  /** What the bar and the skeleton header say. */
  name: string
  /** The nav item to highlight optimistically (null: not a tab). */
  navId: string | null
}

/**
 * Name and tab of a predicted destination: a known page's name, the plan's
 * name, the nav label, or the id itself. The tab is the nav item that is
 * the page (by id, or the item whose label names it).
 */
export function pendingDestination(
  pageId: string,
  ctx: { nav: readonly NavItem[]; known: UiSpec | null; plan?: readonly PlannedPage[] }
): PendingDestination {
  const nav = [...ctx.nav]
  const pages = ctx.known?.pages ?? []
  const resolved = resolvePageId(nav, pages, pageId)
  const page = resolved ? pages.find((p) => p.id === resolved) : undefined
  const planned = ctx.plan?.find((p) => p.id === pageId || p.id === resolved)
  const item =
    nav.find((i) => i.id === pageId) ??
    nav.find((i) => i.id === resolved) ??
    nav.find((i) => {
      const label = i.label.trim().toLowerCase()
      return label === (page?.name ?? planned?.name ?? '').trim().toLowerCase() && label !== ''
    })
  const name = page?.name ?? planned?.name ?? item?.label ?? pageId
  return { pageId: resolved ?? pageId, name, navId: item?.id ?? null }
}
