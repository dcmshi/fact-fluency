import { defineConfig } from 'vitest/config';

// Type-only `@shared` imports are erased by esbuild, so no path alias is needed
// for the engine tests. Add one here if shared ever exports runtime values.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
