import type { ActionDecl, ActionStep, CallMethod } from './types'

/**
 * [actions] helpers shared by the parser, the prompt and the runtime: the
 * canonical text of a step (what the file says, so the model sees declared
 * page ids and endpoints verbatim) and the `{…}` interpolation of a `call`
 * step's path.
 */

export const CALL_METHODS: ReadonlySet<CallMethod> = new Set<CallMethod>([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE'
])

/** `{form.x}` / `{row.x}` read the pressed control's data, `{x}` page state. */
export const CALL_INTERPOLATION = /^(?:(form|row)\.)?([A-Za-z0-9_]+)$/

/** A step as written in the file: `goto feed`, `call POST /leads with form`. */
export function formatActionStep(step: ActionStep): string {
  switch (step.kind) {
    case 'set':
      return `set ${step.stateKey} = form.${step.formField}`
    case 'refresh':
      return `refresh ${step.source}`
    case 'goto':
      return `goto ${step.page}`
    case 'call': {
      const body = step.body === 'form' ? ' with form' : ''
      const fields = step.fields
        ? ` body ${Object.entries(step.fields)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}`
        : ''
      return `call ${step.method} ${step.path}${body}${fields}`
    }
  }
}

/** The whole rule as written: `set q = form.q ; refresh leads`. */
export function formatActionSteps(decl: Pick<ActionDecl, 'steps'>): string {
  return decl.steps.map(formatActionStep).join(' ; ')
}

/** The page a rule ends on (its last `goto`), if any. */
export function actionGotoTarget(decl: Pick<ActionDecl, 'steps'>): string | undefined {
  for (let i = decl.steps.length - 1; i >= 0; i--) {
    const step = decl.steps[i]
    if (step.kind === 'goto') return step.page
  }
  return undefined
}

function scalar(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() === '' ? null : v
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null
  if (typeof v === 'boolean') return String(v)
  return null
}

function own(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object' && Object.hasOwn(obj, key)
    ? (obj as Record<string, unknown>)[key]
    : undefined
}

/**
 * A field of the pressed control's data: form submits carry fields at the
 * top level; a Table/List select carries the record's own fields (top level,
 * or under `record` / `item`) next to `row`, the visible cells by label.
 */
function eventField(data: Record<string, unknown> | undefined, key: string): string | null {
  for (const where of [data, own(data, 'record'), own(data, 'item'), own(data, 'row')]) {
    const value = scalar(own(where, key))
    if (value !== null) return value
  }
  return null
}

/**
 * Fill a `call` path: `{form.x}` and `{row.x}` from the event data (form
 * values / the pressed row), `{x}` from page state. Every value is
 * URI-encoded so a field can't add segments or a query. Returns null when a
 * placeholder has no usable scalar value — the call must not run half-filled.
 */
export function interpolateCallPath(
  path: string,
  ctx: { data?: Record<string, unknown>; state?: Record<string, unknown> }
): string | null {
  let missing = false
  const out = path.replace(/\{([^}]*)\}/g, (_m, inner: string) => {
    const m = CALL_INTERPOLATION.exec(inner)
    if (!m) {
      missing = true
      return ''
    }
    const value = m[1] ? eventField(ctx.data, m[2]) : scalar(own(ctx.state, m[2]))
    if (value === null) {
      missing = true
      return ''
    }
    return encodeURIComponent(value)
  })
  return missing ? null : out
}

/**
 * Resolve a `body k=v` pair's value: literals pass through, `{…}` placeholders
 * fill from the press data / page state exactly as in a path (but a body
 * value is JSON, so no URI-encoding). Null when a placeholder has no value —
 * the call must not run half-filled.
 */
export function interpolateBodyValue(
  value: string,
  ctx: { data?: Record<string, unknown>; state?: Record<string, unknown> }
): string | null {
  let missing = false
  const out = value.replace(/\{([^}]*)\}/g, (_m, inner: string) => {
    const m = CALL_INTERPOLATION.exec(inner)
    if (!m) {
      missing = true
      return ''
    }
    const filled = m[1] ? eventField(ctx.data, m[2]) : scalar(own(ctx.state, m[2]))
    if (filled === null) {
      missing = true
      return ''
    }
    return filled
  })
  return missing ? null : out
}

/** The whole `body` map filled; null if any placeholder is unfillable. */
export function interpolateBodyFields(
  fields: Record<string, string>,
  ctx: { data?: Record<string, unknown>; state?: Record<string, unknown> }
): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields)) {
    const filled = interpolateBodyValue(value, ctx)
    if (filled === null) return null
    out[key] = filled
  }
  return out
}

/**
 * The id of the record a `select` event names. Table/List selects carry the
 * whole record next to `id`; the scalar id is what detail-page action rules
 * reference as `{selected}` (the runtime parks it in page state).
 */
export function selectedRecordId(
  data: Record<string, unknown> | undefined
): string | null {
  return eventField(data, 'id')
}
