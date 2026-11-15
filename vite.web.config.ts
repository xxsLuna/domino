import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { isLoopbackHost, isPrivateHost } from './src/core/net/external'

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
 * bodies capped. "Loopback-hosted" is judged from the Host header only when
 * it NUMERICALLY names the loopback, and every request must carry a
 * loopback/LAN Host (hostAllowed) — otherwise a DNS-rebinding domain pointed
 * at this server, or a tunnel past vite's host-allowlist, would pick the
 * permissive mode and reach this machine's services. Production web hosting
 * must deploy its own relay with the same strict rules.
 */
const RELAY_MAX_BYTES = 8 * 1024 * 1024
const RELAY_MAX_HOPS = 5
const RELAY_MAX_REQUEST_BYTES = 1024 * 1024

/** Same fence the core applies to `[api] external` targets (shared module). */
function isPrivateRelayHost(hostname: string): boolean {
  return isPrivateHost(hostname) || isLoopbackHost(hostname)
}

/**
 * The Host header a /relay or /zen request may carry. These endpoints exist
 * for this machine and, when the dev server is shared, the LAN — they are
 * never the production relay (that lives in the deployed backend). An exact
 * allowlist closes the hole where vite's own host-allowlist is bypassed by
 * these middlewares (they run before it): a page on a rebinding domain that
 * points at this server, or a stray tunnel, must not reach them.
 */
function hostHeaderName(hostHeader: string | string[] | undefined): string {
  const raw = (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader) ?? ''
  // `[::1]:5173` → `::1`; `example:5173` → `example`; bare IPv6 keeps working.
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(raw)
  if (bracketed) return bracketed[1].toLowerCase()
  const colon = raw.lastIndexOf(':')
  if (colon > -1 && /^\d*$/.test(raw.slice(colon + 1))) return raw.slice(0, colon).toLowerCase()
  return raw.toLowerCase()
}

function hostAllowed(hostHeader: string | string[] | undefined): boolean {
  const h = hostHeaderName(hostHeader)
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  return isLoopbackHost(h) || isPrivateHost(h)
}

/**
 * True when the relay's own request host is this machine (dev/preview).
 * Only the NUMERIC loopback forms count: `127.rebinding.example` is a
 * hostname, not 127.0.0.1 — treating it as local would hand a rebinding page
 * the permissive mode and every loopback service on this machine.
 */
function relayIsLocal(hostHeader: string | string[] | undefined): boolean {
  const h = hostHeaderName(hostHeader)
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === 'ip6-localhost') {
    return true
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
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

/**
 * Headers that describe the hop, not the payload — never forwarded.
 * `cookie` is dropped on purpose: the browser attaches THIS server's cookies
 * to every /relay request, and forwarding them would hand them to whatever
 * upstream URL the app asked for. `origin`/`referer` describe the local dev
 * page, not the app's request. `authorization` stays: unlike cookies it is
 * never ambient — only the app's own code puts it there, aimed at a target
 * the user configured (BYOK keys ride it to the LLM provider).
 */
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
  'cookie',
  'origin',
  'referer',
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
    if (!hostAllowed(req.headers.host)) {
      return deny(req, res, 'host not allowed (the dev relay serves localhost/LAN only)')
    }
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
    } catch {
      if (controller.signal.aborted) return
      // Static text: undici's error strings quote DNS names, ports and
      // internal hosts — noise to the app, a map of the LAN to anything
      // that can read a response.
      res.statusCode = 502
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end('relay: upstream request failed')
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
    // The proxy adds a real API key downstream — same host fence as /relay,
    // or a rebinding/tunnel Host would collect it.
    if (!hostAllowed(req.headers.host)) return deny('host not allowed')
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

/**
 * Content-Security-Policy for the built web/Capacitor page (dev keeps its
 * inline react preamble, so this applies at build time only).
 *
 * script-src 'self' is the point: app screens are DATA rendered through a
 * component whitelist, so no domino or feed payload ever earns the right to
 * execute. An injected <script>, inline handler or javascript: URL dies
 * here even if some render path ever lets markup slip through. style-src
 * needs 'unsafe-inline' because React/CSS-variable styling writes style
 * attributes; images/media allow remote because feed thumbnails are remote
 * by design. frame-ancestors 'none': a domino app is never a clickjacking
 * surface. The Electron shell has its own pipeline; its CSP is set with the
 * window headers, not here.
 */
function cspPlugin(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    'img-src \'self\' https: data: blob:',
    'media-src \'self\' https: blob:',
    "font-src 'self' data:",
    "connect-src 'self' https: http://127.0.0.1:* http://localhost:*",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ')
  return {
    name: 'domino-csp',
    apply: 'build',
    transformIndexHtml: (html) => ({
      html,
      tags: [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: csp },
          injectTo: 'head-prepend' as const
        }
      ]
    })
  }
}

export default defineConfig(({ mode }) => {
  const { DOMINO_ZEN_API_KEY } = loadEnv(mode, __dirname, 'DOMINO_')
  const proxy = { '/zen': zenProxy(DOMINO_ZEN_API_KEY) }
  return {
    root: resolve(__dirname, 'src/renderer'),
    base: './',
    plugins: [react(), tailwindcss(), zenCsrfGate(), relayPlugin(), cspPlugin()],
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
