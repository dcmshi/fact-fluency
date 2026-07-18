# Number Feast "Sushi-Go-Round" Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape Number Feast from a horizontal tap-to-grab belt into a circular "sushi-go-round" arena with a movable muncher that aims and fires a tongue, a fact-change sound cue, a clearer wrong-plate stun, positional bump, and easier bots.

**Architecture:** Keep the pure engine authoritative for game _truth_ (plates, fact, score, stun, bump cooldown) — plates stay a scalar `pos` (0→1). The client owns the spatial/aiming _layer_ (muncher position, tongue aim/reach, hit-detection) and maps the shared 0→1 coordinate onto a screen circle. Everyone — plates, human munchers, bot munchers — lives in one linear `[0,1]` "belt" coordinate; the client alone knows the `[0,1]→screen-arc` mapping. A new throttled `{move}` input relays each muncher's position/aim so others can render it; the existing `{grab, plateId}` still validates correctness server-side.

**Tech Stack:** TypeScript (strict) monorepo; `shared` (type-only) / `server` (Express + `ws`, esbuild, vitest) / `client` (Vite + React + react-i18next, vitest + jsdom). Web Audio for sound.

## Global Constraints

- **TypeScript strict everywhere.** `npm run typecheck` (all three workspaces) must stay green.
- **Shared stays type-only** — never export a runtime value from `shared/`.
- **Engine purity** — `server/src/engine/feast.ts` imports no framework/DB, reaches for no `Date.now()`; time + rng are injected. It is the most-tested code; every gameplay-truth change is unit-tested in `feast.test.ts`.
- **One shared 0→1 belt coordinate.** Plates `pos`, muncher `rimPos`, and `aim` are all `[0,1]`. Distances along the belt are **linear** (`Math.abs(a-b)`), not circular — the belt has a "kitchen gap" so `0` and `1` are NOT adjacent. Only the client converts `[0,1]` to a screen angle.
- **Server owns correctness.** The client never learns which plate is correct (the answer/correct flag is never broadcast). Aiming picks _which_ plate to grab; the server decides right/wrong.
- **Localize every user-facing string** in all four dictionaries (`client/src/i18n/en|es|fr|zh.ts`); `es/fr/zh` are typed `typeof en`, so a missing key fails the client build. Never build user-facing prose on the server.
- **Commit messages:** no `Co-Authored-By` or other trailers.
- **Run harness for manual (client) verification** — used by every "run-verify" task below:
  - Terminal A: `FF_FEAST_ROUND_MS=20000 npm run dev` (20s rounds keep manual checks fast; `npm run dev` starts Express :3001 + Vite :5173 with `/api` proxied).
  - In the browser (`http://localhost:5173`): create/sign in to an adult account → add a kid → open the kid's **Facts/Settings** and enable at least one fact set → open **🍣 Feast** → **Add a bot** → **I'm ready!**.
  - This reaches the `playing` arena with one human + one bot and a real fact pool.

---

## Task 1: Engine + broadcast player state (rimPos / aim / firing)

Add the three spatial fields to the broadcast DTO and the engine player, initialize them spread along the belt, and include them in the snapshot. This is the seam every later task builds on; it keeps all three workspaces typechecking and all tests green on its own.

**Files:**

- Modify: `shared/src/index.ts` (`FeastPlayerView`, ~lines 392-401; doc comment near line 380)
- Modify: `server/src/engine/feast.ts` (`FeastPlayer` interface ~lines 49-59; `createFeastState` ~lines 141-147; `feastSnapshot` ~lines 257-265)
- Test: `server/src/engine/feast.test.ts`

**Interfaces:**

- Produces (engine `FeastPlayer`): new fields `rimPos: number` (0→1 belt position), `aim: number` (0→1 belt direction the tongue points at), `firing: boolean` (tongue currently extended, for remote render).
- Produces (`feastSnapshot(...).players[i]`): each entry now also carries `rimPos`, `aim`, `firing`.
- Produces (shared `FeastPlayerView`): same three fields, all required.

- [ ] **Step 1: Write the failing test**

Add to the `feastStandings + snapshot` describe block in `server/src/engine/feast.test.ts`:

```ts
it('spreads munchers along the belt and exposes rimPos/aim/firing (no answer leak)', () => {
  const s = createFeastState(players('a', 'b'), POOL, 0, rng0);
  // Two players → seeded at 0.25 and 0.75 so they do not stack.
  expect(s.players[0].rimPos).toBeCloseTo(0.25, 5);
  expect(s.players[1].rimPos).toBeCloseTo(0.75, 5);
  expect(s.players[0].aim).toBeCloseTo(0.25, 5);
  expect(s.players[0].firing).toBe(false);

  const snap = feastSnapshot(s, 0);
  expect(snap.players[0]).toMatchObject({ rimPos: 0.25, aim: 0.25, firing: false });
  expect(snap).not.toHaveProperty('answer');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w server -- feast`
Expected: FAIL — `rimPos` is `undefined` (property does not exist yet).

- [ ] **Step 3: Implement**

In `shared/src/index.ts`, extend `FeastPlayerView`:

```ts
/** A player as broadcast to clients (score + stun state, no server internals).
 *  `rimPos`/`aim` are the muncher's position and tongue direction along the
 *  belt (both 0→1, same coordinate as a plate's `pos`); `firing` is whether the
 *  tongue is currently out — all render-only, relayed so everyone sees everyone.
 *  Clients send their own via a throttled `{type:'move', rimPos, aim, firing}`. */
export interface FeastPlayerView {
  profileId: string;
  name: string;
  avatar: string;
  muncher: string;
  score: number;
  stunned: boolean;
  isBot: boolean;
  rimPos: number;
  aim: number;
  firing: boolean;
}
```

In `server/src/engine/feast.ts`, add to `FeastPlayer` (after `botReactAt`):

```ts
rimPos: number; // 0→1 position along the belt (client-owned for humans)
aim: number; // 0→1 belt direction the tongue points at
firing: boolean; // tongue currently extended (render-only)
```

In `createFeastState`, replace the `players.map(...)` initializer so each player is seeded at a spread-out belt position:

