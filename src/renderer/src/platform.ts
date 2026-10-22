import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { bridgedFetch, setHttpFetch, type NetTransport } from '@core/net'
import type { KeyValueStorage } from '@core/session/prefs'

/**
 * Platform bridge: the renderer talks to Electron through window.dominoBridge
 * when present; on web/Android (Capacitor) everything falls back to
 * localStorage. Core code only ever sees the KeyValueStorage interface.
 */

interface SecureStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
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
  if (transport) setHttpFetch(bridgedFetch(transport))
}

function localStorageAdapter(): KeyValueStorage {
  return {
    async get(key) {
      return window.localStorage.getItem(key)
    },
    async set(key, value) {
      window.localStorage.setItem(key, value)
    },
    async remove(key) {
      window.localStorage.removeItem(key)
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
function secureAdapter(): KeyValueStorage {
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
  return {
    async get(key) {
      await ensureMigrated()
      const value = await SecureStorage.getItem(key)
      return value !== null ? value : legacy.get(key)
    },
    async set(key, value) {
      await ensureMigrated()
      await SecureStorage.setItem(key, value)
    },
    async remove(key) {
      await ensureMigrated()
      await SecureStorage.removeItem(key)
      await legacy.remove(key)
    }
  }
}

let cached: KeyValueStorage | null = null

export function getStorage(): KeyValueStorage {
  if (cached) return cached
  const bridge = window.dominoBridge
  if (bridge?.secure) {
    cached = {
      get: (key) => bridge.secure!.get(key),
      set: (key, value) => bridge.secure!.set(key, value),
      remove: (key) => bridge.secure!.remove(key)
    }
  } else if (isNativeMobile()) {
    cached = secureAdapter()
  } else {
    cached = localStorageAdapter()
  }
  return cached
}
