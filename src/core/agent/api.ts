import { httpFetch, readTextCapped } from '../net'

/**
 * call_api execution with domino allowlist enforcement.
 *
 * Two gates must both pass before a request leaves the app:
 *  1. **origin** — the request may only reach the `[api] base_url` origin, or
 *     an origin an allow pattern pins itself (`https://host/path`). A bare
 *     path pattern never widens to arbitrary hosts: otherwise a model steered
 *     by a prompt-injected API response could send the login token to
 *     `https://attacker.example/<allowed-path>`.
 *  2. **path** — the pathname, after dot-segment normalization
 *     (`/leads/../../admin` → `/admin`), must match an allow pattern.
 */

export interface ApiRuntime {
  baseUrl?: string
  allow: string[]
  token?: string | null
}

export interface ApiResult {
  path: string
  status: number
  data: unknown
}

/** The methods the call_api tool schema declares — nothing else leaves. */
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

/** One response is handed straight to the model; cap it so a huge body can't flood the context. */
const MAX_RESPONSE_CHARS = 400_000

/** Timeout for a single API call — a hung backend must not hang the turn. */
const REQUEST_TIMEOUT_MS = 30_000

interface AllowPattern {
  /** Pinned origin for `https://host/...` patterns; null for path-only patterns. */
  origin: string | null
  /** Exact pathname match, or null for the bare `*` pattern. */
  exact: string | null
  /** Trailing-slash prefix for `/*` patterns (keeps `/leads/` form). */
  prefix: string | null
}

function parsePattern(raw: string): AllowPattern | null {
  const p = raw.trim()
  if (!p) return null
  if (p === '*') return { origin: null, exact: null, prefix: null }
  if (/^https?:\/\//i.test(p)) {
    let u: URL
    try {
      u = new URL(p)
    } catch {
      return null
    }
    if (u.pathname.endsWith('/*')) {
      return { origin: u.origin, exact: u.pathname.slice(0, -2), prefix: u.pathname.slice(0, -1) }
    }
    return { origin: u.origin, exact: u.pathname, prefix: null }
  }
  if (!p.startsWith('/')) return null
  if (p.endsWith('/*')) return { origin: null, exact: p.slice(0, -2), prefix: p.slice(0, -1) }
  return { origin: null, exact: p, prefix: null }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * Normalize a model-supplied path to a root-absolute pathname.
 * The URL parser is what removes `.`/`..` segments — the same normalization
 * applies at fetch time, so `/leads/../../admin` must be checked as `/admin`.
 * Returns null when the path can't be parsed.
 */
function normalizePathname(path: string): string | null {
  try {
    return new URL(path, 'http://normalized.invalid').pathname
  } catch {
    return null
  }
}

/** `/leads/*` matches `/leads` and everything under it; exact strings match exactly. */
export function isAllowed(path: string, allow: string[], baseUrl?: string): boolean {
  if (allow.length === 0) return false

  let requestOrigin: string | null
  let pathname: string | null
  if (/^https?:\/\//i.test(path)) {
    try {
      const u = new URL(path)
      requestOrigin = u.origin
      pathname = u.pathname
    } catch {
      return false
    }
  } else {
    // Relative paths are resolved against base_url at fetch time, so they need
    // one to have an origin at all; allow patterns are base-relative, so the
    // path is normalized against the root without the base prefix.
    pathname = normalizePathname(path)
    requestOrigin = baseUrl ? originOf(baseUrl) : null
    if (pathname === null || requestOrigin === null) return false
  }

  const baseOrigin = baseUrl ? originOf(baseUrl) : null
  for (const raw of allow) {
    const pat = parsePattern(raw)
    if (!pat) continue
    // Origin gate.
    if (pat.origin !== null) {
      if (pat.origin !== requestOrigin) continue
    } else if (requestOrigin === null || requestOrigin !== baseOrigin) {
      // Path-only pattern: bound to the base_url origin. With no base_url
      // there is no trusted origin — deny rather than guess.
      continue
    }
    // Path gate.
    if (pat.exact === null) return true // bare `*` — any path on an allowed origin
    if (pathname === pat.exact) return true
    if (pat.prefix !== null && pathname.startsWith(pat.prefix)) return true
  }
  return false
}

/** Absolute URL for a call_api path, or null when it can't be resolved safely. */
export function resolveEndpoint(path: string, baseUrl?: string): string | null {
  if (/^https?:\/\//i.test(path)) {
    try {
      return new URL(path).href
    } catch {
      return null
    }
  }
  const base = (baseUrl ?? '').replace(/\/$/, '')
  if (!base) return null
  try {
    // Normalize the path first so `..` segments can't eat into the base path
    // after joining; only pathname + query ever reach the base origin.
    const u = new URL(path, 'http://normalized.invalid')
    return new URL(`${base}${u.pathname}${u.search}`).href
  } catch {
    return null
  }
}

/** Read at most `maxChars` so one oversized body can't blow up memory or context. */
// (Shared implementation lives in @core/net — readTextCapped.)

export async function executeApi(
  api: ApiRuntime,
  req: { path: string; method?: string; body?: unknown }
): Promise<ApiResult> {
  const method = (req.method ?? 'GET').toUpperCase()
  if (!ALLOWED_METHODS.has(method)) {
    return {
      path: req.path,
      status: 403,
      data: { error: `method "${method}" is not allowed for call_api` }
    }
  }
  if (!isAllowed(req.path, api.allow, api.baseUrl)) {
    return {
      path: req.path,
      status: 403,
      data: { error: `path "${req.path}" is not in the domino [api] allow list` }
    }
  }
  const url = resolveEndpoint(req.path, api.baseUrl)
  if (!url) {
    return {
      path: req.path,
      status: 403,
      data: { error: `path "${req.path}" cannot be resolved — set [api] base_url in the domino file` }
    }
  }
  try {
    const res = await httpFetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(api.token ? { authorization: `Bearer ${api.token}` } : {})
      },
      ...(req.body !== undefined && method !== 'GET' ? { body: JSON.stringify(req.body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    const text = await readTextCapped(res, MAX_RESPONSE_CHARS)
    let data: unknown = text
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      /* keep raw text */
    }
    return { path: req.path, status: res.status, data }
  } catch (err) {
    const message =
      (err as Error).name === 'TimeoutError' ? 'request timed out' : (err as Error).message
    return { path: req.path, status: 0, data: { error: message } }
  }
}
