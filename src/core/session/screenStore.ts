import { tryValidateUiSpec, type UiSpec } from '../spec'
import type { KeyValueStorage } from './prefs'
import { safeGet, toError } from './kv'
import {
  PageStore,
  assembleSpec,
  restoreShell,
  shellOf,
  validRefs,
  type PageRefs,
  type SpecShell
} from './pageStore'

/**
 * Persistent screen memory for one domino — the part of the render cache that
 * survives a restart:
 *
 * - **Screens**: context hash (node id + event + data of the press, no source
 *   page — one action shares one slot wherever it is pressed) → spec, plus the
 *   endpoints the spec was built from (`deps`: endpoint → schema hash). A hit
 *   whose endpoint answered with a different shape since is demoted to a miss
 *   so the screen gets rebuilt against the new keys instead of showing stale
 *   fields. Non-action keys (`init::…`, `edit::…`, `feed-…`) prefix the same
 *   hash with their own kind.
 * - **View**: the last page + every page the runtime knows, so reopening the
 *   app restores the screen without asking the LLM. Stored per auth flag — a
 *   logged-out session never restores a logged-in view.
 *
 * Neither stores pages any more: both keep refs into the domino's PageStore
 * (one copy per page version), so an entry is a few hundred bytes however
 * large the app grows. A screen entry pins only its target page's version —
 * the other pages it was captured with resolve to their newest stored
 * version, which is all a replay merge (withTargetPage) ever reads. A view
 * pins every page it knows.
 *
 * Every entry and view is stamped with the definition fingerprint the store
 * was opened with. One built against a different definition reads as stale:
 * screen hits are demoted to misses (unless the caller asks for stale ones),
 * views come back flagged so the caller decides whether to show them.
 *
 * View writes are debounced (a state toggle or a quick tap sequence becomes
 * one write); `flush()` writes everything pending now — call it on pagehide.
 * Write failures reach `onPersistError` instead of vanishing.
 */

/** endpoint (`METHOD /path`) → hash of the response shape it was built on. */
export type ScreenDeps = Record<string, string>

export interface StoredScreen {
  key: string
  spec: UiSpec
  deps?: ScreenDeps
  at: number
  /** Built against a different definition fingerprint (only with `allowStale`). */
  stale?: boolean
}

export interface ViewSnapshot {
  page: string
  known: UiSpec
  at: number
  /** Saved against a different definition fingerprint: the caller decides. */
  stale?: boolean
}

export interface ScreenStoreOptions {
  /** Definition fingerprint (dominoFingerprint) — stamps every write, checked on read. */
  fingerprint?: string
  /** Told about every failed write (quota, disk) instead of a silent swallow. */
  onPersistError?: (err: Error) => void
  /** View write debounce; default 350ms. */
  viewDebounceMs?: number
}

export interface ScreenGetOptions {
  /** Return entries built against another definition too, flagged `stale`. */
  allowStale?: boolean
}

/** One cached screen as stored: refs instead of pages. */
interface Entry {
  key: string
  page: string
  refs: PageRefs
  shell: SpecShell
  deps?: ScreenDeps
  at: number
  def?: string
}

interface ViewPayload {
  v: 2
  page: string
  refs: PageRefs
  shell: SpecShell
  at: number
  def?: string
}

