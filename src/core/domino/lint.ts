import { isAllowed } from '../agent/api'
import { applyScript, buildScriptContext } from './script'
import type { DominoFile, ParseError } from './types'

/**
 * Semantic checks over a parsed definition: things that parse fine but
 * cannot work as written — a login route in an app without sign-in, a goto
 * to a page the [pages] plan doesn't declare, a [data] source the [api]
 * allow list would 403 on every poll. Never fatal: the loader shows them as
 * warnings and the maker feeds them back for a repair round.
 */

/** Line lookup for a section entry (1 when unknown). */
export type LineOf = (section: string, key?: string) => number

/** A path with `{…}` placeholders reduced to a concrete sample for allow checks. */
function samplePath(path: string): string {
  return path.replace(/\{[^}]*\}/g, 'x')
}

function pageLookup(domino: DominoFile): (id: string) => 'ok' | { near?: string } {
  const exact = new Set(domino.pages.map((p) => p.id))
  return (id) => {
    if (exact.has(id)) return 'ok'
    const near = domino.pages.find((p) => p.id.toLowerCase() === id.toLowerCase())?.id
    return near ? { near } : {}
  }
}

export function lintDomino(domino: DominoFile, lineOf: LineOf = () => 1): ParseError[] {
  const out: ParseError[] = []
  const home = domino.meta.home
  const hasAuth = domino.auth.required

  /* ---------------------- login only with [auth] ---------------------- */
  for (const rule of domino.script) {
    const cmd = rule.command
    if ((cmd.kind === 'goto' || cmd.kind === 'render') && cmd.page === 'login' && !hasAuth) {
      out.push({
        line: rule.line,
        message: `[script] ${cmd.kind} login, but the app has no sign-in ([auth] required = true) — use "${cmd.kind} ${home}"`
      })
    }
  }

  /* ------------------------ the [pages] plan ------------------------- */
  if (domino.pages.length > 0) {
    const check = pageLookup(domino)
    const undeclared = (id: string, line: number, where: string): void => {
      if (id === 'login' && hasAuth) return // the runtime-owned sign-in page
      const hit = check(id)
      if (hit === 'ok') return
      out.push({
        line,
        message: `${where} "${id}" is not a page in [pages]${hit.near ? ` — did you mean "${hit.near}"?` : ''}`
      })
    }
    undeclared(home, lineOf('meta', 'home'), '[meta] home')
    for (const rule of domino.script) {
      const cmd = rule.command
      if (cmd.kind === 'goto' || cmd.kind === 'render') {
        undeclared(cmd.page, rule.line, `[script] ${cmd.kind}`)
      }
    }
    for (const decl of domino.actions) {
      for (const step of decl.steps) {
        if (step.kind === 'goto') {
          undeclared(step.page, lineOf('actions', decl.id), `[actions] ${decl.id}: goto`)
        }
      }
    }
  } else {
    // No plan to check against: at least the first screen should be home.
    // A typical slip is a copied `when logged_in -> goto main` while
    // [meta] home names another page.
    const states = hasAuth ? [true] : [false, true]
    for (const loggedIn of states) {
      const outcome = applyScript(domino, buildScriptContext({ loggedIn }))
      const page = outcome.goto ?? outcome.render
      if (!page || page === home || page === 'login') continue
      const rule = domino.script.find(
        (r) => (r.command.kind === 'goto' || r.command.kind === 'render') && r.command.page === page
      )
      out.push({
        line: rule?.line ?? lineOf('script'),
        message: `[script] sends a ${loggedIn ? 'signed-in' : 'new'} user to "${page}", but [meta] home is "${home}" — use the same page id`
      })
      break
    }
  }

  /* -------------------- [api] allow covers reads/writes -------------------- */
  const allowNote = (path: string): string | null => {
    if (!/^https?:\/\//i.test(path) && !domino.api.baseUrl) {
      return 'has a relative path but [api] has no base_url'
    }
    return isAllowed(samplePath(path), domino.api.allow, domino.api.baseUrl)
      ? null
      : 'is not covered by [api] allow — every request would be refused (403)'
  }
  for (const d of domino.data) {
    if (d.method === 'FEED') continue // fetched directly, never through [api]
    const problem = allowNote(d.path)
    if (problem) {
      out.push({ line: lineOf('data', d.key), message: `[data] ${d.key}: ${d.path} ${problem}` })
    }
  }
  for (const decl of domino.actions) {
    for (const step of decl.steps) {
      if (step.kind !== 'call') continue
      const problem = allowNote(step.path)
      if (problem) {
        out.push({
          line: lineOf('actions', decl.id),
          message: `[actions] ${decl.id}: call ${step.method} ${step.path} ${problem}`
        })
      }
    }
  }
  for (const rule of domino.script) {
    if (rule.command.kind !== 'call') continue
    const problem = allowNote(rule.command.endpoint)
    if (problem) {
      out.push({ line: rule.line, message: `[script] call ${rule.command.endpoint} ${problem}` })
    }
  }

  return out
}
