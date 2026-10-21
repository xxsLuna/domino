/**
 * Headers some gateways need beyond the standard API. opencode zen refuses
 * requests without a per-conversation `x-opencode-session` ("cannot be routed
 * efficiently"); the web dev proxy adds one, and direct calls (desktop, a
 * production web build) need it too. One id per app run keeps a session's
 * turns on the same route.
 */
const RUN_SESSION =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`

export function routingHeaders(baseUrl: string): Record<string, string> {
  // A relative base ("/zen/…") only ever runs in front of a proxy that injects
  // an API key (dev/preview). The marker header lets that proxy tell requests
  // from this app's own page apart from cross-site ones — browsers cannot send
  // a custom header cross-origin without a preflight, which the proxy rejects.
  if (baseUrl.startsWith('/')) return { 'x-domino-client': 'domino-web' }
  let host: string
  try {
    host = new URL(baseUrl, 'http://localhost').hostname
  } catch {
    return {}
  }
  return host === 'opencode.ai' || host.endsWith('.opencode.ai')
    ? { 'x-opencode-session': RUN_SESSION }
    : {}
}
