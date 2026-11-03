import type { TurnUsage } from '../agent/engine'
import { resolvePageId } from '../pageLinks'
import { hashContext, type HistoryEntry } from '../session/session'
import { findPage, type NavItem, type UiSpec } from '../spec'

/**
 * Pure pieces of the runtime's turn pipeline — what goes into one model
 * turn, and how its streamed accounting adds up — kept out of the 3k-line
 * Runtime component so each rule is unit-tested on its own.
 */

/**
 * The provider prompt-cache key for one domino on one model. Stable for the
 * whole session (and across restarts), short and free of the base URL the
 * domino id embeds.
 */
export function promptCacheKey(dominoId: string, model: string): string {
  return `domino-${hashContext([dominoId, model])}`
}

/**
 * Page ids a `navigate` may switch to without a model pass: every built
 * page, plus nav ids that resolve to one (ids drift from page ids — the tab
 * says `orders`, the page is `order-list`).
 */
export function knownPageIds(known: UiSpec | null, nav: readonly NavItem[]): string[] {
  if (!known) return []
  const ids = known.pages.map((p) => p.id)
  for (const item of nav) {
    if (ids.includes(item.id)) continue
    if (resolvePageId([...nav], known.pages, item.id) !== null) ids.push(item.id)
  }
  return ids
}

/** Screen-history moments listed to the model (newest last). */
const HISTORY_LINE_ENTRIES = 25

/**
 * Per-turn context the model needs but history must not keep: the live
 * client-side state (the model carries it in "state") and the moment list
 * ("take me back to …" answers with history:<n>). Sent as the engine's
 * transientContext — appended to this turn's request only, never stored, so
 * old turns don't each keep a stale copy.
 */
export function turnTransientContext(
  state: Record<string, unknown>,
  entries: readonly (Pick<HistoryEntry, 'index' | 'kind' | 'label' | 'at'> & {
    current?: boolean
  })[]
): string {
  const parts: string[] = []
  if (Object.keys(state).length > 0) {
    parts.push(
      `Current screen state (updated client-side — carry it in your "state" field): ${JSON.stringify(state)}`
    )
  }
  if (entries.length >= 2) {
    // "Current" is the moment on screen — after a Back that is not the
    // newest one — and the listed window always keeps it in view.
    const found = entries.findIndex((e) => e.current)
    const cur = found >= 0 ? found : entries.length - 1
    const start = Math.max(
      0,
      Math.min(cur - Math.floor(HISTORY_LINE_ENTRIES / 2), entries.length - HISTORY_LINE_ENTRIES)
    )
    const line = entries
      .slice(start, start + HISTORY_LINE_ENTRIES)
      .map((e) => `${e.index}) [${e.kind}] ${e.label} ${new Date(e.at).toTimeString().slice(0, 5)}`)
      .join(' | ')
    parts.push(
      `Screen history (oldest first, "index) [kind] label time"; current = ${entries[cur].index}): ${line}`
    )
  }
  return parts.join('\n')
}

/** Cap for the page spec an edit turn carries inline (history keeps only stubs of old screens). */
const MAX_EDIT_SPEC_CHARS = 60_000

/**
 * The edit turn's request. Older render_ui calls are stubbed in history
 * (compactHistory), so the page being edited travels inline: the model edits
 * what is actually on screen instead of recalling a stub.
 */
export function editTurnPrompt(pageId: string, known: UiSpec | null): string {
  const base =
    `The user asked to change the current screen (EDIT REQUEST above). Apply only that change to page "${pageId}" and keep everything else — layout, ids, values, data and the other pages — as it is unless the change requires otherwise. Re-render the page. ` +
    `If the request is app-wide (a theme, colors, wording, navigation), re-render every page with the change applied and include all of them in the spec.`
  const page = known ? findPage(known, pageId) : undefined
  if (!known || !page) return base
  const others = known.pages
    .filter((p) => p.id !== pageId)
    .map((p) => `${p.id} ("${p.name}")`)
    .join(', ')
  let json = JSON.stringify({ ...(known.nav ? { nav: known.nav } : {}), page })
  if (json.length > MAX_EDIT_SPEC_CHARS) json = JSON.stringify({ page })
  return (
    `${base}\nCurrent spec of page "${pageId}" (edit this — keep its ids and bindings): ${json}` +
    (others ? `\nOther pages (re-render them only for an app-wide change): ${others}` : '')
  )
}

/**
 * The session/screen cache key of a user action. Page-free: the same control
 * (id + event + data) is the same action wherever it sits. An empty payload
 * counts as none, so a predicted click (built with no data) and the real
 * press share one slot.
 */
export function actionCacheKey(
  e: {
    nodeId: string
    event: string
    data?: Record<string, unknown>
  },
  /**
   * The auth state the answer was made in. Replayable keys are partitioned
   * by it (as `init::` keys are): a screen cached while signed in must never
   * answer the same press signed out — and pull signed-in pages into the
   * signed-out app. Omitted: the bare key (legacy callers).
   */
  loggedIn?: boolean
): string {
  const d = e.data && Object.keys(e.data).length > 0 ? e.data : undefined
  const key = hashContext({ id: e.nodeId, ev: e.event, d })
  return loggedIn === undefined ? key : `${key}::auth:${loggedIn}`
}

/** Token count of one usage update (explicit total, else prompt + completion). */
export function usageTotal(u: TurnUsage): number {
  return u.total ?? (u.prompt ?? 0) + (u.completion ?? 0)
}

/**
 * Fold one usage update into a running count. The engine reports the TURN's
 * cumulative totals (passes summed), so only the growth since the last
 * update is new; a repeated or smaller report adds nothing.
 */
export function usageStep(last: number, u: TurnUsage): { total: number; add: number } {
  const total = usageTotal(u)
  if (!(total > 0)) return { total: last, add: 0 }
  return { total: Math.max(total, last), add: Math.max(0, total - last) }
}

/** Cap for the page JSON a predicted click's scratch turn carries. */
const MAX_CLICK_PAGE_CHARS = 12_000

/**
 * Scratch request for pre-building a plain button's destination in the
 * background: the same ACTION line a real press pushes, the page it sits on
 * (the scratch history has no earlier turns) and the usual instruction.
 */
export function clickPregenPrompt(
  known: UiSpec,
  target: { pageId: string; nodeId: string; label: string }
): string {
  const page = findPage(known, target.pageId)
  let json = page ? JSON.stringify(page) : ''
  if (json.length > MAX_CLICK_PAGE_CHARS) json = ''
  return (
    `ACTION click from Button/${target.nodeId} (page "${target.pageId}")\n` +
    (json ? `The page the button sits on: ${json}\n` : '') +
    `The user pressed "${target.label}" on the current screen (see ACTION above). Compute and render the next screen. Do not change any data: read-only calls only.`
  )
}