/** How many screens one domino keeps; older ones fall off first (entries are tiny now). */
export const MAX_SCREENS = 60
const VIEW_DEBOUNCE_MS = 350
const SCREENS_OWNER = 'screens'
const viewOwner = (loggedIn: boolean): string => `view:${loggedIn ? 'true' : 'false'}`

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
  private entries: Entry[] = []
  /** Monotonic `at`: LRU order must not collapse when puts share a millisecond. */
  private lastAt = 0
  private readonly pendingViews = new Map<boolean, ViewPayload>()
  private viewWaiters: Array<() => void> = []
  private viewTimer: ReturnType<typeof setTimeout> | null = null
  private indexChain: Promise<unknown> = Promise.resolve()
  /**
   * The stored list is still the legacy whole-spec array: it is the only
   * full copy of those screens until their pages are in the page table, so
   * it is overwritten only by a write whose pages all landed.
   */
  private legacyPending = false

  private constructor(
    private readonly storage: KeyValueStorage,
    private readonly dominoId: string,
    /** The page table every entry and view points into (shared with history). */
    readonly pages: PageStore,
    private readonly opts: ScreenStoreOptions
  ) {}

  static async open(
    storage: KeyValueStorage,
    dominoId: string,
    opts: ScreenStoreOptions = {}
  ): Promise<ScreenStore> {
    const pages = await PageStore.open(storage, dominoId)
    if (opts.onPersistError) pages.onError(opts.onPersistError)
    const store = new ScreenStore(storage, dominoId, pages, opts)
    const { entries, legacy } = parseEntries(
      await safeGet(storage, screensKey(dominoId)),
      pages,
      opts.fingerprint
    )
    store.entries = entries
    store.legacyPending = legacy
    store.lastAt = entries.reduce((max, e) => Math.max(max, e.at), 0)
    store.pinScreens()
    // Old whole-app entries move into the page table right away: the next
    // write would otherwise be the first chance, and the quota may be gone.
    if (legacy) void store.persistScreens()
    return store
  }

  /** The definition fingerprint this store stamps and checks (if any). */
  get fingerprint(): string | undefined {
    return this.opts.fingerprint
  }

  private isStale(def: string | undefined): boolean {
    return Boolean(this.opts.fingerprint && def && def !== this.opts.fingerprint)
  }

  /**
   * Cache lookup. A hit whose `deps` no longer match the current schema hashes
   * is reported as a miss (the entry stays — a successful turn replaces it);
   * so is one built against another definition, unless `allowStale`.
   */
  get(
    key: string,
    schemaHashes: Record<string, string> = {},
    opts: ScreenGetOptions = {}
  ): StoredScreen | null {
    const entry = this.entries.find((e) => e.key === key)
    if (!entry) return null
    if (entry.deps && !depsFresh(entry.deps, schemaHashes)) return null
    const stale = this.isStale(entry.def)
    if (stale && !opts.allowStale) return null
    const pages = this.pages.resolve(entry.refs)
    if (!pages.some((p) => p.id === entry.page)) return null // its page is gone
    // The shell was validated when the entry was parsed or put.
    const spec: UiSpec = { ...entry.shell, version: 1, page: entry.page, pages }
    return {
      key: entry.key,
      spec,
      at: entry.at,
      ...(entry.deps ? { deps: entry.deps } : {}),
      ...(stale ? { stale: true } : {})
    }
  }

  async put(key: string, spec: UiSpec, deps?: ScreenDeps): Promise<void> {
    if (!spec.pages.some((p) => p.id === spec.page)) return
    const prev = this.entries.find((e) => e.key === key)
    // A turn without API calls re-renders the same key: it didn't *lose* the
    // provenance the earlier turn recorded, so keep it.
    const clean = deps && Object.keys(deps).length ? deps : prev?.deps
    this.entries = this.entries.filter((e) => e.key !== key)
    this.lastAt = Math.max(Date.now(), this.lastAt + 1)
    this.entries.push({
      key,
      page: spec.page,
      refs: this.pages.refsOf(spec),
      shell: shellOf(spec),
      ...(clean ? { deps: clean } : {}),
      at: this.lastAt,
      ...(this.opts.fingerprint ? { def: this.opts.fingerprint } : {})
    })
    this.enforceCaps()
    this.pinScreens()
    await this.persistScreens()
  }

  /**
   * Drop every stored screen that lands on `pageId` (except `keepKey`): the
   * page was edited, and replaying an entry captured before the edit would
   * put the old copy back on screen — after a restart too.
   */
  async evictPage(pageId: string, keepKey?: string): Promise<void> {
    const kept = this.entries.filter((e) => e.page !== pageId || e.key === keepKey)
    if (kept.length === this.entries.length) return
    this.entries = kept
    this.pinScreens()
    await this.persistScreens()
  }

  /** Write every pending view, new page versions and the screen list now. */
  async flush(): Promise<boolean> {
    const views = await this.writeViews()
    const screens = await this.persistScreens()
    return views && screens
  }

  private enforceCaps(): void {
    this.entries.sort((a, b) => b.at - a.at) // newest first
    this.entries = this.entries.slice(0, MAX_SCREENS)
  }

  /** A screen entry pins only its target page's exact version. */
  private pinScreens(): void {
    const pins: string[] = []
    for (const e of this.entries) {
      const ref = e.refs.find(([id]) => id === e.page)
      if (ref) pins.push(ref[1])
    }
    this.pages.retain(SCREENS_OWNER, pins)
  }

  /** Pages first, then the list that points at them. */
  private persistScreens(): Promise<boolean> {
    const run = this.indexChain.then(async () => {
      const pagesOk = await this.pages.flush()
      // Migrating: keep the whole-copy list until the refs replacing it resolve.
      if (!pagesOk && this.legacyPending) return false
      try {
        await this.storage.set(
          screensKey(this.dominoId),
          JSON.stringify({ v: 2, entries: this.entries })
        )
        if (pagesOk) this.legacyPending = false
        return pagesOk
      } catch (err) {
        this.report(err)
        return false
      }
    })
    this.indexChain = run.catch(() => undefined)
    return run
  }

  /**
   * Remember where the user was. Debounced: the returned promise settles once
   * the (coalesced) write happened. Cheap to call often — page versions are
   * cached per page object, so only changed pages are ever hashed or written.
   */
  saveView(loggedIn: boolean, view: { page: string; known: UiSpec }): Promise<void> {
    const refs = this.pages.refsOf(view.known)
    this.pages.retain(
      viewOwner(loggedIn),
      refs.map((r) => r[1])
    )
    this.pendingViews.set(loggedIn, {
      v: 2,
      page: view.page,
      refs,
      shell: { ...shellOf(view.known), page: view.page },
      at: Date.now(),
      ...(this.opts.fingerprint ? { def: this.opts.fingerprint } : {})
    })
    return new Promise<void>((resolve) => {
      this.viewWaiters.push(resolve)
      if (this.viewTimer !== null) clearTimeout(this.viewTimer)
      this.viewTimer = setTimeout(() => {
        this.viewTimer = null
        void this.writeViews()
      }, this.opts.viewDebounceMs ?? VIEW_DEBOUNCE_MS)
    })
  }

  private async writeViews(): Promise<boolean> {
    if (this.viewTimer !== null) {
      clearTimeout(this.viewTimer)
      this.viewTimer = null
    }
    const pending = [...this.pendingViews]
    const waiters = this.viewWaiters
    this.pendingViews.clear()
    this.viewWaiters = []
    let ok = true
    if (pending.length) {
      ok = await this.pages.flush()
      if (!ok) {
        // A view whose pages did not land would replace one that still
        // restores (or the legacy whole-app copy being migrated) with refs to
        // versions that do not exist. Keep it pending: flush() retries.
        for (const [loggedIn, payload] of pending) {
          if (!this.pendingViews.has(loggedIn)) this.pendingViews.set(loggedIn, payload)
        }
        for (const resolve of waiters) resolve()
        return false
      }
      for (const [loggedIn, payload] of pending) {
        try {
          await this.storage.set(viewKey(this.dominoId, loggedIn), JSON.stringify(payload))
        } catch (err) {
          ok = false
          this.report(err)
        }
      }
    }
    for (const resolve of waiters) resolve()
    return ok
  }

  /**
   * Erase every stored screen and BOTH view snapshots — the persisted half of
   * "rebuild from scratch": the other auth flag's view holds pages of the
   * same thrown-away app. `loggedIn` is accepted for compatibility only.
   */
  async clear(_loggedIn?: boolean): Promise<void> {
    if (this.viewTimer !== null) {
      clearTimeout(this.viewTimer)
      this.viewTimer = null
    }
    this.pendingViews.clear()
    for (const resolve of this.viewWaiters.splice(0)) resolve()
    this.entries = []
    this.pages.retain(SCREENS_OWNER, [])
    this.pages.retain(viewOwner(true), [])
    this.pages.retain(viewOwner(false), [])
    // Best-effort per key: one failed removal must not keep the others.
    for (const key of [
      screensKey(this.dominoId),
      viewKey(this.dominoId, true),
      viewKey(this.dominoId, false)
    ]) {
      try {
        await this.storage.remove(key)
      } catch (err) {
        this.report(err)
      }
    }
    await this.pages.flush()
  }

  async loadView(loggedIn: boolean): Promise<ViewSnapshot | null> {
    const pending = this.pendingViews.get(loggedIn)
    if (pending) return this.viewFrom(pending)
    const key = viewKey(this.dominoId, loggedIn)
    const raw = await safeGet(this.storage, key)
    if (!raw) return null
    let parsed: Record<string, unknown>
    try {
      const value: unknown = JSON.parse(raw)
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      parsed = value as Record<string, unknown>
    } catch {
      return null
    }
    if (typeof parsed.page !== 'string') return null
    const at = typeof parsed.at === 'number' ? parsed.at : 0
    const def = typeof parsed.def === 'string' ? parsed.def : undefined

    let snapshot: ViewSnapshot | null = null
    if (parsed.known !== undefined) {
      // Legacy whole-app snapshot: validate it, then move it into the page table.
      const known = tryValidateUiSpec(parsed.known)
      if (known && known.pages.some((p) => p.id === parsed.page)) {
        snapshot = { page: parsed.page, known: { ...known, page: parsed.page }, at }
        void this.saveView(loggedIn, { page: snapshot.page, known: snapshot.known })
      }
    } else {
      const refs = validRefs(parsed.refs)
      if (refs) {
        const pages = this.pages.resolve(refs)
        const known = assembleSpec(parsed.shell, parsed.page, pages)
        if (known) snapshot = { page: parsed.page, known, at }
      }
    }
    if (!snapshot) {
      // Unrestorable (its page is gone, or it fails validation): drop it so the
      // next launch takes the embed / cache / regeneration path instead of
      // tripping over the same snapshot forever.
      try {
        await this.storage.remove(key)
      } catch {
        /* the next launch drops it again */
      }
      return null
    }
    return this.isStale(def) ? { ...snapshot, stale: true } : snapshot
  }

  private viewFrom(payload: ViewPayload): ViewSnapshot | null {
    const pages = this.pages.resolve(payload.refs)
    if (!pages.some((p) => p.id === payload.page)) return null
    return {
      page: payload.page,
      known: { ...payload.shell, version: 1, page: payload.page, pages },
      at: payload.at
    }
  }

  private report(err: unknown): void {
    try {
      this.opts.onPersistError?.(toError(err))
    } catch {
      /* a broken listener must not break persistence */
    }
  }
}