```ts
    players: players.map((p, i) => ({
      ...p,
      score: 0,
      stunnedUntil: 0,
      bumpReadyAt: 0,
      botReactAt: now + randInt(rng, BOT_MIN_REACT_MS, BOT_MAX_REACT_MS),
      rimPos: (i + 0.5) / Math.max(1, players.length),
      aim: (i + 0.5) / Math.max(1, players.length),
      firing: false,
    })),
```

In `feastSnapshot`, add the three fields to each mapped player:

```ts
    players: state.players.map((p) => ({
      profileId: p.profileId,
      name: p.name,
      avatar: p.avatar,
      muncher: p.muncher,
      score: p.score,
      stunned: isStunned(p, now),
      isBot: p.isBot,
      rimPos: p.rimPos,
      aim: p.aim,
      firing: p.firing,
    })),
```

Also update the two hand-built `FeastPlayer` literals in the existing `feastStandings + snapshot` test (the `roster` array) to include `rimPos: 0, aim: 0, firing: false`, so the file still typechecks.

- [ ] **Step 4: Run tests + typecheck**

Run: `npm run test -w server -- feast`
Expected: PASS (new test + all existing feast tests).
Run: `npm run typecheck`
Expected: PASS (shared/server/client all clean — the new required fields are additive to what the client reads).

- [ ] **Step 5: Commit**

```bash
git add shared/src/index.ts server/src/engine/feast.ts server/src/engine/feast.test.ts
git commit -m "Feast circle: add rimPos/aim/firing to player state + snapshot"
```

---

## Task 2: Engine `applyMove` mutation

A pure, validated mutation the WS layer will call for human `{move}` inputs — symmetric with `applyGrab`/`applyBump`.

**Files:**

- Modify: `server/src/engine/feast.ts` (add `applyMove` near `applyGrab`, ~line 200)
- Test: `server/src/engine/feast.test.ts`

**Interfaces:**

- Produces: `export function applyMove(state: FeastState, playerId: string, rimPos: number, aim: number, firing: boolean): void` — clamps `rimPos`/`aim` to `[0,1]`; sets the player's fields; no-op for an unknown player. Consumed by Task 5.

- [ ] **Step 1: Write the failing test**

Add a new describe block to `server/src/engine/feast.test.ts`:

```ts
describe('applyMove', () => {
  it('sets and clamps the mover’s position/aim and ignores unknown players', () => {
    const s = createFeastState(players('a'), POOL, 0, rng0);
    applyMove(s, 'a', 1.4, -0.2, true); // out of range → clamped
    expect(s.players[0].rimPos).toBe(1);
    expect(s.players[0].aim).toBe(0);
    expect(s.players[0].firing).toBe(true);
    // unknown player: no throw, no change elsewhere
    expect(() => applyMove(s, 'ghost', 0.5, 0.5, false)).not.toThrow();
    expect(s.players[0].rimPos).toBe(1);
  });
});
```

Add `applyMove` to the import from `./feast` at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w server -- feast`
Expected: FAIL — `applyMove` is not exported / not defined.

- [ ] **Step 3: Implement**

In `server/src/engine/feast.ts`, add after `applyGrab`:

```ts
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** A player reports its muncher position + tongue aim (render-only relay). The
 *  server keeps this only to broadcast to other clients; it is NOT trusted for
 *  scoring (correctness is decided in applyGrab). Mutates `state`. */
