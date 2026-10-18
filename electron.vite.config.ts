import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const appVersion: string = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf-8')
).version

export default defineConfig({
  main: {
    build: {
      lib: {
        entry: { index: resolve(__dirname, 'src/shell-electron/main.ts') }
      }
    },
    resolve: {
      alias: {
        '@core': resolve(__dirname, 'src/core')
      }
    }
  },
  preload: {
    build: {
      lib: {
        entry: { index: resolve(__dirname, 'src/shell-electron/preload.ts') }
      }
    },
    resolve: {
      alias: {
        '@core': resolve(__dirname, 'src/core')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@core': resolve(__dirname, 'src/core'),
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()],
    define: { __APP_VERSION__: JSON.stringify(appVersion) },
    // electron-vite leaves the renderer unminified; HeroUI + React Aria make
    // that ~2 MB of JS to parse on every launch.
    build: { minify: 'esbuild', cssMinify: true }
  }
})
