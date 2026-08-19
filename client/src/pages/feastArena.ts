/**
 * Number Feast — pure arena geometry, Stadium-style movement, and
 * hit-detection. Keeping this independent of React makes the game feel
 * testable rather than burying tuning constants inside rendering code.
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** Fraction of the circle left open as the kitchen gap. */
export const GAP = 0.12;
/** Rendering radii in the arena's 100×100 coordinate system. */
export const ARENA_RENDER_RADIUS = 30;
export const PLATE_RENDER_RADIUS = 38;
/** Plate radius expressed in normalized arena coordinates. */
export const PLATE_ORBIT_RADIUS = PLATE_RENDER_RADIUS / ARENA_RENDER_RADIUS;
/** Maximum center-to-plate distance from which a tongue can connect. */
export const TONGUE_REACH = 0.58;
/** The decomp checks food within 30 world units of the animated tongue tip. */
export const PLATE_HIT_RADIUS = 30 / 130;
/** About the original two 20-unit character collision radii in a radius-130 arena. */
export const BUMP_RANGE = 40 / 130;

// Sushi-Go-Round movement reference (pret/pokestadium fragment14): the N64
// stick ignores its first 10 units, caps at 74, and maps the remaining 64 to
// 0→1. Its desired planar speed is 10 world units/update inside a radius-130
// arena; acceleration blends 0.8 toward a faster target while braking/reversal
// blends 0.2. Normalize those world units by the arena radius for the browser.
export const STICK_DEAD_ZONE = 10;
export const STICK_LIMIT = 74;
export const STADIUM_ACCEL_BLEND = 0.8;
export const STADIUM_BRAKE_BLEND = 0.2;
const STADIUM_SPEED_PER_UPDATE = 10;
const STADIUM_ARENA_RADIUS = 130;
const REFERENCE_HZ = 60;
const REFERENCE_FRAME_MS = 1000 / REFERENCE_HZ;
/** Hands-on browser tuning: the larger screen arena otherwise traverses much
 * faster in pixels than the original radius-130 playfield feels. */
export const MOVEMENT_SPEED_SCALE = 0.62;
/** Maximum velocity in normalized arena units/ms. */
export const MAX_ARENA_SPEED =
  ((STADIUM_SPEED_PER_UPDATE * REFERENCE_HZ) / (STADIUM_ARENA_RADIUS * 1000)) *
  MOVEMENT_SPEED_SCALE;
/** Pointer distance that represents a fully tilted analogue stick. */
export const POINTER_FULL_SPEED_DISTANCE = 0.55;
/** Cap a resumed/backgrounded frame so it cannot teleport the muncher. */
const MAX_PHYSICS_STEP_MS = 50;

export const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Map belt position to circle fraction, leaving the gap centred at the top. */
export const plateFrac = (pos: number): number => GAP / 2 + clamp01(pos) * (1 - GAP);

/** Inverse of plateFrac: circle fraction → belt position, clamped. */
export const invPlateFrac = (frac: number): number => clamp01((frac - GAP / 2) / (1 - GAP));

/** Cartesian point on a circle. frac=0 is top, increasing clockwise. */
export const pointOnCircle = (cx: number, cy: number, r: number, frac: number): Vec2 => {
  const a = frac * Math.PI * 2 - Math.PI / 2;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
};

/** Point on the playable belt arc. */
export const pointOnBelt = (cx: number, cy: number, r: number, pos: number): Vec2 =>
  pointOnCircle(cx, cy, r, plateFrac(pos));

/** Convert a normalized arena vector to a render-space point. */
export const pointInArena = (cx: number, cy: number, r: number, point: Vec2): Vec2 => ({
  x: cx + point.x * r,
  y: cy + point.y * r,
});

/** A belt plate's position in the normalized 2-D movement space. */
export const plateArenaPoint = (pos: number): Vec2 => pointOnBelt(0, 0, PLATE_ORBIT_RADIUS, pos);

