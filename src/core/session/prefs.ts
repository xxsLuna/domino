import { isReasoningLevel } from '../llm/reasoning'
import type { LLMConfig, ProviderId } from '../llm/types'
import { PROVIDER_META } from '../llm/types'
import { sourceKey } from './registry'

/**
 * Preferences persisted through a platform KeyValueStorage
 * (Electron: safeStorage-secured file; Web/Android: localStorage).
 */

export interface KeyValueStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
  /**
   * Enumerate every stored [key, value] — the storage-management settings
   * need sizes per domino. Optional: adapters without enumeration simply
   * leave it out and management UI degrades to "unsupported here".
   */
  entries?(): Promise<Array<[string, string]>>
}

export type DominoSource =
  | { type: 'url'; url: string }
  | { type: 'file'; path: string; text?: string }
  /** Raw file content (web uploads / pasted text) so recents can reopen it. */
  | { type: 'text'; text: string }

export interface RecentEntry {
  source: DominoSource
  name: string
  at: number
}

const KEYS = {
  llm: 'domino:llm-config',
  recents: 'domino:recents',
  token: (id: string) => `domino:token:${id}`,
  sessionVars: (id: string) => `domino:sessionvars:${id}`,
  welcomeHint: 'domino:welcome-hint',
  tokenWarn: 'domino:token-warn',
  dominoLlm: (id: string) => `domino:llm-config:${id}`
} as const

export function defaultLlmConfig(): LLMConfig {
  const meta = PROVIDER_META.chat_completions
  return {
    provider: 'chat_completions',
    baseUrl: meta.defaultBaseUrl,
    model: meta.defaultModel,
    apiKey: ''
  }
}

/**
 * The optional tuning fields of a stored config, each type-checked: a bad
 * value (hand-edited file, older build) is dropped on its own instead of
 * failing the whole load.
 */
function optionalLlmFields(
  p: Record<string, unknown>
): Pick<LLMConfig, 'temperature' | 'reasoning' | 'maxOutputTokens'> {
  return {
    ...(typeof p.temperature === 'number' && Number.isFinite(p.temperature)
      ? { temperature: p.temperature }
      : {}),
    ...(isReasoningLevel(p.reasoning) ? { reasoning: p.reasoning } : {}),
    ...(typeof p.maxOutputTokens === 'number' &&
    Number.isFinite(p.maxOutputTokens) &&
    p.maxOutputTokens >= 1
      ? { maxOutputTokens: Math.floor(p.maxOutputTokens) }
      : {})
  }
}

export async function loadLlmConfig(storage: KeyValueStorage): Promise<LLMConfig> {
  const defaults = defaultLlmConfig()
  let raw: string | null
  try {
    raw = await storage.get(KEYS.llm)
  } catch {
    return defaults // storage unavailable: boot with defaults instead of failing
  }
  if (!raw) return defaults
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return defaults
  }
  if (!parsed || typeof parsed !== 'object') return defaults
  const p = parsed as Record<string, unknown>
  // Object.hasOwn: `provider: "constructor"` is truthy on Object.prototype and
  // would otherwise pass a plain membership check, crashing createAdapter later.
  if (typeof p.provider !== 'string' || !Object.hasOwn(PROVIDER_META, p.provider)) {
    return defaults
  }
  return {
    provider: p.provider as ProviderId,
    baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : defaults.baseUrl,
    model: typeof p.model === 'string' ? p.model : defaults.model,
    apiKey: typeof p.apiKey === 'string' ? p.apiKey : defaults.apiKey,
    ...optionalLlmFields(p)
  }
}

export async function saveLlmConfig(storage: KeyValueStorage, config: LLMConfig): Promise<void> {
  await storage.set(KEYS.llm, JSON.stringify(config))
}

export async function loadRecents(storage: KeyValueStorage): Promise<RecentEntry[]> {
  const raw = await storage.get(KEYS.recents)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as RecentEntry[]
    return Array.isArray(parsed) ? parsed.filter((e) => e && e.source && e.name) : []
  } catch {
    return []
  }
}

/** Insert/reorder a recent entry; keeps the newest 8. */
export async function pushRecent(
  storage: KeyValueStorage,
  entry: Omit<RecentEntry, 'at'>
): Promise<RecentEntry[]> {
  const list = await loadRecents(storage)
  const key = sourceKey(entry.source)
  const filtered = list.filter((e) => sourceKey(e.source) !== key)
  const next = [{ ...entry, at: Date.now() }, ...filtered].slice(0, 8)
  await storage.set(KEYS.recents, JSON.stringify(next))
  return next
}

