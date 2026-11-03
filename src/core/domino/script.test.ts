import { describe, expect, it } from 'vitest'
import { parseDomino } from './parse'
import { bootNeedsLogin, buildScriptContext, scriptEventOutcome, scriptLandingPage } from './script'

const parse = (text: string) => {
  const res = parseDomino(text)
  if (!res.domino) throw new Error(JSON.stringify(res.errors))
  return res.domino
}

const PLAN_GATE = parse(
  [
    '[meta]',
    'name = PlanGate',
    'home = overview',
    '[auth]',
    'required = true',
    'login_endpoint = /login',
    'skip_if_logged_in = false',
    '[script]',
    'when not logged_in -> goto login',
    'when error == "billing" -> goto upgrade',
    'when plan == "pro" and logged_in -> goto overview',
    'on logout -> goto goodbye',
    'on auth_failed -> goto login',
    'on login -> call /me',
    'on saved -> call POST /audit'
  ].join('\n')
)

describe('scriptEventOutcome', () => {
  it('routes boot with every when rule', () => {
    expect(scriptEventOutcome(PLAN_GATE, undefined, undefined, false)).toMatchObject({
      goto: 'login',
      routedBy: 'when'
    })
    expect(scriptEventOutcome(PLAN_GATE, undefined, { plan: 'pro' }, true)).toMatchObject({
      goto: 'overview'
    })
  })

  it('lets an on-event rule win on an auth transition', () => {
    expect(scriptEventOutcome(PLAN_GATE, 'logout', undefined, false)).toMatchObject({
      goto: 'goodbye',
      routedBy: 'event'
    })
    expect(scriptEventOutcome(PLAN_GATE, 'AUTH_FAILED', undefined, false).goto).toBe('login')
  })

  it('collects call commands with their method', () => {
    const login = scriptEventOutcome(PLAN_GATE, 'login', { plan: 'pro' }, true)
    expect(login).toMatchObject({ call: '/me', goto: 'overview' })
    expect(login.callMethod).toBeUndefined()
    expect(scriptEventOutcome(PLAN_GATE, 'saved', { plan: 'pro' }, true)).toEqual({
      call: '/audit',
      callMethod: 'POST'
    })
  })

  it('only counts when rules a non-routing event newly made true', () => {
    // plan == "pro" was already true: an API error must not yank the user away.
    expect(scriptEventOutcome(PLAN_GATE, 'api_error', { plan: 'pro' }, true, '500')).toEqual({})
    // the billing error is what made this rule true: route.
    expect(
      scriptEventOutcome(PLAN_GATE, 'api_error', { plan: 'pro' }, true, 'billing')
    ).toMatchObject({ goto: 'upgrade', routedBy: 'when' })
  })

  it('exposes the event name to conditions', () => {
    const d = parse('[meta]\nname = X\n[script]\nwhen event == "tour" -> goto intro\n')
    expect(scriptEventOutcome(d, 'tour', undefined, false).goto).toBe('intro')
    expect(scriptEventOutcome(d, undefined, undefined, false).goto).toBeUndefined()
  })

  it('ignores a login route in an app without sign-in', () => {
    const d = parse('[meta]\nname = X\nhome = board\n[script]\nwhen not logged_in -> goto login\n')
    expect(scriptEventOutcome(d, undefined, undefined, false).goto).toBeUndefined()
    expect(scriptLandingPage(d, { loggedIn: false })).toBe('board')
  })
})

describe('scriptLandingPage / bootNeedsLogin', () => {
  it('falls back to login, then home', () => {
    const d = parse('[meta]\nname = X\nhome = dash\n[auth]\nrequired = true\nlogin_endpoint = /l\n')
    expect(scriptLandingPage(d, { loggedIn: false })).toBe('login')
    expect(scriptLandingPage(d, { loggedIn: true })).toBe('dash')
    expect(scriptLandingPage(PLAN_GATE, { loggedIn: false, event: 'logout' })).toBe('goodbye')
  })

  it('honours skip_if_logged_in = false', () => {
    expect(bootNeedsLogin(PLAN_GATE, true)).toBe(true)
    const crm = parse('[meta]\nname = X\n[auth]\nrequired = true\nlogin_endpoint = /l\n')
    expect(bootNeedsLogin(crm, true)).toBe(false)
    expect(bootNeedsLogin(crm, false)).toBe(true)
    expect(bootNeedsLogin(parse('[meta]\nname = X\n'), false)).toBe(false)
  })
})

describe('buildScriptContext', () => {
  it('keeps built-ins un-shadowable and resolves own properties only', () => {
    const ctx = buildScriptContext({
      loggedIn: false,
      vars: { logged_in: true, error: 'x', event: 'y', plan: 'free' },
      event: 'Saved'
    })
    expect(ctx.vars).toMatchObject({ logged_in: false, error: null, event: 'saved', plan: 'free' })
    const d = parse('[meta]\nname = X\n[script]\nwhen plan.constructor -> goto oops\n')
    expect(scriptEventOutcome(d, undefined, { plan: 'free' }, true).goto).toBeUndefined()
  })
})
