import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Emit the service worker at dist/sw.js with its cache name stamped with a
 * per-build id, so every deploy gets a fresh cache and the SW's activate
 * handler evicts the previous one. The source lives in src/ (not public/) so
 * the deployed file is always the stamped build asset, never a verbatim
 * publicDir copy. replaceAll, not replace: the placeholder also appears in
 * sw.js's own header comment, and first-occurrence replace stamped the
 * comment while leaving the CACHE constant untouched.
 */
function serviceWorker(): Plugin {
  return {
    name: 'emit-stamped-sw',
    apply: 'build',
    generateBundle() {
      const src = readFileSync(fileURLToPath(new URL('./src/sw.js', import.meta.url)), 'utf8');
      if (!src.includes('__BUILD__')) {
        throw new Error('src/sw.js: __BUILD__ placeholder missing — cache would never rotate');
      }
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: src.replaceAll('__BUILD__', Date.now().toString(36)),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
