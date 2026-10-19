import type { DominoSource, KeyValueStorage } from './prefs'
import { hashContext } from './session'

/**
 * Identity + raw-text cache for domino files.
 *
 * Every way a domino can be addressed gets one stable key (text sources are
 * keyed by content hash, so two different uploads no longer collide on a
 * single "text" slot), and the raw text of remote/file opens is kept locally
 * so a reopen parses instantly — and still works offline — instead of
 * re-fetching.
 */

/** LRU cap on cached source texts; matches the recents list's scale. */
const MAX_CACHED_TEXTS = 10
/** A single cached text over this many chars is skipped (localStorage budget). */
const MAX_TEXT_CHARS = 512_000

const INDEX_KEY = 'domino:text-index'
const textKey = (hash: string): string => `domino:text:${hash}`

interface IndexEntry {
  key: string
  hash: string
  at: number
}

/** Stable identity for a domino source; text sources hash their content. */
export function sourceKey(source: DominoSource): string {
  switch (source.type) {
    case 'url':
      return `url:${source.url}`
    case 'file':
      return `file:${source.path}`
    case 'text':
      return `text:${hashContext(source.text)}`
  }
}

/**
 * Inline domino://…?c= payloads travel inside the URL itself — caching them
 * would only duplicate megabytes of text that needs no fetch anyway.
 */
function cacheable(source: DominoSource): boolean {
  if (source.type === 'text') return false // already persisted in recents
  if (source.type === 'url' && source.url.trim().startsWith('domino://')) {
    try {
      return !new URL(source.url.trim()).searchParams.has('c')
    } catch {
      return true
    }
  }
  return true
}

async function loadIndex(storage: KeyValueStorage): Promise<IndexEntry[]> {
  try {
    const raw = await storage.get(INDEX_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is IndexEntry =>
        e && typeof e.key === 'string' && typeof e.hash === 'string' && typeof e.at === 'number'
    )
  } catch {
    return [] // corrupt index just means a cold cache, never a failed open
  }
}

/** Cached raw text for this source, or null (uncached / corrupt / too old). */
export async function getCachedText(
  storage: KeyValueStorage,
  source: DominoSource
): Promise<string | null> {
  if (!cacheable(source)) return null
  try {
    const entry = (await loadIndex(storage)).find((e) => e.key === sourceKey(source))
    if (!entry) return null
    return await storage.get(textKey(entry.hash))
  } catch {
    return null
  }
}

/**
 * Store raw text for this source and bump it to the front of the LRU.
 * Never throws: a storage failure must not fail the open that triggered it.
 */
export async function putCachedText(
  storage: KeyValueStorage,
  source: DominoSource,
  text: string
): Promise<void> {
  if (!cacheable(source) || !text || text.length > MAX_TEXT_CHARS) return
  try {
    const key = sourceKey(source)
    const hash = hashContext(text)
    const index = await loadIndex(storage)
    const next: IndexEntry[] = [
      { key, hash, at: Date.now() },
      ...index.filter((e) => e.key !== key)
    ].slice(0, MAX_CACHED_TEXTS)
    // Write the blob before the index: a crash in between leaves an orphaned
    // blob (harmless), never an index entry pointing at missing text.
    await storage.set(textKey(hash), text)
    const live = new Set(next.map((e) => e.hash))
    for (const e of index) {
      if (!live.has(e.hash)) await storage.remove(textKey(e.hash))
    }
    await storage.set(INDEX_KEY, JSON.stringify(next))
  } catch {
    // Best-effort cache: dropping the write costs a re-fetch next time.
  }
}

/** Drop a source's cached text (used when a cached copy turns out corrupt). */
export async function clearCachedText(
  storage: KeyValueStorage,
  source: DominoSource
): Promise<void> {
  if (!cacheable(source)) return
  try {
    const key = sourceKey(source)
    const index = await loadIndex(storage)
    const gone = index.filter((e) => e.key === key)
    const next = index.filter((e) => e.key !== key)
    const live = new Set(next.map((e) => e.hash))
    for (const e of gone) {
      if (!live.has(e.hash)) await storage.remove(textKey(e.hash))
    }
    await storage.set(INDEX_KEY, JSON.stringify(next))
  } catch {
    // Best-effort again: a stale entry just re-fetches next time.
  }
}
