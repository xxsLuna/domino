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
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { NetEvent, NetRequest } from '@core/net'
import { checkForUpdate, installUpdate, RELEASES_URL, setBeforeExit } from './updater'
import { KvStore } from './kvStore'

/** What people see: dock/taskbar, installers, the macOS app menu. */
const DISPLAY_NAME = 'Domino UI'
// The internal name stays "domino" — it names the data folder and the keychain
// entry that encrypts saved API keys, so renaming it would lose them.
app.setName('domino')

/* --------------------------- app-origin boundary --------------------------- */
// The preload bridge (local files, BYOK keys, HTTP, self-update) is granted to
// this window's pages. These helpers define "our own page" for the navigation
// guard and the IPC sender checks — nothing else may reach the bridge.
const DEV_ORIGIN_URL = process.env['ELECTRON_RENDERER_URL'] ?? null
// Trailing slash so `.../renderer-evil/` can't match the prefix. Compared
// case-insensitively: Chromium canonicalizes the drive letter of file URLs
// differently from Node's pathToFileURL.
const RENDERER_DIR_PREFIX = DEV_ORIGIN_URL
  ? null
  : `${pathToFileURL(join(__dirname, '../renderer')).href.replace(/\/$/, '')}/`.toLowerCase()

function isAppUrl(url: string): boolean {
  if (DEV_ORIGIN_URL) {
    try {
      return new URL(url).origin === new URL(DEV_ORIGIN_URL).origin
    } catch {
      return false
    }
  }
  if (!RENDERER_DIR_PREFIX) return false
  try {
    const target = new URL(url)
    return target.protocol === 'file:' && target.href.toLowerCase().startsWith(RENDERER_DIR_PREFIX)
  } catch {
    return false
  }
}

/** Only pages served from the app's own origin may invoke privileged IPC. */
function trustedSender(sender: Electron.WebContents): boolean {
  try {
    return isAppUrl(sender.getURL())
  } catch {
    return false
  }
}

/** Only these schemes may be handed to the OS (blocks file:, smb:, custom handlers). */
const EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:', 'tel:'])

/** Hosts reachable over cleartext http — the local mock/demo server only. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Parse a renderer-supplied fetch URL; https everywhere, http only on loopback. */
function parseRemoteUrl(raw: unknown): URL {
  if (typeof raw !== 'string') throw new Error('invalid URL')
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error(`invalid URL: ${raw}`)
  }
  if (u.protocol === 'https:') return u
  if (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)) return u
  throw new Error('only https URLs are allowed (http is limited to localhost)')
}

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

  // Closing the window tears the renderer down after its first IPC: its
  // pagehide flush (one awaited write after another) would be cut off. Hold
  // the close once, let the renderer write and acknowledge, flush the store,
  // then close for real.
  let closeFlushed = false
  win.on('close', (event) => {
    // A quit already flushed every renderer (before-quit runs first); holding
    // the close then would cancel the quit.
    if (closeFlushed || quitStarted) return
    event.preventDefault()
    closeFlushed = true
    void flushEverything([win]).finally(() => {
      if (!win.isDestroyed()) win.close()
    })
  })

  // A top-frame navigation away from the app origin would hand the privileged
  // bridge to whatever loads next (window.open is covered below, but plain
  // links, window.location and server redirects are not).
  const guardNavigation = (event: { preventDefault(): void }, url: string): void => {
    if (!isAppUrl(url)) event.preventDefault()
  }
  win.webContents.on('will-navigate', guardNavigation)
  win.webContents.on('will-redirect', guardNavigation)

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (EXTERNAL_PROTOCOLS.has(new URL(url).protocol)) void shell.openExternal(url)
    } catch {
      /* malformed url — drop it */
    }
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
/** The app's key/value store (created once the app is ready). */
let kvStore: KvStore | null = null
/** Quit has begun: a late renderer write goes straight to disk, not on a timer. */
let quitStarted = false

/** How long a renderer gets to write its debounced state before quit goes on. */
const RENDERER_FLUSH_TIMEOUT_MS = 1_500

/**
 * Ask one window's renderer to write everything it still holds (views,
 * history, page blobs, snapshots) and wait for its acknowledgement — at most
 * RENDERER_FLUSH_TIMEOUT_MS, so a hung renderer can never block quitting.
 */
