import { defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

/**
 * Plain web build (browser + Capacitor/Android webview).
 * Same renderer code as the Electron shell; platform differences are
 * isolated behind window.dominoBridge checks in src/renderer/src/platform.ts.
 */

// Stable per-conversation id some providers (opencode zen) require for routing.
const SESSION_ID = '1f0e3a24-6c9d-4b7e-9a21-7d4f5e8b0c32'

/** Forward same-origin /zen/* calls to the provider, bypassing browser CORS. */
const zenProxy: ProxyOptions = {
  target: 'https://opencode.ai',
  changeOrigin: true,
  configure(proxy) {
    proxy.on('proxyReq', (proxyReq) => {
      if (!proxyReq.getHeader('x-opencode-session')) {
        proxyReq.setHeader('x-opencode-session', SESSION_ID)
      }
      proxyReq.setHeader('user-agent', 'domino-runtime/0.1')
    })
  }
}

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  server: {
    proxy: { '/zen': zenProxy }
  },
  preview: {
    proxy: { '/zen': zenProxy }
  },
  build: {
    outDir: resolve(__dirname, 'dist-web'),
    emptyOutDir: true
  }
})
