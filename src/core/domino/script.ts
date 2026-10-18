import { evalCondition, type EvalContext } from './conditions'
import type { DominoFile, ScriptCommand, ScriptRule } from './types'

/**
 * Applies [script] rules against a runtime context.
 * Rules are evaluated in file order; every matching rule's command is
 * collected so callers can pick the highest-priority one (goto wins over
 * render, explicit on-event rules win over `when` rules).
 */

export interface ScriptOutcome {
  goto?: string
  render?: string
  call?: string
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
      if (outcome.call === undefined) outcome.call = cmd.endpoint
      break
  }
}

/** Build the eval context the [script] conditions see. */
export function buildScriptContext(state: {
  loggedIn: boolean
  error?: string | null
  vars?: Record<string, unknown>
}): EvalContext {
  return {
    vars: {
      logged_in: state.loggedIn,
      error: state.error ?? null,
      ...(state.vars ?? {})
    }
  }
}
