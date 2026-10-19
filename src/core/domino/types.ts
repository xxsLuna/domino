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
