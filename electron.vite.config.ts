import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

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
    // electron-vite leaves the renderer unminified; HeroUI + React Aria make
    // that ~2 MB of JS to parse on every launch.
    build: { minify: 'esbuild', cssMinify: true }
  }
})
