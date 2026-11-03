import type {
  ActionDecl,
  ActionStep,
  ApiSection,
  AuthSection,
  CallMethod,
  DataSourceDecl,
  DominoFile,
  PageDecl,
  ParseError,
  ParseResult,
  ScriptRule,
  ScriptCommand,
  UiSection
} from './types'
import { validateCondition } from './conditions'
import { isSafeCssColor } from '../ui/theme'
import { describeUiSpecProblem, tryValidateUiSpec } from '../spec'
import { CALL_INTERPOLATION, CALL_METHODS } from './actions'
import { lintDomino } from './lint'
import { sectionHeader, stripComment } from './sections'

export { SECTION_HEADER } from './sections'

const KNOWN_SECTIONS = new Set([
  'meta',
  'auth',
  'api',
  'ui',
  'pages',
  'script',
  'guide',
  'data',
  'actions',
  'screens'
])
// Sections whose values are collected from the RAW line (see the loop):
// [data]/[actions] values carry `;` as a STEP SEPARATOR ("a ; b ; c"),
// [screens] values are single-line JSON that may contain `;` inside strings
// and [pages] values are free text — the generic comment stripper would cut
// them all. Each strips its own inline comments instead.
const RAW_SECTIONS = new Set(['data', 'actions', 'screens', 'pages'])
// Sections modeled as structures, never passthrough `extras`.
const MODELED_SECTIONS = new Set(['script', 'data', 'actions', 'screens', 'pages'])
// `obj[key] = …` with these keys hits Object.prototype setters instead of
// creating an own property ([__proto__] section / key = pollution vectors).
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
// Page ids appear in gotos, nav items and cache keys: keep them plain.
const PAGE_ID = /^[A-Za-z0-9_-]+$/

/** Strip one layer of matching surrounding quotes from a value. */
function unquote(v: string): string {
  if (v.length >= 2) {
    const q = v[0]
    if ((q === '"' || q === "'") && v[v.length - 1] === q) return v.slice(1, -1)
  }
  return v
}

/**
 * Trailing inline comment of a raw-collected value. A comment needs
 * whitespace before its marker so `;`/`#` inside a URL survive:
 *  - [data]: ` ;` or ` #` (a value is `METHOD path [every Ns]`, nothing else);
 *  - [actions]: ` #` only — `;` separates steps there;
 *  - [pages]: ` ;` (like every INI value) or ` # `.
 */
