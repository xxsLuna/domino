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
  welcomeHint: 'domino:welcome-hint'
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
    ...(typeof p.temperature === 'number' && Number.isFinite(p.temperature)
      ? { temperature: p.temperature }
      : {})
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
