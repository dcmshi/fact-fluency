/**
 * Number Feast — the pure game engine for the real-time math arena (FEAST.md).
 * A belt of numbered plates scrolls past; players grab the plates matching the
 * current fact's answer for points, wrong grabs stun them, and a running timer
 * ends the round. Server-authoritative and framework-free: no IO, no globals,
 * and time + randomness are injected, so it's fully deterministic and unit
 * testable. The WS layer (feast/live.ts) owns the mutable state and the tick.
 *
 * State is mutated in place (game-loop style) rather than rebuilt each tick —
 * cheap and still deterministic given the injected `now`/`rng`.
 */
import type { Fact, FeastSnapshot, FeastStanding } from '@shared';

export type Rng = () => number;

// --- Tunables (ms unless noted) -------------------------------------------
export const ROUND_MS = 90_000;
/** Stadium advances its carousel by 0.5 degrees/update: one lap in 720 updates,
 *  or about 12 seconds at 60 Hz. */
const BELT_LAP_MS = 12_000;
/** Stadium has twelve fixed tables, 30 degrees apart. An eaten table remains
 *  vacant for 120 updates (~2 seconds) before that same slot receives a dish. */
const TABLE_COUNT = 12;
const TABLE_REFILL_MS = 2000;
/** Share of spawns that match the current answer (rest are distractors). Kept
 *  around half so there's always a scoring opportunity on the belt. */
const CORRECT_SPAWN_CHANCE = 0.5;
/** The displayed fact rotates this often. */
const FACT_ROTATE_MS = 18_000;
/** Stun after a wrong grab. Player collisions use physical separation instead. */
const WRONG_STUN_MS = 2500;
/** Bots: reaction window between grab attempts, and how often they're right.
 *  Deliberately forgiving — this is a kids' game (DESIGN.md §4). */
const BOT_MIN_REACT_MS = 700;
const BOT_MAX_REACT_MS = 1600;
const BOT_ACCURACY = 0.7;
/** Bots only consider plates in this on-belt window (mimics "reachable"). */
const BOT_WINDOW: readonly [number, number] = [0.15, 0.85];
/** Bots move inside the arena more gently than a fully tilted human stick. */
const BOT_MOVE_SPEED = 0.0024;
const BELT_GAP = 0.12;
const PLATE_ORBIT_RADIUS = 38 / 30;
const BOT_STANDOFF_RADIUS = 0.82;
/** Decomp player collision diameter: two 20-unit radii in a radius-130 arena. */
const PLAYER_COLLISION_DISTANCE = 40 / 130;
/** Suppress duplicate network reports for one physical contact. Stadium's full
 * overlap separation normally clears the pair in one update. */
const COLLISION_PUSH_COOLDOWN_MS = 180;
const REFERENCE_FRAME_MS = 1000 / 60;
const MAX_COLLISION_STEP_MS = 50;
/** Browser's normalized full-stick speed: 10 world units/update at 60 Hz in a
 * radius-130 arena, with the current 0.62 feel scale. */
const MAX_REPORTED_SPEED = ((10 * 60) / (130 * 1000)) * 0.62;

// --- State ----------------------------------------------------------------
export interface FeastPlate {
  id: number;
  value: number;
  pos: number; // current 0→1 carousel position, derived from table slot + belt offset
  correct: boolean; // value === current answer (recomputed when the fact rotates)
  slot: number; // fixed Stadium-style table index (0→11)
  spawnedAt: number; // oldest wrong plate is the last-resort math-specific recycle target
}

export interface FeastPlayer {
  profileId: string;
  name: string;
  avatar: string;
  muncher: string;
  isBot: boolean;
  score: number;
  stunnedUntil: number;
  botReactAt: number; // bots only: next allowed grab attempt
  x: number; // normalized position inside the circular arena (client-owned for humans)
  y: number;
  vx: number; // normalized arena units/ms, relayed for physical collision response
  vy: number;
  pushX: number; // cumulative server-applied displacement consumed by the owning client
  pushY: number;
  pushVx: number; // most recent incoming collision velocity
  pushVy: number;
  aimX: number; // unit direction the tongue points
  aimY: number;
  firing: boolean; // tongue currently extended (render-only)
}

