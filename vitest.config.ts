import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// Plain vitest (no Nuxt runtime). Code under server/lib/** and shared/** must therefore not rely on
// Nuxt/Nitro auto-imports — import everything explicitly.
export default defineConfig({
  resolve: {
    alias: {
      '#shared': r('./shared'),
      '~~': r('.'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
  },
})
