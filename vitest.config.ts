import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@mnemonima/core': pkg('core'),
      '@mnemonima/store': pkg('store'),
      '@mnemonima/engine': pkg('engine'),
      '@mnemonima/daemon': pkg('daemon'),
      '@mnemonima/mcp': pkg('mcp'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
  },
})
