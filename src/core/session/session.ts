import type { UiSpec } from '../spec'

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
}

/** One row of the history panel / the agent's injected screen-history line. */
export interface HistoryEntry {
  index: number
  pageId: string
  label: string
  kind: HistoryKind
  at: number
  current: boolean
}

export interface SnapshotMeta {
  kind: HistoryKind
  label?: string
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
      label: meta?.label ?? page?.name ?? spec.page
    })
    this.idx = this.stack.length - 1
    if (this.stack.length > MAX_HISTORY) {
      const drop = this.stack.length - MAX_HISTORY
      this.stack.splice(0, drop)
      this.idx = Math.max(0, this.idx - drop)
    }
  }

  back(): Snapshot | null {
    if (!this.canBack) return null
    this.idx -= 1
    return this.stack[this.idx]
  }

  forward(): Snapshot | null {
    if (!this.canForward) return null
    this.idx += 1
    return this.stack[this.idx]
  }

  /** Move to an arbitrary moment without pushing — history-panel restore. */
  jumpTo(index: number): Snapshot | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.stack.length) return null
    this.idx = index
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
      current: i === this.idx
    }))
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
    this.stack = []
    this.idx = -1
    this.cache.clear()
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
