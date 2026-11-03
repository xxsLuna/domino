import { tryValidateUiSpec, type UiSpec } from '../spec'
import type { KeyValueStorage } from './prefs'
import { safeGet, toError } from './kv'
import {
  PageStore,
  assembleSpec,
  shellOf,
  validRefs,
  type PageRefs,
  type SpecShell
} from './pageStore'

/**
 * SessionStore — back/forward history plus the in-process render cache.
 *
 * - History: browser-style back/forward over rendered UiSpec snapshots.
 *   A new render after an interaction truncates the forward branch.
 * - Cache: "this screen was already rendered in this session, reuse it".
 *   The cache dies with the process: restarting the app regenerates screens
 *   (the persisted screen cache lives in ScreenStore).
 *
 * attach() opts the stack into cross-restart persistence. Snapshots are
 * stored by reference — page id + version into the domino's PageStore — so
 * fifty moments of a thirty-page app cost a few kilobytes instead of fifty
 * whole-app copies. The key is meant to be per auth state (historyKey()):
 * signed-in and signed-out stacks never mix, and rebind() switches between
 * them when the user signs in or out. Writes are debounced; flush() writes
 * now (pagehide / unmount), and failures reach `onPersistError`.
 */

/** What produced a history entry — shown as the panel's badge. */
export type HistoryKind = 'start' | 'action' | 'nav' | 'edit' | 'restore'

const KINDS: ReadonlySet<string> = new Set<HistoryKind>([
  'start',
  'action',
  'nav',
  'edit',
  'restore'
])

export interface Snapshot {
  spec: UiSpec
  at: number
  kind: HistoryKind
  label: string
  /** First line of the edit request, when this moment came from one. */
  note?: string
  /**
   * Identity of the record a data-carrying press showed (row select,
   * submit…): pages reused across records (one `order-detail` id for every
   * order) are told apart on back/forward by it.
   */
  dataKey?: string
  /**
   * The press landed on a DIFFERENT page than it was made on: only then is
   * `dataKey` the identity of the record this page shows. An in-place data
   * press (search, filter, pagination on a list) also carries a dataKey, but
   * its page is still the plain list.
   */
  recordLanding?: boolean
}

/** One row of the history panel / the agent's injected screen-history line. */
export interface HistoryEntry {
  index: number
  pageId: string
  label: string
  kind: HistoryKind
  at: number
  current: boolean
  note?: string
  /** Snapshot.dataKey: the moment showed one record of a page reused across records. */
  dataKey?: string
  /** Snapshot.recordLanding. */
  recordLanding?: boolean
}

export interface SnapshotMeta {
  kind: HistoryKind
  label?: string
  note?: string
  dataKey?: string
  recordLanding?: boolean
}

export interface SessionPersistOptions {
  /** Page-table namespace; derived from a `domino:history:<id>…` key when omitted. */
  dominoId?: string
  /** Definition fingerprint: stamped on writes; a stack saved under another one is dropped. */
  fingerprint?: string
  /** Told about every failed write (quota, disk). */
  onPersistError?: (err: Error) => void
  /**
   * Pre-partition key (`domino:history:<id>`) to migrate from when the
   * attached key holds nothing — pass it only when the stack can't carry
   * another auth state's screens (an app without sign-in). Removed once the
   * migrated stack is written under the new key.
   */
  legacyKey?: string
  /** Write debounce; default 400ms. */
  debounceMs?: number
}

/**
 * The stack backs both navigation and the history panel, so it stays bounded:
 * beyond this, the oldest moments fall off (and with them, restorability).
 */
export const MAX_HISTORY = 50
const PERSIST_DEBOUNCE_MS = 400

/** Persisted history of one domino for one auth state. */
export function historyKey(dominoId: string, loggedIn: boolean): string {
  return `domino:history:${dominoId}::auth:${loggedIn ? 'true' : 'false'}`
}