/** Parse the stored screen list — the current ref format or the legacy whole-spec array. */
function parseEntries(
  raw: string | null,
  pages: PageStore,
  fingerprint?: string
): { entries: Entry[]; legacy: boolean } {
  if (!raw) return { entries: [], legacy: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { entries: [], legacy: false }
  }
  const out: Entry[] = []
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const s = item as Record<string, unknown>
      if (typeof s.key !== 'string' || typeof s.at !== 'number') continue
      const spec = tryValidateUiSpec(s.spec)
      // validateUiSpec rewrites a missing page pointer — the stored one must hold.
      if (!spec || (s.spec as { page?: unknown }).page !== spec.page) continue
      const deps = validDeps(s.deps)
      out.push({
        key: s.key,
        page: spec.page,
        refs: pages.refsOf(spec),
        shell: shellOf(spec),
        at: s.at,
        ...(deps ? { deps } : {}),
        // Migrated entries were built against the definition the store opens
        // with (as the legacy view migration stamps it): a later definition
        // change must find them stale like any other entry.
        ...(fingerprint ? { def: fingerprint } : {})
      })
    }
    return { entries: out, legacy: true }
  }
  if (!parsed || typeof parsed !== 'object') return { entries: [], legacy: false }
  const list = (parsed as { entries?: unknown }).entries
  if (!Array.isArray(list)) return { entries: [], legacy: false }
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const s = item as Record<string, unknown>
    if (typeof s.key !== 'string' || typeof s.at !== 'number' || typeof s.page !== 'string')
      continue
    const refs = validRefs(s.refs)
    if (!refs) continue
    const target = refs.find(([id]) => id === s.page)
    if (!target || !pages.resolveOne(target[0], target[1])) continue
    const shell = restoreShell(s.shell, s.page)
    if (!shell) continue
    const deps = validDeps(s.deps)
    out.push({
      key: s.key,
      page: s.page,
      refs,
      shell,
      at: s.at,
      ...(deps ? { deps } : {}),
      ...(typeof s.def === 'string' ? { def: s.def } : {})
    })
  }
  return { entries: out, legacy: false }
}

/** A deps map survives only as `Record<string, string>`; anything else is dropped. */
function validDeps(deps: unknown): ScreenDeps | undefined {
  if (!deps || typeof deps !== 'object' || Array.isArray(deps)) return undefined
  const entries = Object.entries(deps as Record<string, unknown>)
  if (!entries.length || !entries.every(([, v]) => typeof v === 'string')) return undefined
  return deps as ScreenDeps
}
