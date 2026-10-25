import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { NetEvent, NetTransport } from '@core/net'
import type { UpdateInfo, UpdateProgress } from './updater'

export interface SecureStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
  /** All [key, value] pairs — powers the storage-management settings. */
  entries(): Promise<Array<[string, string]>>
}

export interface DominoBridge {
  readFile(filePath: string): Promise<string>
  readFileUrl(fileUrl: string): Promise<string>
  onOpenFile(cb: (filePath: string) => void): void
  secure: SecureStore
  /** Outbound HTTP through the main process (no browser CORS). */
  netFetch: NetTransport
  /** Filesystem path of a dropped/picked File (File.path is gone since Electron 32). */
  pathForFile(file: File): string
  update: {
    /** Newer GitHub release for this platform, or null. */
    check(): Promise<UpdateInfo | null>
    /** Download, install and relaunch; progress and errors arrive via the callbacks. */
    install(onProgress: (p: UpdateProgress) => void, onError: (message: string) => void): void
    openReleases(): void
  }
}

const bridge: DominoBridge = {
  readFile: (filePath) => ipcRenderer.invoke('domino:read-file', filePath),
  readFileUrl: (fileUrl) => ipcRenderer.invoke('domino:read-file-url', fileUrl),
  onOpenFile: (cb) => {
    ipcRenderer.on('domino:open-file', (_e, filePath: string) => cb(filePath))
  },
  secure: {
    get: (key) => ipcRenderer.invoke('secure:get', key),
    set: (key, value) => ipcRenderer.invoke('secure:set', key, value),
    remove: (key) => ipcRenderer.invoke('secure:remove', key),
    entries: () => ipcRenderer.invoke('secure:entries')
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    install: (onProgress, onError) => {
      const progress = (_e: IpcRendererEvent, p: UpdateProgress): void => onProgress(p)
      const error = (_e: IpcRendererEvent, message: string): void => {
        ipcRenderer.removeListener('update:progress', progress)
        ipcRenderer.removeListener('update:error', error)
        onError(message)
      }
      ipcRenderer.on('update:progress', progress)
      ipcRenderer.on('update:error', error)
      ipcRenderer.send('update:install')
    },
    openReleases: () => ipcRenderer.send('update:open-releases')
  },
  netFetch: (url, req, onEvent) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    const listener = (_e: IpcRendererEvent, eventId: string, msg: NetEvent): void => {
      if (eventId !== id) return
      onEvent(msg)
      if (msg.type === 'end' || msg.type === 'error')
        ipcRenderer.removeListener('net:event', listener)
    }
    ipcRenderer.on('net:event', listener)
    ipcRenderer.send('net:fetch', id, url, req)
    // Returned so bridgedFetch can stop the remote fetch when the caller aborts.
    return () => {
      ipcRenderer.removeListener('net:event', listener)
      ipcRenderer.send('net:cancel', id)
    }
  }
}

contextBridge.exposeInMainWorld('dominoBridge', bridge)
