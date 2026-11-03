import type { KeyValueStorage } from './prefs'

/**
 * Small storage helpers shared by the persistence stores.
 *
 * - `getMany`: platforms that can answer several keys in one round trip
 *   (Electron's IPC, see platform.ts) expose an optional `getMany`; boot reads
 *   dozens of page blobs, so one IPC beats forty sequential ones.
 * - `safeGet`: a read failure is a cold cache, never a failed open.
 * - `isQuotaError`: the one storage failure that eviction can fix.
 */

/** A KeyValueStorage that may batch reads. The extra method stays optional. */
export interface BulkKeyValueStorage extends KeyValueStorage {
  getMany?(keys: string[]): Promise<Array<string | null>>
}

/** Read several keys at once; per-key failures come back as null. */
export async function getMany(
  storage: KeyValueStorage,
  keys: readonly string[]
): Promise<Array<string | null>> {
  if (keys.length === 0) return []
  const bulk = (storage as BulkKeyValueStorage).getMany
  if (typeof bulk === 'function') {
    try {
      const out = await bulk.call(storage, [...keys])
      if (Array.isArray(out) && out.length === keys.length) {
        return out.map((v) => (typeof v === 'string' ? v : null))
      }
    } catch {
      /* fall back to single reads below */
    }
  }
  return Promise.all(keys.map((key) => safeGet(storage, key)))
}

export async function safeGet(storage: KeyValueStorage, key: string): Promise<string | null> {
  try {
    return await storage.get(key)
  } catch {
    return null
  }
}

/** Normalize anything thrown into an Error (storage adapters throw strings too). */
export function toError(err: unknown): Error {
  if (err instanceof Error) return err
  return new Error(typeof err === 'string' ? err : 'storage operation failed')
}

/**
 * True for "the store is full": the web QuotaExceededError (code 22, Firefox's
 * NS_ERROR_DOM_QUOTA_REACHED / 1014) and native shells that only say so in the
 * message.
 */
export function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: unknown; code?: unknown; message?: unknown }
  if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true
  if (e.code === 22 || e.code === 1014) return true
  return typeof e.message === 'string' && /quota|exceeded the storage|disk is full/i.test(e.message)
}
