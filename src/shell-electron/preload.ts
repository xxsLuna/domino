import { contextBridge, ipcRenderer } from 'electron'

export interface SecureStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

export interface DominoBridge {
  readFile(filePath: string): Promise<string>
  readFileUrl(fileUrl: string): Promise<string>
  onOpenFile(cb: (filePath: string) => void): void
  secure: SecureStore
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
    remove: (key) => ipcRenderer.invoke('secure:remove', key)
  }
}

contextBridge.exposeInMainWorld('dominoBridge', bridge)
