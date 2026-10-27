import type { KeyValueStorage } from '../session/prefs'
import { compactToolResult } from './engine'

/**
 * Endpoint → last successful response body. The persistence twin of the
 * schema book: screens bind call_api results as {"$data": "api:<endpoint>.…"},
 * and reopening a domino must re-resolve those bindings against what the
 * endpoint last answered — otherwise a restored screen would come back empty.
 * Bodies are stored compacted (arrays trimmed, capped), the same shape the
 * model reads, so a snapshot can never outgrow its screen.
 */

export type ApiSnaps = Record<string, unknown>

/** Endpoints remembered at once — same scale as the schema book's horizon. */
const MAX_SNAPS = 12

export function apiSnapsKey(dominoId: string): string {
  return `domino:apisnaps:${dominoId}`
}

/** Store one snapshot; insertion order doubles as recency, oldest drop first. */
export function putApiSnap(snaps: ApiSnaps, endpoint: string, data: unknown): ApiSnaps {
  const next: ApiSnaps = { ...snaps }
  delete next[endpoint]
  next[endpoint] = compactToolResult(data)
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
      snaps[endpoint] = value
      if (++count >= MAX_SNAPS) break
    }
    return snaps
  } catch {
    return {}
  }
}

/** Persist snapshots; a storage failure must never break the session. */
export async function saveApiSnaps(
  storage: KeyValueStorage,
  dominoId: string,
  snaps: ApiSnaps
): Promise<void> {
  try {
    await storage.set(apiSnapsKey(dominoId), JSON.stringify(snaps))
  } catch {
    /* next successful save picks it up */
  }
}