export interface FeastState {
  factId: string;
  factA: number;
  factOp: Fact['operation'];
  factB: number;
  answer: number;
  plates: FeastPlate[];
  players: FeastPlayer[];
  pool: Fact[];
  endsAt: number;
  nextPlateId: number;
  beltOffset: number;
  slotReadyAt: number[];
  collisionReadyAt: Record<string, number>;
  lastRotateAt: number;
}

export interface PlayerInit {
  profileId: string;
  name: string;
  avatar: string;
  muncher: string;
  isBot: boolean;
}

const randInt = (rng: Rng, lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];

interface Vec2 {
  x: number;
  y: number;
}

const normalize = (v: Vec2, fallback: Vec2 = { x: 0, y: -1 }): Vec2 => {
  const length = Math.hypot(v.x, v.y);
  return length > 0 ? { x: v.x / length, y: v.y / length } : fallback;
};

const clampVelocity = (velocity: Vec2): Vec2 => {
  const speed = Math.hypot(velocity.x, velocity.y);
  if (speed <= MAX_REPORTED_SPEED) return velocity;
  const scale = MAX_REPORTED_SPEED / speed;
  return { x: velocity.x * scale, y: velocity.y * scale };
};

const platePoint = (pos: number, radius: number = PLATE_ORBIT_RADIUS): Vec2 => {
  const frac = BELT_GAP / 2 + Math.max(0, Math.min(1, pos)) * (1 - BELT_GAP);
  const angle = frac * Math.PI * 2 - Math.PI / 2;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
};

/** Move a bot toward a 2-D target by at most `step`. */
const easePoint = (current: Vec2, target: Vec2, step: number): Vec2 => {
  const offset = { x: target.x - current.x, y: target.y - current.y };
  const distance = Math.hypot(offset.x, offset.y);
  if (distance <= step || distance === 0) return target;
  return {
    x: current.x + (offset.x / distance) * step,
    y: current.y + (offset.y / distance) * step,
  };
};

const clampToArena = (point: Vec2): Vec2 => {
  const length = Math.hypot(point.x, point.y);
  return length > 1 ? { x: point.x / length, y: point.y / length } : point;
};

const tablePos = (slot: number, beltOffset: number): number =>
  (beltOffset + slot / TABLE_COUNT) % 1;

const collisionKey = (a: FeastPlayer, b: FeastPlayer): string =>
  a.profileId < b.profileId ? `${a.profileId}:${b.profileId}` : `${b.profileId}:${a.profileId}`;

/** Move the other body away, and accumulate the exact applied delta so a human
 * owner's predicted local position can consume it even if snapshots are lost. */
const applyExternalPush = (
  target: FeastPlayer,
  direction: Vec2,
  incomingSpeed: number,
  overlap: number,
  dtMs: number,
): void => {
  const pushVelocity = {
    x: direction.x * incomingSpeed,
    y: direction.y * incomingSpeed,
  };
  const dt = Math.min(MAX_COLLISION_STEP_MS, Math.max(0, dtMs));
  const before = { x: target.x, y: target.y };
  const next = clampToArena({
    x: target.x + pushVelocity.x * dt + direction.x * overlap,
    y: target.y + pushVelocity.y * dt + direction.y * overlap,
  });
  target.x = next.x;
  target.y = next.y;
  target.vx = pushVelocity.x;
  target.vy = pushVelocity.y;
  target.pushX += next.x - before.x;
  target.pushY += next.y - before.y;
  target.pushVx = pushVelocity.x;
  target.pushVy = pushVelocity.y;
};

