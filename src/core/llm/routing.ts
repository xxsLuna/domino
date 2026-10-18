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
  let host = ''
  try {
    host = new URL(baseUrl, 'http://localhost').hostname
  } catch {
    return {}
  }
  return host === 'opencode.ai' || host.endsWith('.opencode.ai')
    ? { 'x-opencode-session': RUN_SESSION }
    : {}
}