/** Fraction (0→1 clockwise from top) of the point (px,py) around (cx,cy). */
export const fracFromPoint = (cx: number, cy: number, px: number, py: number): number => {
  const a = Math.atan2(py - cy, px - cx) + Math.PI / 2;
  const frac = a / (Math.PI * 2);
  return frac - Math.floor(frac);
};

export const vectorLength = (v: Vec2): number => Math.hypot(v.x, v.y);

export const normalizeVector = (v: Vec2, fallback: Vec2 = { x: 0, y: -1 }): Vec2 => {
  const length = vectorLength(v);
  return length > 0 ? { x: v.x / length, y: v.y / length } : fallback;
};

/** Keep a position inside the circular arena. */
export const clampToArena = (point: Vec2): Vec2 => {
  const length = vectorLength(point);
  return length > 1 ? { x: point.x / length, y: point.y / length } : point;
};

/** Normalize one N64 stick axis using Sushi-Go-Round's 10/74/64 curve. */
export const normalizeStadiumStick = (raw: number): number => {
  const sign = Math.sign(raw);
  const magnitude = Math.min(STICK_LIMIT, Math.abs(raw));
  if (magnitude <= STICK_DEAD_ZONE) return 0;
  return (sign * (magnitude - STICK_DEAD_ZONE)) / (STICK_LIMIT - STICK_DEAD_ZONE);
};

/** Treat the vector from the muncher to the pointer like analogue-stick tilt. */
export const pointerSteerInput = (current: Vec2, target: Vec2): Vec2 => {
  const scale = STICK_LIMIT / POINTER_FULL_SPEED_DISTANCE;
  const input = {
    x: normalizeStadiumStick((target.x - current.x) * scale),
    y: normalizeStadiumStick((target.y - current.y) * scale),
  };
  const length = vectorLength(input);
  return length > 1 ? { x: input.x / length, y: input.y / length } : input;
};

export interface ArenaMotion {
  pos: Vec2;
  /** Normalized arena units per millisecond. */
  velocity: Vec2;
}

export interface CollisionBody {
  id: string;
  pos: Vec2;
  velocity: Vec2;
}

export interface CollisionMotion extends ArenaMotion {
  collidedIds: string[];
}

/** One frame of the decomp's planar movement. Acceleration is deliberately
 * quick while releasing/reversing carries momentum. The exponential conversion
 * preserves the per-update blends at variable browser frame rates. */
export const stepArenaMotion = (
  pos: Vec2,
  velocity: Vec2,
  input: Vec2,
  dtMs: number,
): ArenaMotion => {
  const dt = Math.min(MAX_PHYSICS_STEP_MS, Math.max(0, dtMs));
  const inputLength = vectorLength(input);
  const clampedInput =
    inputLength > 1 ? { x: input.x / inputLength, y: input.y / inputLength } : input;
  const desired = {
    x: clampedInput.x * MAX_ARENA_SPEED,
    y: clampedInput.y * MAX_ARENA_SPEED,
  };
  const delta = { x: desired.x - velocity.x, y: desired.y - velocity.y };
  const dot = velocity.x * delta.x + velocity.y * delta.y;
  const baseBlend = dot >= 0 ? STADIUM_ACCEL_BLEND : STADIUM_BRAKE_BLEND;
  const blend = dt === 0 ? 0 : 1 - Math.pow(1 - baseBlend, dt / REFERENCE_FRAME_MS);
  let nextVelocity = {
    x: velocity.x + delta.x * blend,
    y: velocity.y + delta.y * blend,
  };
  if (vectorLength(nextVelocity) < MAX_ARENA_SPEED * 0.001) {
    nextVelocity = { x: 0, y: 0 };
  }

  const unconstrained = {
    x: pos.x + nextVelocity.x * dt,
    y: pos.y + nextVelocity.y * dt,
  };
  const nextPos = clampToArena(unconstrained);
  if (nextPos !== unconstrained) nextVelocity = { x: 0, y: 0 };
  return { pos: nextPos, velocity: nextVelocity };
};

