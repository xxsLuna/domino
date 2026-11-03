import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { bridgedFetch, setHttpFetch, type NetTransport } from '@core/net'
import type { KeyValueStorage } from '@core/session/prefs'
import { isQuotaError, type BulkKeyValueStorage } from '@core/session/kv'
import { withQuotaRelief, type StorageErrorEvent } from '@core/session/storageAudit'

/**
 * Platform bridge: the renderer talks to Electron through window.dominoBridge
 * when present; on web/Android (Capacitor) everything falls back to
 * localStorage. Core code only ever sees the KeyValueStorage interface.
 */

interface SecureStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
  entries?(): Promise<Array<[string, string]>>
  getMany?(keys: string[]): Promise<Array<string | null>>
  flush?(): Promise<void>
  onError?(cb: (key: string, message: string) => void): () => void
  onFlushRequest?(cb: () => Promise<void>): () => void
}

interface DominoBridge {
  readFile(filePath: string): Promise<string>
  readFileUrl(fileUrl: string): Promise<string>
  onOpenFile(cb: (filePath: string) => void): void
  secure?: SecureStore
  netFetch?: NetTransport
  pathForFile?(file: File): string
  update?: UpdateBridge
}

export interface UpdateInfo {
  current: string
  version: string
  notes: string
  url: string
  assetName: string
  size: number
}

export type UpdateProgress =
  { phase: 'download'; received: number; total: number } | { phase: 'install' }

interface UpdateBridge {
  check(): Promise<UpdateInfo | null>
  install(onProgress: (p: UpdateProgress) => void, onError: (message: string) => void): void
  openReleases(): void
}

declare global {
  interface Window {
    dominoBridge?: DominoBridge
  }
}

export function isElectron(): boolean {
  return Boolean(window.dominoBridge)
}

/** Android/iOS shell (Capacitor), as opposed to a browser or Electron. */
export function isNativeMobile(): boolean {
  return Capacitor.isNativePlatform()
}

/** Status/navigation bar icons readable on the current theme (edge-to-edge). */
export function syncSystemBars(theme: 'light' | 'dark'): void {
  if (!isNativeMobile()) return
  void SystemBars.setStyle({
    style: theme === 'dark' ? SystemBarsStyle.Dark : SystemBarsStyle.Light
  }).catch(() => {
    /* older shells without SystemBars: keep the default */
  })
}

/** On desktop, outbound HTTP runs in the main process — free of browser CORS. */
export function installPlatformFetch(): void {
  const transport = window.dominoBridge?.netFetch
  if (transport) {
    setHttpFetch(bridgedFetch(transport))
    return
  }
  // Android (CapacitorHttp) also bypasses CORS natively. A plain browser page
  // has neither escape hatch, so cross-origin calls ride the dev/preview
  // relay proxy (see vite.web.config.ts) — same marker header as /zen. The
  // relay only exists on the vite dev/preview server; production web hosting
  // must deploy its own endpoint at /relay with the same rules.
  if (!Capacitor.isNativePlatform()) setHttpFetch(relayFetch(globalThis.fetch.bind(globalThis)))
}

const RELAY_CLIENT_HEADER = 'x-domino-client'
const RELAY_CLIENT_VALUE = 'domino-web'

/**
 * Rewriter turning cross-origin http(s) calls into same-origin /relay?url=…
 *
 * For url + init callers (every httpFetch call site) the relayed request is
 * rebuilt from the ORIGINAL init: copying the constructed Request instead
 * carries the body as a bare ReadableStream, which Chromium refuses to
 * dispatch without duplex mode — every POST died client-side as
 * "Failed to fetch" before ever reaching the relay.
 */
