import { describe, expect, it } from 'vitest';
import {
  ARENA_RENDER_RADIUS,
  BUMP_RANGE,
  clamp01,
  fracFromPoint,
  GAP,
  inBumpRange,
  invPlateFrac,
  MAX_ARENA_SPEED,
  normalizeStadiumStick,
  pickTarget,
  plateArenaPoint,
  plateFrac,
  PLATE_HIT_RADIUS,
  pointInArena,
  pointOnBelt,
  pointOnCircle,
  POINTER_FULL_SPEED_DISTANCE,
  pointerSteerInput,
  resolvePlayerCollisions,
  stepArenaMotion,
  tongueEnd,
  TONGUE_REACH,
} from './feastArena';

describe('clamp01', () => {
  it('clamps to [0,1]', () => {
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(1.2)).toBe(1);
  });
});

describe('plateFrac / invPlateFrac', () => {
  it('maps the belt into the circle leaving a gap at top', () => {
    expect(plateFrac(0)).toBeCloseTo(GAP / 2);
    expect(plateFrac(1)).toBeCloseTo(1 - GAP / 2);
    expect(plateFrac(0.5)).toBeCloseTo(0.5);
  });
  it('round-trips belt positions', () => {
    for (const pos of [0, 0.1, 0.5, 0.9, 1]) {
      expect(invPlateFrac(plateFrac(pos))).toBeCloseTo(pos, 8);
    }
  });
});

describe('arena geometry', () => {
  it('uses clockwise fractions from the top', () => {
    expect(pointOnCircle(0, 0, 10, 0)).toEqual({ x: expect.closeTo(0), y: -10 });
    expect(pointOnCircle(0, 0, 10, 0.25)).toEqual({ x: 10, y: expect.closeTo(0) });
  });
  it('round-trips circle points', () => {
    const p = pointOnCircle(5, 5, 8, 0.6);
    expect(fracFromPoint(5, 5, p.x, p.y)).toBeCloseTo(0.6, 6);
  });
  it('maps belt plates and free-moving players in the same coordinate system', () => {
    expect(pointOnBelt(0, 0, 10, 0)).toEqual(pointOnCircle(0, 0, 10, plateFrac(0)));
    expect(pointInArena(50, 50, ARENA_RENDER_RADIUS, { x: 0.5, y: -0.5 })).toEqual({
      x: 65,
      y: 35,
    });
  });
});

