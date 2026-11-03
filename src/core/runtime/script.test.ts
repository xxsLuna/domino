import { describe, expect, it } from 'vitest'
import { parseDomino } from '../domino/parse'
import { bootNeedsLogin, scriptEventOutcome, scriptLandingPage } from '../domino/script'
import type { DominoFile } from '../domino/types'
import {
  allowErrorRoute,
  apiErrorCode,
  isSessionExpiry,
  pressScriptEvent,
  scriptCallRequest,
  scriptRoute,
  sessionVarsFromLogin,
  SCRIPT_ROUTE_REPEAT_MS
} from './script'

function domino(text: string): DominoFile {
  const r = parseDomino(text)
  if (!r.ok || !r.domino) throw new Error(JSON.stringify(r.errors))
  return r.domino
}

const PLAN_GATE = domino(`[meta]
name = PlanGate
home = overview

[auth]
required = true
login_endpoint = https://api.example.com/login
skip_if_logged_in = false

[api]
base_url = https://api.example.com
allow = /login, /overview, /upgrade, /me

[pages]
overview = Overview | nav
upgrade = Upgrade

[script]
when not logged_in -> goto login
when error == "billing" -> goto upgrade
when plan == "pro" and logged_in -> goto overview
on logout -> goto login
on auth_failed -> goto login
on login -> call GET /me
on upgrade-cta -> goto upgrade
`)

describe('pressScriptEvent', () => {
  it('fires an on-rule named by the pressed control id', () => {
    expect(pressScriptEvent(PLAN_GATE, { event: 'click', nodeId: 'Upgrade-CTA' })).toBe(
      'upgrade-cta'
    )
    expect(pressScriptEvent(PLAN_GATE, { event: 'submit', nodeId: 'upgrade-cta' })).toBe(
      'upgrade-cta'
    )
  })

  it('ignores other events, unknown ids and the runtime-owned events', () => {
    expect(pressScriptEvent(PLAN_GATE, { event: 'navigate', nodeId: 'upgrade-cta' })).toBeNull()
    expect(pressScriptEvent(PLAN_GATE, { event: 'click', nodeId: 'save' })).toBeNull()
    // A button with id "logout" must not fire the runtime's logout routing.
    expect(pressScriptEvent(PLAN_GATE, { event: 'click', nodeId: 'logout' })).toBeNull()
    expect(pressScriptEvent(PLAN_GATE, { event: 'click', nodeId: 'auth_failed' })).toBeNull()
  })
})

describe('sessionVarsFromLogin', () => {
  it('keeps non-secret scalars and one nested level, drops secrets and the token', () => {
    const vars = sessionVarsFromLogin(
      {
        access: 'tok-123',
        token: 'x',
        refresh_token: 'y',
        plan: 'pro',
        seats: 3,
        trial: false,
        user: { name: 'Ann', role: 'admin', password: 'p', tags: ['a'] },
        list: [1, 2],
        bio: 'x'.repeat(500)
      },
      'access'
    )
    expect(vars).toEqual({
      plan: 'pro',
      seats: 3,
      trial: false,
      user: { name: 'Ann', role: 'admin' }
    })
  })

  it('returns nothing for non-object bodies and stays small', () => {
    expect(sessionVarsFromLogin('tok')).toEqual({})
    expect(sessionVarsFromLogin([1])).toEqual({})
    expect(sessionVarsFromLogin(null)).toEqual({})
    const big: Record<string, string> = {}
    for (let i = 0; i < 200; i++) big[`field${i}`] = 'v'.repeat(150)
    expect(JSON.stringify(sessionVarsFromLogin(big)).length).toBeLessThanOrEqual(4_000)
  })

  it('feeds the plan conditions of [script]', () => {
    const vars = sessionVarsFromLogin({ token: 't', plan: 'pro' })
    expect(scriptLandingPage(PLAN_GATE, { loggedIn: true, event: 'login', vars })).toBe('overview')
  })
})