function stripInlineComment(section: string, value: string): string {
  switch (section) {
    case 'data':
      return value.replace(/\s+[;#].*$/, '').trim()
    case 'actions':
      return value.replace(/(^|\s+)#.*$/, '').trim()
    case 'pages':
      return value
        .replace(/\s+;.*$/, '')
        .replace(/\s+#\s.*$/, '')
        .trim()
    default:
      return value
  }
}

/** Parse a .domino v1 file. Never throws; diagnostics carry line numbers. */
export function parseDomino(source: string): ParseResult {
  const errors: ParseError[] = []
  // Non-fatal notes that are not syntax errors (unknown keys, case-only
  // matches, semantic findings): reported as warnings only.
  const notes: ParseError[] = []
  const sections = new Map<string, Array<{ line: number; key: string; value: string }>>()
  const scriptLines: Array<{ line: number; text: string }> = []
  // [guide] is free prose for the agent: kept verbatim (";" and "#" included).
  const guideLines: string[] = []

  const lines = source.split(/\r?\n/)
  let current: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = i + 1
    const header = sectionHeader(raw)
    if (current === 'guide' && header === null) {
      guideLines.push(raw.trimEnd())
      continue
    }
    const text = stripComment(raw).trim()
    if (header === null && !text) continue

    if (header !== null) {
      if (!KNOWN_SECTIONS.has(header)) {
        errors.push({
          line,
          message: `unknown section [${header}] (allowed: ${[...KNOWN_SECTIONS].join(', ')})`
        })
        // keep parsing so unknown keys land in extras
      }
      current = header
      if (!sections.has(header)) sections.set(header, [])
      continue
    }

    if (!current) {
      errors.push({ line, message: `content outside of any section: "${text}"` })
      continue
    }

    if (current === 'script') {
      scriptLines.push({ line, text })
      continue
    }
    if (RAW_SECTIONS.has(current)) {
      const rawKv = raw.trim().match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/)
      const value = rawKv ? stripInlineComment(current, rawKv[2].trim()) : ''
      if (!rawKv || !value) {
        errors.push({ line, message: `expected "key = value", got "${text}"` })
        continue
      }
      // Keys keep their case: they are matched exactly against node ids,
      // `{"$data": "key…"}` bindings and `refresh <key>` references.
      // [screens] keys are fixed names (spec/graph), so those fold.
      const key = current === 'screens' ? rawKv[1].toLowerCase() : rawKv[1]
      if (UNSAFE_KEYS.has(key.toLowerCase())) {
        errors.push({ line, message: `unsafe key "${key}" is not allowed` })
        continue
      }
      sections.get(current)!.push({ line, key, value })
      continue
    }

    const kv = text.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/)
    if (!kv) {
      errors.push({ line, message: `expected "key = value", got "${text}"` })
      continue
    }
    const key = kv[1].toLowerCase()
    if (UNSAFE_KEYS.has(key)) {
      errors.push({ line, message: `unsafe key "${key}" is not allowed` })
      continue
    }
    sections.get(current)!.push({ line, key, value: unquote(kv[2].trim()) })
  }

  const get = (section: string, key: string): string | undefined =>
    sections.get(section)?.find((e) => e.key === key)?.value

  const getLine = (section: string, key?: string): number => {
    const entries = sections.get(section)
    if (key === undefined) return entries?.[0]?.line ?? 1
    return entries?.find((e) => e.key === key)?.line ?? 1
  }

  /* ------------------------------- meta ------------------------------- */
  const name = get('meta', 'name')
  let fatal: ParseError | null = null
  if (!name) {
    // Always report: with no [meta] section at all this used to return
    // ok:false with an empty errors array (callers showed a blank message).
    fatal = {
      line: getLine('meta', 'name'),
      message: sections.has('meta')
        ? '[meta] name is required'
        : '[meta] section is missing — name is required'
    }
    errors.push(fatal)
  }
  const home = get('meta', 'home') ?? 'main'
  const guide = guideLines.join('\n').trim()

  /* ------------------------------- auth ------------------------------- */
  const auth: AuthSection = {
    required: parseBool(get('auth', 'required'), false),
    loginEndpoint: get('auth', 'login_endpoint'),
    tokenKey: get('auth', 'token_key') ?? 'access_token',
    skipIfLoggedIn: parseBool(get('auth', 'skip_if_logged_in'), true)
  }
  if (auth.required && !auth.loginEndpoint) {
    errors.push({
      line: getLine('auth', 'required'),
      message: '[auth] required = true needs login_endpoint'
    })
  }

  /* -------------------------------- api ------------------------------- */
  const api: ApiSection = {
    baseUrl: get('api', 'base_url'),
    allow: (get('api', 'allow') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }

  /* -------------------------------- ui -------------------------------- */
  const themeRaw = (get('ui', 'theme') ?? 'auto').toLowerCase()
  if (themeRaw !== 'light' && themeRaw !== 'dark' && themeRaw !== 'auto') {
    errors.push({
      line: getLine('ui', 'theme'),
      message: `[ui] theme must be light, dark or auto, got "${themeRaw}"`
    })
  }
  const styleRaw = (get('ui', 'style') ?? 'soft').toLowerCase()
  if (styleRaw !== 'soft' && styleRaw !== 'sharp') {
    errors.push({
      line: getLine('ui', 'style'),
      message: `[ui] style must be soft or sharp, got "${styleRaw}"`
    })
  }
  const densityRaw = (get('ui', 'density') ?? 'comfortable').toLowerCase()
  if (densityRaw !== 'comfortable' && densityRaw !== 'compact') {
    errors.push({
      line: getLine('ui', 'density'),
      message: `[ui] density must be comfortable or compact, got "${densityRaw}"`
    })
  }
  let radius: number | undefined
  const radiusRaw = get('ui', 'radius')
  if (radiusRaw !== undefined) {
    const n = Number(radiusRaw)
    if (!Number.isFinite(n) || n < 0 || n > 99) {
      errors.push({
        line: getLine('ui', 'radius'),
        message: `[ui] radius must be a number 0-99, got "${radiusRaw}"`
      })
    } else {
      radius = n
    }
  }
  // Colors land in CSS custom properties via setProperty, so a value like
  // `red; background-image: url(...)` (reachable through quotes, which
  // stripComment keeps intact) would inject CSS — accept plain colors only.
  const uiColor = (key: 'primary' | 'success' | 'warning' | 'danger'): string | undefined => {
    const raw = get('ui', key)
    if (raw === undefined) return undefined
    if (isSafeCssColor(raw)) return raw
    errors.push({
      line: getLine('ui', key),
      message: `[ui] ${key} must be a plain CSS color (hex, name or color function), got "${raw}"`
    })
    return undefined
  }
  const ui: UiSection = {
    theme: themeRaw === 'light' || themeRaw === 'dark' ? themeRaw : 'auto',
    style: styleRaw === 'sharp' ? 'sharp' : 'soft',
    density: densityRaw === 'compact' ? 'compact' : 'comfortable',
    primary: uiColor('primary'),
    radius,
    success: uiColor('success'),
    warning: uiColor('warning'),
    danger: uiColor('danger')
  }

  /* ------------------------------- pages ------------------------------- */
  // `leads = Leads | every lead as a table, newest first | nav` — the page
  // plan: stable ids, a display name, what the page is for, and whether it
  // sits in the primary navigation.
  const pages: PageDecl[] = []
  {
    const seen = new Set<string>()
    for (const e of sections.get('pages') ?? []) {
      if (!PAGE_ID.test(e.key)) {
        errors.push({
          line: e.line,
          message: `[pages] "${e.key}": a page id may only use letters, digits, "-" and "_"`
        })
        continue
      }
      if (seen.has(e.key.toLowerCase())) {
        errors.push({
          line: e.line,
          message: `[pages] "${e.key}" is declared twice — the first one wins`
        })
        continue
      }
      seen.add(e.key.toLowerCase())
      const parts = e.value.split('|').map((s) => s.trim())
      let purpose: string | undefined
      let flags: string[]
      if (parts.length === 2 && /^nav$/i.test(parts[1])) {
        flags = [parts[1]]
      } else {
        purpose = parts[1] ? unquote(parts[1]) : undefined
        flags = parts.slice(2)
      }
      let nav = false
      for (const flag of flags) {
        if (!flag) continue
        if (/^nav$/i.test(flag)) nav = true
        else {
          errors.push({
            line: e.line,
            message: `[pages] ${e.key}: unknown flag "${flag}" ignored (expected: id = Name | purpose | nav)`
          })
        }
      }
      pages.push({
        id: e.key,
        name: unquote(parts[0]) || e.key,
        ...(purpose ? { purpose } : {}),
        nav
      })
    }
  }

  /* ------------------------------ script ------------------------------ */
  const script: ScriptRule[] = []
  for (const { line, text } of scriptLines) {
    const rule = parseScriptLine(text)
    if (!rule) {
      errors.push({
        line,
        message: `bad script rule "${text}" (expected: when <cond> -> <cmd>  or  on <event> -> <cmd>; commands: goto <page>, render <page>, call [METHOD] <path>)`
      })
      continue
    }
    if (rule.when !== undefined) {
      const problem = validateCondition(rule.when)
      if (problem) {
        // A syntactically broken condition can only ever evaluate to false;
        // report it at load time instead of failing silently at runtime.
        errors.push({ line, message: `bad condition "${rule.when}": ${problem}` })
        continue
      }
    }
    script.push({ line, ...rule })
  }

  /* ------------------------------- data ------------------------------- */
  // `feed = GET /feed?url={rssUrl} every 20s` — one runtime-owned source.
  // `feed = FEED https://example.com/rss.xml every 60s` — RSS/Atom fetched and
  // parsed client-side; `FEED @subscriptions` is the user's subscription list.
  // Sources are re-fetched on open, before turns and on polls — read-only
  // methods only; writes belong in an [actions] `call` step.
  const data: DataSourceDecl[] = []
  {
    const seen = new Set<string>()
    for (const e of sections.get('data') ?? []) {
      if (seen.has(e.key.toLowerCase())) {
        errors.push({
          line: e.line,
          message: `[data] "${e.key}" is declared twice — the first one wins`
        })
        continue
      }
      const write = /^(POST|PUT|PATCH|DELETE)\s/i.exec(e.value)
      if (write) {
        errors.push({
          line: e.line,
          message: `[data] ${e.key}: ${write[1].toUpperCase()} is not allowed — [data] sources are re-fetched on open, before each turn and on polls, so they must be read-only (GET or FEED). Put writes in an [actions] call step.`
        })
        continue
      }
      const m = e.value.match(/^(GET|FEED)\s+(.+)$/i)
      if (!m) {
        errors.push({
          line: e.line,
          message: `[data] ${e.key}: expected "GET /path?query (every Ns)" or "FEED <url> (every Ns)", got "${e.value}"`
        })
        continue
      }
      const rest = m[2].trim()
      const ev = /\s+every\s+(\d+)\s*s?$/i.exec(rest)
      const path = (ev ? rest.slice(0, ev.index) : rest).trim()
      // `{state key}` segments may hold spaces; the rest of a path may not.
      const spacesOutside = path.replace(/\{[^}]*\}/g, '').includes(' ')
      if (spacesOutside) {
        errors.push({
          line: e.line,
          message: `[data] ${e.key}: the path must be "/…" (or an absolute http URL), got "${path}"`
        })
        continue
      }
      const method = m[1].toUpperCase() as 'GET' | 'FEED'
      if (method === 'FEED') {
        // A FEED source is fetched directly (no [api] involved): an absolute
        // http(s) URL, a bare {stateKey} holding the whole URL (substituted raw
        // and re-validated at fetch time), or @subscriptions — the runtime's
        // user-managed subscription list.
        const ok =
          path === '@subscriptions' ||
          /^\{[A-Za-z0-9_]+\}$/.test(path) ||
          /^https?:\/\//i.test(path)
        if (!ok) {
          errors.push({
            line: e.line,
            message: `[data] ${e.key}: FEED needs an absolute https URL, a bare {stateKey} holding one, or @subscriptions, got "${path}"`
          })
          continue
        }
      } else if (!/^(\/|https?:\/\/)/i.test(path)) {
        errors.push({
          line: e.line,
          message: `[data] ${e.key}: the path must be "/…" (or an absolute http URL), got "${path}"`
        })
        continue
      }
      if (interpolationGap(path, e, errors)) continue
      seen.add(e.key.toLowerCase())
      data.push({
        key: e.key,
        method,
        path,
        ...(ev ? { everySec: Math.min(600, Math.max(5, Number(ev[1]))) } : {})
      })
    }
  }

  /* ------------------------------ actions ------------------------------ */
  // `add-feed = set rssUrl = form.url ; refresh feed ; goto feed` — runtime-
  // owned steps for the widget with this node id.
  // `new-lead-form = call POST /leads with form ; refresh leads ; goto leads`
  const actions: ActionDecl[] = []
  {
    const dataKeys = new Set(data.map((d) => d.key))
    const seen = new Set<string>()
    for (const e of sections.get('actions') ?? []) {
      if (seen.has(e.key.toLowerCase())) {
        errors.push({
          line: e.line,
          message: `[actions] "${e.key}" is declared twice — the first one wins`
        })
        continue
      }
      seen.add(e.key.toLowerCase())
      const steps: ActionStep[] = []
      let bad = false
      const fail = (message: string): void => {
        errors.push({ line: e.line, message: `[actions] ${e.key}: ${message}` })
        bad = true
      }
      for (const rawStep of e.value
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)) {
        const refresh = rawStep.match(/^refresh\s+([A-Za-z0-9_.-]+)$/)
        if (refresh) {
          // References resolve like keys are declared: exactly. A match that
          // differs only in case still works (normalized to the declared key)
          // but is pointed out, so bindings written the same way don't miss.
          let source = refresh[1]
          if (!dataKeys.has(source)) {
            const near = data.find((d) => d.key.toLowerCase() === source.toLowerCase())?.key
            if (near) {
              notes.push({
                line: e.line,
                message: `[actions] ${e.key}: refresh "${source}" matches [data] "${near}" only by case — write "${near}"`
              })
              source = near
            } else {
              // Kept (the rest of the rule still runs); said at load time
              // instead of silently doing nothing at runtime.
              errors.push({
                line: e.line,
                message: `[actions] ${e.key}: refresh "${source}" — no such [data] source`
              })
            }
          }
          steps.push({ kind: 'refresh', source })
          continue
        }
        const set = rawStep.match(/^set\s+([A-Za-z0-9_]+)\s*=\s*form\.([A-Za-z0-9_]+)$/)
        if (set) {
          steps.push({ kind: 'set', stateKey: set[1], formField: set[2] })
          continue
        }
        const goto = rawStep.match(/^goto\s+([A-Za-z0-9_-]+)$/)
        if (goto) {
          steps.push({ kind: 'goto', page: goto[1] })
          continue
        }
        const call = rawStep.match(/^call\s+([A-Za-z]+)\s+(\S+)(?:\s+(?:with\s+)?(form|none))?$/i)
        if (call) {
          const method = call[1].toUpperCase() as CallMethod
          const path = call[2]
          if (!CALL_METHODS.has(method)) {
            fail(`call ${call[1]}: method must be GET, POST, PUT, PATCH or DELETE`)
            continue
          }
          if (!/^(\/|https?:\/\/)/i.test(path)) {
            fail(`call ${method} ${path}: the path must be "/…" (or an absolute http URL)`)
            continue
          }
          const gap = [...path.matchAll(/\{([^}]*)\}/g)].find((g) => !CALL_INTERPOLATION.test(g[1]))
          if (gap) {
            fail(
              `call ${method} ${path}: "{${gap[1]}}" must be {form.field}, {row.field} or {stateKey}`
            )
            continue
          }
          steps.push({
            kind: 'call',
            method,
            path,
            body: call[3]?.toLowerCase() === 'form' ? 'form' : 'none'
          })
          continue
        }
        fail(
          `bad step "${rawStep}" (steps: set <key> = form.<field> | refresh <source> | goto <page> | call <METHOD> /path [with form], joined by ";"; comments start with #)`
        )
      }
      if (!bad && steps.length > 0) actions.push({ id: e.key, steps })
    }
  }

  if (!name) {
    return {
      ok: false,
      errors,
      warnings: sortByLine(errors.filter((e) => e !== fatal))
    }
  }

  /* ------------------------------ screens ------------------------------ */
  // An export "with the app": the built UiSpec (one JSON line) plus the
  // observed action graph, so a fresh device runs it without the model. The
  // spec goes through the same normalize + validate as model output — a
  // hand-edited or stale embed must not reach the renderer malformed.
  let screens: DominoFile['screens']
  {
    const entries = sections.get('screens') ?? []
    const rawSpec = entries.find((e) => e.key === 'spec')?.value
    const rawGraph = entries.find((e) => e.key === 'graph')?.value
    const rawDef = entries.find((e) => e.key === 'def')?.value?.trim()
    if (rawSpec !== undefined) {
      const line = entries.find((e) => e.key === 'spec')!.line
      let parsed: unknown
      let json = true
      try {
        parsed = JSON.parse(rawSpec)
      } catch {
        json = false
        errors.push({
          line,
          message: '[screens] spec is not valid JSON — the app must be generated from scratch'
        })
      }
      if (json) {
        const version =
          parsed && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>).version
            : undefined
        const spec = version === 1 ? tryValidateUiSpec(parsed) : null
        if (!spec) {
          const why = version === 1 ? describeUiSpecProblem(parsed) : 'version 1 required'
          errors.push({
            line,
            message: `[screens] spec is not a valid UiSpec (${why ?? 'version 1 + pages required'}) — the app will be generated from scratch`
          })
        } else {
          screens = { spec }
          if (rawDef) screens.def = rawDef
          if (rawGraph !== undefined) {
            try {
              const graph = JSON.parse(rawGraph)
              if (Array.isArray(graph)) {
                screens.graph = graph.filter(
                  (
                    e: unknown
                  ): e is NonNullable<NonNullable<DominoFile['screens']>['graph']>[number] =>
                    typeof e === 'object' &&
                    e !== null &&
                    ['from', 'to', 'action', 'label', 'kind'].every(
                      (k) => typeof (e as Record<string, unknown>)[k] === 'string'
                    )
                )
              }
            } catch {
              errors.push({ line, message: '[screens] graph is not valid JSON — ignored' })
            }
          }
        }
      }
    }
  }

  const extras: Record<string, Record<string, string>> = {}
  for (const [section, entries] of sections) {
    // script/data/actions/pages/screens are modeled structures, not passthrough config.
    if (MODELED_SECTIONS.has(section)) continue
    if (UNSAFE_KEYS.has(section)) continue // never copies into plain objects
    const known = knownKeys(section)
    const extra: Record<string, string> = {}
    for (const e of entries) {
      if (known.has(e.key)) continue
      extra[e.key] = e.value
      // Keys of an unknown section were reported with the section itself.
      if (KNOWN_SECTIONS.has(section)) {
        notes.push({
          line: e.line,
          message: `[${section}] unknown key "${e.key}" — ignored (known: ${[...known].join(', ')})`
        })
      }
    }
    if (Object.keys(extra).length > 0) extras[section] = extra
  }

  const domino: DominoFile = {
    meta: { name, logo: get('meta', 'logo'), home, description: get('meta', 'description') },
    auth,
    api,
    ui,
    script,
    pages,
    data,
    actions,
    ...(screens ? { screens } : {}),
    ...(guide ? { guide } : {}),
    extras,
    id: `${name}|${api.baseUrl ?? ''}`
  }
  notes.push(...lintDomino(domino, getLine))
  return { ok: true, domino, errors, warnings: sortByLine([...errors, ...notes]) }
}