const closestPointOnSegment = (start: Vec2, end: Vec2, point: Vec2): Vec2 => {
  const segment = { x: end.x - start.x, y: end.y - start.y };
  const lengthSq = segment.x * segment.x + segment.y * segment.y;
  if (lengthSq === 0) return start;
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * segment.x + (point.y - start.y) * segment.y) / lengthSq),
  );
  return { x: start.x + segment.x * t, y: start.y + segment.y * t };
};

/** Server-side half of the decomp collision response for bots. Human clients
 * resolve their own body; bots need the same overlap and incoming-speed shove
 * applied here because they have no owning client. */
const resolveBotCollisions = (state: FeastState, bot: FeastPlayer, now: number, dtMs: number) => {
  const impulse = { x: 0, y: 0 };
  const separation = { x: 0, y: 0 };
  const botIncomingSpeed = Math.hypot(bot.vx, bot.vy);
  let collided = false;
  for (const other of state.players) {
    if (other === bot) continue;
    const offset = { x: other.x - bot.x, y: other.y - bot.y };
    const distance = Math.hypot(offset.x, offset.y);
    if (distance >= PLAYER_COLLISION_DISTANCE) continue;
    collided = true;
    const inverse = distance < 0.01 / 130 ? 0 : 1 / distance;
    const direction = { x: offset.x * inverse, y: offset.y * inverse };
    const otherSpeed = Math.hypot(other.vx, other.vy);
    impulse.x -= direction.x * otherSpeed;
    impulse.y -= direction.y * otherSpeed;
    const overlap = PLAYER_COLLISION_DISTANCE - distance;
    separation.x -= direction.x * overlap;
    separation.y -= direction.y * overlap;

    const key = collisionKey(bot, other);
    if ((state.collisionReadyAt[key] ?? 0) <= now) {
      applyExternalPush(other, direction, botIncomingSpeed, overlap, dtMs);
      state.collisionReadyAt[key] = now + COLLISION_PUSH_COOLDOWN_MS;
    }
  }
  if (!collided) return;
  const next = clampToArena({
    x: bot.x + impulse.x * Math.max(0, dtMs) + separation.x,
    y: bot.y + impulse.y * Math.max(0, dtMs) + separation.y,
  });
  bot.x = next.x;
  bot.y = next.y;
  bot.vx = impulse.x;
  bot.vy = impulse.y;
};

/** Set the current fact and recompute which plates now count as correct. */
function setFact(state: FeastState, fact: Fact): void {
  state.factId = fact.id;
  state.factA = fact.operandA;
  state.factOp = fact.operation;
  state.factB = fact.operandB;
  state.answer = fact.answer;
  for (const p of state.plates) p.correct = p.value === fact.answer;
}

/** A plausible wrong value near the current answer (other pool answers or small
 *  offsets), never equal to the answer and never negative. */
function distractor(state: FeastState, rng: Rng): number {
  const { answer, pool } = state;
  const candidates = new Set<number>();
  for (const off of [1, 2, 3, 10, -1, -2, -10]) {
    const v = answer + off;
    if (v >= 0 && v !== answer) candidates.add(v);
  }
  // A few real answers from the pool make for believable near-misses.
  for (let i = 0; i < 6 && pool.length > 0; i++) {
    const v = pick(rng, pool).answer;
    if (v !== answer) candidates.add(v);
  }
  const arr = [...candidates];
  return arr.length > 0 ? pick(rng, arr) : answer + 1;
}

function addPlate(
  state: FeastState,
  slot: number,
  now: number,
  rng: Rng,
  forceCorrect: boolean,
): void {
  const correct = forceCorrect || rng() < CORRECT_SPAWN_CHANCE;
  const value = correct ? state.answer : distractor(state, rng);
  state.plates.push({
    id: state.nextPlateId++,
    value,
    pos: tablePos(slot, state.beltOffset),
    correct: value === state.answer,
    slot,
    spawnedAt: now,
  });
}