describe('apiErrorCode', () => {
  it('is null for a success and names the failure otherwise', () => {
    expect(apiErrorCode({ status: 200, data: {} })).toBeNull()
    expect(apiErrorCode({ status: 304 })).toBeNull()
    expect(apiErrorCode({ status: 0 })).toBe('unreachable')
    expect(apiErrorCode({ status: 402, data: { error: 'billing' } })).toBe('billing')
    expect(apiErrorCode({ status: 429, data: { code: 'QUOTA' } })).toBe('QUOTA')
    expect(apiErrorCode({ status: 400, data: { error: { code: 'bad_input' } } })).toBe('bad_input')
    expect(apiErrorCode({ status: 500, data: 'oops' })).toBe('500')
    expect(apiErrorCode({ status: 404, data: { error: 'x'.repeat(200) } })).toBe('404')
  })

  it('routes an error-gated rule once the error is set', () => {
    const error = apiErrorCode({ status: 402, data: { error: 'billing' } })
    const outcome = scriptEventOutcome(PLAN_GATE, 'api_error', {}, true, error)
    expect(scriptRoute(outcome, 'overview')).toBe('upgrade')
    // …but `when plan == "pro"` (already true before the error) does not yank the user.
    const other = scriptEventOutcome(PLAN_GATE, 'api_error', { plan: 'pro' }, true, '500')
    expect(scriptRoute(other, 'billing')).toBeNull()
  })
})

describe('isSessionExpiry', () => {
  it('needs a 401 on a request that carried the token', () => {
    expect(isSessionExpiry(401, true)).toBe(true)
    expect(isSessionExpiry(401, false)).toBe(false)
    expect(isSessionExpiry(403, true)).toBe(false)
  })

  it('auth_failed lands on the declared page', () => {
    const outcome = scriptEventOutcome(PLAN_GATE, 'auth_failed', {}, false, 'auth_failed')
    expect(scriptRoute(outcome, 'overview')).toBe('login')
    expect(scriptLandingPage(PLAN_GATE, { loggedIn: false, event: 'auth_failed' })).toBe('login')
  })
})

describe('scriptRoute / allowErrorRoute', () => {
  it('never routes to the page on screen or without a routing rule', () => {
    expect(scriptRoute({ goto: 'upgrade', routedBy: 'when' }, 'upgrade')).toBeNull()
    expect(scriptRoute({ call: '/me' }, 'overview')).toBeNull()
    expect(scriptRoute({ render: 'upgrade', routedBy: 'event' }, null)).toBe('upgrade')
  })

  it('honours the same error route once per window', () => {
    expect(allowErrorRoute(null, 'upgrade', 0)).toBe(true)
    const last = { target: 'upgrade', at: 1_000 }
    expect(allowErrorRoute(last, 'upgrade', 2_000)).toBe(false)
    expect(allowErrorRoute(last, 'billing', 2_000)).toBe(true)
    expect(allowErrorRoute(last, 'upgrade', 1_000 + SCRIPT_ROUTE_REPEAT_MS + 1)).toBe(true)
  })
})

describe('scriptCallRequest', () => {
  it('runs the outcome call as GET unless a method was given', () => {
    const outcome = scriptEventOutcome(PLAN_GATE, 'login', {}, true)
    expect(scriptCallRequest(outcome)).toEqual({ path: '/me', method: 'GET' })
    expect(scriptCallRequest({ call: '/logout', callMethod: 'POST' })).toEqual({
      path: '/logout',
      method: 'POST'
    })
    expect(scriptCallRequest({})).toBeNull()
  })
})

describe('boot with skip_if_logged_in = false', () => {
  it('asks for a fresh sign-in even with a stored token', () => {
    expect(bootNeedsLogin(PLAN_GATE, true)).toBe(true)
    expect(scriptLandingPage(PLAN_GATE, { loggedIn: false })).toBe('login')
  })
})