function sortByLine(list: ParseError[]): ParseError[] {
  return list
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.line - b.e.line || a.i - b.i)
    .map(({ e }) => e)
}

/**
 * `{stateKey}` interpolations in a [data] path resolve against spec.state at
 * fetch time (missing/empty key = source not ready, fetch skipped). At parse
 * time only the shape is checked: plain identifiers only.
 */
function interpolationGap(
  path: string,
  entry: { line: number; key: string },
  errors: ParseError[]
): boolean {
  for (const m of path.matchAll(/\{([^}]*)\}/g)) {
    if (!/^[A-Za-z0-9_]+$/.test(m[1])) {
      errors.push({
        line: entry.line,
        message: `[data] ${entry.key}: interpolation "{${m[1]}}" must be a plain state key like {rssUrl}`
      })
      return true
    }
  }
  return false
}

function knownKeys(section: string): Set<string> {
  switch (section) {
    case 'meta':
      return new Set(['name', 'logo', 'home', 'description'])
    case 'auth':
      return new Set(['required', 'login_endpoint', 'token_key', 'skip_if_logged_in'])
    case 'api':
      return new Set(['base_url', 'allow'])
    case 'ui':
      return new Set([
        'theme',
        'primary',
        'style',
        'radius',
        'density',
        'success',
        'warning',
        'danger'
      ])
    default:
      return new Set()
  }
}

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback
  const s = v.toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(s)) return true
  if (['false', 'no', 'off', '0'].includes(s)) return false
  return fallback
}

function parseScriptLine(text: string): Omit<ScriptRule, 'line'> | null {
  const m = text.match(/^(when|on)\s+(.+?)\s*->\s*(.+)$/)
  if (!m) return null
  const [, keyword, lhs, rhs] = m
  const command = parseCommand(rhs.trim())
  if (!command) return null
  if (keyword === 'when') return { when: lhs.trim(), command }
  return { event: lhs.trim().toLowerCase(), command }
}

function parseCommand(rhs: string): ScriptCommand | null {
  const goto = rhs.match(/^goto\s+([A-Za-z0-9_-]+)$/)
  if (goto) return { kind: 'goto', page: goto[1] }
  const render = rhs.match(/^render\s+([A-Za-z0-9_-]+)$/)
  if (render) return { kind: 'render', page: render[1] }
  const withMethod = rhs.match(/^call\s+(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/i)
  if (withMethod) {
    const method = withMethod[1].toUpperCase() as CallMethod
    return {
      kind: 'call',
      endpoint: withMethod[2],
      ...(method !== 'GET' ? { method } : {})
    }
  }
  const call = rhs.match(/^call\s+(\S+)$/)
  if (call) return { kind: 'call', endpoint: call[1] }
  return null
}
