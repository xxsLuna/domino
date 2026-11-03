import type { KeyValueStorage } from './prefs'
import { isQuotaError, safeGet, toError } from './kv'
import { PageStore, pageBlobKey, pageIndexKey } from './pageStore'

/**
 * storageAudit — what every `domino:*` key in the store adds up to.
 *
 * The management view in Settings groups stored data per domino (screen
 * cache with its page table, view snapshots, history, graph, API schemas,
 * API response snapshots, feed subscriptions, auth token, per-domino LLM
 * override), reports byte sizes, and offers precise teardown: "초기화" keeps
 * nothing derived — only the per-domino LLM override survives unless asked
 * for; 원본 텍스트 캐시 and global preferences are handled separately. Pure
 * grouping math is separated from I/O so it is unit-testable.
 *
 * When the store runs full, planEviction() picks what can go (the text cache
 * first, then other dominoes' regenerable screens, least recently used
 * first) and applyEviction() removes it.
 */

export type DominoPart =
  'screens' | 'views' | 'history' | 'graph' | 'schemas' | 'snaps' | 'feeds' | 'token' | 'llm'

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

/**
 * Key prefixes owned by one domino, in display order. The page table
 * (index + one blob per page version) is part of the screen cache.
 */
const PART_PREFIXES: Array<[DominoPart, string]> = [
  ['screens', 'domino:screens:'],
  ['screens', 'domino:pageindex:'],
  ['screens', 'domino:page:'],
  ['views', 'domino:view:'],
  ['history', 'domino:history:'],
  ['graph', 'domino:graph:'],
  ['schemas', 'domino:schemas:'],
  ['snaps', 'domino:apisnaps:'],
  // Last-known [data] snapshots (src/core/runtime/dataSnaps.ts): same kind of data.
  ['snaps', 'domino:datasnaps:'],
  ['feeds', 'domino:feeds:'],
  ['token', 'domino:token:'],
  // Non-secret sign-in fields [script] conditions read: they go with the token.
  ['token', 'domino:sessionvars:'],
  // The bare global 'domino:llm-config' has no trailing colon: it stays global.
  ['llm', 'domino:llm-config:']
]

/** Every part, in display order. */
export const ALL_PARTS: readonly DominoPart[] = [...new Set(PART_PREFIXES.map(([p]) => p))]

/** What "초기화" wipes: everything but the per-domino LLM override. */
export const RESET_PARTS: readonly DominoPart[] = ALL_PARTS.filter((p) => p !== 'llm')

/** Derived, regenerable parts — what eviction may take from another domino. */
export const CACHE_PARTS: readonly DominoPart[] = ['screens', 'views', 'history']

/**
 * Split a per-domino key into (part, dominoId) — view and history keys carry
 * ::auth suffixes, page blobs a ::v:<version> suffix.
 */
