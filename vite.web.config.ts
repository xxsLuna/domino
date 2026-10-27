import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'

/**
 * Plain web build (browser + Capacitor/Android webview).
 * Same renderer code as the Electron shell; platform differences are
 * isolated behind window.dominoBridge checks in src/renderer/src/platform.ts.
 */

const appVersion: string = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf-8')
).version

// Commit the build/dev-server runs from, so a footer line can trace the
// running app back to its code. Evaluated when this config loads.
function gitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim()
  } catch {
    return 'unknown' // built outside a git checkout (tarball, some CI)
  }
}

// Stable per-conversation id some providers (opencode zen) require for routing.
const SESSION_ID = '1f0e3a24-6c9d-4b7e-9a21-7d4f5e8b0c32'

/**
 * Forward same-origin /zen/* calls to the provider, bypassing browser CORS.
 * When DOMINO_ZEN_API_KEY is set (e.g. in a git-ignored .env.local) and the
 * browser sent no key, the dev server adds it — the key never reaches the page.
 */
function zenProxy(apiKey: string | undefined): ProxyOptions {
  return {
    target: 'https://opencode.ai',
    changeOrigin: true,
    configure(proxy) {
      proxy.on('proxyReq', (proxyReq) => {
        if (!proxyReq.getHeader('x-opencode-session')) {
          proxyReq.setHeader('x-opencode-session', SESSION_ID)
        }
        if (apiKey && !proxyReq.getHeader('authorization')) {
          proxyReq.setHeader('authorization', `Bearer ${apiKey}`)
        }
        proxyReq.setHeader('user-agent', 'domino-runtime/0.1')
      })
    }
  }
}

/**
 * CSRF gate for the key-injecting /zen proxy. Runs before the proxy middleware
 * (configureServer registrations are installed ahead of Vite's internals), so
 * a rejected request never reaches the proxyReq hook and never gets the key:
 *
 * - OPTIONS is denied outright — a cross-origin page must preflight for the
 *   custom header, so killing preflights cuts off every cors-mode attempt.
 * - An Origin header that doesn't match this server's own host is denied
 *   (plain cross-site form/fetch requests that carry no custom header).
 * - Otherwise the app's x-domino-client marker header must be present; it is
 *   not CORS-safelisted, so a browser can only send it same-origin.
 */
const CLIENT_HEADER = 'x-domino-client'
const CLIENT_VALUE = 'domino-web'

/* ------------------------- generic cross-origin relay ------------------------- */
/**
 * `/relay?url=<encoded>`: the web build's CORS escape hatch for the app's own
 * [api] calls and subscribed feeds — Electron fetches in its main process and
 * Android routes through CapacitorHttp, but a plain browser page has neither.
 *
 * The upstream request is made with Node's fetch (redirect: 'manual') rather
 * than http-proxy: a passed-through 302 would make the browser follow the
 * Location header itself — straight around the relay and back into CORS. Each
 * hop is re-validated here instead.
 *
 * SSRF guard depends on where the RELAY itself is served. A loopback-hosted
 * relay (vite dev/preview on this machine) forwards http/https to any host:
 * local dev backends (the mock on 127.0.0.1, Ollama, LAN services) predate
 * the relay and would otherwise be cut off — the page made these calls
 * directly before it existed, and the CSRF gate still applies. A relay
 * deployed on a public host keeps the strict rules: https only, no
 * loopback/private/link-local targets, five redirect hops max, response
 * bodies capped. Hostname checks can't stop DNS rebinding, which is
 * acceptable for a dev/preview relay; production web hosting must deploy its
 * own relay with the same strict rules.
 */
const RELAY_MAX_BYTES = 8 * 1024 * 1024
const RELAY_MAX_HOPS = 5
const RELAY_MAX_REQUEST_BYTES = 1024 * 1024

function isPrivateRelayHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true
  if (h === '::1' || h === '[::1]') return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }
  return false
}

/** True when the relay's own request host is this machine (dev/preview). */
function relayIsLocal(hostHeader: string | string[] | undefined): boolean {
  const raw = (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader) ?? ''
  const h = raw.replace(/:\d+$/, '').toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h.startsWith('127.')
}

function relayTarget(raw: string | null, localRelay: boolean): URL | null {
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (localRelay) return u
  if (u.protocol !== 'https:') return null
  if (isPrivateRelayHost(u.hostname)) return null
  return u
}

/** Headers that describe the hop, not the payload — never forwarded. */
const RELAY_DROP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  CLIENT_HEADER
])

