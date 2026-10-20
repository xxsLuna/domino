import type { UiSpec } from '../spec'
import type { KeyValueStorage } from './prefs'

/**
 * Persistent screen memory for one domino — the part of the render cache that
 * survives a restart:
 *
 * - **Screens**: `screenCacheKey(pageId, contextHash)` → spec, plus the
 *   endpoints the spec was built from (`deps`: endpoint → schema hash). A hit
 *   whose endpoint answered with a different shape since is demoted to a miss
 *   so the screen gets rebuilt against the new keys instead of showing stale
 *   fields.
 * - **View**: the last page + a snapshot of every page the runtime knows, so
 *   reopening the app restores the screen without asking the LLM. Stored per
 *   auth flag — a logged-out session never restores a logged-in view.
 */

/** endpoint (`METHOD /path`) → hash of the response shape it was built on. */
export type ScreenDeps = Record<string, string>

export interface StoredScreen {
  key: string
  spec: UiSpec
  deps?: ScreenDeps
  at: number
}

export interface ViewSnapshot {
  page: string
  known: UiSpec
  at: number
}

/** How many screens one domino keeps; older ones fall off first. */
const MAX_SCREENS = 20
/** Serialized spec budget across the whole list (localStorage must survive it). */
const MAX_TOTAL_CHARS = 1_500_000
/** One snapshot larger than this isn't worth writing over a good older one. */
const MAX_VIEW_CHARS = 800_000

export function screensKey(dominoId: string): string {
  return `domino:screens:${dominoId}`
}

export function viewKey(dominoId: string, loggedIn: boolean): string {
  return `domino:view:${dominoId}::auth:${loggedIn ? 'true' : 'false'}`
}

/**
 * True while every endpoint the screen was built from still answers with the
 * remembered shape. An endpoint missing from `hashes` counts as moved: without
 * the memory nothing proves the screen still fits the response.
 */
export function depsFresh(deps: ScreenDeps, hashes: Record<string, string>): boolean {
  for (const [endpoint, hash] of Object.entries(deps)) {
    if (hashes[endpoint] !== hash) return false
  }
  return true
}

export class ScreenStore {
  private entries: StoredScreen[] = []
  /** Monotonic `at`: LRU order must not collapse when puts share a millisecond. */
  private lastAt = 0

  private constructor(
    private readonly storage: KeyValueStorage,
    private readonly dominoId: string
  ) {}

  static async open(storage: KeyValueStorage, dominoId: string): Promise<ScreenStore> {
    const store = new ScreenStore(storage, dominoId)
    store.entries = parseEntries(await safeGet(storage, screensKey(dominoId)))
    return store
  }

  /**
   * Cache lookup. A hit whose `deps` no longer match the current schema hashes
   * is reported as a miss (the entry stays — a successful turn replaces it).
   */
  get(key: string, schemaHashes: Record<string, string> = {}): StoredScreen | null {
    const entry = this.entries.find((e) => e.key === key)
    if (!entry) return null
    if (entry.deps && !depsFresh(entry.deps, schemaHashes)) return null
    return entry
  }

  async put(key: string, spec: UiSpec, deps?: ScreenDeps): Promise<void> {
    // One spec this large would erase the whole cache by itself — skip it.
    if (JSON.stringify(spec).length > MAX_TOTAL_CHARS) return
    const prev = this.entries.find((e) => e.key === key)
    // A turn without API calls re-renders the same key: it didn't *lose* the
    // provenance the earlier turn recorded, so keep it.
    const clean = deps && Object.keys(deps).length ? deps : prev?.deps
    this.entries = this.entries.filter((e) => e.key !== key)
    this.lastAt = Math.max(Date.now(), this.lastAt + 1)
    this.entries.push({ key, spec, ...(clean ? { deps: clean } : {}), at: this.lastAt })
    this.enforceCaps()
    await this.flush()
  }

  /** Persist the current list; a storage failure never breaks the session. */
  async flush(): Promise<void> {
    try {
      await this.storage.set(screensKey(this.dominoId), JSON.stringify(this.entries))
    } catch {
      /* keep the in-memory list working without persistence */
    }
  }

  private enforceCaps(): void {
    this.entries.sort((a, b) => b.at - a.at) // newest first
    let total = 0
    const kept: StoredScreen[] = []
    for (const entry of this.entries) {
      if (kept.length >= MAX_SCREENS) break
      const size = JSON.stringify(entry.spec).length
      if (kept.length && total + size > MAX_TOTAL_CHARS) continue
      kept.push(entry)
      total += size
    }
    this.entries = kept
  }

  async saveView(loggedIn: boolean, view: { page: string; known: UiSpec }): Promise<void> {
    const snapshot: ViewSnapshot = { ...view, at: Date.now() }
    // Never trade a perfectly restorable older snapshot for an unwieldy one.
    if (JSON.stringify(snapshot).length > MAX_VIEW_CHARS) return
    try {
      await this.storage.set(viewKey(this.dominoId, loggedIn), JSON.stringify(snapshot))
    } catch {
      /* without persistence reopening just asks the LLM again */
    }
  }

  /**
   * Erase every stored screen and the view snapshot for the given auth flag —
   * the persisted half of "rebuild from scratch", so reopening starts from the
   * LLM instead of restoring pages that were thrown away.
   */
  async clear(loggedIn: boolean): Promise<void> {
    this.entries = []
    try {
      await this.storage.remove(screensKey(this.dominoId))
      await this.storage.remove(viewKey(this.dominoId, loggedIn))
    } catch {
      /* without removal the next reopen restores old pages once */
    }
  }

  async loadView(loggedIn: boolean): Promise<ViewSnapshot | null> {
    const raw = await safeGet(this.storage, viewKey(this.dominoId, loggedIn))
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const known = parsed?.known as UiSpec | undefined
      if (!parsed || typeof parsed.page !== 'string') return null
      if (!known || typeof known !== 'object' || !Array.isArray(known.pages)) return null
      return { page: parsed.page, known, at: typeof parsed.at === 'number' ? parsed.at : 0 }
    } catch {
      return null
    }
  }
}

async function safeGet(storage: KeyValueStorage, key: string): Promise<string | null> {
  try {
    return await storage.get(key)
  } catch {
    return null
  }
}

function parseEntries(raw: string | null): StoredScreen[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: StoredScreen[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const s = item as Record<string, unknown>
      const spec = s.spec as Record<string, unknown> | undefined
      if (typeof s.key !== 'string' || typeof s.at !== 'number') continue
      if (!spec || typeof spec !== 'object' || !Array.isArray(spec.pages)) continue
      const deps = validDeps(s.deps)
      out.push({
        key: s.key,
        spec: spec as unknown as UiSpec,
        at: s.at,
        ...(deps ? { deps } : {})
      })
    }
    return out
  } catch {
    return []
  }
}

/** A deps map survives only as `Record<string, string>`; anything else is dropped. */
function validDeps(deps: unknown): ScreenDeps | undefined {
  if (!deps || typeof deps !== 'object' || Array.isArray(deps)) return undefined
  const entries = Object.entries(deps as Record<string, unknown>)
  if (!entries.length || !entries.every(([, v]) => typeof v === 'string')) return undefined
  return deps as ScreenDeps
}
