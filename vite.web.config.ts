import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Plain web build (browser + Capacitor/Android webview).
 * Same renderer code as the Electron shell; platform differences are
 * isolated behind window.dominoBridge checks in src/renderer/src/platform.ts.
 */

const appVersion: string = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf-8')
).version

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

export default defineConfig(({ mode }) => {
  const { DOMINO_ZEN_API_KEY } = loadEnv(mode, __dirname, 'DOMINO_')
  const proxy = { '/zen': zenProxy(DOMINO_ZEN_API_KEY) }
  return {
    root: resolve(__dirname, 'src/renderer'),
    base: './',
    plugins: [react(), tailwindcss()],
    define: { __APP_VERSION__: JSON.stringify(appVersion) },
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
