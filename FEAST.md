# Number Feast — real-time math arena

Design notes for the "sushi-go-round" multiplayer game (the first Math Circus
game). Companion to `MULTIPLAYER.md` (the async/live Race). Read `DESIGN.md` for
the product philosophy.

## What it is

Numbered plates orbit a **circular** conveyor (a Pokémon-Stadium
_Sushi-Go-Round_). The current fact (e.g. `6 × 7`) and a countdown timer sit at
the top. Each player controls a **movable muncher inside the ring**: point or use
WASD/arrow keys to move freely around the arena and aim its tongue, then **fire**
to munch the plate you aimed at. Munching a plate whose value matches the answer
scores a point; a wrong munch is consumed and **stuns** you for 2.5 seconds
(wasabi); steering **into** a rival physically **shoves** both munchers apart
using Stadium's body-collision response, so you can contest space around a
plate. The conveyor has Stadium's **12 fixed table slots**: an eaten table stays
empty for about two seconds, then refills in place; uneaten dishes survive full
laps instead of being replaced. The displayed fact stays up for **18 seconds**, and a **sound cue**
fires when it rotates so kids notice the new target. When the timer runs out,
the highest score wins and earns placement
coins. 1–4 players: solo vs. bots, or live with siblings on other devices (same
account).

Like Race, Feast **never touches the spaced-repetition scheduler or the attempt
log** — it's pure play; only coins are credited.

## Why it's different from Race

Race is request/response: each player runs their **own** deck in parallel and
reports `progress`/`finish`; the server just ranks scores. Feast is a **shared,
server-authoritative real-time playfield**: one ring of plates that everyone
sees and competes over, driven by a server **tick loop** (~15 Hz) that
broadcasts snapshots.

**Authority split.** The server stays authoritative for game _truth_ — plates
(a scalar `pos` 0→1), the current fact, score, and wrong-answer stun — and
decides correctness when a `grab` arrives (the answer is never sent to clients).
The **client owns the spatial/aiming layer**: its muncher's normalized `(x,y)`
position inside the circle, the tongue's aim + reach, and the hit-detection that
turns an aimed fire into a `grab`. Plates retain their linear `[0,1]` belt
coordinate; players use true 2-D arena coordinates, matching Stadium's movement
model (the pure geometry lives in `client/src/pages/feastArena.ts`). This
deliberately reverses the earlier "no player position / no aiming physics"
decision; it's acceptable
under the light-anti-cheat stance (kids share one account), because a mis-aimed
or cheating client still can't invent points — the server owns correctness.
Muncher positions are relayed so everyone can render everyone. Validated body
contacts also accumulate a server push displacement for the remote owner, so a
CPU or another player actually moves when shoved.

## Architecture

- **Pure engine** — `server/src/engine/feast.ts`. Framework-free; time and
  randomness are injected, so it's deterministic and unit-tested
  (`feast.test.ts`). State is mutated in place (game-loop style).
  - `createFeastState(players, pool, now, rng)` — seed the round.
  - `stepFeast(state, now, dt, rng)` — rotate/refill the twelve stable table
    slots, rotate the fact (recomputing plate correctness), steer bot munchers
    toward their target and drive bot grabs. Empty tables refill first; only if
    all twelve are occupied and none matches a new fact is the oldest wrong
    plate recycled.
  - `applyGrab` / `applyMove` — validated, authoritative mutations
    (`applyMove` just relays a human muncher's normalized position/aim, never trusted
    for scoring).
  - `feastStandings` / `feastSnapshot` — ranking and the client-facing view
    (the answer and per-plate correctness are **never** sent to clients).
  - Tunables live at the top (`ROUND_MS`, table refill/lap speed, stun timings,
    bot reaction/accuracy).
