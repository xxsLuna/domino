import { tryValidateUiSpec, type PageSpec, type UiSpec } from '../spec'
import type { KeyValueStorage } from './prefs'
import { getMany, safeGet, toError } from './kv'

/**
 * PageStore — the per-domino page table every persisted moment points into.
 *
 * The screen cache, the view snapshots and the back/forward history used to
 * each carry whole-app copies (every page, every time), so a 30-page app
 * blew the storage quota within a session or two and every tap rewrote
 * megabytes. Now each page VERSION is stored exactly once, content-addressed:
 *
 * - `domino:page:<id>::v:<version>` → `{ v, page }`: one page as it was at
 *   some moment. The version is a hash of the page JSON, so an unchanged page
 *   is never written twice.
 * - `domino:pageindex:<id>` → which versions exist, which owner (screen
 *   cache, a view snapshot, a history stack) still pins which versions, and
 *   the newest version per page id. Owners that are not loaded right now
 *   (the other auth flag's view, a signed-in history stack while signed out)
 *   keep their pins through this index, so garbage collection never pulls a
 *   page out from under them.
 *
 * Owners hand over refs (`[pageId, version]` pairs) instead of pages and
 * re-declare their pins with `retain()`; `flush()` writes new versions that
 * someone pins, removes the ones nobody pins any more, and saves the index.
 * A ref whose exact version is gone resolves to the newest stored version of
 * the same page id — a restored moment shows that page as it is now rather
 * than not at all.
 */

/** One moment of the app by reference: page id → page version, in page order. */
export type PageRefs = Array<[pageId: string, version: string]>

/** Everything of a UiSpec except its pages (page pointer, nav, state…). */
export type SpecShell = Omit<UiSpec, 'pages'>

export function pageIndexKey(dominoId: string): string {
  return `domino:pageindex:${dominoId}`
}

export function pageBlobKey(dominoId: string, version: string): string {
  return `domino:page:${dominoId}::v:${version}`
}

interface IndexPayload {
  v: 2
  /** Stored versions, oldest write first (the fallback order for `latest`). */
  blobs: string[]
  owners: Record<string, string[]>
  latest: Record<string, string>
}

/* ------------------------------ page versions ------------------------------ */

// Pages are treated as immutable everywhere (React state, specs from the
// model), so a version computed once per page object stays true; hashing a
// 30-page app on every navigation would cost what we just stopped writing.
const versionCache = new WeakMap<PageSpec, string>()

/** Two independent 32-bit hashes — a collision would swap a page's content. */
function hash64(text: string): string {
  let djb = 5381
  let fnv = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    djb = ((djb << 5) + djb + c) | 0
    fnv = Math.imul(fnv ^ c, 0x01000193)
  }
  return (djb >>> 0).toString(36) + (fnv >>> 0).toString(36).padStart(7, '0')
}

/** Content version of one page (cached per page object). */
export function pageVersion(page: PageSpec): string {
  let v = versionCache.get(page)
  if (!v) {
    v = hash64(JSON.stringify(page))
    versionCache.set(page, v)
  }
  return v
}

/* ------------------------------- validation ------------------------------- */

const isRecord = (x: unknown): x is Record<string, unknown> =>
  Boolean(x) && typeof x === 'object' && !Array.isArray(x)

/**
 * A stored page through the same validator model output goes through, so a
 * page saved by an older build (a renamed prop, a hand-edited export) can't
 * reach the renderer malformed. Null when it can't be repaired.
 */
export function restorePage(raw: unknown): PageSpec | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null
  const spec = tryValidateUiSpec({ version: 1, page: raw.id, pages: [raw] })
  return spec?.pages.find((p) => p.id === raw.id) ?? null
}

/**
 * Validate a spec's non-page fields (nav, state, …) without re-validating
 * every page: a placeholder page carries the shell through the validator.
 */
export function restoreShell(shell: unknown, page: string): SpecShell | null {
  if (typeof page !== 'string' || !page) return null
  const base = isRecord(shell) ? { ...shell } : {}
  delete base.pages
  const probe = tryValidateUiSpec({
    ...base,
    version: 1,
    page,
    pages: [{ id: page, name: page, layout: [] }]
  })
  if (!probe || probe.page !== page) return null
  const { pages: _pages, ...rest } = probe
  return rest
}

/** Rebuild a whole-app spec; null when the shell is unusable or `page` is missing. */
export function assembleSpec(shell: unknown, page: string, pages: PageSpec[]): UiSpec | null {
  if (!pages.some((p) => p.id === page)) return null
  const valid = restoreShell(shell, page)
  return valid ? { ...valid, page, pages } : null
}

