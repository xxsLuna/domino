import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeTheme,
  protocol,
  net,
  safeStorage,
  shell
} from 'electron'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { NetEvent, NetRequest } from '@core/net'
import { checkForUpdate, installUpdate, RELEASES_URL } from './updater'

/** What people see: dock/taskbar, installers, the macOS app menu. */
const DISPLAY_NAME = 'Domino UI'
// The internal name stays "domino" — it names the data folder and the keychain
// entry that encrypts saved API keys, so renaming it would lose them.
app.setName('domino')

// domino:// scheme must be registered before app ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'domino',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
])

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    // Narrow enough to exercise the phone layout, never so small it breaks.
    minWidth: 360,
    minHeight: 480,
    // Matches HeroUI's --background so resizing never flashes the wrong color.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0b0d' : '#f4f4f4',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// domino:// scheme handler: inline content (domino://<name>?c=<urlencoded>)
// or remote fetch (domino://host/path.domino).
async function registerDominoProtocol(): Promise<void> {
  protocol.handle('domino', async (request) => {
    try {
      const url = new URL(request.url)
      const inline = url.searchParams.get('c')
      if (inline) {
        const text = decodeURIComponent(inline)
        return new Response(text, {
          headers: { 'content-type': 'text/plain; charset=utf-8' }
        })
      }
      const httpUrl = `https://${url.host}${url.pathname}${url.search}`
      const res = await net.fetch(httpUrl)
      return res
    } catch (err) {
      return new Response(`domino protocol error: ${(err as Error).message}`, {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' }
      })
    }
  })
}

let pendingOpenFile: string | null = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    await registerDominoProtocol()

    app.setAboutPanelOptions({
      applicationName: DISPLAY_NAME,
      applicationVersion: app.getVersion()
    })
    if (process.platform === 'darwin') {
      // The default menu labels items with the internal name; spell out the display name.
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: DISPLAY_NAME,
            submenu: [
              { role: 'about', label: `About ${DISPLAY_NAME}` },
              { type: 'separator' },
              { role: 'hide', label: `Hide ${DISPLAY_NAME}` },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit', label: `Quit ${DISPLAY_NAME}` }
            ]
          },
          { role: 'editMenu' },
          { role: 'viewMenu' },
          { role: 'windowMenu' }
        ])
      )
    }

    // Open *.domino file via double click / "open with" (macOS).
    app.on('open-file', (event, filePath) => {
      event.preventDefault()
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        win.webContents.send('domino:open-file', filePath)
      } else {
        pendingOpenFile = filePath
      }
    })

    // Windows/Linux: file path passed as process argument.
    const argFile = process.argv.slice(1).find((a) => a.endsWith('.domino'))
    if (argFile) pendingOpenFile = argFile

    createWindow()

    if (pendingOpenFile) {
      const filePath = pendingOpenFile
      pendingOpenFile = null
      const win = BrowserWindow.getAllWindows()[0]
      win?.webContents.once('did-finish-load', () => {
        win.webContents.send('domino:open-file', filePath)
      })
    }

    ipcMain.handle('domino:read-file', async (_e, filePath: string) => {
      if (!filePath.endsWith('.domino')) throw new Error('Not a .domino file')
      return readFile(filePath, 'utf-8')
    })

    ipcMain.handle('domino:read-file-url', async (_e, fileUrl: string) => {
      const res = await net.fetch(fileUrl)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.text()
    })

    /* ---------------- outbound HTTP (LLM providers, app APIs) ---------------- */
    // The renderer's fetch is bound by browser CORS, and some providers never
    // answer preflights (opencode zen) — so the renderer sends its requests
    // here (see @core/net) and the main process streams the response back.
    ipcMain.on('net:fetch', async (event, id: string, url: string, req: NetRequest) => {
      const send = (msg: NetEvent): void => {
        if (!event.sender.isDestroyed()) event.sender.send('net:event', id, msg)
      }
      try {
        if (!/^https?:\/\//i.test(url)) throw new Error(`unsupported URL: ${url}`)
        const res = await net.fetch(url, {
          method: req.method,
          headers: req.headers,
          body: req.body
        })
        send({
          type: 'head',
          status: res.status,
          statusText: res.statusText,
          headers: [...res.headers]
        })
        if (res.body) {
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            const text = decoder.decode(value, { stream: true })
            if (text) send({ type: 'chunk', text })
          }
          const tail = decoder.decode()
          if (tail) send({ type: 'chunk', text: tail })
        }
        send({ type: 'end' })
      } catch (err) {
        send({ type: 'error', message: (err as Error).message })
      }
    })

    /* ---------------------------- self-update ---------------------------- */
    // The renderer only triggers; the release URL and asset stay in this process.
    ipcMain.handle('update:check', () => checkForUpdate())
    ipcMain.on('update:install', (event) => {
      const send = (channel: string, payload: unknown): void => {
        if (!event.sender.isDestroyed()) event.sender.send(channel, payload)
      }
      installUpdate((p) => send('update:progress', p)).catch((err: Error) =>
        send('update:error', err.message)
      )
    })
    ipcMain.on('update:open-releases', () => void shell.openExternal(RELEASES_URL))

    /* ---------------- secure KV store (BYOK keys, tokens) ---------------- */
    const securePath = (): string => join(app.getPath('userData'), 'secure-store.json')

    async function readSecureStore(): Promise<Record<string, string>> {
      try {
        return JSON.parse(await readFile(securePath(), 'utf-8')) as Record<string, string>
      } catch {
        return {}
      }
    }

    async function writeSecureStore(data: Record<string, string>): Promise<void> {
      await writeFile(securePath(), JSON.stringify(data, null, 2), 'utf-8')
    }

    ipcMain.handle('secure:get', async (_e, key: string) => {
      const all = await readSecureStore()
      const stored = all[key]
      if (stored === undefined) return null
      if (stored.startsWith('plain:')) return stored.slice(6)
      if (!safeStorage.isEncryptionAvailable()) return stored
      try {
        return safeStorage.decryptString(Buffer.from(stored, 'base64'))
      } catch {
        return null
      }
    })

    ipcMain.handle('secure:set', async (_e, key: string, value: string) => {
      const all = await readSecureStore()
      if (safeStorage.isEncryptionAvailable()) {
        all[key] = safeStorage.encryptString(value).toString('base64')
      } else {
        all[key] = `plain:${value}`
      }
      await writeSecureStore(all)
    })

    ipcMain.handle('secure:remove', async (_e, key: string) => {
      const all = await readSecureStore()
      delete all[key]
      await writeSecureStore(all)
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

export { pathToFileURL }
