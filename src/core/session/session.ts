import type { UiSpec } from '../spec'

/**
 * SessionStore — in-memory only by design.
 *
 * - History: browser-style back/forward over rendered UiSpec snapshots.
 *   A new render after an interaction truncates the forward branch.
 * - Cache: "this screen was already rendered in this session, reuse it".
 *   The cache dies with the process: restarting the app regenerates screens.
 */

export interface Snapshot {
  spec: UiSpec
  at: number
}

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
  push(spec: UiSpec): void {
    this.stack.splice(this.idx + 1)
    this.stack.push({ spec, at: Date.now() })
    this.idx = this.stack.length - 1
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
