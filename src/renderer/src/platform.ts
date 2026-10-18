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
}

declare global {
  interface Window {
    dominoBridge?: DominoBridge
  }
}

export function isElectron(): boolean {
  return Boolean(window.dominoBridge)
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
  } else {
    cached = localStorageAdapter()
  }
  return cached
}
