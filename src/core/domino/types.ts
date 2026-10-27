/**
 * .domino v1 — our own INI-like format with a tiny condition script.
 *
 *   [meta]   name, logo, home, description
 *   [auth]   required, login_endpoint, token_key, skip_if_logged_in
 *   [api]    base_url, allow (comma-separated path patterns)
 *   [ui]     theme, primary, style (soft|sharp), radius, density (comfortable|compact),
 *            success/warning/danger (step colors)
 *   [script] when <cond> -> <command>   /   on <event> -> <command>
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

export type ScriptCommand =
  | { kind: 'goto'; page: string }
  | { kind: 'render'; page: string }
  | { kind: 'call'; endpoint: string }

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
  /** API method, or `FEED` for RSS/Atom fetched and parsed client-side. */
  method: string
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
  | { kind: 'goto'; page: string }

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
  errors: ParseError[]
}
