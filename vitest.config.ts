import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@git-helper/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@git-helper/server': fileURLToPath(new URL('./packages/server/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    setupFiles: ['./test-setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
