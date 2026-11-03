import { evalCondition, type EvalContext } from './conditions'
import type { CallMethod, DominoFile, ScriptCommand, ScriptRule } from './types'

/**
 * Applies [script] rules against a runtime context.
 * Rules are evaluated in file order; every matching rule's command is
 * collected so callers can pick the highest-priority one (goto wins over
 * render, explicit on-event rules win over `when` rules).
 */

export interface ScriptOutcome {
  goto?: string
  render?: string
  /** Endpoint of the first matching `call` command. */
  call?: string
  /** Its method (`call POST /x`); absent means GET. */
  callMethod?: CallMethod
}

export function applyScript(
  domino: DominoFile,
  ctx: EvalContext,
  firedEvent?: string
): ScriptOutcome {
  const outcome: ScriptOutcome = {}
  const event = firedEvent?.toLowerCase()

  // Explicit `on <event>` rules take priority over `when` conditions;
  // within each group, file order wins.
  const eventRules = domino.script.filter((r) => r.event !== undefined)
  const whenRules = domino.script.filter((r) => r.when !== undefined)
  for (const rule of [...eventRules, ...whenRules]) {
    if (!matches(rule, ctx, event)) continue
    applyCommand(rule.command, outcome)
  }
  return outcome
}

function matches(rule: ScriptRule, ctx: EvalContext, event: string | undefined): boolean {
  if (rule.when !== undefined) return evalCondition(rule.when, ctx)
  if (rule.event !== undefined) return event !== undefined && rule.event === event
  return false
}

function applyCommand(cmd: ScriptCommand, outcome: ScriptOutcome): void {
  switch (cmd.kind) {
    case 'goto':
    case 'render':
      // First matching wins (file order); later rules don't override.
      if (outcome.goto === undefined && outcome.render === undefined) {
        if (cmd.kind === 'goto') outcome.goto = cmd.page
        else outcome.render = cmd.page
      }
      break
    case 'call':
      if (outcome.call === undefined) {
        outcome.call = cmd.endpoint
        if (cmd.method && cmd.method !== 'GET') outcome.callMethod = cmd.method
      }
      break
  }
}

/** Build the eval context the [script] conditions see. */
export function buildScriptContext(state: {
  loggedIn: boolean
  error?: string | null
  vars?: Record<string, unknown>
  /** The event being dispatched (`login`, `auth_failed`, a custom one…). */
  event?: string | null
}): EvalContext {
  return {
    vars: {
      // Spread first: a file's vars must never shadow the built-ins below,
      // or `[script]` could be tricked into thinking the user is logged in.
      ...(state.vars ?? {}),
      logged_in: state.loggedIn,
      error: state.error ?? null,
      event: state.event?.toLowerCase() ?? null
    }
  }
}

/**
 * Events after which the app re-routes like at boot: the auth state just
 * changed, so every `when` rule applies (`when not logged_in -> goto login`).
 * Any other event only routes through its own `on <event>` rules and the
 * `when` rules it newly made true (`when error == "billing" -> goto upgrade`).
 */
export const ROUTING_EVENTS: ReadonlySet<string> = new Set(['login', 'logout', 'auth_failed'])

export interface ScriptEventOutcome extends ScriptOutcome {
  /** Which kind of rule produced goto/render (absent when none did). */
  routedBy?: 'event' | 'when'
}

/**
 * Evaluate [script] for one runtime moment: boot (`event` undefined), an
 * auth transition (`login` / `logout` / `auth_failed`) or any other event
 * the runtime fires (`api_error`, a custom name). `vars` are the session's
 * non-secret fields (plan, role, param…); `error` the last API error code.
 *
 * For a non-routing event a `when` rule only counts when THIS event made it
 * true — otherwise `when logged_in -> goto main` would yank the user home
 * on every API error. A `login` route in an app without [auth] is ignored
 * (there is no sign-in page to show).
 */
export function scriptEventOutcome(
  domino: DominoFile,
  event: string | undefined,
  vars: Record<string, unknown> | undefined,
  loggedIn: boolean,
  error?: string | null
): ScriptEventOutcome {
  const name = event?.toLowerCase()
  const ctx = buildScriptContext({ loggedIn, error, vars, event: name })
  const baseline =
    name === undefined || ROUTING_EVENTS.has(name)
      ? null
      : buildScriptContext({ loggedIn, error: null, vars })
  const routable = (page: string): boolean => page !== 'login' || domino.auth.required

  const outcome: ScriptEventOutcome = {}
  const take = (cmd: ScriptCommand, by: 'event' | 'when'): void => {
    if (cmd.kind === 'call') {
      applyCommand(cmd, outcome)
      return
    }
    if (outcome.routedBy || !routable(cmd.page)) return
    applyCommand(cmd, outcome)
    outcome.routedBy = by
  }
  if (name !== undefined) {
    for (const rule of domino.script) {
      if (rule.event === name) take(rule.command, 'event')
    }
  }
  for (const rule of domino.script) {
    if (rule.when === undefined || !evalCondition(rule.when, ctx)) continue
    if (baseline && evalCondition(rule.when, baseline)) continue
    take(rule.command, 'when')
  }
  return outcome
}

/**
 * The page to show at boot or after an auth transition: the script's route,
 * else login when signing in is required and nobody is, else [meta] home.
 */
export function scriptLandingPage(
  domino: DominoFile,
  state: {
    loggedIn: boolean
    event?: string
    vars?: Record<string, unknown>
    error?: string | null
  }
): string {
  const outcome = scriptEventOutcome(domino, state.event, state.vars, state.loggedIn, state.error)
  const scripted = outcome.goto ?? outcome.render
  if (scripted) return scripted
  if (domino.auth.required && !state.loggedIn) return 'login'
  return domino.meta.home
}

/**
 * Whether boot must show the sign-in page: signing in is required and there
 * is no stored token — or there is one but `skip_if_logged_in = false` asks
 * for a fresh sign-in each time (the token may still prefill/refresh).
 */
export function bootNeedsLogin(domino: DominoFile, hasToken: boolean): boolean {
  if (!domino.auth.required) return false
  return !hasToken || !domino.auth.skipIfLoggedIn
}