export function applyMove(
  state: FeastState,
  playerId: string,
  rimPos: number,
  aim: number,
  firing: boolean,
): void {
  const player = state.players.find((p) => p.profileId === playerId);
  if (!player) return;
  player.rimPos = clamp01(rimPos);
  player.aim = clamp01(aim);
  player.firing = firing;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w server -- feast`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/engine/feast.ts server/src/engine/feast.test.ts
git commit -m "Feast circle: add applyMove engine mutation"
```

---

## Task 3: Bot muncher movement (cosmetic easing)

Bots visibly steer their muncher toward the nearest reachable correct plate each step, so their `rimPos` looks intentional on the ring. Scoring/grab logic is unchanged (Task 4 tunes it); easing runs every step, even before the bot's reaction window.

**Files:**

- Modify: `server/src/engine/feast.ts` (tunables block; the bot loop in `stepFeast`, ~lines 186-195)
- Test: `server/src/engine/feast.test.ts`

**Interfaces:**

- Consumes: `FeastPlayer.rimPos`/`aim`/`firing` (Task 1).
- Produces: bots’ `rimPos` eases toward a target each `stepFeast`; new module const `BOT_MOVE_SPEED`.

- [ ] **Step 1: Write the failing test**

Add to the `stepFeast` describe block in `server/src/engine/feast.test.ts`:

```ts
it('eases a bot’s rimPos toward the nearest correct plate before it grabs', () => {
  const s = createFeastState(
    [{ profileId: 'bot1', name: 'Bot', avatar: '🤖', muncher: 'cat', isBot: true }],
    POOL,
    0,
    rng0,
  );
  s.players[0].rimPos = 0.5;
  s.plates = [{ id: 1, value: s.answer, pos: 0.3, correct: true }];
  s.lastSpawnAt = 1e12; // no new spawns
  // now (100) < botReactAt (>=700) → the bot moves but does not grab yet.
  stepFeast(s, 100, 100, rng0);
  expect(s.players[0].rimPos).toBeLessThan(0.5);
  expect(s.players[0].rimPos).toBeGreaterThan(0.3);
  expect(s.plates).toHaveLength(1); // not grabbed
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w server -- feast`
Expected: FAIL — `rimPos` stays `0.5` (no easing yet).

- [ ] **Step 3: Implement**

In the tunables block of `server/src/engine/feast.ts`, add:

```ts
/** Bots steer their muncher toward a target at this speed (belt units per ms). */
const BOT_MOVE_SPEED = 0.0006;
```

Add a small easing helper near `randInt`/`pick`:

```ts
/** Move `cur` toward `target` by at most `step`, staying within [0,1]. */
const ease = (cur: number, target: number, step: number): number => {
  const d = target - cur;
  if (Math.abs(d) <= step) return target;
  return cur + Math.sign(d) * step;
};
```

Replace the bot loop in `stepFeast` (the `for (const bot of state.players) { ... }` block) with:

```ts
// Bots: steer toward the nearest reachable correct plate every step (cosmetic
// movement), and grab on the reaction timer with BOT_ACCURACY.
for (const bot of state.players) {
  if (!bot.isBot || isStunned(bot, now)) continue;

  // Ease toward the nearest correct plate inside the reachable window.
  let steerTo: number | null = null;
  let bestD = Infinity;
  for (const p of state.plates) {
    if (!p.correct || p.pos < BOT_WINDOW[0] || p.pos > BOT_WINDOW[1]) continue;
    const d = Math.abs(p.pos - bot.rimPos);
    if (d < bestD) {
      bestD = d;
      steerTo = p.pos;
    }
  }
  if (steerTo !== null) {
    bot.rimPos = ease(bot.rimPos, steerTo, BOT_MOVE_SPEED * dtMs);
    bot.aim = bot.rimPos;
  }

  // Grab on the reaction timer (accuracy roll unchanged from before).
  bot.firing = false;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w server -- feast`
Expected: PASS (new easing test; the existing bot-grab test still passes because it steps at a time past the reaction window — Task 4 adjusts its timing for the retuned constants).

- [ ] **Step 5: Commit**

```bash
git add server/src/engine/feast.ts server/src/engine/feast.test.ts
git commit -m "Feast circle: bots steer their muncher toward targets"
```

---

## Task 4: Easier bots + a clearer wrong-plate stun (tuning)

Pure constant changes plus the one existing test whose timing assumption they break.

**Files:**

- Modify: `server/src/engine/feast.ts` (tunables ~lines 30-37)
- Test: `server/src/engine/feast.test.ts` (the existing "lets a bot grab a correct plate…" test)

This is a tuning change. The retune raises the bot reaction floor from 450ms to 700ms, which **breaks** the existing bot-grab test (it steps at `now = 500`, which is now before the floor) — that's our red. We then fix the test's timing (green) and add an explicit floor test.

- [ ] **Step 1: Retune the constants**

In `server/src/engine/feast.ts`:

```ts
/** Stun after a wrong grab, and after being bumped. */
const WRONG_STUN_MS = 1500;
const BUMP_STUN_MS = 900;
```

```ts
/** Bots: reaction window between grab attempts, and how often they're right.
 *  Deliberately forgiving — this is a kids' game (DESIGN.md §4). */
const BOT_MIN_REACT_MS = 700;
const BOT_MAX_REACT_MS = 1600;
const BOT_ACCURACY = 0.7;
```

- [ ] **Step 2: Run tests to see the existing bot-grab test go red**

Run: `npm run test -w server -- feast`
Expected: FAIL — `lets a bot grab a correct plate once its reaction window passes` now fails: it steps at `now = 500`, but the reaction floor is `700`, so the bot hasn't grabbed yet (`score` is `0`, expected `1`).

- [ ] **Step 3: Fix that test's timing and add a floor test**

In `server/src/engine/feast.test.ts`, in the `lets a bot grab a correct plate…` test, step past the new floor:

```ts
s.lastSpawnAt = 1e12; // isolate the bot's grab from new spawns
stepFeast(s, 800, 5, rng0); // now past botReactAt (700)
expect(s.players[0].score).toBe(1);
expect(s.plates).toHaveLength(0);
```

Then add a new test to the `stepFeast` describe block asserting the floor:

```ts
it('does not let a bot grab before the reaction floor', () => {
  const s = createFeastState(
    [{ profileId: 'bot1', name: 'Bot', avatar: '🤖', muncher: 'cat', isBot: true }],
    POOL,
    0,
    rng0,
  );
  s.plates = [{ id: 1, value: s.answer, pos: 0.5, correct: true }];
  s.lastSpawnAt = 1e12;
  stepFeast(s, 500, 5, rng0); // 500 < BOT_MIN_REACT_MS (700)
  expect(s.players[0].score).toBe(0);
  expect(s.plates).toHaveLength(1);
});
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npm run test -w server -- feast`
Expected: PASS (retimed bot-grab test, the new floor test, and the "stuns on a wrong plate" test, which only asserts `stunnedUntil > 100`).

- [ ] **Step 5: Commit**

```bash
git add server/src/engine/feast.ts server/src/engine/feast.test.ts
git commit -m "Feast circle: easier bots + a longer, clearer wrong-plate stun"
```

---

## Task 5: WebSocket `{move}` input

Wire the new human input through the room to `applyMove`. `live.ts` isn't unit-tested (WS IO); verify by typecheck + build.

**Files:**

- Modify: `server/src/feast/live.ts` (protocol doc comment ~lines 12-15; `applyMove` import ~lines 25-35; `onMessage` signature + switch ~lines 222-249)

**Interfaces:**

- Consumes: `applyMove` (Task 2).
- Produces: server accepts `{type:'move', rimPos:number, aim:number, firing:boolean}` during `playing`.

- [ ] **Step 1: Implement**

In `server/src/feast/live.ts`:

1. Add `applyMove` to the engine import list:

```ts
import {
  applyBump,
  applyGrab,
  applyMove,
  createFeastState,
  feastSnapshot,
  feastStandings,
  isFeastOver,
  stepFeast,
  type FeastState,
  type Rng,
} from '../engine/feast';
```

2. Update the protocol comment line to include `move`:

```ts
 *   client → server: {ready}, {addBot}, {grab, plateId}, {bump, targetId},
 *                    {move, rimPos, aim, firing}, {again}
```

3. Widen the `msg` type in both the `ws.on('message', ...)` handler (~line 192) and the `onMessage` signature (~line 226) to carry the new fields:

```ts
    msg: {
      type?: string;
      plateId?: unknown;
      targetId?: unknown;
      rimPos?: unknown;
      aim?: unknown;
      firing?: unknown;
    };
```

(apply the same shape to the `onMessage(...)` parameter type).

4. Add a `move` case to the `switch (msg.type)` in `onMessage`, before `again`:

```ts
    case 'move':
      if (
        room.phase === 'playing' &&
        room.state &&
        typeof msg.rimPos === 'number' &&
        typeof msg.aim === 'number' &&
        typeof msg.firing === 'boolean'
      ) {
        applyMove(room.state, player.profileId, msg.rimPos, msg.aim, msg.firing);
      }
      return;
```

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm run build -w server`
Expected: esbuild bundles `dist/index.js` with no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/feast/live.ts
git commit -m "Feast circle: accept {move} input over the arena WS"
```

---

## Task 6: Client belt geometry helpers (pure + unit-tested)

The math the arena renders and the hit-detection it fires — isolated as pure functions with real tests (client uses vitest + jsdom; see `client/src/injects.test.ts` for the pattern). No React, no DOM.

**Files:**

- Create: `client/src/pages/feastArena.ts`
- Test: `client/src/pages/feastArena.test.ts`

**Interfaces (all exported from `feastArena.ts`):**

- Consts: `GAP = 0.12`, `REACH = 0.16`, `BUMP_RANGE = 0.06`, `MOVE_SPEED = 0.0016` (belt units per ms).
- `clamp01(n: number): number`
- `plateFrac(pos: number): number` — belt `pos` (0→1) → circle fraction (0→1, clockwise from top), leaving a gap of `GAP` at the top.
- `invPlateFrac(frac: number): number` — inverse of `plateFrac`, clamped to `[0,1]`.
- `pointOnCircle(cx: number, cy: number, r: number, frac: number): { x: number; y: number }` — `frac` measured clockwise from 12 o'clock.
- `fracFromPoint(cx: number, cy: number, px: number, py: number): number` — inverse (returns 0→1).
- `stepRimPos(current: number, target: number, dtMs: number): number` — ease along the belt toward `target`, capped at `MOVE_SPEED*dtMs`, result in `[0,1]`.
- `pickTarget(plates: { id: number; pos: number }[], rimPos: number, aim: number): number | null` — among plates within `REACH` of `rimPos`, the id nearest `aim`; else `null`. Correctness-agnostic (client never knows it).
- `inBumpRange(a: number, b: number): boolean` — `|a-b| <= BUMP_RANGE`.

Produced values are consumed by Tasks 9-11.

- [ ] **Step 1: Write the failing tests**

Create `client/src/pages/feastArena.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  clamp01,
  fracFromPoint,
  GAP,
  inBumpRange,
  invPlateFrac,
  pickTarget,
  plateFrac,
  pointOnCircle,
  stepRimPos,
} from './feastArena';

describe('clamp01', () => {
  it('clamps to [0,1]', () => {
    expect(clamp01(-0.3)).toBe(0);
    expect(clamp01(1.7)).toBe(1);
    expect(clamp01(0.42)).toBe(0.42);
  });
});

describe('plateFrac / invPlateFrac', () => {
  it('maps pos 0→1 into the belt arc, leaving a top gap', () => {
    expect(plateFrac(0)).toBeCloseTo(GAP / 2, 6); // 0.06
    expect(plateFrac(1)).toBeCloseTo(1 - GAP / 2, 6); // 0.94
    expect(plateFrac(0.5)).toBeCloseTo(0.5, 6);
  });
  it('round-trips and clamps', () => {
    expect(invPlateFrac(plateFrac(0.37))).toBeCloseTo(0.37, 6);
    expect(invPlateFrac(0)).toBe(0); // below arc → clamp to 0
    expect(invPlateFrac(1)).toBe(1); // above arc → clamp to 1
  });
});

describe('pointOnCircle / fracFromPoint', () => {
  it('places frac 0 at top and 0.25 at right (clockwise)', () => {
    const top = pointOnCircle(0, 0, 10, 0);
    expect(top.x).toBeCloseTo(0, 6);
    expect(top.y).toBeCloseTo(-10, 6);
    const right = pointOnCircle(0, 0, 10, 0.25);
    expect(right.x).toBeCloseTo(10, 6);
    expect(right.y).toBeCloseTo(0, 6);
  });
  it('inverts pointOnCircle', () => {
    const p = pointOnCircle(5, 5, 8, 0.6);
    expect(fracFromPoint(5, 5, p.x, p.y)).toBeCloseTo(0.6, 6);
  });
});

describe('stepRimPos', () => {
  it('eases toward the target, capped by speed, and snaps when close', () => {
    expect(stepRimPos(0.5, 0.3, 100)).toBeCloseTo(0.5 - 0.16, 6); // 0.0016*100 = 0.16
    expect(stepRimPos(0.5, 0.52, 1000)).toBe(0.52); // within one step → snap
    expect(stepRimPos(0.9, 2, 1000)).toBe(1); // clamped
  });
});

describe('pickTarget', () => {
  const plates = [
    { id: 1, pos: 0.3 },
    { id: 2, pos: 0.5 },
    { id: 3, pos: 0.9 },
  ];
  it('returns the in-reach plate nearest the aim', () => {
    expect(pickTarget(plates, 0.4, 0.31)).toBe(1); // 0.3 & 0.5 in reach; aim closest to 0.3
    expect(pickTarget(plates, 0.5, 0.52)).toBe(2);
  });
  it('returns null when nothing is within reach', () => {
    expect(pickTarget(plates, 0.1, 0.1)).toBeNull();
    expect(pickTarget([], 0.5, 0.5)).toBeNull();
  });
});

describe('inBumpRange', () => {
  it('is true only within BUMP_RANGE', () => {
    expect(inBumpRange(0.5, 0.53)).toBe(true);
    expect(inBumpRange(0.5, 0.7)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w client -- feastArena`
Expected: FAIL — module `./feastArena` not found.

- [ ] **Step 3: Implement**

Create `client/src/pages/feastArena.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w client -- feastArena`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/feastArena.ts client/src/pages/feastArena.test.ts
git commit -m "Feast circle: pure belt geometry + hit-detection helpers"
```

---

## Task 7: i18n copy for the new arena

Add/adjust all Feast strings the client tasks will use, in **all four** dictionaries up front (so `es/fr/zh: typeof en` keeps the build green as later tasks reference them).

**Files:**

- Modify: `client/src/i18n/en.ts`, `es.ts`, `fr.ts`, `zh.ts` (the `feast: { ... }` block)

- [ ] **Step 1: Implement (en.ts)**

In `client/src/i18n/en.ts`, update the `feast` block: change `lobbyHint` and `tapHint`, and add `fire`, `aimHint`, `stunned`, `factChanged`:

```ts
    lobbyHint: 'Steer your muncher, aim your tongue, and gobble the plates that match the answer!',
    // ...existing keys unchanged...
    tapHint: 'Steer to aim · tap FIRE (or a plate) to shoot your tongue · bump rivals by nudging into them',
    fire: 'FIRE',
    aimHint: 'Aim at a plate',
    stunned: 'Dizzy! 💫',
    factChanged: 'New fact!',
```

- [ ] **Step 2: Implement (es.ts, fr.ts, zh.ts)**

Add the same keys with translations. `es.ts`:

```ts
    lobbyHint: '¡Mueve tu comelón, apunta la lengua y engulle los platos que coincidan con la respuesta!',
    tapHint: 'Muévete para apuntar · pulsa DISPARA (o un plato) para lanzar la lengua · empuja a tus rivales para aturdirlos',
    fire: 'DISPARA',
    aimHint: 'Apunta a un plato',
    stunned: '¡Mareado! 💫',
    factChanged: '¡Nueva operación!',
```

`fr.ts`:

```ts
    lobbyHint: 'Dirige ton mangeur, vise avec ta langue et gobe les assiettes qui correspondent à la réponse !',
    tapHint: 'Dirige-toi pour viser · appuie sur FEU (ou une assiette) pour lancer ta langue · bouscule tes rivaux pour les étourdir',
    fire: 'FEU',
    aimHint: 'Vise une assiette',
    stunned: 'Étourdi ! 💫',
    factChanged: 'Nouveau calcul !',
```

`zh.ts`:

```ts
    lobbyHint: '移动你的吞食者，瞄准舌头，吞掉与答案相符的盘子！',
    tapHint: '移动来瞄准 · 点击“发射”（或盘子）伸出舌头 · 撞向对手让他们晕眩',
    fire: '发射',
    aimHint: '瞄准一个盘子',
    stunned: '晕了！💫',
    factChanged: '新算式！',
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck -w client`
Expected: PASS (all four dictionaries share the same key set; missing/extra keys would fail here).

- [ ] **Step 4: Commit**

```bash
git add client/src/i18n/en.ts client/src/i18n/es.ts client/src/i18n/fr.ts client/src/i18n/zh.ts
git commit -m "Feast circle: i18n copy for steer/aim/fire arena (en/es/fr/zh)"
```

---

## Task 8: Fact-change sound cue

A short, distinct Web Audio cue for when the displayed fact rotates. No unit test (Web Audio side effect); verify by typecheck + audible in run.

**Files:**

- Modify: `client/src/sound.ts` (add `playFactChange` after `playWrong`)

**Interfaces:**

- Produces: `export function playFactChange(): void`. Consumed by Task 10.

- [ ] **Step 1: Implement**

In `client/src/sound.ts`, after `playWrong`:

```ts
/** The displayed fact just changed: a bright, quick two-note "ding" so kids
 *  notice the new target while they're busy steering. Distinct from
 *  correct/wrong so it never reads as a score cue. */
export function playFactChange(): void {
  play(() => {
    note(880.0, 0, 0.09, 'triangle', 0.14); // A5
    note(1174.66, 0.07, 0.13, 'triangle', 0.14); // D6
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w client`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/sound.ts
git commit -m "Feast circle: add playFactChange sound cue"
```

---

## Task 9: Client arena — circular render + CSS

Replace the horizontal belt/plate/players markup with a circular ring: plates and munchers positioned via the Task 6 helpers. Keep the existing inputs working (tap-a-plate → grab, and a display-only scoreboard) so the game is fully playable after this task; steering/aiming/fire come in Task 10. Run-verified (see the run harness in Global Constraints).

**Files:**

- Modify: `client/src/pages/FeastPage.tsx` (the `// ---- playing ----` block, ~lines 230-301)
- Modify: `client/src/pages/FeastPage.css` (belt/plate/players styles ~lines 38-159)

**Interfaces:**

- Consumes: `plateFrac`, `pointOnCircle` (Task 6); `FeastSnapshot`/`FeastPlayerView.rimPos` (Task 1); `Muncher` component.

- [ ] **Step 1: Implement the render**

In `client/src/pages/FeastPage.tsx`, add imports:

```ts
import { plateFrac, pointOnCircle } from './feastArena';
```

Replace the `feast-belt` + `feast-players` markup (between the `</header>` and the `<p className="feast-hint">`) with a square ring stage. The ring uses a fixed viewport-ish size via CSS; plates and munchers are absolutely positioned by percentage so the math is resolution-independent (center at 50%,50%, plate ring radius 38%, muncher rim radius 48%):

```tsx
{
  /* The round belt. Plates ride an inner ring; munchers sit on the rim.
          Positions come from the shared 0→1 belt coordinate via feastArena. */
}
<div className="feast-ring" aria-label={t('feast.beltLabel')}>
  <div className="feast-ring-track" aria-hidden="true" />
  {snap?.plates.map((plate) => {
    const { x, y } = pointOnCircle(50, 50, 38, plateFrac(plate.pos));
    return (
      <button
        key={plate.id}
        className="feast-plate"
        style={{ left: `${x}%`, top: `${y}%` }}
        onClick={() => send({ type: 'grab', plateId: plate.id })}
        disabled={me?.stunned}
        aria-label={String(plate.value)}
      >
        {plate.value}
      </button>
    );
  })}
  {snap?.players.map((p) => {
    const { x, y } = pointOnCircle(50, 50, 48, p.rimPos);
    const you = p.profileId === profileId;
    return (
      <span
        key={p.profileId}
        className={`feast-muncher ${you ? 'you' : ''} ${p.stunned ? 'stunned' : ''}`}
        style={{ left: `${x}%`, top: `${y}%` }}
      >
        <Muncher animal={p.muncher} state={p.stunned ? 'bleh' : 'still'} size={44} />
        {p.stunned && (
          <span className="feast-stun" aria-hidden="true">
            💫
          </span>
        )}
      </span>
    );
  })}
</div>;

{
  /* Display-only scoreboard (bumping is positional now — Task 11). */
}
<div className="feast-players">
  {snap?.players.map((p) => {
    const you = p.profileId === profileId;
    return (
      <span
        key={p.profileId}
        className={`feast-player ${you ? 'you' : ''} ${p.stunned ? 'stunned' : ''}`}
      >
        <span aria-hidden="true">{p.avatar}</span>
        <span className="feast-player-name">{you ? t('feast.you') : p.name}</span>
        <span className="feast-player-score" key={you ? pulse : undefined}>
          {p.score}
        </span>
      </span>
    );
  })}
</div>;
```

- [ ] **Step 2: Implement the CSS**

In `client/src/pages/FeastPage.css`, replace the `.feast-belt` and `.feast-plate` rules (and the `.feast-players`/`.feast-player` block’s button-specific bits) with ring styles. Add:

```css
/* The round belt: a square stage; plates + munchers are placed by % from the
   shared 0→1 belt coordinate (feastArena.ts). */
.feast-ring {
  position: relative;
  width: min(92vw, 60vh, 560px);
  aspect-ratio: 1;
}
.feast-ring-track {
  position: absolute;
  inset: 8%;
  border-radius: 50%;
  border: 14px solid var(--paper-2);
  box-shadow:
    inset 0 0 0 2px var(--line),
    0 0 0 2px var(--line);
}
.feast-plate {
  position: absolute;
  transform: translate(-50%, -50%);
  transition:
    left 0.09s linear,
    top 0.09s linear;
  width: clamp(40px, 10vw, 58px);
  height: clamp(40px, 10vw, 58px);
  border-radius: 50%;
  border: 3px solid var(--sun-shadow);
  background: var(--card);
  color: var(--ink);
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(1rem, 3vw, 1.4rem);
  box-shadow: 0 3px 0 rgba(43, 36, 64, 0.15);
  cursor: pointer;
}
.feast-plate:active {
  transform: translate(-50%, -50%) scale(0.9);
}
.feast-plate:disabled {
  cursor: default;
  opacity: 0.75;
}
.feast-muncher {
  position: absolute;
  transform: translate(-50%, -50%);
  transition:
    left 0.09s linear,
    top 0.09s linear;
  display: grid;
  place-items: center;
  pointer-events: none;
}
.feast-muncher.you {
  filter: drop-shadow(0 0 0 var(--sun)) drop-shadow(0 3px 6px rgba(43, 36, 64, 0.25));
}
.feast-muncher.stunned {
  opacity: 0.6;
}
```

Keep the existing `.feast-players`/`.feast-player`/`.feast-player-score`/`.feast-stun` rules; just ensure `.feast-player` no longer implies a button (it's a `span` now — the existing rules are fine, and the `:active` scale under reduced-motion still applies only to `.feast-plate`). Remove the now-unused old `.feast-belt` rule.

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck -w client`
Expected: PASS.
Run: `npm run build -w client`
Expected: Vite build succeeds.

- [ ] **Step 4: Run-verify**

Start the run harness (Global Constraints). In the arena, confirm:

- Plates now orbit a **circle** (entering/leaving at the top gap), gliding smoothly.
- Both munchers sit on the outer rim; the bot's muncher visibly slides around the ring.
- Tapping a plate still scores (correct) or dizzies you (wrong); the scoreboard updates.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/FeastPage.tsx client/src/pages/FeastPage.css
git commit -m "Feast circle: render the arena as a round belt with rim munchers"
```

---

## Task 10: Client controls — steer, aim, fire the tongue, broadcast move

Add point-to-aim steering (pointer/keyboard), a FIRE control, tongue animation, client-side hit-detection → `grab`, and the throttled `{move}` broadcast. Keep tap-a-plate as the accessibility fallback. Run-verified.

**Files:**

- Modify: `client/src/pages/FeastPage.tsx` (playing block + a new rAF/input effect)
- Modify: `client/src/pages/FeastPage.css` (tongue + fire button)

**Interfaces:**

- Consumes: `fracFromPoint`, `invPlateFrac`, `stepRimPos`, `pickTarget`, `pointOnCircle`, `plateFrac`, `clamp01` (Task 6); sends `{type:'move', rimPos, aim, firing}` (Task 5) and `{type:'grab', plateId}`.

- [ ] **Step 1: Implement input state + rAF loop**

In `client/src/pages/FeastPage.tsx`:

1. Imports:

```ts
import {
  clamp01,
  fracFromPoint,
  invPlateFrac,
  pickTarget,
  pointOnCircle,
  plateFrac,
  stepRimPos,
} from './feastArena';
```

2. Refs/state near the other refs (top of the component):

```ts
const ringRef = useRef<HTMLDivElement | null>(null);
const selfPos = useRef(0.5); // muncher position (belt 0→1), owned locally
const selfAim = useRef(0.5); // pointer target (belt 0→1)
const platesRef = useRef<FeastSnapshot['plates']>([]);
const snapRef = useRef<FeastSnapshot | null>(null); // latest snapshot, for fresh reads in the rAF loop
const seededPos = useRef(false); // have we placed the muncher at the server's seed yet?
const [selfRender, setSelfRender] = useState({ pos: 0.5, aim: 0.5 });
const [firing, setFiring] = useState(0); // timestamp-ish counter; >0 while tongue is out
```

3. Keep the refs current: in the `snapshot` case of `ws.onmessage`, after `setSnap(...)`, add the plate + snapshot refs and seed `selfPos`/`selfAim`/`selfRender` from the server's rimPos on the first snapshot (so the muncher starts where the server seeded it). `me` here is the existing `const me = (msg as FeastSnapshot).players.find(...)` already computed in that case:

```ts
platesRef.current = (msg as FeastSnapshot).plates;
snapRef.current = msg as FeastSnapshot;
if (me && !seededPos.current) {
  seededPos.current = true;
  selfPos.current = me.rimPos;
  selfAim.current = me.rimPos;
  setSelfRender({ pos: me.rimPos, aim: me.rimPos });
}
```

In the `countdown` case, reset `seededPos.current = false;` so a rematch re-seeds the muncher position.

4. A steering + broadcast effect (runs only while `playing`):

```ts
useEffect(() => {
  if (phase !== 'playing') return;
  let raf = 0;
  let last = 0;
  let lastSent = 0;
  const loop = (t: number) => {
    const dt = last ? t - last : 16;
    last = t;
    selfPos.current = stepRimPos(selfPos.current, selfAim.current, dt);
    setSelfRender({ pos: selfPos.current, aim: selfAim.current });
    // Throttle move broadcasts to ~12 Hz.
    if (t - lastSent > 80) {
      lastSent = t;
      send({ type: 'move', rimPos: selfPos.current, aim: selfAim.current, firing: firing > 0 });
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [phase, firing]);
```

(Note: `send` is stable enough for this use; `firing` in deps is fine — the loop restarts but state is in refs.)

- [ ] **Step 2: Implement pointer/keyboard aim + fire**

Add handlers in the component:

```ts
const aimAt = (clientX: number, clientY: number) => {
  const el = ringRef.current;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  selfAim.current = invPlateFrac(fracFromPoint(cx, cy, clientX, clientY));
};

const fire = () => {
  if (me?.stunned) return;
  const id = pickTarget(platesRef.current, selfPos.current, selfAim.current);
  if (id != null) send({ type: 'grab', plateId: id });
  setFiring((n) => n + 1);
  window.setTimeout(() => setFiring((n) => Math.max(0, n - 1)), 180);
};

const onRingPointerMove = (e: React.PointerEvent) => aimAt(e.clientX, e.clientY);
const onKeyControl = (e: React.KeyboardEvent) => {
  if (e.key === 'ArrowLeft') selfAim.current = clamp01(selfAim.current - 0.05);
  else if (e.key === 'ArrowRight') selfAim.current = clamp01(selfAim.current + 0.05);
  else if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    fire();
  }
};
```

Wire them onto the ring container and add a FIRE button + the tongue. Update the `.feast-ring` element:

```tsx
      <div
        className="feast-ring"
        ref={ringRef}
        aria-label={t('feast.beltLabel')}
        onPointerMove={onRingPointerMove}
        onPointerDown={(e) => {
          aimAt(e.clientX, e.clientY);
          fire();
        }}
        tabIndex={0}
        onKeyDown={onKeyControl}
      >
```

Render the self muncher + tongue from **local** state (not the snapshot), and other munchers from the snapshot. Change the players-on-ring map to skip self, and add a dedicated self muncher node driven by `selfRender`:

```tsx
{
  snap?.players
    .filter((p) => p.profileId !== profileId)
    .map((p) => {
      const { x, y } = pointOnCircle(50, 50, 48, p.rimPos);
      return (
        <span
          key={p.profileId}
          className={`feast-muncher ${p.stunned ? 'stunned' : ''}`}
          style={{ left: `${x}%`, top: `${y}%` }}
        >
          <Muncher animal={p.muncher} state={p.stunned ? 'bleh' : 'still'} size={44} />
          {p.stunned && (
            <span className="feast-stun" aria-hidden="true">
              💫
            </span>
          )}
          {p.firing && <span className="feast-tongue-mini" aria-hidden="true" />}
        </span>
      );
    });
}
{
  me &&
    (() => {
      const { x, y } = pointOnCircle(50, 50, 48, selfRender.pos);
      return (
        <span
          className={`feast-muncher you ${me.stunned ? 'stunned' : ''} ${firing > 0 ? 'firing' : ''}`}
          style={{ left: `${x}%`, top: `${y}%` }}
        >
          <Muncher animal={me.muncher} state={me.stunned ? 'bleh' : 'still'} size={48} />
          {me.stunned && (
            <span className="feast-stun" aria-hidden="true">
              💫
            </span>
          )}
        </span>
      );
    })();
}
```

Add the FIRE button after the ring (before the hint):

```tsx
<button className="btn sun feast-fire" onClick={fire} disabled={me?.stunned}>
  {t('feast.fire')}
</button>
```

- [ ] **Step 3: Implement tongue CSS**

In `client/src/pages/FeastPage.css`, add a tongue that shoots inward (toward ring center) when firing. Because the muncher sits on the rim and plates are just inside, a short inward-pointing tongue reads correctly without per-frame angle math:

```css
.feast-muncher.you::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 6px;
  height: 0;
  background: #ff7a9c;
  border-radius: 3px;
  transform: translate(-50%, -50%) rotate(0deg);
  /* point toward the ring center: the muncher is on the rim, center is inward */
  transform-origin: 50% 50%;
  transition: height 0.09s ease-out;
  pointer-events: none;
}
.feast-muncher.you.firing::after {
  height: 46px;
}
.feast-fire {
  width: min(80vw, 260px);
  font-size: 1.3rem;
  letter-spacing: 0.05em;
}
.feast-tongue-mini {
  position: absolute;
  width: 5px;
  height: 22px;
  background: #ff7a9c;
  border-radius: 3px;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
}
@media (prefers-reduced-motion: reduce) {
  .feast-muncher.you::after {
    transition: none;
  }
}
```

(The tongue points toward the center only when the muncher is at the top; a fully angle-accurate tongue is a later polish — the FIRE/hit logic is already correct regardless of the tongue’s drawn angle, since `pickTarget` uses `selfAim`.)

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck -w client && npm run build -w client`
Expected: PASS.

- [ ] **Step 5: Run-verify**

With the run harness: confirm moving the pointer over the ring slides your muncher around the rim toward the pointer; clicking (or the FIRE button, or Space) shoots the tongue and grabs the nearest plate in reach — a correct one scores, a wrong one dizzies you; tapping a plate directly still works. Open a second browser profile on the same account to confirm you can see the other muncher move (optional).

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/FeastPage.tsx client/src/pages/FeastPage.css
git commit -m "Feast circle: steer + aim + fire the tongue, broadcast move"
```

---

## Task 11: Client — fact-change cue, positional bump, stun polish

The remaining feel items: play `playFactChange()` + pulse the fact banner when the fact rotates; send `{bump}` when you steer into a rival; disable all input and make the stun obvious while dizzy. Run-verified.

**Files:**

- Modify: `client/src/pages/FeastPage.tsx`
- Modify: `client/src/pages/FeastPage.css`

**Interfaces:**

- Consumes: `playFactChange` (Task 8); `inBumpRange` (Task 6); sends `{type:'bump', targetId}` (existing server handler).

- [ ] **Step 1: Fact-change cue + banner pulse**

In `client/src/pages/FeastPage.tsx`:

1. Import: `import { playComplete, playCorrect, playFactChange, playWrong } from '../sound';`
2. Add a ref: `const lastFact = useRef('');` and `const [factPulse, setFactPulse] = useState(0);`
3. In the `snapshot` case, after setting `snap`, detect a fact change:

```ts
const fk = `${(msg as FeastSnapshot).factA}${(msg as FeastSnapshot).factOp}${(msg as FeastSnapshot).factB}`;
if (lastFact.current && lastFact.current !== fk) {
  playFactChange();
  setFactPulse((n) => n + 1);
}
lastFact.current = fk;
```

4. On the `.feast-fact` element, replay a pulse animation by keying it: `<div className="feast-fact" aria-live="polite" key={factPulse}>`. (Remounting restarts the CSS animation.)

- [ ] **Step 2: Positional bump**

This edits the rAF loop created in Task 10, which already has `snapRef` (set in the `snapshot` case). Read the _fresh_ self player from `snapRef` — the render-scope `me` is captured stale in the loop closure — and add a bump check against other players. Add a bump cooldown ref with the others: `const bumpAt = useRef(0);`.

In the loop body, near the top, read the fresh self once:

```ts
const meNow = snapRef.current?.players.find((p) => p.profileId === profileId);
```

Then, after the move-send block:

```ts
if (!meNow?.stunned && t - bumpAt.current > 400) {
  for (const other of snapRef.current?.players ?? []) {
    if (other.profileId === profileId) continue;
    if (inBumpRange(selfPos.current, other.rimPos)) {
      bumpAt.current = t;
      send({ type: 'bump', targetId: other.profileId });
      break;
    }
  }
}
```

Import `inBumpRange` from `./feastArena`. (The server enforces the real `BUMP_COOLDOWN_MS`; this 400ms local gate just avoids spamming the socket.)

- [ ] **Step 3: Stun polish**

- The FIRE button and plate buttons already use `disabled={me?.stunned}` (render-scope `me`, fresh each render); `fire()` already early-returns when stunned. Also freeze steering while stunned — using the fresh `meNow` from Step 2, replace the loop's unconditional `stepRimPos` line with:

```ts
if (!meNow?.stunned) {
  selfPos.current = stepRimPos(selfPos.current, selfAim.current, dt);
}
setSelfRender({ pos: selfPos.current, aim: selfAim.current });
```

- Add CSS for the fact pulse and a stronger stun tint:

```css
/* Add this one line to the EXISTING .feast-fact rule (near the top of the file): */
/*   animation: feast-fact-pulse 0.4s ease-out; */
@keyframes feast-fact-pulse {
  0% {
    transform: scale(1);
  }
  40% {
    transform: scale(1.25);
    color: var(--sun-shadow);
  }
  100% {
    transform: scale(1);
  }
}
.feast-muncher.you.stunned {
  filter: grayscale(0.7);
  animation: feast-wobble 0.4s ease-in-out infinite;
}
@keyframes feast-wobble {
  0%,
  100% {
    rotate: -6deg;
  }
  50% {
    rotate: 6deg;
  }
}
@media (prefers-reduced-motion: reduce) {
  .feast-fact {
    animation: none;
  }
  .feast-muncher.you.stunned {
    animation: none;
  }
}
```

(Note: the base `.feast-fact` rule already exists in `FeastPage.css` with the font/size/layout; only add the `animation` property to it plus the keyframes — don't duplicate the font/size rules and don't add a second `.feast-fact` block.)

- [ ] **Step 4: Update the hint text**

The playing view’s hint already reads `t('feast.tapHint')` (updated in Task 7) — no change needed. Confirm it renders the new copy.

- [ ] **Step 5: Typecheck + build**

Run: `npm run typecheck -w client && npm run build -w client`
Expected: PASS.

- [ ] **Step 6: Run-verify**

With the run harness: confirm a distinct sound + a banner pop fire exactly when the fact changes; steering your muncher into the bot’s muncher briefly stuns the bot (💫, grayed, on a cooldown); eating a wrong plate freezes your steering/aim/fire for ~1.5s with an obvious dizzy wobble.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/FeastPage.tsx client/src/pages/FeastPage.css
git commit -m "Feast circle: fact-change cue, positional bump, stun polish"
```

---

## Task 12: Update FEAST.md

Bring the design doc in line with the shipped arena so it no longer claims "no player position / no aiming physics."

**Files:**

- Modify: `FEAST.md`

- [ ] **Step 1: Edit**

- In **"What it is"**, change the description from a scrolling belt + tap-to-grab to: a **circular** conveyor; each player steers a **movable muncher** on the rim and **aims + fires a tongue** to grab matching plates; wrong grabs **stun** (wasabi); steering into a rival **bumps** them; a **sound cue** marks each fact change.
- In **"Why it's different from Race"**, replace the "no belt position … deliberately removes movement/collision physics" paragraph with the new split: the server stays authoritative for game _truth_ (plates as scalar `pos`, fact, score, stun, bump cooldown); the **client owns the spatial/aiming layer** (muncher `rimPos`, tongue `aim`/reach, hit-detection) and maps the shared `[0,1]` belt coordinate to a screen circle. Note this is a deliberate reversal of the earlier decision, acceptable under the "anti-cheat is light — kids on one account" stance.
- In **"Architecture" → Client** and **"Broadcast shape"**, add the new player fields `rimPos`/`aim`/`firing` and the new `{move, rimPos, aim, firing}` input; note the pure geometry lives in `client/src/pages/feastArena.ts`.

- [ ] **Step 2: Verify docs-only**

Run: `git diff --stat`
Expected: only `FEAST.md` changed.

- [ ] **Step 3: Commit**

```bash
git add FEAST.md
git commit -m "Docs: FEAST.md reflects the circular sushi-go-round arena"
```

---

## Final verification

- [ ] `npm run typecheck` — PASS (shared/server/client).
- [ ] `npm test` — PASS (server engine + client `feastArena` tests).
- [ ] `npm run build` — PASS (shared → server → client).
- [ ] `npm run lint && npm run format` — clean (fix any findings).
- [ ] Full run-through with the run harness: circular belt; steer + aim + fire; fact-change cue; wrong-plate stun freezes input; positional bump; easier bots; round ends and awards coins as before.

## Spec coverage map

- Bots easier → Task 4 (accuracy/reaction) + Task 3 (steering delay).
- Plates in a circle → Task 9 (render) + Task 6 (geometry).
- Movable muncher → Task 10 (steering) + Task 1 (`rimPos`).
- Aim the tongue to munch → Task 10 (aim + fire + hit-detection) + Task 6 (`pickTarget`).
- Sound on fact change → Task 8 + Task 11.
- Wrong-plate stun → Task 4 (duration) + Task 11 (freeze + visuals); engine rule already present.
- Positional bump → Task 11 (client) + Task 2/5 (unchanged `applyBump`, `move` relay) + Task 6 (`inBumpRange`).
- Authority split, one shared ring, coins/lobby unchanged → Tasks 1/2/5 (server), Tasks 9-11 (client), Task 12 (docs).
