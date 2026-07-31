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
    // Unmounts every render and clears global stubs between tests — see the
    // file for why @testing-library's own auto-cleanup doesn't apply here.
    setupFiles: ['./src/test/setup.ts'],
  },
});
