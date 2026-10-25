import type { KeyValueStorage } from './prefs'

/**
 * storageAudit — what every `domino:*` key in the store adds up to.
 *
 * The management view in Settings groups stored data per domino (screen
 * cache, view snapshots, history, graph, API schemas, auth token), reports
 * byte sizes, and offers precise teardown: "초기화" keeps nothing derived,
 * 원본 텍스트 캐시 and global preferences are handled separately. Pure
 * grouping math is separated from I/O so it is unit-testable.
 */

export type DominoPart = 'screens' | 'views' | 'history' | 'graph' | 'schemas' | 'token'

export interface PartInfo {
  keys: number
  bytes: number
}

export interface DominoStorage {
  /** DominoFile id — "Name|baseUrl". */
  id: string
  /** Display name (the id's first segment). */
  name: string
  parts: Partial<Record<DominoPart, PartInfo>>
  keys: number
  bytes: number
  /** Newest view snapshot timestamp, when one exists. */
  lastUsed: number | null
}

export interface StorageAudit {
  dominoes: DominoStorage[]
  /** domino:text:* + the text index (source originals cache). */
  texts: PartInfo
  /** llm-config, recents, handle position, welcome hint, … */
  globals: PartInfo
  totalBytes: number
}

/** Key prefixes owned by one domino, in display order. */
const PART_PREFIXES: Array<[DominoPart, string]> = [
  ['screens', 'domino:screens:'],
  ['views', 'domino:view:'],
  ['history', 'domino:history:'],
  ['graph', 'domino:graph:'],
  ['schemas', 'domino:schemas:'],
  ['token', 'domino:token:']
]

/** Split a per-domino key into (part, dominoId) — view keys carry ::auth suffixes. */
function matchDominoKey(key: string): [DominoPart, string] | null {
  for (const [part, prefix] of PART_PREFIXES) {
    if (key.startsWith(prefix)) {
      let rest = key.slice(prefix.length)
      if (part === 'views') rest = rest.replace(/::auth:(?:true|false)$/, '')
      return [part, rest]
    }
  }
  return null
}

const byteLength = (value: string): number => value.length

/** Pure grouping: entries (any order) → per-domino / texts / globals audit. */
export function auditStorage(entries: Array<[string, string]>): StorageAudit {
  const dominoes = new Map<string, DominoStorage>()
  const texts: PartInfo = { keys: 0, bytes: 0 }
  const globals: PartInfo = { keys: 0, bytes: 0 }

  const dominoOf = (id: string): DominoStorage => {
    let d = dominoes.get(id)
    if (!d) {
      d = { id, name: id.split('|')[0] || id, parts: {}, keys: 0, bytes: 0, lastUsed: null }
      dominoes.set(id, d)
    }
    return d
  }

  for (const [key, value] of entries) {
    const bytes = byteLength(value)
    const hit = matchDominoKey(key)
    if (hit) {
      const [part, id] = hit
      const d = dominoOf(id)
      const info = d.parts[part] ?? { keys: 0, bytes: 0 }
      d.parts[part] = { keys: info.keys + 1, bytes: info.bytes + bytes }
      d.keys += 1
      d.bytes += bytes
      if (part === 'views') {
        try {
          const at = (JSON.parse(value) as { at?: unknown }).at
          if (typeof at === 'number' && at > (d.lastUsed ?? 0)) d.lastUsed = at
        } catch {
          /* unreadable snapshot — size still counts */
        }
      }
      continue
    }
    if (key === 'domino:text-index' || key.startsWith('domino:text:')) {
      texts.keys += 1
      texts.bytes += bytes
      continue
    }
    if (key.startsWith('domino:')) {
      globals.keys += 1
      globals.bytes += bytes
    }
  }

  const list = [...dominoes.values()].sort((a, b) => b.bytes - a.bytes)
  return {
    dominoes: list,
    texts,
    globals,
    totalBytes: list.reduce((sum, d) => sum + d.bytes, 0) + texts.bytes + globals.bytes
  }
}

/** Collect the audit from a storage that supports enumeration (else null). */
export async function readStorageAudit(storage: KeyValueStorage): Promise<StorageAudit | null> {
  if (!storage.entries) return null
  try {
    return auditStorage(await storage.entries())
  } catch {
    return null
  }
}

/** Every key one domino owns (all parts; view keys on both auth variants). */
export function dominoKeys(
  id: string,
  parts: readonly DominoPart[] = PART_PREFIXES.map((p) => p[0])
): string[] {
  const out: string[] = []
  for (const part of parts) {
    const prefix = PART_PREFIXES.find(([p]) => p === part)![1]
    if (part === 'views') {
      out.push(`${prefix}${id}::auth:true`, `${prefix}${id}::auth:false`)
    } else {
      out.push(`${prefix}${id}`)
    }
  }
  return out
}

/**
 * Wipe one domino's stored data: screens, snapshots, history, graph, API
 * shapes — and the auth token (it IS that domino's data). The LLM key and
 * other global preferences are never touched.
 */
export async function clearDominoData(storage: KeyValueStorage, id: string): Promise<void> {
  await Promise.all(dominoKeys(id).map((key) => storage.remove(key)))
}

/** Every cached source original + the index that points at them. */
export async function clearTextCache(storage: KeyValueStorage): Promise<void> {
  if (!storage.entries) return
  const entries = await storage.entries()
  await Promise.all(
    entries
      .map(([key]) => key)
      .filter((key) => key === 'domino:text-index' || key.startsWith('domino:text:'))
      .map((key) => storage.remove(key))
  )
}

/** Wipe every domino's data (global preferences — LLM key included — stay). */
export async function clearAllDominoData(storage: KeyValueStorage): Promise<void> {
  const audit = await readStorageAudit(storage)
  if (!audit) return
  await Promise.all(audit.dominoes.map((d) => clearDominoData(storage, d.id)))
}