/** A spec without its pages. */
export function shellOf(spec: UiSpec): SpecShell {
  const { pages: _pages, ...shell } = spec
  return shell
}

/** Refs survive only as `[string, string]` pairs. */
export function validRefs(raw: unknown): PageRefs | null {
  if (!Array.isArray(raw)) return null
  const out: PageRefs = []
  for (const r of raw) {
    if (
      Array.isArray(r) &&
      r.length === 2 &&
      typeof r[0] === 'string' &&
      typeof r[1] === 'string'
    ) {
      out.push([r[0], r[1]])
    }
  }
  return out
}

/* --------------------------------- store --------------------------------- */

const shared = new WeakMap<object, Map<string, Promise<PageStore>>>()

export class PageStore {
  /** version → page (validated). */
  private readonly blobs = new Map<string, PageSpec>()
  /** Versions known to be written. */
  private readonly persisted = new Set<string>()
  /** owner → pinned versions. */
  private readonly owners = new Map<string, Set<string>>()
  /** page id → newest version seen. */
  private readonly latest = new Map<string, string>()
  private indexDirty = false
  private chain: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(err: Error) => void>()

  private constructor(
    private readonly storage: KeyValueStorage,
    readonly dominoId: string
  ) {}

  /**
   * The page table of one domino. Shared per (storage, domino) so the screen
   * cache, the views and the history stack pin into the same index — two
   * instances would overwrite each other's pins.
   */
  static open(storage: KeyValueStorage, dominoId: string): Promise<PageStore> {
    let byId = shared.get(storage)
    if (!byId) {
      byId = new Map()
      shared.set(storage, byId)
    }
    let store = byId.get(dominoId)
    if (!store) {
      store = PageStore.load(storage, dominoId)
      byId.set(dominoId, store)
    }
    return store
  }

  /** Drop the shared instance (after its keys were wiped behind its back). */
  static forget(storage: KeyValueStorage, dominoId: string): void {
    shared.get(storage)?.delete(dominoId)
  }

  private static async load(storage: KeyValueStorage, dominoId: string): Promise<PageStore> {
    const store = new PageStore(storage, dominoId)
    const index = parseIndex(await safeGet(storage, pageIndexKey(dominoId)))
    if (!index) return store
    const values = await getMany(
      storage,
      index.blobs.map((v) => pageBlobKey(dominoId, v))
    )
    index.blobs.forEach((v, i) => {
      const page = parseBlob(values[i])
      if (!page) {
        // Missing or unreadable: the index stops listing it on the next flush.
        store.indexDirty = true
        return
      }
      versionCache.set(page, v) // a restored page maps back to its stored version
      store.blobs.set(v, page)
      store.persisted.add(v)
      store.latest.set(page.id, v) // index order: newer writes win
    })
    for (const [id, v] of Object.entries(index.latest)) {
      if (store.blobs.get(v)?.id === id) store.latest.set(id, v)
    }
    for (const [owner, versions] of Object.entries(index.owners)) {
      store.owners.set(owner, new Set(versions))
    }
    return store
  }

  /** Remember one page in memory; returns its version. Nothing is written until flush(). */
  put(page: PageSpec): string {
    const v = pageVersion(page)
    if (!this.blobs.has(v)) this.blobs.set(v, page)
    if (this.latest.get(page.id) !== v) {
      this.latest.set(page.id, v)
      this.indexDirty = true
    }
    return v
  }

  /** Remember every page of a spec; returns its refs. */
  refsOf(spec: UiSpec): PageRefs {
    return spec.pages.map((p): [string, string] => [p.id, this.put(p)])
  }

  /** The page stored under this exact version. */
  page(version: string): PageSpec | undefined {
    return this.blobs.get(version)
  }

  /** The newest known version of a page id. */
  latestOf(pageId: string): PageSpec | undefined {
    const v = this.latest.get(pageId)
    return v ? this.blobs.get(v) : undefined
  }

  /** One ref → its page; a vanished version falls back to the page's newest version. */
  resolveOne(pageId: string, version: string): PageSpec | undefined {
    const exact = this.blobs.get(version)
    return exact && exact.id === pageId ? exact : this.latestOf(pageId)
  }

  /** Refs → pages (dropping ids nothing is stored for, and duplicates). */
  resolve(refs: PageRefs): PageSpec[] {
    const seen = new Set<string>()
    const out: PageSpec[] = []
    for (const [id, v] of refs) {
      if (seen.has(id)) continue
      const page = this.resolveOne(id, v)
      if (!page) continue
      seen.add(id)
      out.push(page)
    }
    return out
  }