/** Refill the same fixed table that was eaten, matching Stadium's carousel.
 * Empty slots always win. Only when every table is occupied and a new fact has
 * no matching value do we recycle the oldest wrong plate; that exception keeps
 * the math round solvable without churning otherwise-stable dishes. */
function refillTables(state: FeastState, now: number, rng: Rng): void {
  const occupied = new Set(state.plates.map((p) => p.slot));
  const emptySlots = Array.from({ length: TABLE_COUNT }, (_, slot) => slot).filter(
    (slot) => !occupied.has(slot),
  );
  let hasCorrect = state.plates.some((p) => p.correct);

  for (const slot of emptySlots) {
    if (state.slotReadyAt[slot] > now) continue;
    addPlate(state, slot, now, rng, !hasCorrect);
    hasCorrect ||= state.plates[state.plates.length - 1].correct;
  }

  // A recently eaten empty table is already on its way; wait for it instead of
  // replacing a visible plate elsewhere on the ring.
  if (hasCorrect || emptySlots.length > 0) return;
  const oldestWrong = state.plates
    .filter((p) => !p.correct)
    .sort((a, b) => a.spawnedAt - b.spawnedAt || a.id - b.id)[0];
  if (!oldestWrong) return;
  state.plates = state.plates.filter((p) => p !== oldestWrong);
  addPlate(state, oldestWrong.slot, now, rng, true);
}

/** A benign fact so the engine never crashes on an empty pool (shouldn't happen
 *  — the caller requires enabled sets — but keeps the engine total). */
const fallbackFact = (): Fact => ({
  id: 'add:1+1',
  operation: 'add',
  operandA: 1,
  operandB: 1,
  answer: 2,
});

/** Initialize a round: pick the first fact, empty tables, players at zero. The
 * first server step fills all twelve ready tables in their stable slots. */
export function createFeastState(
  players: PlayerInit[],
  pool: Fact[],
  now: number,
  rng: Rng,
  roundMs: number = ROUND_MS,
): FeastState {
  const state: FeastState = {
    factId: '',
    factA: 0,
    factOp: 'add',
    factB: 0,
    answer: 0,
    plates: [],
    players: players.map((p, i) => {
      const angle = (i / Math.max(1, players.length)) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(angle) * 0.45;
      const y = Math.sin(angle) * 0.45;
      const aim = normalize({ x, y });
      return {
        ...p,
        score: 0,
        stunnedUntil: 0,
        botReactAt: now + randInt(rng, BOT_MIN_REACT_MS, BOT_MAX_REACT_MS),
        x,
        y,
        vx: 0,
        vy: 0,
        pushX: 0,
        pushY: 0,
        pushVx: 0,
        pushVy: 0,
        aimX: aim.x,
        aimY: aim.y,
        firing: false,
      };
    }),
    pool,
    endsAt: now + roundMs,
    nextPlateId: 1,
    beltOffset: 0,
    slotReadyAt: Array(TABLE_COUNT).fill(now),
    collisionReadyAt: {},
    lastRotateAt: now,
  };
  setFact(state, pool.length > 0 ? pick(rng, pool) : fallbackFact());
  return state;
}

const isStunned = (p: FeastPlayer, now: number): boolean => now < p.stunnedUntil;

/** Advance the world by `dtMs`: rotate fixed table slots, refill vacancies,
 * rotate the fact on schedule, and drive bot grabs. Mutates `state`. */
