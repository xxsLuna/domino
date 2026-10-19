import type { DominoFile } from '../domino/types'
import type { UiSpec } from '../spec'

/**
 * Background pre-generation: after the first screen settles, the pages a tap
 * would otherwise generate live — nav tabs and [script] goto/render targets —
 * are built one by one while the app is idle, then merged into what the
 * runtime already knows so selecting them switches instantly (no LLM).
 */

/** Background build budget per session: three screens, sequential. */
export const MAX_PREGEN_TARGETS = 3

/**
 * Candidate pages, in tap likelihood: nav items first (they're on every
 * screen), then scripted targets. Already-known pages, the login page and —
 * for an auth-required app while signed out — everything are excluded: those
 * would be built against the wrong context or rebuilt for no reason.
 */
export function pregenTargets(
  domino: DominoFile,
  known: UiSpec,
  loggedIn: boolean
): string[] {
  if (domino.auth.required && !loggedIn) return []
  const have = new Set(known.pages.map((p) => p.id))
  const targets: string[] = []
  const add = (id: string | undefined): void => {
    if (!id || id === 'login' || have.has(id) || targets.includes(id)) return
    targets.push(id)
  }
  for (const item of known.nav ?? []) add(item.id)
  for (const rule of domino.script) {
    if (rule.command.kind === 'goto' || rule.command.kind === 'render') add(rule.command.page)
  }
  return targets.slice(0, MAX_PREGEN_TARGETS)
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
