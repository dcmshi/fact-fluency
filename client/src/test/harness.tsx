import type { ReactElement, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import '../i18n';

export interface RenderOptions {
  /** Route to render at, e.g. '/play/p1'. Defaults to '/'. */
  route?: string;
  /** Route pattern, e.g. '/play/:profileId', so the page's useParams resolves. */
  path?: string;
}

/**
 * Render a page or component with the providers the app gives it.
 *
 * Two details matter for the tests that use this. Retries are off, so a rejected
 * query surfaces as `isError` on the first tick instead of after three backoffs —
 * an error-state test would otherwise just time out. And the QueryClient is built
 * per render: react-query caches by key, so a client shared between tests would
 * let one test's fetched data satisfy the next one's "still loading" assertion.
 */
export function renderWithProviders(ui: ReactElement, options: RenderOptions = {}): RenderResult {
  const { route = '/', path } = options;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // Passed as RTL's `wrapper` rather than composed into the element, so that
  // `rerender` re-applies it. Composing by hand means rerender replaces the
  // whole tree, unmounting the providers and remounting the component under
  // test — which silently turns any "does it survive a re-render" assertion
  // into a test of a fresh mount, i.e. into nothing.
  const Providers = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        {path ? (
          <Routes>
            <Route path={path} element={children} />
          </Routes>
        ) : (
          children
        )}
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(ui, { wrapper: Providers });
}

/** A hand-driven requestAnimationFrame, plus counters for what was scheduled. */
export interface FrameControl {
  /** Run every callback queued right now, once. */
  flush: () => void;
  /** How many times cancelAnimationFrame has been called. */
  cancels: () => number;
}

/**
 * Replace requestAnimationFrame with one the test drives by hand.
 *
 * jsdom's rAF fires on a ~16ms timer: fake timers freeze it and real timers make
 * it slow and order-dependent. Several of the behaviours under test hang off rAF
 * — the print sheet renders a frame before opening the dialog, the feast steering
 * loop is a rAF chain — and the cancel count is how a test can tell whether that
 * loop was torn down and restarted. Globals are unstubbed in test/setup.ts.
 */
export function stubAnimationFrame(): FrameControl {
  const pending = new Map<number, FrameRequestCallback>();
  let nextHandle = 0;
  let cancels = 0;

  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    pending.set(++nextHandle, cb);
    return nextHandle;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    cancels += 1;
    pending.delete(handle);
  });

  return {
    flush: () => {
      const due = [...pending];
      pending.clear();
      for (const [, cb] of due) cb(performance.now());
    },
    cancels: () => cancels,
  };
}