function relayFetch(inner: typeof fetch): typeof fetch {
  return (input, init) => {
    let rawUrl: string
    if (input instanceof Request) rawUrl = input.url
    else if (input instanceof URL) rawUrl = input.href
    else rawUrl = input
    let resolved: URL
    try {
      resolved = new URL(rawUrl, window.location.href)
    } catch {
      return inner(input, init)
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return inner(input, init)
    if (resolved.origin === window.location.origin) return inner(input, init)

    const relayUrl = `/relay?url=${encodeURIComponent(resolved.href)}`
    if (input instanceof Request) {
      // No separate init to rebase onto — copy path. Our callers always pass
      // url + init, so this never carries a body (where the copy breaks).
      const relayed = new Request(relayUrl, input)
      relayed.headers.set(RELAY_CLIENT_HEADER, RELAY_CLIENT_VALUE)
      return inner(relayed)
    }
    const headers = new Headers(init?.headers)
    headers.set(RELAY_CLIENT_HEADER, RELAY_CLIENT_VALUE)
    return inner(relayUrl, { ...init, headers })
  }
}

function localStorageAdapter(): BulkKeyValueStorage {
  return {
    async get(key) {
      return window.localStorage.getItem(key)
    },
    async getMany(keys) {
      return keys.map((key) => window.localStorage.getItem(key))
    },
    async set(key, value) {
      window.localStorage.setItem(key, value)
    },
    async remove(key) {
      window.localStorage.removeItem(key)
    },
    async entries() {
      return Object.keys(window.localStorage).map((k) => [k, window.localStorage.getItem(k) ?? ''])
    }
  }
}

/**
 * Native shells store domino:* values encrypted (Android Keystore / iOS
 * Keychain) instead of plain WebView localStorage. First use migrates every
 * existing key across — copying, VERIFYING the copy, and only then deleting
 * the original; a failed copy keeps the legacy value readable forever via the
 * get() fallback, so the LLM key can never be lost by this upgrade.
 */
function secureAdapter(): BulkKeyValueStorage {
  const legacy = localStorageAdapter()
  let migrated: Promise<void> | null = null
  const ensureMigrated = (): Promise<void> => {
    if (!migrated) {
      migrated = (async () => {
        try {
          const keys = Object.keys(window.localStorage).filter((k) => k.startsWith('domino:'))
          for (const key of keys) {
            const value = window.localStorage.getItem(key)
            if (value === null) continue
            await SecureStorage.setItem(key, value)
            if ((await SecureStorage.getItem(key)) === value) {
              window.localStorage.removeItem(key)
            }
          }
        } catch {
          /* secure store unavailable — legacy fallback keeps serving reads */
        }
      })()
    }
    return migrated
  }
  const get = async (key: string): Promise<string | null> => {
    await ensureMigrated()
    const value = await SecureStorage.getItem(key)
    return value !== null ? value : legacy.get(key)
  }
  return {
    get,
    async getMany(keys) {
      return Promise.all(keys.map((key) => get(key).catch(() => null)))
    },
    async set(key, value) {
      await ensureMigrated()
      await SecureStorage.setItem(key, value)
    },
    async remove(key) {
      await ensureMigrated()
      await SecureStorage.removeItem(key)
      await legacy.remove(key)
    },
    async entries() {
      await ensureMigrated()
      const keys = await SecureStorage.keys()
      const out: Array<[string, string]> = []
      for (const key of keys) {
        const value = await SecureStorage.getItem(key)
        if (value !== null) out.push([key, value])
      }
      return out
    }
  }
}

/* ------------------------- storage failure reporting ------------------------ */

export type { StorageErrorEvent }

const storageListeners = new Set<(e: StorageErrorEvent) => void>()

/**
 * Get told about storage failures (quota, disk) — the runtime shows them
 * instead of persistence silently stopping. Returns an unsubscribe.
 */
export function onStorageError(listener: (e: StorageErrorEvent) => void): () => void {
  storageListeners.add(listener)
  return () => {
    storageListeners.delete(listener)
  }
}

function emitStorageError(e: StorageErrorEvent): void {
  for (const listener of storageListeners) {
    try {
      listener(e)
    } catch {
      /* one broken listener must not hide the event from the rest */
    }
  }
}

/* --------------------------------- storage -------------------------------- */

let cached: BulkKeyValueStorage | null = null

export function getStorage(): KeyValueStorage {
  if (cached) return cached
  const bridge = window.dominoBridge
  const secure = bridge?.secure
  if (secure) {
    cached = withQuotaRelief(
      {
        get: (key) => secure.get(key),
        set: (key, value) => secure.set(key, value),
        remove: (key) => secure.remove(key),
        ...(secure.entries ? { entries: () => secure.entries!() } : {}),
        ...(secure.getMany ? { getMany: (keys: string[]) => secure.getMany!(keys) } : {})
      },
      emitStorageError
    )
    // The main process writes on its own debounce: its failures arrive here.
    secure.onError?.((key, message) =>
      emitStorageError({
        key,
        error: new Error(message),
        quota: isQuotaError(new Error(message)),
        recovered: false,
        evicted: []
      })
    )
  } else if (isNativeMobile()) {
    cached = withQuotaRelief(secureAdapter(), emitStorageError)
  } else {
    cached = withQuotaRelief(localStorageAdapter(), emitStorageError)
  }
  return cached
}

/**
 * Push buffered writes toward disk. The core stores flush their own debounced
 * writes (ScreenStore.flush / SessionStore.flush); this asks the Electron
 * main process to write what it still holds in memory. No-op elsewhere.
 */
export async function flushStorage(): Promise<void> {
  try {
    await window.dominoBridge?.secure?.flush?.()
  } catch {
    /* best effort on the way out */
  }
}

/** Renderer-side writers the main process waits for before it quits (onQuitFlush). */
const quitFlushers = new Set<() => Promise<void>>()
let quitFlushWired = false

/**
 * Register an async flush the Electron main process runs — and waits for —
 * before it quits or closes the window: pagehide alone fires too late
 * (Cmd+Q, app.quit) or is cut off by window teardown after the first IPC.
 * No-op outside Electron. Returns an unsubscribe.
 */
export function onQuitFlush(cb: () => Promise<void>): () => void {
  quitFlushers.add(cb)
  const secure = window.dominoBridge?.secure
  if (!quitFlushWired && secure?.onFlushRequest) {
    quitFlushWired = true
    secure.onFlushRequest(async () => {
      await Promise.all([...quitFlushers].map((f) => f().catch(() => undefined)))
    })
  }
  return () => {
    quitFlushers.delete(cb)
  }
}

/**
 * Run `cb` whenever the app is about to be hidden or unloaded (pagehide,
 * tab/app switch, window close) — the moment debounced persistence must be
 * flushed. Returns an unsubscribe.
 */
export function onAppHidden(cb: () => void): () => void {
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') cb()
  }
  window.addEventListener('pagehide', cb)
  window.addEventListener('beforeunload', cb)
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    window.removeEventListener('pagehide', cb)
    window.removeEventListener('beforeunload', cb)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