  /** Re-declare which versions an owner still needs (replaces its earlier pins). */
  retain(owner: string, versions: Iterable<string>): void {
    const next = new Set(versions)
    const prev = this.owners.get(owner)
    if (next.size === 0) {
      if (prev) {
        this.owners.delete(owner)
        this.indexDirty = true
      }
      return
    }
    if (prev && prev.size === next.size && [...next].every((v) => prev.has(v))) return
    this.owners.set(owner, next)
    this.indexDirty = true
  }

  /** Versions currently pinned by this owner (empty when none). */
  pinned(owner: string): string[] {
    return [...(this.owners.get(owner) ?? [])]
  }

  /** Get told when a page or index write fails (quota, disk). Returns an unsubscribe. */
  onError(listener: (err: Error) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Write what's pinned and not yet stored, drop what nobody pins, save the
   * index. Calls run one after another; false when any write failed (the
   * listeners have been told why).
   */
  flush(): Promise<boolean> {
    const run = this.chain.then(() => this.write())
    this.chain = run.catch(() => undefined)
    return run
  }

  private live(): Set<string> {
    const live = new Set<string>()
    for (const set of this.owners.values()) for (const v of set) live.add(v)
    return live
  }

  private async write(): Promise<boolean> {
    const live = this.live()
    const toWrite = [...live].filter((v) => !this.persisted.has(v) && this.blobs.has(v))
    const garbage = [...this.persisted].filter((v) => !live.has(v))
    if (!toWrite.length && !garbage.length && !this.indexDirty) return true
    let ok = true
    for (const v of toWrite) {
      try {
        await this.storage.set(
          pageBlobKey(this.dominoId, v),
          JSON.stringify({ v, page: this.blobs.get(v) })
        )
        this.persisted.add(v)
      } catch (err) {
        ok = false
        this.report(err)
        break // the store is full or gone — the rest would fail the same way
      }
    }
    // A version being replaced goes only once its replacement is stored:
    // the owners that still point at it on disk (a stack or view held back
    // by the failed write) must keep restoring.
    for (const v of ok ? garbage : []) {
      try {
        await this.storage.remove(pageBlobKey(this.dominoId, v))
        this.persisted.delete(v)
      } catch {
        /* stays listed; the next flush tries again */
      }
    }
    this.prune(live)
    try {
      await this.storage.set(pageIndexKey(this.dominoId), JSON.stringify(this.indexPayload()))
      this.indexDirty = false
    } catch (err) {
      ok = false
      this.report(err)
    }
    return ok
  }

  /**
   * Forget in-memory versions nobody pins and that aren't any page's newest:
   * owners re-put their pages from the specs they hold before pinning them.
   */
  private prune(live: Set<string>): void {
    const newest = new Set(this.latest.values())
    for (const v of [...this.blobs.keys()]) {
      if (!live.has(v) && !newest.has(v) && !this.persisted.has(v)) this.blobs.delete(v)
    }
  }

  private indexPayload(): IndexPayload {
    const owners: Record<string, string[]> = {}
    for (const [owner, set] of this.owners) owners[owner] = [...set]
    const latest: Record<string, string> = {}
    for (const [id, v] of this.latest) if (this.persisted.has(v)) latest[id] = v
    return { v: 2, blobs: [...this.persisted], owners, latest }
  }

  private report(err: unknown): void {
    const error = toError(err)
    for (const listener of this.listeners) {
      try {
        listener(error)
      } catch {
        /* a broken listener must not break persistence */
      }
    }
  }
}

function parseIndex(raw: string | null): IndexPayload | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || !Array.isArray(parsed.blobs)) return null
    const blobs = parsed.blobs.filter((v): v is string => typeof v === 'string')
    const owners: Record<string, string[]> = {}
    if (isRecord(parsed.owners)) {
      for (const [owner, list] of Object.entries(parsed.owners)) {
        if (Array.isArray(list))
          owners[owner] = list.filter((v): v is string => typeof v === 'string')
      }
    }
    const latest: Record<string, string> = {}
    if (isRecord(parsed.latest)) {
      for (const [id, v] of Object.entries(parsed.latest)) if (typeof v === 'string') latest[id] = v
    }
    return { v: 2, blobs, owners, latest }
  } catch {
    return null
  }
}

function parseBlob(raw: string | null): PageSpec | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? restorePage(parsed.page) : null
  } catch {
    return null
  }
}