/** Apply Sushi-Go-Round's player-player response after ordinary movement.
 * Within two 20-unit body radii, the decomp replaces self velocity with an
 * impulse opposite each other player's speed and pushes out the full overlap. */
export const resolvePlayerCollisions = (
  pos: Vec2,
  velocity: Vec2,
  others: readonly CollisionBody[],
  dtMs: number,
): CollisionMotion => {
  const dt = Math.min(MAX_PHYSICS_STEP_MS, Math.max(0, dtMs));
  const impulse = { x: 0, y: 0 };
  const separation = { x: 0, y: 0 };
  const collidedIds: string[] = [];

  for (const other of others) {
    const offset = { x: other.pos.x - pos.x, y: other.pos.y - pos.y };
    const distance = vectorLength(offset);
    if (distance >= BUMP_RANGE) continue;
    collidedIds.push(other.id);

    // The original treats extremely coincident centres as having no stable
    // direction. Use its 0.01-world-unit cutoff in normalized coordinates.
    const inverse = distance < 0.01 / STADIUM_ARENA_RADIUS ? 0 : 1 / distance;
    const direction = { x: offset.x * inverse, y: offset.y * inverse };
    const otherSpeed = vectorLength(other.velocity);
    impulse.x -= direction.x * otherSpeed;
    impulse.y -= direction.y * otherSpeed;

    const overlap = BUMP_RANGE - distance;
    separation.x -= direction.x * overlap;
    separation.y -= direction.y * overlap;
  }

  if (collidedIds.length === 0) return { pos, velocity, collidedIds };
  const nextPos = clampToArena({
    x: pos.x + impulse.x * dt + separation.x,
    y: pos.y + impulse.y * dt + separation.y,
  });
  return { pos: nextPos, velocity: impulse, collidedIds };
};

/** The plate intersected by the tongue segment, or null. This uses the plate's
 * visible radius rather than a centre-line angle, so a visible overlap counts
 * even while CSS is interpolating the belt between server snapshots. */
export const pickTarget = (
  plates: ReadonlyArray<{ id: number; pos: number }>,
  player: Vec2,
  aim: Vec2,
): number | null => {
  const direction = normalizeVector(aim);
  let bestId: number | null = null;
  let bestMiss = Infinity;
  let bestAlong = Infinity;
  for (const plate of plates) {
    const target = plateArenaPoint(plate.pos);
    const offset = { x: target.x - player.x, y: target.y - player.y };
    const along = offset.x * direction.x + offset.y * direction.y;
    if (along < 0 || along > TONGUE_REACH + PLATE_HIT_RADIUS) continue;
    const closestAlong = Math.min(TONGUE_REACH, along);
    const miss = Math.hypot(
      offset.x - direction.x * closestAlong,
      offset.y - direction.y * closestAlong,
    );
    if (miss > PLATE_HIT_RADIUS) continue;
    if (miss < bestMiss - 1e-6 || (Math.abs(miss - bestMiss) <= 1e-6 && along < bestAlong)) {
      bestMiss = miss;
      bestAlong = along;
      bestId = plate.id;
    }
  }
  return bestId;
};

/** End the visible tongue at the plate orbit when reachable, otherwise at its
 * maximum reach. This keeps it inside the arena instead of overshooting plates. */
export const tongueEnd = (player: Vec2, aim: Vec2): Vec2 => {
  const direction = normalizeVector(aim);
  const along = player.x * direction.x + player.y * direction.y;
  const discriminant =
    along * along + PLATE_ORBIT_RADIUS * PLATE_ORBIT_RADIUS - vectorLength(player) ** 2;
  const orbitDistance = -along + Math.sqrt(Math.max(0, discriminant));
  const distance = Math.min(TONGUE_REACH, orbitDistance);
  return {
    x: player.x + direction.x * distance,
    y: player.y + direction.y * distance,
  };
};

/** Whether two player centres overlap enough to bump. */
export const inBumpRange = (a: Vec2, b: Vec2): boolean =>
  Math.hypot(a.x - b.x, a.y - b.y) <= BUMP_RANGE;
