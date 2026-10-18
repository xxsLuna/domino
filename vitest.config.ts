import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