export function matchDominoKey(key: string): [DominoPart, string] | null {
  for (const [part, prefix] of PART_PREFIXES) {
    if (key.startsWith(prefix)) {
      let rest = key.slice(prefix.length)
      if (part === 'views' || part === 'history') rest = rest.replace(/::auth:(?:true|false)$/, '')
      if (prefix === 'domino:page:') rest = rest.replace(/::v:[a-z0-9]+$/, '')
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

/**
 * Every fixed key one domino owns (view and history keys on both auth
 * variants, plus the pre-partition history key). Page blobs are addressed by
 * version and are found through the page index instead — see
 * clearDominoData.
 */
export function dominoKeys(id: string, parts: readonly DominoPart[] = ALL_PARTS): string[] {
  const out: string[] = []
  for (const part of parts) {
    switch (part) {
      case 'screens':
        out.push(`domino:screens:${id}`, pageIndexKey(id))
        break
      case 'views':
        out.push(`domino:view:${id}::auth:true`, `domino:view:${id}::auth:false`)
        break
      case 'history':
        out.push(
          `domino:history:${id}`,
          `domino:history:${id}::auth:true`,
          `domino:history:${id}::auth:false`
        )
        break
      default:
        for (const [p, prefix] of PART_PREFIXES) if (p === part) out.push(`${prefix}${id}`)
    }
  }
  return out
}

export interface ClearOptions {
  /** Parts to wipe; default everything except the per-domino LLM override. */
  parts?: readonly DominoPart[]
  /** Also wipe the per-domino LLM override (ignored when `parts` is given). */
  includeLlm?: boolean
}

/**
 * Wipe one domino's stored data: screens and their page table, snapshots,
 * history, graph, API shapes, API response snapshots (private bodies), feed
 * subscriptions — and the auth token (it IS that domino's data). The
 * per-domino LLM override stays unless `includeLlm`; the global LLM key and
 * other preferences are never touched.
 */
export async function clearDominoData(
  storage: KeyValueStorage,
  id: string,
  opts: ClearOptions = {}
): Promise<void> {
  const parts = opts.parts ?? (opts.includeLlm ? ALL_PARTS : RESET_PARTS)
  const keys = new Set(dominoKeys(id, parts))
  if (parts.includes('screens')) {
    // Page blobs the index lists…
    for (const v of pageBlobVersions(await safeGet(storage, pageIndexKey(id)))) {
      keys.add(pageBlobKey(id, v))
    }
  }
  // …and anything else the store can enumerate for this domino (orphans too).
  if (storage.entries) {
    try {
      for (const [key] of await storage.entries()) {
        const hit = matchDominoKey(key)
        if (hit && hit[1] === id && parts.includes(hit[0])) keys.add(key)
      }
    } catch {
      /* the fixed keys above still go */
    }
  }
  // Best-effort per key: one failed removal must not keep the rest.
  await Promise.all([...keys].map((key) => storage.remove(key).catch(() => undefined)))
  // A live page table would otherwise believe its blobs are still stored.
  if (parts.includes('screens')) PageStore.forget(storage, id)
}

function pageBlobVersions(raw: string | null): string[] {
  if (!raw) return []
  try {
    const blobs = (JSON.parse(raw) as { blobs?: unknown }).blobs
    return Array.isArray(blobs) ? blobs.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** Every cached source original + the index that points at them. */
export async function clearTextCache(storage: KeyValueStorage): Promise<void> {
  if (!storage.entries) return
  const entries = await storage.entries()
  await Promise.all(
    entries
      .map(([key]) => key)
      .filter((key) => key === 'domino:text-index' || key.startsWith('domino:text:'))
      .map((key) => storage.remove(key).catch(() => undefined))
  )
}

/** Wipe every domino's data (global preferences — LLM key included — stay). */
export async function clearAllDominoData(
  storage: KeyValueStorage,
  opts: ClearOptions = {}
): Promise<void> {
  const audit = await readStorageAudit(storage)
  if (!audit) return
  await Promise.all(audit.dominoes.map((d) => clearDominoData(storage, d.id, opts)))
}

/* ------------------------------ quota relief ------------------------------ */

export type EvictionStep = { kind: 'texts' } | { kind: 'domino'; id: string }

/**
 * Dominoes open right now (a Runtime registers its own while mounted):
 * quota relief never evicts their screens, views or history, whatever key
 * is being written. Counted, so two views of one domino stay protected
 * until both have closed.
 */
const openDominoes = new Map<string, number>()

/** Protect `id` from quota eviction until the returned release is called. */
export function protectDomino(id: string): () => void {
  openDominoes.set(id, (openDominoes.get(id) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const n = (openDominoes.get(id) ?? 1) - 1
    if (n > 0) openDominoes.set(id, n)
    else openDominoes.delete(id)
  }
}

/** Ids currently protected by protectDomino. */
export function protectedDominoes(): string[] {
  return [...openDominoes.keys()]
}

/** A source-text cache key (the cached originals or their index). */
function isTextCacheKey(key: string): boolean {
  return key === 'domino:text-index' || key.startsWith('domino:text:')
}

/**
 * What may be dropped to make room, cheapest loss first: the source-text
 * cache (a re-fetch), then OTHER dominoes' generated screens, views and
 * history (a regeneration), least recently used first. The domino being
 * written (`keepId`), every protected (open) domino, and every token, graph,
 * schema and preference stay.
 */
export function planEviction(
  audit: StorageAudit,
  keepId: string | null,
  protectedIds: readonly string[] = protectedDominoes()
): EvictionStep[] {
  const steps: EvictionStep[] = []
  if (audit.texts.keys > 0) steps.push({ kind: 'texts' })
  const keep = new Set(protectedIds)
  if (keepId !== null) keep.add(keepId)
  const others = audit.dominoes
    .filter((d) => !keep.has(d.id) && CACHE_PARTS.some((p) => d.parts[p]))
    .sort((a, b) => (a.lastUsed ?? 0) - (b.lastUsed ?? 0))
  for (const d of others) steps.push({ kind: 'domino', id: d.id })
  return steps
}

export async function applyEviction(storage: KeyValueStorage, step: EvictionStep): Promise<void> {
  if (step.kind === 'texts') await clearTextCache(storage)
  else await clearDominoData(storage, step.id, { parts: CACHE_PARTS })
}

/**
 * One failed write. `recovered`: room was made (see `evicted`) and the retry
 * went through — worth a quiet notice; otherwise the value was NOT saved.
 */
export interface StorageErrorEvent {
  key: string
  error: Error
  quota: boolean
  recovered: boolean
  /** What was dropped to make room: 'texts' or a domino id. */
  evicted: string[]
}

/**
 * Wrap a platform storage so writes that hit the quota make room and retry,
 * cheapest loss first (planEviction — never the domino being written). Every
 * failure is reported and still thrown, so callers' own persist-error hooks
 * see it too; a recovered write is reported with `recovered: true`.
 */
export function withQuotaRelief<S extends KeyValueStorage>(
  inner: S,
  report: (e: StorageErrorEvent) => void
): S {
  const set = async (key: string, value: string): Promise<void> => {
    try {
      await inner.set(key, value)
      return
    } catch (err) {
      const quota = isQuotaError(err)
      const evicted: string[] = []
      if (quota) {
        const audit = await readStorageAudit(inner)
        const keepId = matchDominoKey(key)?.[1] ?? null
        // Only a domino's own data (screens, views, history…) may cost other
        // dominoes their generated screens. A global key — the text cache,
        // recents, preferences, the handle position — may at most clear the
        // text cache, and a text-cache write gives up instead: a source text
        // can be fetched again, a generated app cannot.
        const plan = audit ? planEviction(audit, keepId) : []
        const steps =
          keepId !== null ? plan : isTextCacheKey(key) ? [] : plan.filter((s) => s.kind === 'texts')
        for (const step of steps) {
          try {
            await applyEviction(inner, step)
          } catch {
            continue
          }
          evicted.push(step.kind === 'texts' ? 'texts' : step.id)
          try {
            await inner.set(key, value)
            report({ key, error: toError(err), quota, recovered: true, evicted })
            return
          } catch (retryErr) {
            if (!isQuotaError(retryErr)) break
          }
        }
      }
      const error = toError(err)
      report({ key, error, quota, recovered: false, evicted })
      throw error
    }
  }
  return { ...inner, set }
}
