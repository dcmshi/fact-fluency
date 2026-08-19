import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { feastSnapshot } from '../test/fixtures';
import type { FeastSnapshot } from '@shared';
import { stubWebSocket, type FakeSocket } from '../test/fakeSocket';
import { renderWithProviders, stubAnimationFrame, type FrameControl } from '../test/harness';
import {
  ARENA_RENDER_RADIUS,
  normalizeVector,
  plateArenaPoint,
  pointInArena,
  tongueEnd,
} from './feastArena';
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
function playing(overrides: Partial<FeastSnapshot> = {}) {
  const result = renderWithProviders(<FeastPage />, {
    route: '/feast/p1',
    path: '/feast/:profileId',
  });
  act(() => socket().receive(snapshotFrame(overrides)));
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

  it('renders the player inside the circular plate belt', () => {
    playing();
    const muncher = document.querySelector<HTMLElement>('.feast-muncher.you');
    const left = Number.parseFloat(muncher?.style.left ?? 'NaN');
    const top = Number.parseFloat(muncher?.style.top ?? 'NaN');
    expect(Math.hypot(left - 50, top - 50)).toBeLessThanOrEqual(ARENA_RENDER_RADIUS);
  });

  it('captures every WASD/arrow direction even when the ring is not focused', () => {
    playing();
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'w', 'a', 's', 'd']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      act(() => {
        document.body.dispatchEvent(event);
      });
      expect(event.defaultPrevented, `${key} was not prevented`).toBe(true);
    }
  });

  it('moves continuously while a direction is held and coasts after release', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    playing();
    const muncher = document.querySelector<HTMLElement>('.feast-muncher.you');
    expect(muncher).not.toBeNull();
    const start = muncher!.style.cssText;

    fireEvent.keyDown(window, { key: 'd' });
    now += 1000 / 60;
    act(() => frames.flush());
    const moving = muncher!.style.cssText;
    expect(moving).not.toBe(start);

    fireEvent.keyUp(window, { key: 'd' });
    now += 1000 / 60;
    act(() => frames.flush());
    expect(muncher!.style.cssText).not.toBe(moving);
  });

  it('physically separates from an incoming CPU instead of applying a bump stun', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const self = { ...feastSnapshot().players[0], x: 0, y: 0 };
    const cpu = {
      ...self,
      profileId: 'cpu',
      name: 'CPU',
      isBot: true,
      x: 0.2,
      vx: -0.002,
    };
    playing({ players: [self, cpu] });

    now += 1000 / 60;
    act(() => frames.flush());

    const muncher = document.querySelector<HTMLElement>('.feast-muncher.you');
    expect(Number.parseFloat(muncher?.style.left ?? 'NaN')).toBeLessThan(50);
    expect(muncher?.classList.contains('stunned')).toBe(false);
  });

  it('consumes a server-relayed push from another player exactly once', () => {
    const self = { ...feastSnapshot().players[0], x: 0, y: 0 };
    playing({ players: [self] });
    const pushed = { ...self, pushX: 0.15, pushVx: 0.002 };

    act(() => socket().receive(snapshotFrame({ players: [pushed] })));
    const muncher = document.querySelector<HTMLElement>('.feast-muncher.you');
    const afterPush = muncher?.style.left;
    expect(Number.parseFloat(afterPush ?? 'NaN')).toBeGreaterThan(50);

    act(() => socket().receive(snapshotFrame({ players: [pushed] })));
    expect(muncher?.style.left).toBe(afterPush);
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
    expect(moves.at(-1)).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      vx: expect.any(Number),
      vy: expect.any(Number),
      impactX: expect.any(Number),
      impactY: expect.any(Number),
      impactVx: expect.any(Number),
      impactVy: expect.any(Number),
      aimX: expect.any(Number),
      aimY: expect.any(Number),
      firing: true,
    });
    expect(moves.at(-1)).not.toHaveProperty('rimPos');
  });

  it('points at the selected plate without eating a different nearby plate', () => {
    const player = { ...feastSnapshot().players[0], x: 0, y: 0.9, aimX: 0, aimY: 1 };
    playing({
      plates: [
        { id: 1, value: 11, pos: 0.5 },
        { id: 2, value: 90, pos: 0.9 },
      ],
      players: [player],
    });

    fireEvent.click(screen.getByRole('button', { name: '90' }));

    expect(socket().sentOfType('grab')).toHaveLength(0);
    const tongue = document.querySelector<SVGLineElement>('.feast-tongues line.you');
    const plate = plateArenaPoint(0.9);
    const aim = normalizeVector({ x: plate.x - player.x, y: plate.y - player.y });
    const target = pointInArena(50, 50, ARENA_RENDER_RADIUS, tongueEnd(player, aim));
    expect(Number(tongue?.getAttribute('x2'))).toBeCloseTo(target.x, 8);
    expect(Number(tongue?.getAttribute('y2'))).toBeCloseTo(target.y, 8);
  });

  it('grabs a plate when the visible tongue reaches its edge', () => {
    const plate = plateArenaPoint(0.5);
    const player = {
      ...feastSnapshot().players[0],
      x: plate.x,
      y: plate.y - 0.73,
      aimX: 0,
      aimY: 1,
    };
    playing({ plates: [{ id: 7, value: 42, pos: 0.5 }], players: [player] });

    fireEvent.click(screen.getByRole('button', { name: '42' }));

    expect(socket().sentOfType('grab')).toEqual([expect.objectContaining({ plateId: 7 })]);
  });

  /** A quit within the retract window used to leave a live timer behind. */
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
