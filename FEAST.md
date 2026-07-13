# Number Feast — real-time math arena

Design notes for the "sushi-go-round" multiplayer game (the first Math Circus
game). Companion to `MULTIPLAYER.md` (the async/live Race). Read `DESIGN.md` for
the product philosophy.

## What it is

A belt of numbered plates scrolls past. The current fact (e.g. `6 × 7`) and a
countdown timer sit at the top. Players **tap** the plates whose value matches
the answer to score points; a wrong tap is consumed and briefly **stuns** them
(wasabi); tapping a rival **bumps** them (a short stun, on a cooldown) so you can
grab a contested plate. The displayed fact rotates every few seconds. When the
timer runs out, the highest score wins and earns placement coins. 1–4 players:
solo vs. bots, or live with siblings on other devices (same account).

Like Race, Feast **never touches the spaced-repetition scheduler or the attempt
log** — it's pure play; only coins are credited.

## Why it's different from Race

Race is request/response: each player runs their **own** deck in parallel and
reports `progress`/`finish`; the server just ranks scores. Feast is a **shared,
server-authoritative real-time playfield**: one belt of plates that everyone
sees and competes over, driven by a server **tick loop** (~15 Hz) that
broadcasts snapshots. Clients render and send discrete inputs (`grab`, `bump`);
they never own game state.

Tap-to-grab means players have **no belt position** — the only spatial thing is
the plates. That deliberately removes movement/collision physics: "bumping" is a
discrete tap on a rival's muncher, not a positional collision. Much simpler to
sync, still fun.

## Architecture

- **Pure engine** — `server/src/engine/feast.ts`. Framework-free; time and
  randomness are injected, so it's deterministic and unit-tested
  (`feast.test.ts`). State is mutated in place (game-loop style).
  - `createFeastState(players, pool, now, rng)` — seed the round.
  - `stepFeast(state, now, dt, rng)` — move/spawn/despawn plates, rotate the
    fact (recomputing plate correctness), drive bot grabs.
  - `applyGrab` / `applyBump` — validated, authoritative mutations.
  - `feastStandings` / `feastSnapshot` — ranking and the client-facing view
    (the answer and per-plate correctness are **never** sent to clients).
  - Tunables live at the top (`ROUND_MS`, spawn cadence, plate speed, stun/bump
    timings, bot reaction/accuracy).
- **WS room + tick** — `server/src/feast/live.ts` (slice 2), mirroring
  `race/live.ts`: cookie-authenticated upgrade on `/api/feast-ws`, ephemeral
  in-memory rooms, lobby → countdown → playing → finished, a `setInterval` tick
  that steps the engine and broadcasts `feastSnapshot`. Bots run server-side in
  the tick. Coins via `placementCoins` on finish.
- **Client** — `client/src/pages/FeastPage.tsx` (slice 3): connect, lobby,
  countdown, arena (belt + munchers + fact + timer + scores), tap-to-grab /
  tap-to-bump, light interpolation between snapshots. Reuses `Muncher`,
  `CelebrationBurst`, `sound`, and the RacePage WS pattern.

## Broadcast shape (`@shared`)

`FeastSnapshot { factA, factOp, factB, timeLeftMs, plates: {id,value,pos}[],
players: {profileId,name,avatar,muncher,score,stunned,isBot}[] }` per tick, and
`FeastStanding` for the final results. Inputs: `{ready} | {grab, plateId} |
{bump, targetId} | {addBot}`.

## Decisions

- **Server-authoritative.** Anti-cheat is light (kids on one account), but the
  server owns state for consistency; clients only render + send inputs.
- **No persistence.** Rooms and results are ephemeral (like live Race); only
  coins are written.
- **Bots fill solo play** and are driven entirely server-side in the tick.
- **Bandwidth is trivial** — ≤4 players and a handful of plates at 15 Hz.
