import { httpFetch, readTextCapped } from '../net'
import type { KeyValueStorage } from '../session/prefs'
import { parseFeed, type FeedData } from './parse'

/**
 * Runtime feed subscriptions: the list the app's user built by pasting URLs,
 * persisted per domino like the schema book. The runtime fetches every entry
 * into the `@subscriptions` [data] source — snapshots refresh silently, so no
 * diff baseline needs to ride along here.
 */

export interface FeedEntry {
  url: string
  title: string
}

/** Subscriptions beyond this are refused — each one costs a fetch slot. */
export const MAX_FEEDS = 20
/** One feed body is text, not an archive; the parser caps items at 50 anyway. */
const MAX_FEED_CHARS = 500_000

export function feedsKey(dominoId: string): string {
  return `domino:feeds:${dominoId}`
}

/**
 * True for this machine's own hosts — the one place plain http is still
 * fetchable everywhere (Electron's main process opens http only on loopback,
 * the local dev relay likewise). Matches that transport contract exactly so
 * the address accepted here can never be one the transports refuse later.
 */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '[::1]') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/** https everywhere; plain http only on this machine (dev mocks, local NAS readers). */
export function normalizeFeedUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    return null
  }
  if (u.protocol === 'https:') return u.href
  if (u.protocol === 'http:' && isLoopbackHost(u.hostname)) return u.href
  return null
}

/** Load persisted subscriptions; any unreadable or malformed entry is forgotten. */
export async function loadFeeds(storage: KeyValueStorage, dominoId: string): Promise<FeedEntry[]> {
  let raw: string | null
  try {
    raw = await storage.get(feedsKey(dominoId))
  } catch {
    return []
  }
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: FeedEntry[] = []
    for (const value of parsed) {
      const v = value as { url?: unknown; title?: unknown } | null
      if (!v || typeof v !== 'object') continue
      if (typeof v.url !== 'string') continue
      const url = normalizeFeedUrl(v.url)
      if (!url) continue
      out.push({ url, title: typeof v.title === 'string' ? v.title : url })
      if (out.length >= MAX_FEEDS) break
    }
    return out
  } catch {
    return []
  }
}

/** Persist subscriptions; a storage failure must never break the session. */
export async function saveFeeds(
  storage: KeyValueStorage,
  dominoId: string,
  feeds: FeedEntry[]
): Promise<void> {
  try {
    await storage.set(feedsKey(dominoId), JSON.stringify(feeds.slice(0, MAX_FEEDS)))
  } catch {
    /* next successful save picks it up */
  }
}

export interface FeedFetchResult {
  /** The entry with its title refreshed from the feed, when parsing succeeded. */
  entry: FeedEntry
  /** Parsed feed body, or null when the fetch or parse failed. */
  data: FeedData | null
  /** HTTP status of the attempt; 0 = network failure. */
  status: number
  ms: number
  error?: string
}

/**
 * Fetch and parse one feed URL. Runs on the runtime's own authority — the
 * author declared this URL in [data] or the user typed it into this app — so
 * it never touches the [api] allow gate and never carries the auth token.
 */
export async function fetchFeed(url: string, title = url): Promise<FeedFetchResult> {
  const started = Date.now()
  try {
    const res = await httpFetch(url, {
      headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(30_000)
    })
    if (!res.ok) {
      return { entry: { url, title }, data: null, status: res.status, ms: Date.now() - started }
    }
    const text = await readTextCapped(res, MAX_FEED_CHARS)
    const feed = parseFeed(text)
    if (!feed) {
      return {
        entry: { url, title },
        data: null,
        status: res.status,
        ms: Date.now() - started,
        error: 'not a recognized feed format'
      }
    }
    return {
      entry: { url, title: feed.title || title },
      data: feed,
      status: res.status,
      ms: Date.now() - started
    }
  } catch (err) {
    return {
      entry: { url, title },
      data: null,
      status: 0,
      ms: Date.now() - started,
      error: (err as Error).message
    }
  }
}
