import type { KeyValueStorage } from '../session/prefs'

/**
 * Endpoint → last successful response body. The persistence twin of the
 * schema book: screens bind call_api results as {"$data": "api:<endpoint>.…"},
 * and reopening a domino must re-resolve those bindings against what the
 * endpoint last answered — otherwise a restored screen would come back empty.
 *
 * These are the bodies screens RENDER from, so they keep the response's own
 * structure: lists are cut to a generous row cap (no marker rows), the root
 * is never replaced. The model-facing copy (compactToolResult, the prompt's
 * sampled snapshots) is a separate, smaller view — binding against it would
 * show a junk "…+60 more" row, or nothing at all once a wide body turned
 * into {truncated, head}. A body still too big to persist is kept live only.
 */

export type ApiSnaps = Record<string, unknown>

/** Endpoints remembered at once — same scale as the schema book's horizon. */
const MAX_SNAPS = 12

export function apiSnapsKey(dominoId: string): string {
  return `domino:apisnaps:${dominoId}`
}

/** Rows kept per list in a bound snapshot — far past what a screen shows at once. */
export const MAX_LIST_ROWS = 200

/** Longest single snapshot written to storage; a bigger one stays live-only. */
const MAX_PERSIST_CHARS = 400_000

/** Nesting followed by the row cap; deeper values pass through untouched. */
const MAX_CAP_DEPTH = 20

/**
 * Structure-preserving cap: every array cut to MAX_LIST_ROWS, nothing else
 * changed — no marker elements, no replaced root, so `rows` stays a list of
 * rows and every binding path still resolves.
 */
export function capApiBody(data: unknown, depth = 0): unknown {
  if (depth > MAX_CAP_DEPTH) return data
  if (Array.isArray(data)) return data.slice(0, MAX_LIST_ROWS).map((v) => capApiBody(v, depth + 1))
  if (data && typeof data === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) out[k] = capApiBody(v, depth + 1)
    return out
  }
  return data
}

/** The model-facing compaction marker (`…+N more`) an older build stored inside lists. */
const LEGACY_MARKER = /^…\+\d+ more$/

/**
 * A snapshot read back from storage, or null when it cannot be bound: the
 * old `{truncated, chars, head}` replacement form is dropped, and a trailing
 * legacy marker row is cut from every list.
 */
function restoredSnap(value: unknown, depth = 0): unknown {
  if (depth > MAX_CAP_DEPTH) return value
  if (Array.isArray(value)) {
    const rows =
      typeof value[value.length - 1] === 'string' && LEGACY_MARKER.test(value[value.length - 1] as string)
        ? value.slice(0, -1)
        : value
    return rows.map((v) => restoredSnap(v, depth + 1))
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (depth === 0 && obj.truncated === true && typeof obj.head === 'string' && 'chars' in obj) {
      return null
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = restoredSnap(v, depth + 1)
    return out
  }
  return value
}

/** Store one snapshot; insertion order doubles as recency, oldest drop first. */
export function putApiSnap(snaps: ApiSnaps, endpoint: string, data: unknown): ApiSnaps {
  const next: ApiSnaps = { ...snaps }
  delete next[endpoint]
  next[endpoint] = capApiBody(data)
  const keys = Object.keys(next)
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SNAPS))) delete next[key]
  return next
}

/** Load persisted snapshots; any unreadable or malformed entry is forgotten. */
export async function loadApiSnaps(
  storage: KeyValueStorage,
  dominoId: string
): Promise<ApiSnaps> {
  let raw: string | null
  try {
    raw = await storage.get(apiSnapsKey(dominoId))
  } catch {
    return {}
  }
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const snaps: ApiSnaps = {}
    let count = 0
    for (const [endpoint, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue
      const restored = restoredSnap(value)
      if (restored === null) continue
      snaps[endpoint] = restored
      if (++count >= MAX_SNAPS) break
    }
    return snaps
  } catch {
    return {}
  }
}

/**
 * Persist snapshots; a storage failure must never break the session — but
 * it is reported through `onError` (quota, a locked store) so the runtime
 * can tell the user instead of silently losing the restore data.
 */
export async function saveApiSnaps(
  storage: KeyValueStorage,
  dominoId: string,
  snaps: ApiSnaps,
  onError?: (err: Error) => void
): Promise<void> {
  try {
    // Each entry on its own budget: one huge body is left out (it stays
    // live this session) instead of costing every other endpoint its restore.
    const kept: ApiSnaps = {}
    for (const [endpoint, value] of Object.entries(snaps)) {
      const text = JSON.stringify(value)
      if (text !== undefined && text.length <= MAX_PERSIST_CHARS) kept[endpoint] = value
    }
    await storage.set(apiSnapsKey(dominoId), JSON.stringify(kept))
  } catch (err) {
    // Next successful save picks it up; the caller decides whether to say so.
    onError?.(err instanceof Error ? err : new Error(String(err)))
  }
}

/**
 * Snapshots under the keys screens bind them by (`api:<endpoint>`), for
 * seeding the runtime's data sources at boot. Merging the raw endpoint keys
 * instead left restored {"$data": "api:…"} bindings unresolved until a new
 * call — and put unprefixed duplicates into the prompt.
 */
export function apiSnapBindings(snaps: ApiSnaps): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [endpoint, value] of Object.entries(snaps)) {
    out[endpoint.startsWith('api:') ? endpoint : `api:${endpoint}`] = value
  }
  return out
}