function flushRenderer(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return Promise.resolve()
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      ipcMain.removeListener('storage:flush-done', onDone)
      resolve()
    }
    const onDone = (e: Electron.IpcMainEvent, ackId: unknown): void => {
      if (ackId === id && e.sender === win.webContents) finish()
    }
    const timer = setTimeout(finish, RENDERER_FLUSH_TIMEOUT_MS)
    ipcMain.on('storage:flush-done', onDone)
    try {
      win.webContents.send('storage:flush-request', id)
    } catch {
      finish()
    }
  })
}

/** Every open renderer writes its state, then the store writes to disk. */
async function flushEverything(windows: BrowserWindow[]): Promise<void> {
  await Promise.all(windows.map((w) => flushRenderer(w)))
  await kvStore?.flush().catch(() => undefined)
}

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

    /** Invoke-style handlers: reject anything that isn't our own page. */
    const requireTrusted = (sender: Electron.WebContents): void => {
      if (!trustedSender(sender)) throw new Error('untrusted IPC sender')
    }

    ipcMain.handle('domino:read-file', async (e, filePath: unknown) => {
      requireTrusted(e.sender)
      if (typeof filePath !== 'string' || !/\.domino$/i.test(filePath)) {
        throw new Error('Not a .domino file')
      }
      return readFile(filePath, 'utf-8')
    })

    ipcMain.handle('domino:read-file-url', async (e, fileUrl: unknown) => {
      requireTrusted(e.sender)
      const url = parseRemoteUrl(fileUrl)
      const res = await net.fetch(url.href, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      return text.length > 8_000_000 ? `${text.slice(0, 8_000_000)}\n…[truncated]` : text
    })

    /* ---------------- outbound HTTP (LLM providers, app APIs) ---------------- */
    // The renderer's fetch is bound by browser CORS, and some providers never
    // answer preflights (opencode zen) — so the renderer sends its requests
    // here (see @core/net) and the main process streams the response back.
    const HEAD_TIMEOUT_MS = 30_000
    const MAX_RESPONSE_BYTES = 64 * 1024 * 1024
    const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
    /** In-flight fetches by request id, so the renderer can cancel them. */
    const pendingFetches = new Map<string, AbortController>()

    ipcMain.on('net:cancel', (_event, id: unknown) => {
      if (typeof id === 'string') pendingFetches.get(id)?.abort()
    })

    ipcMain.on('net:fetch', async (event, id: string, url: string, req: NetRequest) => {
      const send = (msg: NetEvent): void => {
        if (!event.sender.isDestroyed()) event.sender.send('net:event', id, msg)
      }
      if (!trustedSender(event.sender)) {
        send({ type: 'error', message: 'untrusted IPC sender' })
        return
      }
      const controller = new AbortController()
      if (typeof id === 'string') pendingFetches.set(id, controller)
      try {
        const target = parseRemoteUrl(url)
        const method = String(req?.method ?? 'GET').toUpperCase()
        if (!ALLOWED_METHODS.has(method)) throw new Error(`unsupported method: ${method}`)
        // Headers must be plain [name, value] pairs of strings.
        const headers: Array<[string, string]> = Array.isArray(req?.headers)
          ? req.headers.filter(
              (h): h is [string, string] =>
                Array.isArray(h) && h.length === 2 && h.every((v) => typeof v === 'string')
            )
          : []
        // Wait for response headers only — a streaming body may legitimately
        // run for minutes, but a server that never answers must not hang.
        let timer: ReturnType<typeof setTimeout> | undefined
        const headDeadline = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('timed out waiting for response')),
            HEAD_TIMEOUT_MS
          )
          timer.unref?.()
        })
        let res: Response
        try {
          res = await Promise.race([
            net.fetch(target.href, {
              method,
              headers,
              body: req?.body,
              signal: controller.signal
            }),
            headDeadline
          ])
        } finally {
          if (timer) clearTimeout(timer)
        }
        send({
          type: 'head',
          status: res.status,
          statusText: res.statusText,
          headers: [...res.headers]
        })
        if (res.body) {
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let received = 0
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            received += value.byteLength
            if (received > MAX_RESPONSE_BYTES) {
              await reader.cancel().catch(() => {})
              throw new Error('response exceeded the size limit')
            }
            const text = decoder.decode(value, { stream: true })
            if (text) send({ type: 'chunk', text })
          }
          const tail = decoder.decode()
          if (tail) send({ type: 'chunk', text: tail })
        }
        send({ type: 'end' })
      } catch (err) {
        send({ type: 'error', message: (err as Error).message })
      } finally {
        if (typeof id === 'string') pendingFetches.delete(id)
      }
    })

    /* ---------------------------- self-update ---------------------------- */
    // The renderer only triggers; the release URL and asset stay in this process.
    ipcMain.handle('update:check', (e) => {
      requireTrusted(e.sender)
      return checkForUpdate()
    })
    ipcMain.on('update:install', (event) => {
      if (!trustedSender(event.sender)) return
      const send = (channel: string, payload: unknown): void => {
        if (!event.sender.isDestroyed()) event.sender.send(channel, payload)
      }
      installUpdate((p) => send('update:progress', p)).catch((err: Error) =>
        send('update:error', err.message)
      )
    })
    ipcMain.on('update:open-releases', (event) => {
      if (trustedSender(event.sender)) void shell.openExternal(RELEASES_URL)
    })

    /* ------------- key/value store (BYOK keys, tokens, app data) ------------- */
    // Secrets stay encrypted in secure-store.json; bulk per-domino data lives
    // in one small file per key (see kvStore.ts). Everything is served from
    // memory, writes are debounced and flushed before quit.
    const kv = new KvStore({
      dir: app.getPath('userData'),
      cipher: {
        available: () => safeStorage.isEncryptionAvailable(),
        encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
        decrypt: (stored) => safeStorage.decryptString(Buffer.from(stored, 'base64'))
      },
      // A failed write reaches every window: the renderer surfaces it.
      onError: (key, err) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.webContents.isDestroyed()) win.webContents.send('secure:error', key, err.message)
        }
      },
      log: (message) => console.warn(`[kv] ${message}`)
    })
    kvStore = kv
    // An update that exits the process directly (app.exit) flushes first.
    setBeforeExit(() => kv.flush())

    ipcMain.handle('secure:get', (e, key: unknown) => {
      requireTrusted(e.sender)
      return typeof key === 'string' ? kv.get(key) : null
    })

    ipcMain.handle('secure:getMany', (e, keys: unknown) => {
      requireTrusted(e.sender)
      if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string')) {
        throw new Error('invalid secure store keys')
      }
      return kv.getMany(keys as string[])
    })

    ipcMain.handle('secure:set', (e, key: unknown, value: unknown) => {
      requireTrusted(e.sender)
      if (typeof key !== 'string' || typeof value !== 'string') {
        throw new Error('invalid secure store arguments')
      }
      // Once quitting, the debounce timer (unref'd) would not outlive the
      // process: write through.
      if (quitStarted) return kv.set(key, value).then(() => kv.flush())
      return kv.set(key, value)
    })

    ipcMain.handle('secure:remove', (e, key: unknown) => {
      requireTrusted(e.sender)
      if (typeof key !== 'string') throw new Error('invalid secure store key')
      if (quitStarted) return kv.remove(key).then(() => kv.flush())
      return kv.remove(key)
    })

    // Every [key, value] — the storage-management settings use it to compute
    // per-domino sizes.
    ipcMain.handle('secure:entries', (e) => {
      requireTrusted(e.sender)
      return kv.entries()
    })

    // The renderer flushes its own debounced writes on pagehide; this makes
    // sure they reach disk before the process goes.
    ipcMain.handle('secure:flush', (e) => {
      requireTrusted(e.sender)
      return kv.flush()
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // Debounced storage writes must land before the process exits. before-quit
  // fires BEFORE the windows close (Cmd+Q, menu Quit, an updater's
  // app.quit): every renderer first writes its own debounced state and
  // acknowledges, then the store goes to disk, then quit resumes.
  let quitFlushed = false
  app.on('before-quit', (event) => {
    quitStarted = true
    if (quitFlushed) return
    event.preventDefault()
    quitFlushed = true
    void flushEverything(BrowserWindow.getAllWindows()).finally(() => app.quit())
  })

  // Anything written after that flush (a late renderer set) still lands.
  let willQuitFlushing = false
  app.on('will-quit', (event) => {
    const kv = kvStore
    if (willQuitFlushing || !kv?.dirty) return
    event.preventDefault()
    willQuitFlushing = true
    void kv
      .flush()
      .catch(() => undefined)
      .finally(() => app.quit())
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

export { pathToFileURL }
