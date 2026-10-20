import type { NavItem, PageSpec } from './spec'

/**
 * pageLinks — the single owner of the nav ↔ page relationship.
 *
 * The prompt asks models to give every nav item the id of the page it opens,
 * but nothing enforces it: when a nav id drifts from the real page id, a tap
 * misses the stored page and falls through to a live LLM re-render — the user
 * sees "another, different page" where they expected the one they had.
 * Resolution here keeps taps landing on the stored page whenever any stable
 * link (id, nav label, page name) connects them.
 */

/** Loose human-text comparison: trim, collapse whitespace, case-insensitive. */
const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * Map a navigation target (nav item id, breadcrumb id, scripted page string)
 * to the id of a page that actually exists:
 *
 * 1. exact page id — the normal contract;
 * 2. nav item id → its label → that page's id or name — the drift case;
 * 3. the target itself as a page name — labels used where ids were meant.
 *
 * Returns null when no known page is connected, so the caller can fall back
 * to a live generation instead of switching to nothing.
 */
export function resolvePageId(
  nav: NavItem[] | undefined,
  pages: PageSpec[],
  target: string
): string | null {
  const t = norm(target)
  if (!t) return null

  const byId = pages.find((p) => norm(p.id) === t)
  if (byId) return byId.id

  const item = nav?.find((i) => norm(i.id) === t)
  if (item) {
    const label = norm(item.label)
    const linked = pages.find((p) => norm(p.id) === label || norm(p.name) === label)
    if (linked) return linked.id
  }

  const byName = pages.find((p) => norm(p.name) === t)
  return byName ? byName.id : null
}
