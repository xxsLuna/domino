import type { DataSourceDecl } from '../domino/types'
import type { KeyValueStorage } from '../session/prefs'

/**
 * Last-known [data] snapshots, persisted per domino. A reopened screen binds
 * `{"$data": "<key>.…"}`; without these its tables and counters would sit
 * empty until every source answered again. Restored values show at once and
 * count as never fetched this session, so each source still refreshes in
 * the background (planSourceFetch: "stale", not "missing" — no turn waits).
 *
 * Only declared sources are kept, never `api:` bodies (apiSnaps owns those),
 * never error placeholders, and only values small enough to restore
 * cheaply — a source too big to store simply comes back on its first fetch.
 */

/** One source's snapshot larger than this (serialized) is not persisted. */
export const MAX_DATA_SNAP_CHARS = 60_000
/** All of a domino's persisted snapshots together. */
export const MAX_DATA_SNAPS_CHARS = 400_000

export function dataSnapsKey(dominoId: string): string {
  return `domino:datasnaps:${dominoId}`
}

/** `{error: "…"}` — what a failed fetch leaves as a snapshot; not worth restoring. */
function isErrorSnapshot(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const keys = Object.keys(v)
  return keys.length === 1 && keys[0] === 'error'
}

/** The part of the live snapshots worth persisting (declared sources, bounded). */
export function persistableDataSnaps(
  snaps: Record<string, unknown>,
  decls: readonly Pick<DataSourceDecl, 'key'>[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let total = 0
  for (const { key } of decls) {
    if (!(key in snaps)) continue
    const value = snaps[key]
    if (value === undefined || isErrorSnapshot(value)) continue
    let size: number
    try {
      size = JSON.stringify(value).length
    } catch {
      continue // cyclic or unserializable: nothing to restore
    }
    if (size > MAX_DATA_SNAP_CHARS || total + size > MAX_DATA_SNAPS_CHARS) continue
    total += size
    out[key] = value
  }
  return out
}

/** Restore the persisted snapshots of sources the file still declares. */
export async function loadDataSnaps(
  storage: KeyValueStorage,
  dominoId: string,
  decls: readonly Pick<DataSourceDecl, 'key'>[]
): Promise<Record<string, unknown>> {
  try {
    const raw = await storage.get(dataSnapsKey(dominoId))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return persistableDataSnaps(parsed as Record<string, unknown>, decls)
  } catch {
    return {} // unreadable: the sources just fetch as on a first open
  }
}

/** Persist (or, when empty, remove) the snapshots; failures go to `onError`. */
export async function saveDataSnaps(
  storage: KeyValueStorage,
  dominoId: string,
  snaps: Record<string, unknown>,
  onError?: (err: Error) => void
): Promise<void> {
  try {
    if (Object.keys(snaps).length === 0) await storage.remove(dataSnapsKey(dominoId))
    else await storage.set(dataSnapsKey(dominoId), JSON.stringify(snaps))
  } catch (err) {
    onError?.(err instanceof Error ? err : new Error(String(err)))
  }
}