export async function clearToken(storage: KeyValueStorage, dominoId: string): Promise<void> {
  await storage.remove(KEYS.token(dominoId))
}

export async function getToken(storage: KeyValueStorage, dominoId: string): Promise<string | null> {
  return storage.get(KEYS.token(dominoId))
}

export async function setToken(
  storage: KeyValueStorage,
  dominoId: string,
  token: string
): Promise<void> {
  await storage.set(KEYS.token(dominoId), token)
}

/**
 * Session variables — the non-secret fields of the sign-in response (plan,
 * role, …) that [script] conditions read (`when plan == "pro" -> …`). They
 * live and die with the token: saved on sign-in, cleared on sign-out or an
 * expired session, and restored with the token on reopen.
 */
export async function loadSessionVars(
  storage: KeyValueStorage,
  dominoId: string
): Promise<Record<string, unknown>> {
  try {
    const raw = await storage.get(KEYS.sessionVars(dominoId))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {} // unreadable: the conditions simply see no variables
  }
}

export async function saveSessionVars(
  storage: KeyValueStorage,
  dominoId: string,
  vars: Record<string, unknown>
): Promise<void> {
  if (Object.keys(vars).length === 0) {
    await storage.remove(KEYS.sessionVars(dominoId))
    return
  }
  await storage.set(KEYS.sessionVars(dominoId), JSON.stringify(vars))
}

export async function clearSessionVars(storage: KeyValueStorage, dominoId: string): Promise<void> {
  await storage.remove(KEYS.sessionVars(dominoId))
}

/**
 * Per-domino LLM override: one domino may run on a different provider or
 * model than the global default (a test app on a local Ollama, a heavy app
 * on a bigger model…). Stored alongside — never inside — the .domino file,
 * so a shared file never carries a key.
 */
export async function loadDominoLlmConfig(
  storage: KeyValueStorage,
  dominoId: string
): Promise<LLMConfig | null> {
  let raw: string | null
  try {
    raw = await storage.get(KEYS.dominoLlm(dominoId))
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const p = parsed as Record<string, unknown>
    if (typeof p.provider !== 'string' || !Object.hasOwn(PROVIDER_META, p.provider)) {
      return null
    }
    return {
      provider: p.provider as ProviderId,
      model: typeof p.model === 'string' ? p.model : defaultLlmConfig().model,
      ...(typeof p.apiKey === 'string' ? { apiKey: p.apiKey } : {}),
      ...(typeof p.baseUrl === 'string' ? { baseUrl: p.baseUrl } : {}),
      ...optionalLlmFields(p)
    }
  } catch {
    return null
  }
}

/** true when the domino runs on its own override. */
export async function hasDominoLlmConfig(
  storage: KeyValueStorage,
  dominoId: string
): Promise<boolean> {
  return (await loadDominoLlmConfig(storage, dominoId)) !== null
}

export async function saveDominoLlmConfig(
  storage: KeyValueStorage,
  dominoId: string,
  config: LLMConfig
): Promise<void> {
  await storage.set(KEYS.dominoLlm(dominoId), JSON.stringify(config))
}

export async function clearDominoLlmConfig(
  storage: KeyValueStorage,
  dominoId: string
): Promise<void> {
  await storage.remove(KEYS.dominoLlm(dominoId))
}

/**
 * Session token-budget warning threshold: once cumulative usage crosses it
 * the runtime shows a dismissible banner (0 disables the guard). BYOK means
 * real money — the default keeps runaway sessions visible.
 */
export const DEFAULT_TOKEN_WARN = 200_000

export async function loadTokenWarn(storage: KeyValueStorage): Promise<number> {
  let raw: string | null
  try {
    raw = await storage.get(KEYS.tokenWarn)
  } catch {
    return DEFAULT_TOKEN_WARN
  }
  if (raw === null) return DEFAULT_TOKEN_WARN
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : DEFAULT_TOKEN_WARN
}

export async function saveTokenWarn(storage: KeyValueStorage, value: number): Promise<void> {
  await storage.set(KEYS.tokenWarn, String(Math.max(0, Math.round(value))))
}

/** Extract a token from a login response body using the domino token_key. */
export function extractToken(data: unknown, tokenKey: string): string | null {
  if (!data || typeof data !== 'object') return null
  const obj = data as Record<string, unknown>
  for (const key of [tokenKey, 'access_token', 'token', 'jwt', 'id_token']) {
    const v = obj[key]
    if (typeof v === 'string' && v.length > 1) return v
  }
  const nested = obj.data ?? obj.result
  if (nested && typeof nested === 'object') return extractToken(nested, tokenKey)
  return null
}