- **WS room + tick** — `server/src/feast/live.ts` (slice 2), mirroring
  `race/live.ts`: cookie-authenticated upgrade on `/api/feast-ws`, ephemeral
  in-memory rooms, lobby → countdown → playing → finished, a `setInterval` tick
  that steps the engine and broadcasts `feastSnapshot`. Bots run server-side in
  the tick. Coins via `placementCoins` on finish.
  - **Room lifetime is the fragile part**, and it shares the guards Race uses
    (`ws/heartbeat.ts`, `ws/upgrade.ts`): a liveness heartbeat, so a half-open
    socket can't sit in `connectedHumans` forever; a socket-identity check in
    `close`, so a reconnect's stale close can't tear the room down under the
    live socket; and a re-check of the start condition on disconnect, so the
    player left behind isn't stuck in a lobby that can never start.
  - `go()` awaits the database for the fact pool, and everyone can leave during
    that await — it re-checks for connected humans before starting the tick, or
    it would orphan a 90s `setInterval` nothing can clear and then hand out
    coins for a game with no players in it.
  - The 1–4 arena cap applies to **humans as well as bots**; an account with
    five-plus profiles used to overflow the rim (extra joins get `arena_full`).
- **Client** — `client/src/pages/FeastPage.tsx`: connect, lobby, countdown,
  circular arena (ring belt + interior munchers + fact + timer + scores). Pointer
  distance acts like analogue-stick tilt; WASD/arrow holds provide two-axis
  digital stick input, and Space/Enter or FIRE extends the tongue. Keyboard
  listeners cover the whole playing phase, so clicking a plate or button does
  not disable movement. The rAF loop uses the original Stadium movement ratios
  (10-unit stick dead zone, 74-unit cap,
  0.8 grounded acceleration and 0.2 braking/reversal) normalized directly from
  its free 2-D radius-130 arena, with a browser feel scale of 0.62. The
  conversion is frame-rate independent and caps background-tab catch-up. It
  only re-renders when the muncher actually moved, or the whole arena reconciles 60×/s on the older
  tablets this targets. A shot sweeps Stadium's 30-world-unit tongue-tip sphere
  along the visible tongue, including the small interpolation gap between
  server snapshots; tapping a plate directly aims at _that_ plate and fires, so a far target cannot
  consume an unrelated nearby plate.
  Arena-space SVG tongues connect each muncher to that aim point. It sends a
  throttled `move` so others render it, plays a cue + pulses the banner on a fact
  change, applies Stadium's 40-world-unit body collision response (incoming
  speed impulse plus full overlap separation), and freezes after a wrong grab.
  The pre-separation impact point/velocity is sent with each move; the server
  validates the swept contact and accumulates the displacement on the pushed
  CPU/player. Player velocity is relayed so humans and CPUs produce the same physical shove. Pure 2-D
  geometry + physics + hit-detection is isolated (and unit-tested) in
  `feastArena.ts`. Reuses `Muncher`, `sound`, and the RacePage WS pattern.

## Broadcast shape (`@shared`)

`FeastSnapshot { factA, factOp, factB, timeLeftMs, plates: {id,value,pos}[],
players: {profileId,name,avatar,muncher,score,stunned,isBot,x,y,vx,vy,pushX,pushY,pushVx,pushVy,aimX,aimY,firing}[]
}` per tick, and `FeastStanding` for the final results. The normalized position,
unit aim vector, cumulative push, and `firing` are spatial relay fields. Inputs: `{ready} |
{grab, plateId} | {move, x, y, vx, vy, impactX, impactY, impactVx, impactVy, aimX, aimY, firing} | {addBot} |
{again}`.

## Decisions

- **Server-authoritative.** Anti-cheat is light (kids on one account), but the
  server owns state for consistency; clients only render + send inputs.
- **No persistence.** Rooms and results are ephemeral (like live Race); only
  coins are written.
- **Bots fill solo play** and are driven entirely server-side in the tick.
- **Bandwidth is trivial** — ≤4 players and a handful of plates at 15 Hz.
