import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

/**
 * Plain web build (browser + Capacitor/Android webview).
 * Same renderer code as the Electron shell; platform differences are
 * isolated behind window.dominoBridge checks in src/renderer/src/platform.ts.
 */
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
  build: {
    outDir: resolve(__dirname, 'dist-web'),
    emptyOutDir: true
  }
})