/** The single pre-partition key older builds wrote (mixed auth states). */
export function legacyHistoryKey(dominoId: string): string {
  return `domino:history:${dominoId}`
}

/** `domino:history:<id>[::auth:<flag>]` → `<id>`; any other key is its own namespace. */
export function dominoIdOfHistoryKey(key: string): string {
  const prefix = 'domino:history:'
  if (!key.startsWith(prefix)) return key
  return key.slice(prefix.length).replace(/::auth:(?:true|false)$/, '')
}

const historyOwner = (key: string): string => `history:${key}`

interface StoredMoment {
  page: string
  /** Index into the payload's `refSets` — consecutive moments mostly share one app. */
  r: number
  shell: SpecShell
  kind: HistoryKind
  label: string
  at: number
  note?: string
  /** Snapshot.dataKey. */
  dk?: string
  /** Snapshot.recordLanding. */
  rl?: 1
}

export class SessionStore {
  private stack: Snapshot[] = []
  private idx = -1
  private readonly cache = new Map<string, UiSpec>()
  /** Optional cross-restart persistence (attach() wires it; debounced). */
  private storage: KeyValueStorage | null = null
  private historyKey: string | null = null
  private opts: SessionPersistOptions = {}
  private pages: Promise<PageStore> | null = null
  private pagesId: string | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private persisting: Promise<unknown> = Promise.resolve()
  /** A write was held back (its pages did not land): flush() tries again. */
  private retryPending = false

  get current(): Snapshot | null {
    return this.idx >= 0 ? this.stack[this.idx] : null
  }

  get canBack(): boolean {
    return this.idx > 0
  }

  get canForward(): boolean {
    return this.idx >= 0 && this.idx < this.stack.length - 1
  }

  get historySize(): number {
    return this.stack.length
  }

  /** Position of the current moment (-1 when the stack is empty). */
  get index(): number {
    return this.idx
  }

  /** The key the stack persists under (null while in-memory only). */
  get persistKey(): string | null {
    return this.historyKey
  }

  /** Push a newly rendered screen, dropping any forward history. */
  push(spec: UiSpec, meta?: Partial<SnapshotMeta>): void {
    this.stack.splice(this.idx + 1)
    const page = spec.pages.find((p) => p.id === spec.page)
    this.stack.push({
      spec,
      at: Date.now(),
      kind: meta?.kind ?? 'action',
      label: meta?.label ?? page?.name ?? spec.page,
      ...(meta?.note !== undefined ? { note: meta.note } : {}),
      ...(meta?.dataKey !== undefined ? { dataKey: meta.dataKey } : {}),
      ...(meta?.recordLanding ? { recordLanding: true } : {})
    })
    this.idx = this.stack.length - 1
    if (this.stack.length > MAX_HISTORY) {
      const drop = this.stack.length - MAX_HISTORY
      this.stack.splice(0, drop)
      this.idx = Math.max(0, this.idx - drop)
    }
    this.schedulePersist()
  }

  /**
   * Overwrite the moment at `index` in place (a later screen of the same
   * turn): one press is one moment, so Back never lands on the turn's own
   * intermediate render. Only the current, newest moment may be replaced —
   * anything else means the user moved on, and the caller pushes instead.
   */
  replaceTop(index: number, spec: UiSpec, meta?: Partial<SnapshotMeta>): boolean {
    if (index !== this.idx || index !== this.stack.length - 1 || index < 0) return false
    const prev = this.stack[index]
    const page = spec.pages.find((p) => p.id === spec.page)
    const next: Snapshot = {
      spec,
      at: prev.at,
      kind: meta?.kind ?? prev.kind,
      label: meta?.label ?? page?.name ?? spec.page
    }
    const note = meta?.note ?? prev.note
    if (note !== undefined) next.note = note
    const dataKey = meta && 'dataKey' in meta ? meta.dataKey : prev.dataKey
    if (dataKey !== undefined) next.dataKey = dataKey
    if (meta && 'recordLanding' in meta ? meta.recordLanding : prev.recordLanding) {
      next.recordLanding = true
    }
    this.stack[index] = next
    this.schedulePersist()
    return true
  }