describe('Sushi-Go-Round steering', () => {
  it('uses the decomp stick dead zone, cap, and 64-unit normalized range', () => {
    expect(normalizeStadiumStick(9)).toBe(0);
    expect(normalizeStadiumStick(10)).toBe(0);
    expect(normalizeStadiumStick(42)).toBeCloseTo(0.5, 6);
    expect(normalizeStadiumStick(74)).toBe(1);
    expect(normalizeStadiumStick(-100)).toBe(-1);
  });

  it('maps pointer distance to two-axis analogue tilt', () => {
    expect(pointerSteerInput({ x: 0, y: 0 }, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(pointerSteerInput({ x: 0, y: 0 }, { x: POINTER_FULL_SPEED_DISTANCE, y: 0 })).toEqual({
      x: 1,
      y: 0,
    });
    const diagonal = pointerSteerInput({ x: 0, y: 0 }, { x: 1, y: 1 });
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1, 6);
  });

  it('picks up speed quickly but carries momentum while braking or reversing', () => {
    const frame = 1000 / 60;
    const first = stepArenaMotion({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }, frame);
    expect(first.velocity.x).toBeCloseTo(MAX_ARENA_SPEED * 0.8, 8);
    const released = stepArenaMotion(first.pos, first.velocity, { x: 0, y: 0 }, frame);
    expect(released.velocity.x).toBeCloseTo(first.velocity.x * 0.8, 8);
    const reversed = stepArenaMotion(
      { x: 0, y: 0 },
      { x: MAX_ARENA_SPEED, y: 0 },
      { x: -1, y: 0 },
      frame,
    );
    expect(reversed.velocity.x).toBeCloseTo(MAX_ARENA_SPEED * 0.6, 8);
  });

  it('constrains players to the circular arena and kills boundary velocity', () => {
    const result = stepArenaMotion(
      { x: 0.999, y: 0 },
      { x: MAX_ARENA_SPEED, y: 0 },
      { x: 1, y: 0 },
      50,
    );
    expect(result.pos).toEqual({ x: 1, y: 0 });
    expect(result.velocity).toEqual({ x: 0, y: 0 });
  });
});

describe('tongue targeting', () => {
  it('selects an aligned plate that is within reach', () => {
    const plate = plateArenaPoint(0.5);
    const player = { x: plate.x, y: plate.y - 0.4 };
    expect(pickTarget([{ id: 7, pos: 0.5 }], player, { x: 0, y: 1 })).toBe(7);
  });

  it('counts contact with the plate edge when its centre is beyond tongue reach', () => {
    const plate = plateArenaPoint(0.5);
    const distance = TONGUE_REACH + PLATE_HIT_RADIUS * 0.75;
    const player = { x: plate.x, y: plate.y - distance };
    expect(pickTarget([{ id: 7, pos: 0.5 }], player, { x: 0, y: 1 })).toBe(7);
  });

  it('does not hit when the tongue segment misses the plate radius', () => {
    const plate = plateArenaPoint(0.5);
    const player = { x: plate.x, y: plate.y - 0.5 };
    expect(pickTarget([{ id: 7, pos: 0.5 }], player, { x: 0.6, y: 1 })).toBeNull();
  });

  it('does not eat an aligned plate from the middle of the arena', () => {
    expect(pickTarget([{ id: 7, pos: 0.5 }], { x: 0, y: 0 }, { x: 0, y: 1 })).toBeNull();
  });

  it('does not eat a nearby decoy when aiming elsewhere', () => {
    const decoy = plateArenaPoint(0.5);
    const player = { x: decoy.x, y: decoy.y - 0.35 };
    const farTarget = plateArenaPoint(0.9);
    const aim = { x: farTarget.x - player.x, y: farTarget.y - player.y };
    expect(
      pickTarget(
        [
          { id: 1, pos: 0.5 },
          { id: 2, pos: 0.9 },
        ],
        player,
        aim,
      ),
    ).toBeNull();
  });

  it('draws no farther than its reach', () => {
    const player = { x: 0, y: 0 };
    const end = tongueEnd(player, { x: 1, y: 0 });
    expect(Math.hypot(end.x, end.y)).toBeCloseTo(TONGUE_REACH, 6);
  });
});

describe('inBumpRange', () => {
  it('uses player-centre distance in two dimensions', () => {
    expect(inBumpRange({ x: 0, y: 0 }, { x: BUMP_RANGE, y: 0 })).toBe(true);
    expect(inBumpRange({ x: 0, y: 0 }, { x: BUMP_RANGE + 0.01, y: 0 })).toBe(false);
  });

  it('applies the decomp overlap separation and incoming-speed impulse', () => {
    const frame = 1000 / 60;
    const result = resolvePlayerCollisions(
      { x: 0, y: 0 },
      { x: MAX_ARENA_SPEED, y: 0 },
      [{ id: 'cpu', pos: { x: 0.2, y: 0 }, velocity: { x: -0.002, y: 0 } }],
      frame,
    );
    const overlap = BUMP_RANGE - 0.2;
    expect(result.collidedIds).toEqual(['cpu']);
    expect(result.velocity).toEqual({ x: -0.002, y: 0 });
    expect(result.pos.x).toBeCloseTo(-overlap - 0.002 * frame, 8);
    expect(result.pos.y).toBe(0);
  });

  it('stops at and separates from a stationary player', () => {
    const result = resolvePlayerCollisions(
      { x: 0, y: 0 },
      { x: MAX_ARENA_SPEED, y: 0 },
      [{ id: 'cpu', pos: { x: 0.2, y: 0 }, velocity: { x: 0, y: 0 } }],
      1000 / 60,
    );
    expect(result.velocity).toEqual({ x: 0, y: 0 });
    expect(0.2 - result.pos.x).toBeCloseTo(BUMP_RANGE, 8);
  });
});