export function stepFeast(state: FeastState, now: number, dtMs: number, rng: Rng): void {
  if (now >= state.endsAt) return;

  // Every dish remains attached to one of Stadium's twelve rotating tables.
  state.beltOffset = (state.beltOffset + Math.max(0, dtMs) / BELT_LAP_MS) % 1;
  for (const plate of state.plates) plate.pos = tablePos(plate.slot, state.beltOffset);

  // Rotate the displayed fact on schedule.
  if (now - state.lastRotateAt >= FACT_ROTATE_MS && state.pool.length > 1) {
    let next = pick(rng, state.pool);
    if (next.id === state.factId) next = pick(rng, state.pool); // one nudge off a repeat
    setFact(state, next);
    state.lastRotateAt = now;
  }

  refillTables(state, now, rng);

  // Bots: steer toward the nearest reachable correct plate every step (cosmetic
  // movement), and grab on the reaction timer with BOT_ACCURACY.
  for (const bot of state.players) {
    if (!bot.isBot) continue;
    bot.firing = false;
    if (isStunned(bot, now)) {
      bot.vx = 0;
      bot.vy = 0;
      continue;
    }

    // Ease toward the nearest correct plate inside the reachable window.
    let steerTo: number | null = null;
    let bestD = Infinity;
    for (const p of state.plates) {
      if (!p.correct || p.pos < BOT_WINDOW[0] || p.pos > BOT_WINDOW[1]) continue;
      const target = platePoint(p.pos, BOT_STANDOFF_RADIUS);
      const d = Math.hypot(target.x - bot.x, target.y - bot.y);
      if (d < bestD) {
        bestD = d;
        steerTo = p.pos;
      }
    }
    if (steerTo !== null) {
      const destination = platePoint(steerTo, BOT_STANDOFF_RADIUS);
      const previous = { x: bot.x, y: bot.y };
      const next = easePoint({ x: bot.x, y: bot.y }, destination, BOT_MOVE_SPEED * dtMs);
      bot.x = next.x;
      bot.y = next.y;
      bot.vx = dtMs > 0 ? (next.x - previous.x) / dtMs : 0;
      bot.vy = dtMs > 0 ? (next.y - previous.y) / dtMs : 0;
      const plate = platePoint(steerTo);
      const aim = normalize({ x: plate.x - bot.x, y: plate.y - bot.y });
      bot.aimX = aim.x;
      bot.aimY = aim.y;
    } else {
      bot.vx = 0;
      bot.vy = 0;
    }
    resolveBotCollisions(state, bot, now, dtMs);

    // Grab on the reaction timer (accuracy roll unchanged from before).
    if (now < bot.botReactAt) continue;
    const target =
      rng() < BOT_ACCURACY
        ? state.plates.find((p) => p.correct && p.pos >= BOT_WINDOW[0] && p.pos <= BOT_WINDOW[1])
        : state.plates.find((p) => !p.correct && p.pos >= BOT_WINDOW[0] && p.pos <= BOT_WINDOW[1]);
    if (target) {
      bot.firing = true;
      applyGrab(state, bot.profileId, target.id, now);
    }
    bot.botReactAt = now + randInt(rng, BOT_MIN_REACT_MS, BOT_MAX_REACT_MS);
  }
}

export type GrabResult = 'correct' | 'wrong' | 'ignored';

/** A player grabs a plate: correct → +1 point, wrong → consumed + a stun. The
 *  plate is removed either way (first tap wins). Mutates `state`. */
export function applyGrab(
  state: FeastState,
  playerId: string,
  plateId: number,
  now: number,
): GrabResult {
  const player = state.players.find((p) => p.profileId === playerId);
  if (!player || isStunned(player, now)) return 'ignored';
  const idx = state.plates.findIndex((p) => p.id === plateId);
  if (idx === -1) return 'ignored';
  const [plate] = state.plates.splice(idx, 1);
  state.slotReadyAt[plate.slot] = now + TABLE_REFILL_MS;
  if (plate.correct) {
    player.score += 1;
    return 'correct';
  }
  player.stunnedUntil = now + WRONG_STUN_MS;
  return 'wrong';
}

/** A player reports its muncher position, pre-separation impact, and tongue
 * aim. Spatial data is relayed, with contact distance and maximum velocity
 * validated before a remote body is pushed; it is never trusted for scoring
 * (correctness is decided in applyGrab). Mutates `state`. */
