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
    plugins: [react(), tailwindcss(), zenCsrfGate()],
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
