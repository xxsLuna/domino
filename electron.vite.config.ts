import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
    define: { __APP_VERSION__: JSON.stringify(appVersion), __GIT_HASH__: JSON.stringify(gitHash()) },
    // electron-vite leaves the renderer unminified; HeroUI + React Aria make
    // that ~2 MB of JS to parse on every launch.
    build: { minify: 'esbuild', cssMinify: true }
  }
})
