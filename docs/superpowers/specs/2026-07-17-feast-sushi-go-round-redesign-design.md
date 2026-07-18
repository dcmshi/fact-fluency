# Number Feast → "Sushi-Go-Round" redesign

**Date:** 2026-07-17
**Status:** Approved (design), pending implementation plan
**Touches:** `shared/src/index.ts`, `server/src/engine/feast.ts`,
`server/src/feast/live.ts`, `client/src/pages/FeastPage.{tsx,css}`,
`client/src/sound.ts`, `client/src/i18n/*`, `FEAST.md`

## Goal

Reshape the Number Feast arena from a horizontal tap-to-grab belt into a
Pokémon-Stadium _Sushi-Go-Round_ experience:

1. Plates orbit a **circular** conveyor instead of scrolling a straight line.
2. Each player has a **movable muncher** that rides the ring's rim.
3. Players **aim a tongue** and fire it to munch plates (intentional, not
   automatic).
4. A **sound cue** fires the instant the displayed fact rotates.
5. Eating a **wrong** plate **stuns** the muncher for a short, clearly-felt beat.
6. Bots are made **a little easier**.
7. The existing "bump" becomes **positional** — steer into a rival to stun them.

This intentionally reverses the `FEAST.md` decision that players have _no belt
position and no aiming physics_. That decision is re-opened on purpose;
`FEAST.md` will be updated to match.

## Non-goals

- No change to the spaced-repetition scheduler / attempt log (Feast stays pure
  play; only coins persist).
- No change to lobby/countdown/results/coins flow, room keying by account, or
  the WS auth/upgrade path.
- No per-player rings — **one shared ring**, still 1–4 players (solo-vs-bots or
  live siblings), still ephemeral.
- No heavyweight anti-cheat. Kids share one account; light validation only.

## Current state (baseline)

- **Engine** (`server/src/engine/feast.ts`, pure + unit-tested): plates have a
  scalar `pos` (0→1 fraction of trip); `stepFeast` moves/spawns/despawns plates,
  rotates the fact, and drives bot grabs; `applyGrab`/`applyBump` are the
  authoritative mutations; `feastSnapshot` builds the leak-free client view.
  Tunables at the top of the file.
- **WS room** (`server/src/feast/live.ts`): a ~15 Hz `setInterval` tick steps
  the engine and broadcasts `{type:'snapshot', ...}`. Client inputs today:
  `{ready} | {addBot} | {grab, plateId} | {bump, targetId} | {again}`.
- **Client** (`client/src/pages/FeastPage.tsx`): renders plates by `pos` as CSS
  `left: pos*100%`; tapping a plate sends `grab`; tapping a rival sends `bump`.
  Local audio feedback on my own score/stun deltas.
- **Shared DTOs** (`shared/src/index.ts`): `FeastPlateView {id,value,pos}`,
  `FeastPlayerView {profileId,name,avatar,muncher,score,stunned,isBot}`,
  `FeastSnapshot`, `FeastStanding`.

## Core architectural decision — authority split

**The client owns the spatial/aiming layer; the server keeps owning game
truth.** This preserves the pure engine and matches the "anti-cheat is light"
decision.

| Concern                                                       | Owner           | Notes                                                                                  |
| ------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------- |
| Plate set, plate `pos`, spawn/despawn                         | Server engine   | Unchanged.                                                                             |
| Current fact + rotation, scoring, stun, bump cooldown         | Server engine   | Unchanged rules.                                                                       |
| Muncher rim position, tongue aim, tongue reach, hit-detection | Client          | Local, instant, no round-trip.                                                         |
| "This plate got munched"                                      | Client → server | Existing `{grab, plateId}`; server validates existence + correctness exactly as today. |
| Rendering _other_ munchers/tongues                            | Server relay    | New broadcast fields `rimPos`/`aim`/`firing`, relayed only.                            |

Consequence: a mis-aimed or malicious client cannot invent points, because the
server alone decides whether a grabbed plate was correct. Reach/aim is a
gameplay skill layer enforced client-side; it is not a security boundary.

### Why the engine barely changes

