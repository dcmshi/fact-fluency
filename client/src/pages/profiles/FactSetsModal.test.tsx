import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Profile } from '@shared';
import '../../i18n';
import { FactSetsModal } from './FactSetsModal';

/**
 * Static-markup render (no @testing-library in this workspace) — enough to pin
 * the one thing that matters here: what Save looks like *before* the catalog
 * query resolves. `enabled` starts as an empty Set, so a Save that is reachable
 * while loading writes "no sets enabled" to the kid's profile and their next
 * session dies with no_enabled_sets.
 */
const profile: Profile = {
  id: 'p1',
  accountId: 'a1',
  displayName: 'Ada',
  avatar: '🦊',
  settings: { sessionCards: 20, sessionSeconds: 300, newPerSession: 2 },
  streak: 0,
  lastPlayedDay: null,
  coins: 0,
  theme: 'classic',
  createdAt: 0,
};

function renderLoading(): string {
  // No queryFn results and retry off: the render sees the pending state, which
  // is the state under test.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <FactSetsModal profile={profile} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe('FactSetsModal', () => {
  it('disables Save until the fact-set catalog has loaded', () => {
    const html = renderLoading();
    expect(html).toContain('Loading');
    const save = /<button class="btn sun full"([^>]*)>\s*Save/.exec(html);
    expect(save, 'Save button not found in markup').not.toBeNull();
    expect(save![1]).toContain('disabled');
  });
});