export function applyMove(
  state: FeastState,
  playerId: string,
  x: number,
  y: number,
  vx: number,
  vy: number,
  impactX: number,
  impactY: number,
  impactVx: number,
  impactVy: number,
  aimX: number,
  aimY: number,
  firing: boolean,
  now: number,
): void {
  const player = state.players.find((p) => p.profileId === playerId);
  if (!player) return;
  if (![x, y, vx, vy, impactX, impactY, impactVx, impactVy, aimX, aimY, now].every(Number.isFinite))
    return;
  const previous = { x: player.x, y: player.y };
  const position = normalize({ x, y }, { x: 0, y: 0 });
  const positionLength = Math.hypot(x, y);
  player.x = positionLength > 1 ? position.x : x;
  player.y = positionLength > 1 ? position.y : y;
  const reportedVelocity = clampVelocity({ x: vx, y: vy });
  player.vx = reportedVelocity.x;
  player.vy = reportedVelocity.y;
  const aim = normalize({ x: aimX, y: aimY }, { x: player.aimX, y: player.aimY });
  player.aimX = aim.x;
  player.aimY = aim.y;
  player.firing = firing;

  // The local client has already separated its own predicted body by the time
  // this report arrives. Sweep the reported path so that contact still pushes
  // the remote CPU/player rather than disappearing from the server endpoint.
  const impactLength = Math.hypot(impactX, impactY);
  const normalizedImpact = normalize({ x: impactX, y: impactY }, { x: 0, y: 0 });
  const impact = impactLength > 1 ? normalizedImpact : { x: impactX, y: impactY };
  const incomingSpeed = Math.min(Math.hypot(impactVx, impactVy), MAX_REPORTED_SPEED);
  for (const other of state.players) {
    if (other === player) continue;
    const closest = closestPointOnSegment(previous, impact, other);
    const offset = { x: other.x - closest.x, y: other.y - closest.y };
    const distance = Math.hypot(offset.x, offset.y);
    if (distance >= PLAYER_COLLISION_DISTANCE) continue;
    const key = collisionKey(player, other);
    if ((state.collisionReadyAt[key] ?? 0) > now) continue;
    const direction = normalize(offset, normalize({ x: impactVx, y: impactVy }, { x: 1, y: 0 }));
    applyExternalPush(
      other,
      direction,
      incomingSpeed,
      PLAYER_COLLISION_DISTANCE - distance,
      REFERENCE_FRAME_MS,
    );
    state.collisionReadyAt[key] = now + COLLISION_PUSH_COOLDOWN_MS;
  }
}

export const isFeastOver = (state: FeastState, now: number): boolean => now >= state.endsAt;

/** Final ranking: highest score first, ties broken by profileId for stability. */
export function feastStandings(players: FeastPlayer[]): FeastStanding[] {
  return [...players]
    .sort((a, b) => b.score - a.score || a.profileId.localeCompare(b.profileId))
    .map((p, i) => ({
      profileId: p.profileId,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      placement: i + 1,
      isBot: p.isBot,
    }));
}

/** The client-facing view of the current tick (no answer / correctness leaked). */
export function feastSnapshot(state: FeastState, now: number): FeastSnapshot {
  return {
    factA: state.factA,
    factOp: state.factOp,
    factB: state.factB,
    timeLeftMs: Math.max(0, state.endsAt - now),
    plates: state.plates.map((p) => ({ id: p.id, value: p.value, pos: p.pos })),
    players: state.players.map((p) => ({
      profileId: p.profileId,
      name: p.name,
      avatar: p.avatar,
      muncher: p.muncher,
      score: p.score,
      stunned: isStunned(p, now),
      isBot: p.isBot,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      pushX: p.pushX,
      pushY: p.pushY,
      pushVx: p.pushVx,
      pushVy: p.pushVy,
      aimX: p.aimX,
      aimY: p.aimY,
      firing: p.firing,
    })),
  };
}