  back(): Snapshot | null {
    if (!this.canBack) return null
    this.idx -= 1
    this.schedulePersist()
    return this.stack[this.idx]
  }

  forward(): Snapshot | null {
    if (!this.canForward) return null
    this.idx += 1
    this.schedulePersist()
    return this.stack[this.idx]
  }

  /** Move to an arbitrary moment without pushing — history-panel restore. */
  jumpTo(index: number): Snapshot | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.stack.length) return null
    this.idx = index
    this.schedulePersist()
    return this.stack[index]
  }

  /** Newest index whose moment shows `pageId` (-1 when none) — view/history reconciliation. */
  lastIndexOf(pageId: string): number {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].spec.page === pageId) return i
    }
    return -1
  }

  /** Every moment in order, with the panel's labels and the current marker. */
  entries(): HistoryEntry[] {
    return this.stack.map((s, i) => ({
      index: i,
      pageId: s.spec.page,
      label: s.label,
      kind: s.kind,
      at: s.at,
      current: i === this.idx,
      ...(s.note !== undefined ? { note: s.note } : {}),
      ...(s.dataKey !== undefined ? { dataKey: s.dataKey } : {}),
      ...(s.recordLanding ? { recordLanding: true } : {})
    }))
  }

  /**
   * Opt into cross-restart persistence: called once at boot with the app's
   * storage and a per-domino, per-auth key (historyKey()); without it the
   * store stays in-memory.
   */
  attach(storage: KeyValueStorage, key: string, opts: SessionPersistOptions = {}): void {
    this.storage = storage
    this.historyKey = key
    this.opts = opts
    this.openPages(opts.dominoId ?? dominoIdOfHistoryKey(key))
  }

  private openPages(dominoId: string): void {
    if (!this.storage || this.pagesId === dominoId) return
    this.pagesId = dominoId
    this.pages = PageStore.open(this.storage, dominoId)
    const listener = this.opts.onPersistError
    if (listener) void this.pages.then((p) => p.onError(listener))
  }

  /**
   * Restore a previously persisted stack. Snapshots that no longer validate
   * (or whose page is gone) are dropped one by one and the position is kept
   * on the nearest surviving moment; false only when nothing is left, the
   * payload is unreadable, or it was saved under another definition.
   */
  async load(): Promise<boolean> {
    const storage = this.storage
    const key = this.historyKey
    if (!storage || !key || !this.pages) return false
    const pages = await this.pages
    let raw = await safeGet(storage, key)
    const legacyKey =
      !raw && this.opts.legacyKey && this.opts.legacyKey !== key ? this.opts.legacyKey : null
    if (legacyKey) raw = await safeGet(storage, legacyKey)
    if (!raw) return false
    let parsed: Record<string, unknown>
    try {
      const value: unknown = JSON.parse(raw)
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      parsed = value as Record<string, unknown>
    } catch {
      return false
    }
    const version = parsed.v
    if (version !== undefined && version !== 1 && version !== 2) return false
    const fp = this.opts.fingerprint
    if (fp && typeof parsed.def === 'string' && parsed.def !== fp) return false
    if (!Array.isArray(parsed.stack) || parsed.stack.length === 0) return false

    const all = parsed.stack as unknown[]
    const source = all.slice(-MAX_HISTORY)
    const rawIdx =
      typeof parsed.idx === 'number' && Number.isInteger(parsed.idx) ? parsed.idx : all.length - 1
    const wantIdx = rawIdx - (all.length - source.length)
    const refSets = Array.isArray(parsed.refSets) ? parsed.refSets.map(validRefs) : []
    const kept: Snapshot[] = []
    let idx = -1
    source.forEach((item, i) => {
      const snap = version === 2 ? momentFromRefs(item, refSets, pages) : momentFromLegacy(item)
      if (!snap) return
      kept.push(snap)
      if (i <= wantIdx) idx = kept.length - 1
    })
    if (kept.length === 0) return false
    // The partitioned stack is in use: a pre-partition copy left behind is
    // never read again (load only falls back to it while this key is empty)
    // and would keep taking quota — drop it.
    const staleLegacy = !legacyKey && this.opts.legacyKey && this.opts.legacyKey !== key
    if (staleLegacy) void storage.remove(this.opts.legacyKey!).catch(() => undefined)
    this.stack = kept
    this.idx = Math.min(Math.max(idx, 0), kept.length - 1)
    if (version !== 2 || legacyKey) {
      // Old whole-app snapshots (or the pre-partition key): rewrite by reference now.
      void this.persist().then((ok) => {
        if (ok && legacyKey) return storage.remove(legacyKey).catch(() => undefined)
        return undefined
      })
    }
    return true
  }

  /**
   * Switch to another persisted stack (sign-in / sign-out): pending writes go
   * to the old key first, then the in-memory stack AND the render cache are
   * dropped — renders of one auth state must never answer for the other —
   * and the new key's stack is loaded.
   */
  async rebind(key: string): Promise<boolean> {
    await this.flush()
    this.stack = []
    this.idx = -1
    this.cache.clear()
    this.historyKey = key
    if (!this.opts.dominoId) this.openPages(dominoIdOfHistoryKey(key))
    return this.load()
  }

  /**
   * Delete a persisted stack and release its pages — e.g. the signed-in stack
   * after sign-out, so the next person on this device can't restore it.
   */
  async forget(key: string): Promise<void> {
    const storage = this.storage
    if (!storage) return
    if (key === this.historyKey && this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.persisting
    try {
      await storage.remove(key)
    } catch (err) {
      this.report(err)
    }
    const pages =
      this.opts.dominoId || dominoIdOfHistoryKey(key) === this.pagesId ? await this.pages : null
    if (pages) {
      pages.retain(historyOwner(key), [])
      await pages.flush()
    }
  }

  /** Write a pending (debounced) persist now and wait for any write in flight. */
  async flush(): Promise<void> {
    if (this.saveTimer !== null || this.retryPending) {
      if (this.saveTimer !== null) clearTimeout(this.saveTimer)
      this.saveTimer = null
      await this.persist()
      return
    }
    await this.persisting
  }

  /** Debounced write — navigation bursts become one write. */
  private schedulePersist(): void {
    if (!this.storage || !this.historyKey) return
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.persist()
    }, this.opts.debounceMs ?? PERSIST_DEBOUNCE_MS)
  }

  /** Capture the stack now, write it after any write in flight. */
  private persist(): Promise<boolean> {
    const storage = this.storage
    const key = this.historyKey
    const pagesP = this.pages
    if (!storage || !key || !pagesP) return Promise.resolve(true)
    const stack = this.stack.slice()
    const idx = this.idx
    const def = this.opts.fingerprint
    const run = this.persisting.then(async () => {
      const pages = await pagesP
      const refSets: PageRefs[] = []
      const setIndex = new Map<string, number>()
      const moments: StoredMoment[] = stack.map((s) => {
        const refs = pages.refsOf(s.spec)
        const id = JSON.stringify(refs)
        let r = setIndex.get(id)
        if (r === undefined) {
          r = refSets.push(refs) - 1
          setIndex.set(id, r)
        }
        return {
          page: s.spec.page,
          r,
          shell: shellOf(s.spec),
          kind: s.kind,
          label: s.label,
          at: s.at,
          ...(s.note !== undefined ? { note: s.note } : {}),
          ...(s.dataKey !== undefined ? { dk: s.dataKey } : {}),
          ...(s.recordLanding ? { rl: 1 as const } : {})
        }
      })
      // A moment can be restored as it was (history panel), so every page
      // version it shows stays pinned while the moment is on the stack.
      pages.retain(
        historyOwner(key),
        refSets.flatMap((refs) => refs.map((r) => r[1]))
      )
      // Pages before the stack that points at them. When a page blob did not
      // land (quota — the page table reports why), the stack is NOT written:
      // its refs would point at versions that do not exist, and it would
      // replace a stack (or a whole-copy legacy payload being migrated) that
      // still restores. The next persist / flush tries again.
      const pagesOk = await pages.flush()
      if (!pagesOk) {
        this.retryPending = true
        return false
      }
      try {
        await storage.set(
          key,
          JSON.stringify({ v: 2, ...(def ? { def } : {}), idx, refSets, stack: moments })
        )
        this.retryPending = false
        return true
      } catch (err) {
        this.retryPending = true
        this.report(err)
        return false
      }
    })
    this.persisting = run.catch(() => undefined)
    return run
  }

  private report(err: unknown): void {
    try {
      this.opts.onPersistError?.(toError(err))
    } catch {
      /* a broken listener must not break persistence */
    }
  }

  /** Session-scoped render cache (cleared when the program restarts). */
  cacheGet(key: string): UiSpec | null {
    return this.cache.get(key) ?? null
  }

  cacheSet(key: string, spec: UiSpec): void {
    this.cache.set(key, spec)
  }

  /**
   * Forget every cached render that lands on `pageId` (except `keepKey`):
   * the page was edited, and replaying an older copy would revert the edit.
   */
  cacheEvictPage(pageId: string, keepKey?: string): void {
    for (const [key, spec] of this.cache) {
      if (spec.page === pageId && key !== keepKey) this.cache.delete(key)
    }
  }

  /** Drop every cached render (an auth or definition boundary) — the stack stays. */
  cacheClear(): void {
    this.cache.clear()
  }

  get cacheSize(): number {
    return this.cache.size
  }

  /** Drop the back stack and every cached render ("rebuild from scratch"). */
  reset(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.stack = []
    this.idx = -1
    this.cache.clear()
    this.schedulePersist() // persist the cleared stack too
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  Boolean(x) && typeof x === 'object' && !Array.isArray(x)

function metaOf(s: Record<string, unknown>): Omit<Snapshot, 'spec'> | null {
  if (typeof s.kind !== 'string' || !KINDS.has(s.kind)) return null
  if (typeof s.label !== 'string' || !s.label) return null
  return {
    kind: s.kind as HistoryKind,
    label: s.label,
    at: typeof s.at === 'number' ? s.at : 0,
    ...(typeof s.note === 'string' ? { note: s.note } : {}),
    ...(typeof s.dk === 'string' ? { dataKey: s.dk } : {}),
    ...(s.rl === 1 || s.recordLanding === true ? { recordLanding: true } : {})
  }
}

/** A stored-by-reference moment → snapshot (null when unrestorable). */
function momentFromRefs(
  item: unknown,
  refSets: Array<PageRefs | null>,
  pages: PageStore
): Snapshot | null {
  if (!isRecord(item) || typeof item.page !== 'string') return null
  const meta = metaOf(item)
  const refs =
    typeof item.r === 'number' && Number.isInteger(item.r)
      ? (refSets[item.r] ?? null)
      : validRefs(item.refs)
  if (!meta || !refs) return null
  const spec = assembleSpec(item.shell, item.page, pages.resolve(refs))
  return spec ? { ...meta, spec } : null
}

/** A pre-page-table snapshot (whole spec inline) → validated snapshot. */
function momentFromLegacy(item: unknown): Snapshot | null {
  if (!isRecord(item) || !isRecord(item.spec)) return null
  const meta = metaOf(item)
  if (!meta) return null
  const spec = tryValidateUiSpec(item.spec)
  // validateUiSpec rewrites a dangling page pointer — the stored one must hold.
  if (!spec || spec.page !== item.spec.page) return null
  return { ...meta, spec }
}

/** Cheap stable hash for screen-identity keys. */
export function hashContext(input: unknown): string {
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? {})
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}
