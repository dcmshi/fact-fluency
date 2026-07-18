/**
 * Number Feast — pure belt geometry + hit-detection for the circular arena
 * (FEAST.md). The server owns game truth in a linear [0,1] "belt" coordinate
 * (plate `pos`, muncher `rimPos`, tongue `aim`); this module is the ONLY place
 * that coordinate is turned into a screen circle. Distances are linear — the
 * belt has a top "kitchen gap", so 0 and 1 are not adjacent. Framework-free and
 * unit-tested (feastArena.test.ts).
 */

/** Fraction of the circle left empty at the top (the sushi "kitchen"). */
export const GAP = 0.12;
/** How far along the belt the tongue can reach from the muncher. */
export const REACH = 0.16;
/** Steer into a rival within this belt distance to bump them. */
export const BUMP_RANGE = 0.06;
/** Muncher steering speed (belt units per ms). */
export const MOVE_SPEED = 0.0016;

export const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Belt pos (0→1) → circle fraction (0→1 clockwise from top), skipping the gap. */
export const plateFrac = (pos: number): number => GAP / 2 + pos * (1 - GAP);

/** Inverse of plateFrac, clamped to the belt [0,1]. */
export const invPlateFrac = (frac: number): number => clamp01((frac - GAP / 2) / (1 - GAP));

/** Point on a circle; `frac` is 0→1 measured clockwise from 12 o'clock. */
export const pointOnCircle = (
  cx: number,
  cy: number,
  r: number,
  frac: number,
): { x: number; y: number } => {
  const a = frac * 2 * Math.PI - Math.PI / 2;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
};

/** Fraction (0→1 clockwise from top) of the point (px,py) around (cx,cy). */
export const fracFromPoint = (cx: number, cy: number, px: number, py: number): number => {
  const a = Math.atan2(py - cy, px - cx) + Math.PI / 2;
  const frac = a / (2 * Math.PI);
  return frac - Math.floor(frac); // normalize into [0,1)
};

/** Ease `current` toward `target` along the belt, capped by MOVE_SPEED*dtMs. */
export const stepRimPos = (current: number, target: number, dtMs: number): number => {
  const step = MOVE_SPEED * dtMs;
  const d = target - current;
  if (Math.abs(d) <= step) return clamp01(target);
  return clamp01(current + Math.sign(d) * step);
};

/** The in-reach plate nearest the aim, or null. Correctness-agnostic — the
 *  server decides right/wrong when the grab arrives. */
export const pickTarget = (
  plates: { id: number; pos: number }[],
  rimPos: number,
  aim: number,
): number | null => {
  let bestId: number | null = null;
  let bestD = Infinity;
  for (const p of plates) {
    if (Math.abs(p.pos - rimPos) > REACH) continue;
    const d = Math.abs(p.pos - aim);
    if (d < bestD) {
      bestD = d;
      bestId = p.id;
    }
  }
  return bestId;
};

/** Whether two munchers are close enough on the belt to bump. */
export const inBumpRange = (a: number, b: number): boolean => Math.abs(a - b) <= BUMP_RANGE;
