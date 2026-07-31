import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { feastSnapshot } from '../test/fixtures';
import type { FeastSnapshot } from '@shared';
import { stubWebSocket, type FakeSocket } from '../test/fakeSocket';
import { renderWithProviders, stubAnimationFrame, type FrameControl } from '../test/harness';
import { FeastPage } from './FeastPage';

let socket: () => FakeSocket;
let frames: FrameControl;

// The wire frame carries a `type` the FeastSnapshot interface doesn't declare —
// the server tags every push so the client can switch on it.
const snapshotFrame = (overrides: Partial<FeastSnapshot> = {}) => ({
  type: 'snapshot',
  ...feastSnapshot(overrides),
});

/** Render the arena and push it a snapshot, which puts it in the playing phase. */
function playing() {
  const result = renderWithProviders(<FeastPage />, {
    route: '/feast/p1',
    path: '/feast/:profileId',
  });
  act(() => socket().receive(snapshotFrame()));
  return result;
}

const ring = () => screen.getByRole('application');
const fireButton = () => screen.getByRole('button', { name: /fire/i });

beforeEach(() => {
  socket = stubWebSocket().latest;
  frames = stubAnimationFrame();
  vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the arena belt', () => {
  it('is an application region a screen reader can land on', () => {
    playing();
    // A focusable div with its own key bindings and no role announces nothing at
    // all (WCAG 4.1.2).
    expect(ring().getAttribute('tabindex')).toBe('0');
    expect(ring().getAttribute('aria-label')).toBeTruthy();
  });

  it('swallows the arrow keys so steering does not scroll the page', () => {
    playing();
    for (const key of ['ArrowLeft', 'ArrowRight']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      act(() => {
        ring().dispatchEvent(event);
      });
      expect(event.defaultPrevented, `${key} was not prevented`).toBe(true);
    }
  });

  it('keeps the live fact region mounted across a fact rotation', () => {
    playing();
    const region = document.querySelector('[aria-live]');
    expect(region?.textContent).toContain('6');

    act(() => socket().receive(snapshotFrame({ factA: 8, factB: 9 })));

    // The region itself must not be replaced: a remounted live region usually
    // announces nothing, which defeats the point of it being live, so the pop
    // animation is keyed on an inner span instead. Asserted before the content,
    // because a remount leaves `region` pointing at the detached old node and
    // "textContent is stale" is a confusing way to be told about it.
    expect(document.querySelector('[aria-live]')).toBe(region);
    expect(region?.textContent).toContain('8');
  });
});

describe('firing the tongue', () => {
  /**
   * The steering loop used to depend on the `firing` state, which changes twice
   * per shot, so every tap tore down and restarted the whole rAF chain — muncher
   * easing, throttled move broadcast and bump scan — mid-play.
   */
  it('does not restart the steering loop', () => {
    playing();
    act(() => frames.flush());
    const before = frames.cancels();

    act(() => {
      fireEvent.click(fireButton());
    });
    act(() => frames.flush());

    expect(frames.cancels()).toBe(before);
  });

  it('still tells the server the tongue is out', () => {
    playing();
    act(() => {
      fireEvent.click(fireButton());
    });
    // The move broadcast is throttled off the frame clock, so drive a frame.
    act(() => frames.flush());
    const moves = socket().sentOfType('move');
    expect(moves.at(-1)?.firing).toBe(true);
  });

  /** A quit within the 180ms retract window used to leave a live timer behind. */
  it('clears the retract timer on unmount', () => {
    const { unmount } = playing();
    act(() => {
      fireEvent.click(fireButton());
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