Plates stay as scalar `pos` (0→1). The **client** maps `pos → angle` to draw the
ring. Spawning, despawning, fact rotation, correctness, scoring, and stun are all
angle-agnostic and stay as-is. The only genuinely new server-side behavior is
**bot steering** (a cosmetic rim position that eases toward the bot's target) and
**relaying** human position fields.

## Detailed design

### 1. Geometry (client render only)

- The muncher rim is the outer circle; the plate belt is a ring just inside it.
- A plate's `pos` (0→1) maps to an angle: `angle = START_ANGLE + pos * SWEEP`,
  where `SWEEP` is slightly less than a full turn so there's a "kitchen gap"
  where plates enter (`pos≈0`) and exit (`pos≈1`). Despawn is unchanged
  (`pos ≥ 1`).
- Plate screen position: `x = cx + BELT_R*cos(angle)`, `y = cy + BELT_R*sin(angle)`,
  placed via `transform: translate(...)`.
- **Smoothing:** because motion is now angular and more noticeable, the client
  runs a light `requestAnimationFrame` loop that dead-reckons plate angles
  forward at the known belt speed between snapshots and reconciles to the server
  `pos` on each snapshot. (Belt speed is derivable; if needed, the snapshot can
  carry a `beltMsPerTrip` constant. Start simple: reconcile per snapshot, lerp
  between.)

### 2. Controls — point-to-aim (one gesture for steer + aim)

The chosen model is "rim: steer **and** aim angle." To keep two-things-at-once
manageable for kids, a single pointer collapses both:

- **Point / drag** anywhere in the ring: the muncher eases around the rim toward
  the pointer's angular direction, **and** the tongue aims from the muncher
  toward the pointer.
- **Fire:** click (desktop) / tap or a large on-screen **FIRE** button (touch).
  The tongue shoots along the aim up to `TONGUE_REACH`; it grabs the **first**
  plate whose center falls within the tongue's line + a small angular/where
  tolerance. On a hit → send `{grab, plateId}`.
- **Keyboard fallback:** ←/→ steer around the rim; Space fires (aims inward).
- **Accessibility fallback:** tapping a plate directly still sends `{grab,
plateId}` (same contract), for kids who can't manage aiming.
- While **stunned**, steering/aiming/firing are all disabled.

The client sends a throttled `{type:'move', rimPos, aim, firing}` (~12 Hz, and/or
on meaningful change) so other clients can render this muncher. This is the only
new sustained traffic; at ≤4 players it stays trivial.

### 3. Positional bump

- The client detects when _its_ muncher's `rimPos` comes within `BUMP_RANGE`
  (angular) of a rival's `rimPos` and sends `{type:'bump', targetId}`.
- The server applies `applyBump` unchanged: it still enforces `BUMP_COOLDOWN_MS`
  and applies `BUMP_STUN_MS`. No new server geometry; the cooldown prevents spam.
- Bots do not initiate bumps (unchanged).

### 4. Bots — a little easier

Tuning only, in `engine/feast.ts`:

- `BOT_ACCURACY`: `0.82 → 0.70`
- `BOT_MIN_REACT_MS` / `BOT_MAX_REACT_MS`: `450 / 1200 → 700 / 1600`
- New `BOT_MOVE_SPEED` (rim units/sec): each step, a bot's `rimPos` eases toward
  the angle of its intended target plate. Grab still fires on the reaction timer
  (+ accuracy roll) as today, so tested scoring behavior is preserved; the
  movement is primarily visual and adds a small natural delay/miss.

These stay module constants (consistent with the other Feast tunables, which are
not env-driven).

### 5. Wrong-plate stun

- `WRONG_STUN_MS`: `1200 → 1500` (clearly felt without being punitive).
- `BUMP_STUN_MS` stays `900`.
- Stun rule in the engine is unchanged (`applyGrab` on a wrong plate sets
  `stunnedUntil`). The **client** makes it obvious: muncher grays out, dizzy 💫,
  a quick wasabi flash, and all input disabled until it clears.

### 6. Fact-change sound

- New `playFactChange()` in `client/src/sound.ts` — a short, distinct cue,
  audibly different from `playCorrect`/`playWrong`.
- The client detects a fact change by comparing the incoming snapshot's
  `factA/factOp/factB` to the previous snapshot's; on change, play the cue and
  give the fact banner a quick visual pulse.
- No server change (the fact fields are already broadcast every tick).

## Data / contract changes

### `shared/src/index.ts`

- `FeastPlayerView` gains render-only fields:
  ```ts
  rimPos: number; // 0→1 fraction of a turn — muncher position on the rim
  aim: number; // 0→1 fraction of a turn — tongue aim direction (same units as rimPos)
  firing: boolean; // tongue currently extended (for remote render)
  ```
- New input DTO documented alongside the others:
  `{ type: 'move'; rimPos: number; aim: number; firing: boolean }`.
- `FeastPlateView`, `FeastSnapshot`, `FeastStanding` shapes otherwise unchanged.

### `server/src/engine/feast.ts`

- `FeastPlayer` gains `rimPos`, `aim`, `firing` (+ any bot steering scratch).
  Initialize `rimPos` spread around the rim (so players/bots don't stack).
- New pure mutation `applyMove(state, playerId, rimPos, aim, firing)` used by the
  WS layer for human `move` inputs (kept pure + testable for symmetry with
  `applyGrab`/`applyBump`).
- `stepFeast` eases each bot's `rimPos` toward its target plate's angle at
  `BOT_MOVE_SPEED`.
- `feastSnapshot` includes the new player fields.
- Tunable edits from §4/§5.

### `server/src/feast/live.ts`

- `onMessage` handles `{type:'move'}` → `applyMove(...)` during `playing`
  (validate numeric `rimPos`/`aim`, boolean `firing`).
- Update the protocol doc comment. No change to tick/broadcast/coins flow.

### `client/src/pages/FeastPage.{tsx,css}` + `sound.ts` + i18n

- Replace the linear belt render with the circular render + muncher/tongue.
- Add the point-to-aim input handling, FIRE button, keyboard + tap-plate
  fallbacks, and the rAF smoothing loop.
- Send throttled `move`; detect fact change → `playFactChange()` + banner pulse.
- Any new user-facing copy (e.g. FIRE button label, a11y labels, updated hint)
  added to **all four** dictionaries (`en/es/fr/zh`); the build enforces this.

### `FEAST.md`

- Update "Why it's different from Race" / "Broadcast shape" to describe the
  circular belt, movable munchers, aimed tongue, positional bump, and the
  client-owns-spatial / server-owns-truth split.

## Testing

- **Engine (vitest, `feast.test.ts`)** stays the primary correctness surface:
  - Existing tests for spawn/despawn/rotate/grab/bump/stun must still pass with
    the retuned constants (adjust expectations where a constant changed).
  - New: `applyMove` updates the right player's fields and is ignored for
    unknown/absent players.
  - New: bot `rimPos` eases toward a target over successive `stepFeast` calls
    (deterministic given injected `rng`/`now`).
  - New: retuned stun/bot constants exercised where behavior is asserted.
- **Client control/render layer** (circular geometry, aiming, tongue, smoothing)
  is not unit-tested; verified by running the app — `/run` or the browser — and
  watching: plates orbit, muncher steers to pointer, tongue fires + grabs,
  wrong-plate stun freezes input, fact-change cue plays, positional bump lands.
- `npm run typecheck` and `npm test` green before completion.

## Risks / mitigations

- **Angular smoothing jitter** at 15 Hz → rAF dead-reckoning + per-snapshot
  reconcile; keep belt speed a shared constant if drift appears.
- **Two-input overload for young kids** → point-to-aim collapses steer+aim to one
  gesture; tap-a-plate fallback remains.
- **Positional-bump griefiness** → `BUMP_COOLDOWN_MS` unchanged; stun stays
  short; never punitive per the product principles.
- **Client-trusted position** → acceptable by the documented light-anti-cheat
  stance; scoring correctness stays server-owned.

## Open questions

None outstanding — the control model (rim steer + aim), bump (positional), and
the authority split are all decided.
