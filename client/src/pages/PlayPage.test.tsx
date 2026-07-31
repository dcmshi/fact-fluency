import { StrictMode } from 'react';
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import i18n from '../i18n';
import { session } from '../test/fixtures';
import { renderWithProviders } from '../test/harness';
import { PlayPage } from './PlayPage';

const play = () =>
  renderWithProviders(<PlayPage />, { route: '/play/p1', path: '/play/:profileId' });

beforeEach(() => {
  // The fixture deck's first card is not new, so play goes straight to a munch
  // round — no study-card timer for these tests to wait on.
  vi.spyOn(api, 'startSession').mockResolvedValue(session());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => {
    await i18n.changeLanguage('en');
  });
});

describe('starting a session', () => {
  it('mints exactly one server session on mount', async () => {
    play();
    await waitFor(() => expect(api.startSession).toHaveBeenCalledTimes(1));
    expect(api.startSession).toHaveBeenCalledWith('p1');
  });

  /**
   * StrictMode deliberately runs every effect setup → cleanup → setup in dev. The
   * start effect was keyed on the identity of its own callback, so that second
   * setup POSTed a second /sessions — two real session rows per dev page load,
   * and the first one abandoned mid-play.
   */
  it('mints one session even under StrictMode double-mounting', async () => {
    renderWithProviders(
      <StrictMode>
        <PlayPage />
      </StrictMode>,
      { route: '/play/p1', path: '/play/:profileId' },
    );
    await waitFor(() => expect(api.startSession).toHaveBeenCalled());
    // Give a second setup a chance to fire before asserting the count.
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.startSession).toHaveBeenCalledTimes(1);
  });

  /**
   * `start` closes over `t` through goNext, so with the effect keyed on its
   * identity a language change abandoned the running session and started a fresh
   * one — the language switcher silently coupled to session state.
   */
  it('does not restart the session when the language changes', async () => {
    play();
    await waitFor(() => expect(api.startSession).toHaveBeenCalledTimes(1));

    await act(async () => {
      await i18n.changeLanguage('fr');
    });

    expect(api.startSession).toHaveBeenCalledTimes(1);
  });

  it('shows a skeleton, not bare text, while the session loads', () => {
    // Never resolves: the page stays in its loading state.
    vi.spyOn(api, 'startSession').mockReturnValue(new Promise(() => {}));
    play();
    expect(document.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
  });

  it('surfaces the no-facts error state', async () => {
    vi.spyOn(api, 'startSession').mockRejectedValue(new ApiError(400, 'no_enabled_sets'));
    play();
    expect(await screen.findByRole('heading', { name: /no facts picked yet/i })).toBeTruthy();
  });
});
