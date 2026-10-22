import type { UiSpec } from '../spec'
import type { KeyValueStorage } from './prefs'

/**
 * SessionStore — in-memory only by design.
 *
 * - History: browser-style back/forward over rendered UiSpec snapshots.
 *   A new render after an interaction truncates the forward branch.
 * - Cache: "this screen was already rendered in this session, reuse it".
 *   The cache dies with the process: restarting the app regenerates screens.
 */

/** What produced a history entry — shown as the panel's badge. */
export type HistoryKind = 'start' | 'action' | 'nav' | 'edit' | 'restore'

export interface Snapshot {
  spec: UiSpec
  at: number
  kind: HistoryKind
  label: string
  /** First line of the edit request, when this moment came from one. */
  note?: string
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
}

export interface SnapshotMeta {
  kind: HistoryKind
  label?: string
  note?: string
}

/**
 * The stack backs both navigation and the history panel, so it stays bounded:
 * beyond this, the oldest moments fall off (and with them, restorability).
 */
export const MAX_HISTORY = 50

export class SessionStore {
  private stack: Snapshot[] = []
  private idx = -1
  private readonly cache = new Map<string, UiSpec>()
  /** Optional cross-restart persistence (attach() wires it; debounced). */
  private storage: KeyValueStorage | null = null
  private historyKey: string | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null

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

  /** Push a newly rendered screen, dropping any forward history. */
  push(spec: UiSpec, meta?: Partial<SnapshotMeta>): void {
    this.stack.splice(this.idx + 1)
    const page = spec.pages.find((p) => p.id === spec.page)
    this.stack.push({
      spec,
      at: Date.now(),
      kind: meta?.kind ?? 'action',
      label: meta?.label ?? page?.name ?? spec.page,
      ...(meta?.note !== undefined ? { note: meta.note } : {})
    })
    this.idx = this.stack.length - 1
    if (this.stack.length > MAX_HISTORY) {
      const drop = this.stack.length - MAX_HISTORY
      this.stack.splice(0, drop)
      this.idx = Math.max(0, this.idx - drop)
    }
    this.schedulePersist()
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

  /** Every moment in order, with the panel's labels and the current marker. */
  entries(): HistoryEntry[] {
    return this.stack.map((s, i) => ({
      index: i,
      pageId: s.spec.page,
      label: s.label,
      kind: s.kind,
      at: s.at,
      current: i === this.idx,
      ...(s.note !== undefined ? { note: s.note } : {})
    }))
  }

  /**
   * Opt into cross-restart persistence: called once at boot with the app's
   * storage and a per-domino key; without it the store stays in-memory.
   */
  attach(storage: KeyValueStorage, historyKey: string): void {
    this.storage = storage
    this.historyKey = historyKey
  }

  /** Restore a previously persisted stack (any parse failure = fresh start). */
  async load(): Promise<boolean> {
    if (!this.storage || !this.historyKey) return false
    try {
      const raw = await this.storage.get(this.historyKey)
      if (!raw) return false
      const parsed = JSON.parse(raw) as { stack?: Snapshot[]; idx?: number }
      if (!Array.isArray(parsed.stack) || parsed.stack.length === 0) return false
      if (!parsed.stack.every((s) => s && s.kind && s.label && s.spec?.pages)) return false
      this.stack = parsed.stack.slice(-MAX_HISTORY)
      const idx = typeof parsed.idx === 'number' ? parsed.idx : this.stack.length - 1
      this.idx = Math.min(Math.max(idx, 0), this.stack.length - 1)
      return true
    } catch {
      return false
    }
  }

  /** Debounced write — 50 full specs are far too big to save per keystroke-ish navigation. */
  private schedulePersist(): void {
    if (!this.storage || !this.historyKey) return
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.persist()
    }, 800)
  }

  private async persist(): Promise<void> {
    if (!this.storage || !this.historyKey) return
    try {
      await this.storage.set(this.historyKey, JSON.stringify({ v: 1, stack: this.stack, idx: this.idx }))
    } catch {
      /* persistence is best-effort — the session keeps working in memory */
    }
  }

  /** Session-scoped render cache (cleared when the program restarts). */
  cacheGet(key: string): UiSpec | null {
    return this.cache.get(key) ?? null
  }

  cacheSet(key: string, spec: UiSpec): void {
    this.cache.set(key, spec)
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

/** Cheap stable hash for screen-identity keys. */
export function hashContext(input: unknown): string {
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? {})
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}
