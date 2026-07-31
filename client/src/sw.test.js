import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The service worker can't be imported — it is a script that registers handlers
 * on a ServiceWorkerGlobalScope. So load the source and run it against a fake
 * scope, which is enough to drive its fetch handler over the paths that matter:
 * an offline navigation with and without a cached shell.
 *
 * Worth the harness because this file decides what a kid sees when the network
 * is gone, and it is the one client file with no other coverage at all.
 */
const resolve = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const source = readFileSync(resolve('./sw.js'), 'utf8');

/** A cache that starts empty; `put` is recorded but never read back. */
function fakeCaches(entries = {}) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    open: vi.fn(async () => ({
      addAll: vi.fn(async () => {}),
      put: vi.fn(async (key, res) => {
        store.set(typeof key === 'string' ? key : key.url, res);
      }),
    })),
    keys: vi.fn(async () => [...store.keys()]),
    delete: vi.fn(async () => true),
    match: vi.fn(async (key) => store.get(typeof key === 'string' ? key : key.url)),
  };
}

/** Run sw.js against a fake global scope and return its registered handlers. */
function loadWorker(caches) {
  const handlers = {};
  const self = {
    location: { origin: 'https://app.test' },
    addEventListener: (type, fn) => {
      handlers[type] = fn;
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  new Function('self', 'caches', 'Response', 'URL', source)(self, caches, Response, URL);
  return handlers;
}

/** Drive the fetch handler and return whatever it responded with. */
async function fetchEvent(handlers, request) {
  let responded;
  handlers.fetch({ request, respondWith: (r) => (responded = r) });
  return responded === undefined ? undefined : await responded;
}

const navigation = (url = 'https://app.test/play/p1') => ({
  url,
  method: 'GET',
  mode: 'navigate',
});

let caches;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

describe('offline navigation', () => {
  it('serves the cached shell when the network is gone', async () => {
    caches = fakeCaches({ '/': new Response('<!doctype html>shell') });
    const handlers = loadWorker(caches);
    fetch.mockRejectedValue(new TypeError('Failed to fetch'));

    const res = await fetchEvent(handlers, navigation());
    expect(await res.text()).toBe('<!doctype html>shell');
  });

  it('falls back to a network error when the shell was never cached', async () => {
    // caches.match resolves to undefined here, and respondWith(undefined)
    // rejects — the kid got an opaque service-worker failure rather than the
    // browser's own offline page.
    caches = fakeCaches();
    const handlers = loadWorker(caches);
    fetch.mockRejectedValue(new TypeError('Failed to fetch'));

    const res = await fetchEvent(handlers, navigation());
    expect(res).toBeInstanceOf(Response);
    expect(res.type).toBe('error');
  });

  it('refreshes the cached shell on a successful navigation', async () => {
    caches = fakeCaches();
    const handlers = loadWorker(caches);
    fetch.mockResolvedValue(new Response('fresh shell', { status: 200 }));

    await fetchEvent(handlers, navigation());
    expect(caches.open).toHaveBeenCalled();
  });
});

describe('pass-through', () => {
  it('never handles /api requests', async () => {
    caches = fakeCaches();
    const handlers = loadWorker(caches);
    const res = await fetchEvent(handlers, {
      url: 'https://app.test/api/session',
      method: 'GET',
      mode: 'cors',
    });
    expect(res).toBeUndefined();
  });

  it('never handles a cross-origin request', async () => {
    caches = fakeCaches();
    const handlers = loadWorker(caches);
    const res = await fetchEvent(handlers, {
      url: 'https://fonts.example/x.woff2',
      method: 'GET',
      mode: 'cors',
    });
    expect(res).toBeUndefined();
  });

  it('never handles a POST', async () => {
    caches = fakeCaches();
    const handlers = loadWorker(caches);
    const res = await fetchEvent(handlers, {
      url: 'https://app.test/api/answer',
      method: 'POST',
      mode: 'cors',
    });
    expect(res).toBeUndefined();
  });
});
