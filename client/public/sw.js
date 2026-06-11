/*
 * Fact Fluency service worker — app-shell offline support (roadmap: offline play).
 * Strategy: cache-first for same-origin static assets (the hashed Vite bundle,
 * icon, manifest), network-first with a cached-shell fallback for navigations,
 * and pass-through for /api (never serve stale data; the app's own sync queue
 * handles offline answer reports). Assets are cached lazily on first fetch, so
 * the SW needs no build-time knowledge of hashed filenames.
 *
 * Each successful navigation refreshes the cached '/' shell, so the offline
 * fallback tracks the latest deployed app instead of being pinned to the
 * first-install version. Bump CACHE when this file changes to evict the prior
 * cache (the activate handler deletes any other-named cache). Fully automatic
 * per-deploy eviction would need a build-time hash stamped into CACHE — a
 * deferred follow-up; content-hashed asset names mean stale assets are inert,
 * only unbounded growth remains.
 */
const CACHE = 'ff-shell-v2';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // answer/complete POSTs hit the network
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // fonts etc. — let the browser handle
  if (url.pathname.startsWith('/api/')) return; // never cache API responses

  // SPA navigations: network-first, refreshing the cached '/' shell on success
  // so the offline fallback stays current; fall back to it when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }

  // Static assets: serve from cache, else fetch and populate.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        }),
    ),
  );
});
