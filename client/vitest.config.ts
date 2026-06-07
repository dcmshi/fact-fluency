import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

// Client unit tests run in jsdom (for localStorage / DOM APIs). The @shared
// alias mirrors vite.config.ts so type-only imports resolve the same way.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
  },
});
