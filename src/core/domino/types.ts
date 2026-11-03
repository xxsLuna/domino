/**
 * .domino v1 — our own INI-like format with a tiny condition script.
 *
 *   [meta]   name, logo, home, description
 *   [auth]   required, login_endpoint, token_key, skip_if_logged_in
 *   [api]    base_url, allow (comma-separated path patterns)
 *   [ui]     theme, primary, style (soft|sharp), radius, density (comfortable|compact),
 *            success/warning/danger (step colors)
 *   [pages]  id = Name | purpose | nav — the app's page plan (stable ids)
 *   [script] when <cond> -> <command>   /   on <event> -> <command>
 *   [data]   key = GET /path every Ns  /  key = FEED <url> — runtime-owned reads
 *   [actions] node-id = step ; step — runtime-owned widget behaviors
 *   [screens] spec = <UiSpec JSON> — an export with the built app embedded
 *   [guide]  free text for the agent: what the service is, what each API
 *            returns/expects, which screens and behaviors the app needs
 */

export interface AuthSection {
  required: boolean
  loginEndpoint?: string
  tokenKey: string
  skipIfLoggedIn: boolean
}

export interface ApiSection {
  baseUrl?: string
  allow: string[]
}

export interface UiSection {
  /** `auto` follows the OS color-scheme preference (default). */
  theme: 'light' | 'dark' | 'auto'
  /** Accent color (buttons, links, card headers). Safe CSS color only (see isSafeCssColor). */
  primary?: string
  /** Corner treatment: sharp = squared-off Tailwind "rounded-none" feel. */
  style: 'soft' | 'sharp'
  /** Explicit corner radius in px; overrides `style` when set. */
  radius?: number
  density: 'comfortable' | 'compact'
  /** Semantic/step colors ("각 단계별 색"): Tailwind-like status palette. */
  success?: string
  warning?: string
  danger?: string
}

/** HTTP methods an [actions] `call` step or a [script] `call` may use. */
export type CallMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type ScriptCommand =
  | { kind: 'goto'; page: string }
  | { kind: 'render'; page: string }
  /** `call /path` (GET) or `call POST /path` — run by the runtime, under [api] allow. */
  | { kind: 'call'; endpoint: string; method?: CallMethod }

export interface ScriptRule {
  /** Line number for diagnostics. */
  line: number
  /** `when <cond>` rules; `on <event>` rules have `event` set instead. */
  when?: string
  event?: string
  command: ScriptCommand
}

/**
 * [data] — a live data source the RUNTIME owns: fetched before turns, bound
 * into screens via `{"$data": "<key>.<path>"}` props and refreshed (by an
 * [actions] rule or an `every Ns` poll) without a model turn.
 */
export interface DataSourceDecl {
  /** Source key used in `{"$data": "key.path"}` bindings and `refresh` steps. */
  key: string
  /**
   * `GET`, or `FEED` for RSS/Atom fetched and parsed client-side. Sources are
   * re-fetched on open, before turns and on polls, so they must be read-only:
   * writes belong in an [actions] `call` step.
   */
  method: 'GET' | 'FEED'
  /**
   * Path (with query) under [api] base_url; `{stateKey}` interpolates spec.state.
   * A FEED source holds an absolute http(s) URL, a bare `{stateKey}` with the
   * whole URL, or `@subscriptions` — the user's runtime-managed feed list.
   */
  path: string
  /** Poll interval while a page showing this source is on screen. */
  everySec?: number
}

/** One step of an [actions] rule — the runtime executes these itself. */
export type ActionStep =
  | { kind: 'refresh'; source: string }
  | { kind: 'set'; stateKey: string; formField: string }
  /** `page` is the declared id exactly as written — a not-yet-built target keeps it. */
  | { kind: 'goto'; page: string }
  /**
   * `call POST /leads with form` — one API request under [api] allow. `body`
   * 'form' sends the submitted form values; the path may interpolate
   * `{form.x}` / `{row.x}` (the pressed control's data) and `{stateKey}`.
   */
  | { kind: 'call'; method: CallMethod; path: string; body: 'form' | 'none' }

/**
 * [pages] — the app's page plan: `id = Name | purpose | nav`. Ids are the
 * ones every screen, nav item and goto must use, so pages can be pre-built
 * and linked before anyone presses a button.
 */
export interface PageDecl {
  id: string
  name: string
  /** What the page shows / is for (fed to the model when it builds it). */
  purpose?: string
  /** Listed in the primary navigation. */
  nav: boolean
}

/**
 * [actions] — widget behaviors implemented by the runtime, not the model:
 * pressing a control whose node id (a Form's id for submits) matches a key
 * runs the steps locally; a `goto` for a page not built yet falls through to
 * a live generation turn.
 */
export interface ActionDecl {
  id: string
  steps: ActionStep[]
}

export interface DominoFile {
  meta: {
    name: string
    logo?: string
    home: string
    /** One-line summary of what the app is for. */
    description?: string
  }
  auth: AuthSection
  api: ApiSection
  ui: UiSection
  script: ScriptRule[]
  /** [pages] plan in file order ([] when the section is absent). */
  pages: PageDecl[]
  /** [data] live sources (runtime-owned fetching/refresh). */
  data: DataSourceDecl[]
  /** [actions] runtime-owned widget behaviors, keyed by node id. */
  actions: ActionDecl[]
  /**
   * [screens] — an export WITH the built app embedded: every rendered page
   * (a full UiSpec snapshot) plus the observed action graph, so the file
   * runs as-is on a fresh device with zero LLM calls. `spec` is imported
   * structurally to avoid a domino ↔ pageGraph type cycle.
   */
  screens?: {
    spec: import('../spec').UiSpec
    graph?: Array<{ from: string; to: string; action: string; label: string; kind: string }>
    /**
     * dominoFingerprint of the definition the embedded screens were built
     * against. A file edited after the export (renamed pages, [data] keys,
     * [actions] paths) no longer matches: the embed is then outdated and is
     * not seeded. Missing on embeds from older builds — treated the same.
     */
    def?: string
  }
  /** Author's instructions for the agent ([guide] section, verbatim). */
  guide?: string
  /** Stable id for session/token storage. */
  id: string
  /** Any keys in sections we don't explicitly model (forward compat). */
  extras: Record<string, Record<string, string>>
}

export interface ParseError {
  line: number
  message: string
}

export interface ParseResult {
  ok: boolean
  domino?: DominoFile
  /**
   * Syntax diagnostics: the fatal one (no [meta] name → ok false) and every
   * line the parser had to drop or ignore.
   */
  errors: ParseError[]
  /**
   * Everything non-fatal, for display when the file opens: the dropped-line
   * errors above, unknown keys, plus semantic findings (a goto to an
   * undeclared page, a [data] path outside [api] allow…). Sorted by line.
   */
  warnings: ParseError[]
}
