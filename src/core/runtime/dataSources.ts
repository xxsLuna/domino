import type { DataSourceDecl } from '../domino/types'

/**
 * When the runtime fetches [data] sources. The old flow awaited every source
 * one by one before every turn (and twice before a restored screen showed),
 * so one slow backend held the whole app. Now:
 * - a turn waits only for sources that have NO snapshot yet, in parallel,
 *   and never longer than a short cap — the prompt uses what exists then;
 * - aged snapshots refresh in the background (bound cells re-render when
 *   they land);
 * - restored and cached screens show at once and refresh behind.
 */

/** A [data] snapshot older than this (or its `every Ns`, if longer) is refreshed before a turn. */
export const SOURCE_MAX_AGE_MS = 30_000

/** Longest a turn waits for missing [data] snapshots before asking the model anyway. */
export const TURN_DATA_WAIT_MS = 3_000

/** Debounce for re-querying sources whose path reads a state key the user is editing. */
export const STATE_SOURCE_DEBOUNCE_MS = 300

/**
 * Split the declared sources for a turn: `missing` (no snapshot — worth a
 * short wait) and `stale` (refresh in the background).
 */
export function planSourceFetch(
  decls: readonly DataSourceDecl[],
  snaps: Record<string, unknown>,
  fetchedAt: Record<string, number>,
  now: number
): { missing: string[]; stale: string[] } {
  const missing: string[] = []
  const stale: string[] = []
  for (const d of decls) {
    const at = fetchedAt[d.key]
    if (!(d.key in snaps) || at === undefined) {
      if (!(d.key in snaps)) missing.push(d.key)
      else stale.push(d.key) // restored value, never fetched this session
      continue
    }
    const maxAge = Math.max((d.everySec ?? 0) * 1000, SOURCE_MAX_AGE_MS)
    if (now - at > maxAge) stale.push(d.key)
  }
  return { missing, stale }
}

/**
 * Wait for `p`, but at most `ms`. Resolves true when it settled in time
 * (either way), false on the cap — the promise keeps running and its late
 * result still lands wherever it writes.
 */
export function settleWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    p.then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      () => {
        clearTimeout(timer)
        resolve(true)
      }
    )
  })
}

/** Keys of the sources whose path interpolates `{stateKey}` — they re-query when it changes. */
export function sourcesReadingState(decls: readonly DataSourceDecl[], stateKey: string): string[] {
  const token = `{${stateKey}}`
  return decls.filter((d) => d.path.includes(token)).map((d) => d.key)
}

/**
 * `{stateKey}` placeholders a source path still can't resolve — the exact
 * condition under which fetchSource stays silent (no request at all). An
 * explicit refresh on such a source must tell the user why nothing happened
 * instead of quietly doing nothing.
 */
export function missingSourceVars(path: string, state: Record<string, unknown>): string[] {
  const missing: string[] = []
  for (const m of path.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
    const key = m[1]
    const v = state[key]
    if ((v === undefined || v === null || String(v).trim() === '') && !missing.includes(key))
      missing.push(key)
  }
  return missing
}

/** A snapshot that carries nothing but an error — never counts as real data. */
export function isErrorSnapshot(v: unknown): boolean {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    'error' in (v as Record<string, unknown>) &&
    Object.keys(v as Record<string, unknown>).length === 1
  )
}

/**
 * True when a [data] path is a URL template rather than a base-relative path:
 * a literal scheme (`https://host/v1/items`) or a leading `{stateKey}` that
 * supplies the whole URL (`{rssUrl}` — the RSS-reader shape, where the user
 * pastes the feed address). `[api] external = https` is what makes these
 * fetchable; the scheme/host part can never be percent-encoded, so such
 * templates interpolate RAW up to the `?` and encoded after it.
 */
export function isUrlTemplate(path: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\/[^/?#]/i.test(path) || /^\{[A-Za-z0-9_]+\}(\/|\?|#|$)/.test(path)
  )
}
