import { httpFetch } from '../net'

/**
 * call_api execution with domino allowlist enforcement.
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

/** `/leads/*` matches `/leads` and everything under it; exact strings match exactly. */
export function isAllowed(path: string, allow: string[]): boolean {
  if (allow.length === 0) return false
  let pathname = path
  try {
    if (/^https?:\/\//.test(path)) pathname = new URL(path).pathname
  } catch {
    /* use raw */
  }
  for (const pattern of allow) {
    if (pattern === '*') return true
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1) // keep trailing slash
      if (pathname === prefix.slice(0, -1) || pathname.startsWith(prefix)) return true
    } else if (pathname === pattern) {
      return true
    }
  }
  return false
}

export function resolveEndpoint(path: string, baseUrl?: string): string {
  if (/^https?:\/\//.test(path)) return path
  const base = (baseUrl ?? '').replace(/\/$/, '')
  if (!base) return path
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`
}

export async function executeApi(
  api: ApiRuntime,
  req: { path: string; method?: string; body?: unknown }
): Promise<ApiResult> {
  if (!isAllowed(req.path, api.allow)) {
    return {
      path: req.path,
      status: 403,
      data: { error: `path "${req.path}" is not in the domino [api] allow list` }
    }
  }
  const url = resolveEndpoint(req.path, api.baseUrl)
  const method = (req.method ?? 'GET').toUpperCase()
  try {
    const res = await httpFetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(api.token ? { authorization: `Bearer ${api.token}` } : {})
      },
      ...(req.body !== undefined && method !== 'GET' ? { body: JSON.stringify(req.body) } : {})
    })
    const text = await res.text()
    let data: unknown = text
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      /* keep raw text */
    }
    return { path: req.path, status: res.status, data }
  } catch (err) {
    return { path: req.path, status: 0, data: { error: (err as Error).message } }
  }
}
