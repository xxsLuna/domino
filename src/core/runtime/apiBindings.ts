import { iterateNodes, type UiSpec } from '../spec'

/**
 * Runtime-owned refresh of `{"$data": "api:GET /path.…"}` bindings.
 *
 * Screens bind call_api responses by endpoint, and the prompt tells the model
 * it may bind a known GET endpoint without calling it — the runtime fetches
 * bound GETs itself. This module decides WHICH endpoints a shown page needs
 * (missing or aged snapshot, not already in flight, not just failed); the
 * runtime runs them in parallel through the same allowlist gates as
 * call_api. A cached, pre-generated, restored or embedded page therefore
 * comes up with live data instead of whatever the last model turn saw.
 */

/** A bound GET snapshot older than this is re-fetched when its page is shown. */
export const API_BINDING_MAX_AGE_MS = 30_000

/** After a failed refresh, wait this long before the same endpoint is tried again. */
export const API_BINDING_RETRY_MS = 10_000

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** The single-key binding object `{"$data": "<key>.<path>"}` → its path string. */
function bindingPath(v: unknown): string | null {
  if (!isRecord(v)) return null
  const keys = Object.keys(v)
  if (keys.length !== 1 || keys[0] !== '$data') return null
  const path = v.$data
  return typeof path === 'string' && path.length > 0 ? path : null
}

const METHOD_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD) (\S+)$/

/** `"GET /leads?x=1"` → `{ method: 'GET', path: '/leads?x=1' }` (the schema.ts endpointKey format). */
export function parseEndpointKey(key: string): { method: string; path: string } | null {
  const m = METHOD_RE.exec(key.trim())
  return m ? { method: m[1], path: m[2] } : null
}

/**
 * The `api:` source key a binding path names. A source key may itself
 * contain dots (`api:GET /v1.0/feed.xml`), so a key the runtime already
 * holds wins when the path starts with it (longest first). Otherwise the
 * endpoint ends at the first dot after the path's last `/` — the JSON path
 * that follows never contains a slash.
 */
export function apiKeyOfBinding(path: string, known: Iterable<string> = []): string | null {
  if (!path.startsWith('api:')) return null
  let best: string | null = null
  for (const k of known) {
    if (!k.startsWith('api:')) continue
    if ((path === k || path.startsWith(`${k}.`)) && (best === null || k.length > best.length)) {
      best = k
    }
  }
  if (best) return best
  const slash = path.lastIndexOf('/')
  if (slash < 0) return null
  const dot = path.indexOf('.', slash)
  const key = dot < 0 ? path : path.slice(0, dot)
  return parseEndpointKey(key.slice('api:'.length)) ? key : null
}

/**
 * Every `api:` source key the given pages bind (all pages when `pageIds` is
 * omitted), in first-seen order. `known` are the source keys the runtime
 * already holds — they resolve dotted endpoint paths exactly.
 */
export function boundApiKeys(
  spec: UiSpec,
  pageIds?: readonly string[],
  known: Iterable<string> = []
): string[] {
  const knownKeys = [...known]
  const out: string[] = []
  const walk = (v: unknown, depth: number): void => {
    if (depth > 24) return
    const path = bindingPath(v)
    if (path !== null) {
      const key = apiKeyOfBinding(path, knownKeys)
      if (key && !out.includes(key)) out.push(key)
      return
    }
    if (Array.isArray(v)) for (const x of v) walk(x, depth + 1)
    else if (isRecord(v)) for (const x of Object.values(v)) walk(x, depth + 1)
  }
  for (const page of spec.pages) {
    if (pageIds && !pageIds.includes(page.id)) continue
    for (const node of iterateNodes(page.layout)) walk(node.props, 0)
  }
  return out
}

export interface ApiRefreshState {
  /** Source key → when its snapshot was last committed (ms). */
  fetchedAt: Record<string, number>
  /** Source key → when its last refresh attempt failed (ms). */
  failedAt?: Record<string, number>
  /** Source keys with a refresh already running. */
  inflight: ReadonlySet<string>
  now: number
  maxAgeMs?: number
  retryMs?: number
}

/**
 * The bound keys worth fetching now: GET only (a write is never replayed),
 * not in flight, not failed a moment ago, and with no snapshot yet or one
 * older than the max age.
 */
export function apiKeysToRefresh(keys: readonly string[], s: ApiRefreshState): string[] {
  const maxAge = s.maxAgeMs ?? API_BINDING_MAX_AGE_MS
  const retry = s.retryMs ?? API_BINDING_RETRY_MS
  return keys.filter((key) => {
    const ep = parseEndpointKey(key.slice('api:'.length))
    if (!ep || ep.method !== 'GET') return false
    if (s.inflight.has(key)) return false
    const failed = s.failedAt?.[key]
    if (failed !== undefined && s.now - failed < retry) return false
    const at = s.fetchedAt[key]
    return at === undefined || s.now - at > maxAge
  })
}

/** Leading path segments that name the API itself (`/api`, `/v1`), not a resource. */
const API_PREFIX_SEGMENT = /^(api|v\d+(\.\d+)?)$/i

/**
 * The resource a request path addresses: its first segment past any API
 * prefix — `/orders/5` and `/api/v1/orders?page=2` both address `orders`.
 * Null for a path with no resource segment (`/`, `/api`).
 */
export function resourceRoot(path: string): string | null {
  const bare = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '').split(/[?#]/)[0]
  const segs = bare.split('/').filter(Boolean)
  const root = segs.find((s) => !API_PREFIX_SEGMENT.test(s))
  return root ? root.toLowerCase() : null
}

/**
 * Which read snapshots a successful write makes stale: every `api:GET …`
 * key and every [data] source (by its declared path) that addresses the
 * same resource. A write to a path with no resource segment stales them
 * all. The landing screen's bindings then refetch at once instead of
 * showing the pre-write list for up to the snapshot max age — a deleted
 * row stays gone, a created one appears.
 */
export function keysStaleAfterWrite(
  writePath: string,
  apiKeys: Iterable<string>,
  dataSources: ReadonlyArray<{ key: string; path: string; method: string }> = []
): string[] {
  const root = resourceRoot(writePath)
  const touches = (path: string): boolean => root === null || resourceRoot(path) === root
  const out: string[] = []
  for (const key of apiKeys) {
    if (!key.startsWith('api:')) continue
    const ep = parseEndpointKey(key.slice('api:'.length))
    if (ep && ep.method === 'GET' && touches(ep.path) && !out.includes(key)) out.push(key)
  }
  for (const d of dataSources) {
    if (d.method === 'FEED') continue
    if (touches(d.path) && !out.includes(d.key)) out.push(d.key)
  }
  return out
}
