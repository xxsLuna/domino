import type { AuthSection, ApiSection, DominoFile, ParseError, ParseResult, ScriptRule, ScriptCommand, UiSection } from './types'

const KNOWN_SECTIONS = new Set(['meta', 'auth', 'api', 'ui', 'script', 'guide'])
const SECTION_HEADER = /^\s*\[[A-Za-z0-9_-]+\]\s*$/

/** Parse a .domino v1 file. Never throws; diagnostics carry line numbers. */
export function parseDomino(source: string): ParseResult {
  const errors: ParseError[] = []
  const sections = new Map<string, Array<{ line: number; key: string; value: string }>>()
  const scriptLines: Array<{ line: number; text: string }> = []
  // [guide] is free prose for the agent: kept verbatim (";" and "#" included).
  const guideLines: string[] = []

  const lines = source.split(/\r?\n/)
  let current: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = i + 1
    if (current === 'guide' && !SECTION_HEADER.test(raw)) {
      guideLines.push(raw.trimEnd())
      continue
    }
    const text = stripComment(raw).trim()
    if (!text) continue

    const sectionMatch = text.match(/^\[([A-Za-z0-9_-]+)\]$/)
    if (sectionMatch) {
      const name = sectionMatch[1].toLowerCase()
      if (!KNOWN_SECTIONS.has(name)) {
        errors.push({ line, message: `unknown section [${name}] (allowed: ${[...KNOWN_SECTIONS].join(', ')})` })
        // keep parsing so unknown keys land in extras
      }
      current = name
      if (!sections.has(name)) sections.set(name, [])
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

    const kv = text.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/)
    if (!kv) {
      errors.push({ line, message: `expected "key = value", got "${text}"` })
      continue
    }
    sections.get(current)!.push({ line, key: kv[1].toLowerCase(), value: kv[2].trim() })
  }

  const get = (section: string, key: string): string | undefined =>
    sections.get(section)?.find((e) => e.key === key)?.value

  const getLine = (section: string, key: string): number =>
    sections.get(section)?.find((e) => e.key === key)?.line ?? 1

  /* ------------------------------- meta ------------------------------- */
  const name = get('meta', 'name')
  if (!name && sections.has('meta')) {
    errors.push({ line: getLine('meta', 'name'), message: '[meta] name is required' })
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
    errors.push({ line: getLine('auth', 'required'), message: '[auth] required = true needs login_endpoint' })
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
    errors.push({ line: getLine('ui', 'style'), message: `[ui] style must be soft or sharp, got "${styleRaw}"` })
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
      errors.push({ line: getLine('ui', 'radius'), message: `[ui] radius must be a number 0-99, got "${radiusRaw}"` })
    } else {
      radius = n
    }
  }
  const ui: UiSection = {
    theme: themeRaw === 'light' || themeRaw === 'dark' ? themeRaw : 'auto',
    style: styleRaw === 'sharp' ? 'sharp' : 'soft',
    density: densityRaw === 'compact' ? 'compact' : 'comfortable',
    primary: get('ui', 'primary'),
    radius,
    success: get('ui', 'success'),
    warning: get('ui', 'warning'),
    danger: get('ui', 'danger')
  }

  /* ------------------------------ script ------------------------------ */
  const script: ScriptRule[] = []
  for (const { line, text } of scriptLines) {
    const rule = parseScriptLine(text)
    if (!rule) {
      errors.push({ line, message: `bad script rule "${text}" (expected: when <cond> -> <cmd>  or  on <event> -> <cmd>)` })
      continue
    }
    script.push({ line, ...rule })
  }

  if (!name) return { ok: false, errors }

  const extras: Record<string, Record<string, string>> = {}
  for (const [section, entries] of sections) {
    if (section === 'script') continue
    const known = knownKeys(section)
    const extra: Record<string, string> = {}
    for (const e of entries) {
      if (!known.has(e.key)) extra[e.key] = e.value
    }
    if (Object.keys(extra).length > 0) extras[section] = extra
  }

  const domino: DominoFile = {
    meta: { name, logo: get('meta', 'logo'), home, description: get('meta', 'description') },
    auth,
    api,
    ui,
    script,
    ...(guide ? { guide } : {}),
    extras,
    id: `${name}|${api.baseUrl ?? ''}`
  }
  return { ok: true, domino, errors }
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
      return new Set(['theme', 'primary', 'style', 'radius', 'density', 'success', 'warning', 'danger'])
    default:
      return new Set()
  }
}

function stripComment(line: string): string {
  // Full-line comments (# or ;) are stripped; inline ; only outside quotes.
  if (/^\s*[#;]/.test(line)) return ''
  let inQuote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuote) {
      if (c === inQuote) inQuote = null
    } else if (c === '"' || c === "'") {
      inQuote = c
    } else if (c === ';') {
      return line.slice(0, i)
    }
  }
  return line
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
  const call = rhs.match(/^call\s+(\S+)$/)
  if (call) return { kind: 'call', endpoint: call[1] }
  return null
}