function relayPlugin(): Plugin {
  const deny = async (
    req: IncomingMessage,
    res: ServerResponse,
    why: string
  ): Promise<void> => {
    // Drain a bounded slice of any request body before answering: replying to
    // a POST while its body is unread makes Chromium tear down the connection
    // and surface the failure as a network error instead of this status.
    const method = (req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      try {
        let size = 0
        for await (const chunk of req) {
          size += (chunk as Buffer).length
          if (size > RELAY_MAX_REQUEST_BYTES) break
        }
      } catch {
        /* client already gone */
      }
    }
    res.statusCode = 403
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end(`relay: ${why}`)
  }
  const middleware = async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void
  ): Promise<void> => {
    const url = req.url ?? ''
    if (!url.startsWith('/relay')) return next()
    const localRelay = relayIsLocal(req.headers.host)
    // Same CSRF gate as /zen — a rejected request never leaves this process.
    if (req.method === 'OPTIONS') return deny(req, res, 'preflight is not allowed')
    const origin = req.headers.origin
    if (origin) {
      let originHost: string
      try {
        originHost = new URL(origin).host
      } catch {
        originHost = ''
      }
      if (!originHost || originHost !== req.headers.host) return deny(req, res, 'cross-origin blocked')
    }
    if (req.headers[CLIENT_HEADER] !== CLIENT_VALUE) return deny(req, res, 'missing client header')

    const target = relayTarget(
      new URL(url, 'http://relay.invalid').searchParams.get('url'),
      localRelay
    )
    if (!target) return deny(req, res, 'target must be an http(s) URL (public https when the relay is remote)')

    const method = (req.method ?? 'GET').toUpperCase()
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string' && !RELAY_DROP_HEADERS.has(name.toLowerCase())) {
        headers.set(name, value)
      } else if (Array.isArray(value)) {
        for (const v of value) headers.append(name, v)
      }
    }
    let body: BodyInit | undefined
    if (method !== 'GET' && method !== 'HEAD') {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += (chunk as Buffer).length
        if (size > RELAY_MAX_REQUEST_BYTES) return deny(req, res, 'request body too large')
        chunks.push(chunk as Buffer)
      }
      if (chunks.length) body = Buffer.concat(chunks)
    }

    const controller = new AbortController()
    req.on('close', () => controller.abort())
    try {
      let current = target
      let response: Response | undefined
      for (let hop = 0; hop <= RELAY_MAX_HOPS; hop++) {
        response = await fetch(current, {
          method,
          headers,
          ...(body ? { body } : {}),
          redirect: 'manual',
          signal: controller.signal
        })
        if (![301, 302, 303, 307, 308].includes(response.status)) break
        const location = response.headers.get('location')
        const nextUrl = location ? relayTarget(new URL(location, current).href, localRelay) : null
        if (!nextUrl) return deny(req, res, 'redirect target not allowed')
        response.body?.cancel().catch(() => {})
        current = nextUrl
      }
      if (!response) return deny(req, res, 'no response')
      res.statusCode = response.status
      const contentType = response.headers.get('content-type')
      if (contentType) res.setHeader('content-type', contentType)
      const cacheControl = response.headers.get('cache-control')
      if (cacheControl) res.setHeader('cache-control', cacheControl)
      if (!response.body) return void res.end()
      const reader = response.body.getReader()
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > RELAY_MAX_BYTES) {
          res.destroy()
          return
        }
        if (!res.write(Buffer.from(value))) {
          await new Promise((resolve) => res.once('drain', resolve))
        }
      }
      res.end()
    } catch (err) {
      if (controller.signal.aborted) return
      res.statusCode = 502
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(`relay: ${(err as Error).message}`)
    }
  }
  return {
    name: 'domino-relay',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    }
  }
}

function zenCsrfGate(): Plugin {
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if (!req.url?.startsWith('/zen')) return next()
    const deny = (why: string): void => {
      res.statusCode = 403
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(`zen proxy: ${why}`)
    }
    if (req.method === 'OPTIONS') return deny('preflight is not allowed')
    const origin = req.headers.origin
    if (origin) {
      let originHost: string
      try {
        originHost = new URL(origin).host
      } catch {
        originHost = ''
      }
      if (!originHost || originHost !== req.headers.host) return deny('cross-origin blocked')
    }
    if (req.headers[CLIENT_HEADER] !== CLIENT_VALUE) return deny('missing client header')
    next()
  }
  return {
    name: 'zen-csrf-gate',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    }
  }
}

export default defineConfig(({ mode }) => {
  const { DOMINO_ZEN_API_KEY } = loadEnv(mode, __dirname, 'DOMINO_')
  const proxy = { '/zen': zenProxy(DOMINO_ZEN_API_KEY) }
  return {
    root: resolve(__dirname, 'src/renderer'),
    base: './',
    plugins: [react(), tailwindcss(), zenCsrfGate(), relayPlugin()],
    define: { __APP_VERSION__: JSON.stringify(appVersion), __GIT_HASH__: JSON.stringify(gitHash()) },
    resolve: {
      alias: {
        '@core': resolve(__dirname, 'src/core'),
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    server: { proxy },
    preview: { proxy },
    build: {
      outDir: resolve(__dirname, 'dist-web'),
      emptyOutDir: true
    }
  }
})
