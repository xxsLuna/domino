import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
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
    plugins: [react()]
  }
})
