import { ROUTING_EVENTS, type ScriptEventOutcome } from '../domino/script'
import type { CallMethod, DominoFile } from '../domino/types'

/**
 * The runtime side of [script] — which events fire, what the conditions
 * see, and when an outcome may move the user — decided without React so
 * every rule is tested. The evaluator itself is scriptEventOutcome
 * (src/core/domino/script.ts); this module feeds it and reads its answer.
 */

/** Events the runtime fires itself: pressing a control never fires these. */
export const RUNTIME_EVENTS: ReadonlySet<string> = new Set([...ROUTING_EVENTS, 'api_error'])

/**
 * The custom script event a press fires, or null: a click or submit of a
 * control whose id names an `on <id>` rule (`on upgrade -> goto upgrade`
 * fires when the control `upgrade` is pressed). The runtime's own events
 * (login, logout, auth_failed, api_error) cannot be fired from the screen.
 */
export function pressScriptEvent(
  domino: Pick<DominoFile, 'script'>,
  e: { event: string; nodeId: string }
): string | null {
  if (e.event !== 'click' && e.event !== 'submit') return null
  const name = e.nodeId.toLowerCase()
  if (RUNTIME_EVENTS.has(name)) return null
  return domino.script.some((r) => r.event === name) ? name : null
}

// Same spirit as the runtime's history redaction: over-dropping is safe.
const SECRET_KEY = /pass|pwd|secret|token|key|pin|credential|auth|session|cookie|jwt|bearer/i
/** Longest string value kept as a variable (names, plans, roles — not documents). */
const MAX_VAR_STRING = 200
/** Total serialized size of the kept variables. */
const MAX_VARS_CHARS = 4_000

function scalar(v: unknown): v is string | number | boolean | null {
  return (
    v === null ||
    typeof v === 'boolean' ||
    (typeof v === 'number' && Number.isFinite(v)) ||
    (typeof v === 'string' && v.length <= MAX_VAR_STRING)
  )
}

function plainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * The session variables a sign-in response provides to [script]
 * conditions: its non-secret scalar fields (`plan`, `role`) and those of
 * nested objects one level down (`user.plan` — conditions read dotted
 * paths). Anything secret-looking, the token field itself, arrays and long
 * strings are dropped, and the whole set stays small: it is persisted with
 * the token and never sent to the model.
 */
export function sessionVarsFromLogin(body: unknown, tokenKey?: string): Record<string, unknown> {
  if (!plainObject(body)) return {}
  const out: Record<string, unknown> = {}
  let size = 2
  const keep = (target: Record<string, unknown>, key: string, value: unknown): boolean => {
    const cost = key.length + JSON.stringify(value).length + 4
    if (size + cost > MAX_VARS_CHARS) return false
    size += cost
    target[key] = value
    return true
  }
  const secret = (key: string): boolean => SECRET_KEY.test(key) || key === tokenKey
  for (const [key, value] of Object.entries(body)) {
    if (secret(key)) continue
    if (scalar(value)) {
      keep(out, key, value)
    } else if (plainObject(value)) {
      const inner: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) {
        if (!secret(k) && scalar(v)) inner[k] = v
      }
      if (Object.keys(inner).length > 0) keep(out, key, inner)
    }
  }
  return out
}

/**
 * The `error` a failed API answer gives [script] conditions, or null for a
 * success: the body's own error code when it names one (`{"error":
 * "billing"}`, `{"code": "QUOTA"}`, `{"error": {"code": "billing"}}`), else
 * the status as text ("404"), and "unreachable" for a request that never
 * got an answer.
 */
export function apiErrorCode(result: { status: number; data?: unknown }): string | null {
  const { status, data } = result
  if (status >= 200 && status < 400) return null
  if (status === 0) return 'unreachable'
  if (plainObject(data)) {
    const pick = (v: unknown): string | null =>
      typeof v === 'string' && v.trim() !== '' && v.length <= 80 ? v.trim() : null
    const nested = plainObject(data.error) ? data.error : null
    const code =
      pick(data.error) ??
      pick(data.code) ??
      (nested ? (pick(nested.code) ?? pick(nested.type)) : null)
    if (code) return code
  }
  return String(status)
}

/**
 * A 401 on a request that carried the session token: the session expired.
 * Without a token a 401 is just a protected endpoint the user has not
 * signed in for — the screen explains that, the runtime changes nothing.
 */
export function isSessionExpiry(status: number, sentToken: boolean): boolean {
  return status === 401 && sentToken
}

/**
 * Where a [script] outcome moves the user, or null: only an outcome a rule
 * actually routed (scriptEventOutcome's routedBy), and never to the page
 * already on screen.
 */
export function scriptRoute(
  outcome: ScriptEventOutcome,
  currentPage: string | null
): string | null {
  const page = outcome.goto ?? outcome.render
  if (!outcome.routedBy || !page || page === currentPage) return null
  return page
}

/** One remembered error route (target page and when it fired). */
export interface RouteMemo {
  target: string
  at: number
}

/** An error route to the same page is not re-fired within this window. */
export const SCRIPT_ROUTE_REPEAT_MS = 10_000

/**
 * Error routing must not loop: the page an `api_error` rule routes to may
 * itself fail the same way (the upgrade page's own call answers "billing"),
 * which would route there again and again. The same target is honoured at
 * most once per window.
 */
export function allowErrorRoute(last: RouteMemo | null, target: string, now: number): boolean {
  return !last || last.target !== target || now - last.at > SCRIPT_ROUTE_REPEAT_MS
}

/** The request a script outcome's `call` command makes (GET unless stated), or null. */
export function scriptCallRequest(
  outcome: Pick<ScriptEventOutcome, 'call' | 'callMethod'>
): { path: string; method: CallMethod } | null {
  if (!outcome.call) return null
  return { path: outcome.call, method: outcome.callMethod ?? 'GET' }
}
