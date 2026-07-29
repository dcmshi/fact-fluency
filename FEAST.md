# Number Feast — real-time math arena

Design notes for the "sushi-go-round" multiplayer game (the first Math Circus
game). Companion to `MULTIPLAYER.md` (the async/live Race). Read `DESIGN.md` for
the product philosophy.

## What it is

Numbered plates orbit a **circular** conveyor (a Pokémon-Stadium
_Sushi-Go-Round_). The current fact (e.g. `6 × 7`) and a countdown timer sit at
the top. Each player rides a **movable muncher** on the ring's rim: point to
steer it around the rim and aim its tongue, then **fire** to munch the plate you
aimed at. Munching a plate whose value matches the answer scores a point; a wrong
munch is consumed and briefly **stuns** you (wasabi); steering **into** a rival
**bumps** them (a short stun, on a cooldown) so you can grab a contested plate. A
**sound cue** fires each time the displayed fact rotates so kids notice the new
target. When the timer runs out, the highest score wins and earns placement
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
(a scalar `pos` 0→1), the current fact, score, stun, and bump cooldown — and
decides correctness when a `grab` arrives (the answer is never sent to clients).
The **client owns the spatial/aiming layer**: its muncher's rim position, the
tongue's aim + reach, and the hit-detection that turns an aimed fire into a
`grab`. Everyone — plates, human munchers, bot munchers — lives in one linear
`[0,1]` belt coordinate; the client alone maps it onto a screen circle (the pure
geometry lives in `client/src/pages/feastArena.ts`). This deliberately reverses
the earlier "no player position / no aiming physics" decision; it's acceptable
under the light-anti-cheat stance (kids share one account), because a mis-aimed
or cheating client still can't invent points — the server owns correctness.
Muncher positions are relayed (see the broadcast shape) purely so everyone can
render everyone.

## Architecture

- **Pure engine** — `server/src/engine/feast.ts`. Framework-free; time and
  randomness are injected, so it's deterministic and unit-tested
  (`feast.test.ts`). State is mutated in place (game-loop style).
  - `createFeastState(players, pool, now, rng)` — seed the round.
  - `stepFeast(state, now, dt, rng)` — move/spawn/despawn plates, rotate the
    fact (recomputing plate correctness), steer bot munchers toward their target
    and drive bot grabs.
  - `applyGrab` / `applyBump` / `applyMove` — validated, authoritative mutations
    (`applyMove` just relays a human muncher's rim position/aim, never trusted
    for scoring).
  - `feastStandings` / `feastSnapshot` — ranking and the client-facing view
    (the answer and per-plate correctness are **never** sent to clients).
  - Tunables live at the top (`ROUND_MS`, spawn cadence, plate speed, stun/bump
    timings, bot reaction/accuracy).
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
  circular arena (ring belt + rim munchers + fact + timer + scores). Point to
  steer + aim (an rAF loop eases the muncher toward the pointer; it only
  re-renders when the muncher actually moved, or the whole arena reconciles
  60×/s on the older tablets this targets); click / a FIRE button / Space shoots
  the tongue → the nearest in-reach plate is `grab`bed. Tapping a plate directly
  aims at _that_ plate and fires — one input path, so reach still applies. (It
  used to also bubble to the ring, sending two grabs at possibly different
  plates: tapping a correct plate across the belt could munch a wrong nearer one
  and stun the kid for a tap that was right.) It sends a throttled
  `move` so others render it, plays a cue + pulses the banner on a fact change,
  bumps a rival on rim proximity, and freezes on a stun. Pure belt geometry +
  hit-detection is isolated (and unit-tested) in `feastArena.ts`. Reuses
  `Muncher`, `sound`, and the RacePage WS pattern.

## Broadcast shape (`@shared`)

`FeastSnapshot { factA, factOp, factB, timeLeftMs, plates: {id,value,pos}[],
players: {profileId,name,avatar,muncher,score,stunned,isBot,rimPos,aim,firing}[]
}` per tick, and `FeastStanding` for the final results. `rimPos`/`aim` (0→1 belt
coordinate) and `firing` are render-only relay fields. Inputs: `{ready} |
{grab, plateId} | {bump, targetId} | {move, rimPos, aim, firing} | {addBot} |
{again}`.

## Decisions

- **Server-authoritative.** Anti-cheat is light (kids on one account), but the
  server owns state for consistency; clients only render + send inputs.
- **No persistence.** Rooms and results are ephemeral (like live Race); only
  coins are written.
- **Bots fill solo play** and are driven entirely server-side in the tick.
- **Bandwidth is trivial** — ≤4 players and a handful of plates at 15 Hz.
