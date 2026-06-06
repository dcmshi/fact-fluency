# Fact Fluency — Design Doc

## 1. Vision

A browser-based app that helps kids build **fact fluency** in the four math
operations (addition, subtraction, multiplication, division) through **spaced
repetition**, without it feeling like a worksheet grind.

"Fluency" here means more than _getting the right answer_ — it means recalling a
fact **correctly and quickly** (automatic recall), so working memory is freed up
for harder problems later.

Two hard requirements drive every design decision:

1. **Runs in any modern browser** — playable on a school Chromebook, a home
   laptop, or a tablet. Deployable locally (`npm run dev`) or as a small
   single-service deploy on Render.
2. **Doesn't feel tedious** — short sessions, adaptive difficulty, immediate
   warm feedback, and visible progress. The spaced-repetition machinery is
   invisible to the kid.

### Non-goals (for v1)

- Not a full LMS / gradebook export.
- Not multiplayer or real-time competitive.
- No video lessons or teaching of _concepts_ — this is a **fluency drill**, it
  assumes the concept is already understood.
- No native mobile app (responsive web only).

---

## 2. Users & Roles

| Role                       | Who                      | Can do                                                                         |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| **Adult** (parent/teacher) | Owns the account         | Create/manage kid profiles, enable fact sets per kid, view progress dashboards |
| **Kid**                    | A profile under an adult | Pick their profile, play sessions, see their own progress map and rewards      |

- One **adult account** (email + password) holds **many kid profiles**.
- Kids do **not** log in with a password — they tap their profile avatar from a
  profile picker on the adult's authenticated session. Frictionless for young
  kids; data stays behind the adult's auth.
- A kid profile is scoped to exactly one adult account.

### Auth specifics (pinned)

- Passwords hashed with **argon2id**.
- **Server-side session table** (`AuthSession`) keyed by a random opaque token
  stored in an **httpOnly, SameSite=Lax, Secure** cookie. No JWTs.
- Sessions expire after 30 days idle; logout deletes the row.

---

## 3. The Fact Model

The core unit is a **Fact**: a single arithmetic problem.

```
Fact {
  id            // canonical, stable — see id rules below
  operation     // 'add' | 'sub' | 'mul' | 'div'
  operandA
  operandB
  answer
}
```

Facts are **generated** by a pure function, never hand-stored. The universe is
small and deterministic.

### 3.1 Fact sets — full grid (pinned)

A **FactSet** is a catalog entry an adult enables per kid. Each set covers a
**2-D range** of operands:

```
FactSet { id, operation, label, rangeSpec: { aMin, aMax, bMin, bMax } }
```

Generation rules **per operation** (this is the exact, unambiguous spec):

- **add** — for every `a ∈ [aMin..aMax]`, `b ∈ [bMin..bMax]`: `answer = a + b`.
  Commutative → **canonicalize so `a ≤ b`** (3+7 and 7+3 are the _same_ fact).
- **mul** — same as add, commutative, canonicalize `a ≤ b`. `answer = a · b`.
- **sub** — generated as the inverse of addition so results are **never
  negative**. Minuend `m ∈ [aMin..aMax]`, subtrahend `b ∈ [bMin..min(m,bMax)]`:
  `answer = m − b`. Not commutative — order is meaningful.
- **div** — generated as the inverse of multiplication so results are **always
  whole, no ÷0**. Quotient `q ∈ [aMin..aMax]`, divisor `d ∈ [max(1,bMin)..bMax]`:
  `dividend = q · d`, fact is `(q·d) ÷ d = q`. Not commutative.

**Canonical fact ids:**
`add:3+7`, `mul:3x7` (commutative ops always written with `a ≤ b`),
`sub:15-7`, `div:56/7`. Ids are stable across sessions and profiles.

### 3.2 Difficulty ordering

New facts are introduced **easiest-first**, ordered by `(operandA + operandB)`
ascending, then by `answer` ascending as a tiebreak. Used by the session planner
(§4.4) so a kid meets `2 × 3` before `9 × 8`.

### 3.3 Seed catalog (pinned)

v1 ships a **broad catalog across all four operations**; the adult enables what
each kid needs. Sets are named by **operand range** (not by sum) to match the
full-grid model and avoid "to 10 = sums to 10?" confusion.

| Operation | Seeded sets (rangeSpec interpreted per §3.1)             |
| --------- | -------------------------------------------------------- |
| add       | `0–5`, `0–10`, `0–12`                                    |
| sub       | `0–10`, `0–20` (range = minuend; subtrahend `0…minuend`) |
| mul       | `0–5`, `0–10`, `0–12`                                    |
| div       | `0–5`, `0–10`, `0–12` (range = quotient × divisor)       |

**Onboarding pre-checks** a gentle starter — _Addition 0–10_ and
_Multiplication 0–5_ — which the adult can change before handing off.

---

## 4. Spaced Repetition & Fluency Engine

The heart of the app. Two ideas combined:

1. **Spaced repetition** — schedule each fact to reappear at growing intervals,
   concentrating effort on weak facts.
2. **Fluency gating** — a fact isn't "mastered" until answered both _correctly_
   **and** _quickly_ (under the kid's adaptive threshold, §4.5). Speed is a
   first-class signal.

### 4.1 Per-fact state

For each `(profile, fact)` pair, a `FactProgress` row:

```
FactProgress {
  profileId
  factId
  box            // 0 (learning) … 5 (mastered)
  state          // 'learning' | 'review' | 'mastered'
  dueAt          // when this fact should next surface (persistent schedule)
  lastSeenAt
  reps           // total attempts
  fastCorrect    // count of correct-AND-fast answers
  correctStreak  // consecutive correct-and-fast (for display/points)
  accuracyEwma   // rolling % correct
  medianMsEwma   // rolling median response time (correct answers)
}
```

A fact with **no** `FactProgress` row is "unseen."

### 4.2 Two-tier scheduling (pinned)

There are **two distinct mechanisms**; keeping them separate removes the
biggest ambiguity in the old draft:

1. **Persistent schedule (Leitner boxes)** — `dueAt` on `FactProgress`. Governs
   _across_ sessions: which facts are due today/this week. Box intervals:

   | Box | State    | Interval until due again                                    |
   | --- | -------- | ----------------------------------------------------------- |
   | 0   | learning | n/a — lives in the in-session queue, `dueAt` = next session |
   | 1   | review   | 1 day                                                       |
   | 2   | review   | 2 days                                                      |
   | 3   | review   | 4 days                                                      |
   | 4   | review   | 8 days                                                      |
   | 5   | mastered | 21 days                                                     |

   Intervals **< 1 day** don't exist in the persistent schedule — that job
   belongs to tier 2. Intervals **≥ 1 day** snap to a **calendar-day boundary**
   in the **adult's timezone** (stored on the account), so "due tomorrow" lands
   the next morning, not 24h later.

2. **In-session queue** — ephemeral, lives in the `Session` row's working state.
   Governs _within_ a session: incremental rehearsal of just-missed and
   just-introduced facts. A fact re-shown "a few cards later" is the in-session
   queue at work, **not** a sub-day box interval.

### 4.3 Promotion / demotion rules (pinned)

Evaluated on every answer.

**Box 0 (learning, in-session only):**

- A fact enters box 0 via the **study-first** intro (§4.6).
- Each correct answer increments an in-session counter; **2 correct answers
  in the session** (speed _not_ required — it was just taught) promote it to
  **box 1**. Wrong answer resets the in-session counter and re-queues it sooner.
- At session end: if still box 0, persist at box 0 with `dueAt` = next session.

**Boxes 1–4 (review):**

- **Correct AND fast** → promote +1 box, set `dueAt` from the new box interval.
- **Correct but slow** → stay in box; set `dueAt` to **half** the box interval
  (knows it, not yet automatic — see it sooner).
- **Wrong** → demote to `max(0, box − 2)`, add to the in-session re-show queue.

**Box 5 (mastered):**

- **Correct AND fast** → stay mastered, 21-day interval.
- **Correct but slow** → demote to box 4.
- **Wrong** → demote to box 2, add to in-session re-show queue.

`state` is derived: box 0 → `learning`, 1–4 → `review`, 5 → `mastered`.
**Mastery is only reachable through sustained correct-and-fast answers across
spaced intervals** — genuine automaticity, not a single lucky fast answer.

### 4.4 Session composition — keeping it "just right"

Each session is assembled by a pure `SessionPlanner`:

- **Length:** `min(20 cards, 3 minutes)` (both configurable per profile).
- **Mix:** mostly **due review** facts (box ≥ 1, `dueAt ≤ now`), salted with
  **2–4 new facts** (default 3, configurable) drawn easiest-first (§3.2) from
  the kid's enabled sets.
- **Interleaving:** new/weak facts are spaced among easy wins, never clustered.
- **Incremental rehearsal:** a missed fact is re-queued a few cards later among
  known facts, then again further out.
- **Recency guard:** never the same fact twice back-to-back.
- **Target success rate ≈ 80%** — the planner caps how many hard/new facts ride
  in one session to protect this.

**Edge case — nothing (or little) is due (pinned):** never block a kid from
playing. The planner fills in this priority order: (1) due review facts, (2)
soonest-upcoming review facts pulled forward, (3) extra **new** facts beyond the
normal 2–4 cap, (4) if a set is fully mastered, light review of mastered facts.
A "you've mastered everything here — ask a grown-up to add more!" state is shown
only when _all_ enabled sets are fully mastered.

### 4.5 Adaptive fluency threshold (pinned)

The "fast enough" cutoff is **per profile, per operation**, and adapts to the
kid's own speed.

- Track a rolling median of **correct** response times per `(profile, operation)`
  as an EWMA: `medianMsEwma`, stored in `OperationStat`.
- **Cold start:** until the kid has `≥ 20` correct samples for that operation,
  the threshold is a lenient **absolute ceiling** (`add/sub: 6000ms`,
  `mul/div: 8000ms`).
- **Warm:** `threshold = clamp(K × medianMsEwma, floor, ceiling)` where
  `K = 1.3`, `floor = 1200ms`, `ceiling` as above. A fact counts as **fast**
  when `responseMs ≤ threshold`.

Rationale: a fact the kid _recalls_ lands at/below their typical pace; a fact
they _compute_ (counting up, etc.) runs slower. Anchoring to their own median
distinguishes the two and tightens automatically as they speed up — fair to
beginners, demanding of the fluent. **All constants (`K`, floor, ceiling, sample
threshold) are tuning knobs** to be calibrated against real `Attempt` data.

### 4.6 New-fact introduction — study-first (pinned)

When a brand-new fact first appears:

1. **Study card** — shows the full fact with its answer (`7 × 8 = 56`) for a
   brief beat (until tap, min ~1.5s). No input. This _teaches_, avoiding a cold
   failure.
2. **Immediate typed recall** — the same fact is quizzed right away as a normal
   **typed** question (box 0, attempt 1). Because it was just shown, this is
   recall-after-study, not a cold quiz.
3. The fact is now in box 0 and follows §4.3 box-0 rules.

Single input modality everywhere: **typed** (§4.7). No multiple-choice.

### 4.7 Answer input & timing (pinned)

- **Typed** via an on-screen number pad (works on touch + keyboard). Hardware
  keyboard digits also accepted.
- **`responseMs`**: timer starts when the card is fully rendered/interactive,
  stops on submit.
- **Submit is explicit** (Enter / a Go button) — **no auto-submit** on digit
  count, so multi-digit answers aren't judged mid-type.
- **Wrong answer**: reveal the correct answer briefly before advancing; the fact
  is demoted (§4.3) and re-queued in-session.
- **Source of truth**: the client measures `responseMs` and sends it; the
  **server** recomputes correctness, `fast`, and all scheduling decisions and is
  the sole writer of persisted state. Client timing is advisory input.
- **Instant feedback / threat model**: card payloads **include the answer** and
  the session payload includes the current per-operation `threshold`, so the
  client renders correct/incorrect + fast feedback with zero latency. Kids are
  **not** an adversarial threat model — leaking answers to the client is an
  accepted tradeoff for snappy feedback; the server still independently recomputes
  and persists state from the reported `given`/`responseMs` (§4.9).

### 4.8 Why this won't feel tedious

| Lever               | How                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Short bursts        | 2–3 min sessions; always a clear, near finish line                                                                  |
| Adaptive difficulty | ~80% success; new facts trickle in, never flood                                                                     |
| Immediate feedback  | Instant correct/incorrect, warm and non-punitive                                                                    |
| Visible progress    | A **fact grid** that lights up as facts master; streaks                                                             |
| Gentle gamification | Points & streaks _reward_ effort; slowness is never _punished_                                                      |
| Respect the kid     | No harsh visible countdown for beginners; speed is encouraged via the adaptive threshold, not a stopwatch on screen |

### 4.9 Card delivery — client-holds-deck, server-injects (pinned)

The client plays through a deck snappily (no round-trip _to advance_), while the
server stays authoritative over persisted state and reactive re-shows:

1. `POST …/session` returns a **starter deck** (the planned ~20 cards, including
   any study-first new-fact intros), the current per-operation `threshold`s, and
   answers embedded in each card (§4.7).
2. The client plays a card, shows **instant** feedback locally, and **reports**
   the answer (`given`, `responseMs`) without blocking — it keeps playing the
   cards it already holds.
3. The server's reply to a report is authoritative and may carry **injects**:
   `{ factId, afterOffset }` to splice a re-show (incremental rehearsal §4.4) a
   few cards later, or appended cards if the deck is running short. The client
   splices injects as they arrive; because re-shows are scheduled "a few cards
   out," the round-trip lands in time.
4. `POST …/complete` finalizes; the server reconciles `FactProgress` from the
   `Attempt` log (the report stream), so a dropped report can't corrupt state.

`Session.workingState` mirrors the deck + queue so a refresh resumes cleanly.

### 4.10 Daily goal & "all caught up" (pinned)

- A kid's **daily goal** = clear all **due** facts (box ≥ 1, `dueAt ≤ today` in
  the account timezone) across enabled sets, plus the day's new-fact intros.
- When the due queue empties, show a celebratory **"all caught up!"** moment.
  Further play is allowed and framed as **bonus**, falling through the §4.4 fill
  order (pull-forward / extra new facts).
- **Streak = consecutive days with ≥ 1 _completed_ session** — rewards showing
  up, _not_ perfectly clearing the queue (non-punitive, per the design ethos).
  Hitting "all caught up" is a same-day celebration, never a streak gate.

---

## 5. Architecture

A single full-stack app, one deployable service.

```
┌─────────────────────────────────────────────┐
│  Browser (any modern)                         │
│  ┌─────────────────────────────────────────┐ │
│  │ React SPA (Vite)                          │ │
│  │  - Profile picker / adult dashboard       │ │
│  │  - Session player (the game)              │ │
│  │  - Progress views (fact grid, streaks)    │ │
│  └───────────────┬───────────────────────────┘ │
└──────────────────┼─────────────────────────────┘
                   │  JSON over HTTP (/api/*)
┌──────────────────▼─────────────────────────────┐
│  Express server (Node)                           │
│   - Auth (adult sessions, cookie-based)          │
│   - REST API                                     │
│   - Fluency/scheduling engine (PURE functions)   │
│   - Serves built SPA static files in production  │
└──────────────────┬───────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────┐
│  SQLite (dev & small deploy) → Postgres (Render)  │
│   via a thin DB adapter so the swap is one seam   │
└───────────────────────────────────────────────────┘
```

### 5.1 Tech choices

- **Frontend:** Vite + React + TypeScript. React Query for server state.
- **Backend:** Node + Express + TypeScript. Cookie-based adult sessions (§2).
- **DB:** SQLite locally / tiny deploys; one DB-adapter interface so Postgres
  drops in for Render without touching app logic. Lightweight migration runner.
- **The engine is pure:** all scheduling/fluency/planner logic lives in
  framework-free, fully unit-tested pure functions (`server/engine`). **No
  `Date.now()` reached for inside the engine — time is passed in.** The DB and
  HTTP layers feed it state and persist its output.

### 5.2 Single-service deploy

In production Express serves the built React bundle as static files — **one**
Render service + a Postgres add-on. Locally, Vite dev server proxies `/api` to
Express.

---

## 6. Data Model (pinned for v1)

```
Account      { id, email, passwordHash, timezone, createdAt }
AuthSession  { id /*opaque token*/, accountId, expiresAt }
Profile      { id, accountId, displayName, avatar, settings, createdAt }
                // settings: { sessionCards, sessionSeconds, newPerSession }
FactSet      { id, operation, label, rangeSpec }            // seeded catalog
ProfileFactSet { profileId, factSetId, enabled }            // which sets a kid does
FactProgress { profileId, factId, box, state, dueAt, lastSeenAt,
               reps, fastCorrect, correctStreak, accuracyEwma, medianMsEwma }
OperationStat{ profileId, operation, medianMsEwma, correctSamples }  // for §4.5
Session      { id, profileId, startedAt, completedAt, plannedCount,
               workingState /* JSON: in-session queue + box-0 counters */ }
Attempt      { id, sessionId, profileId, factId, given, correct,
               fast, responseMs, answeredAt }                // append-only log
```

- `Attempt` is the append-only event log (dashboard + engine tuning).
- `FactProgress` is the derived current state.
- `Session.workingState` persists the in-session queue (§4.2 tier 2) as JSON so
  a page refresh mid-session resumes cleanly.

---

## 7. Key User Flows

1. **Adult onboarding:** sign up → set timezone → create first kid profile →
   enable starting fact sets (sensible defaults pre-checked) → hand off device.
2. **Kid plays:** profile picker → "Play" → planner builds session → study-first
   intros + typed cards (~20 / 3 min) → celebratory summary (facts mastered,
   streak, points) → done.
3. **Adult checks in:** dashboard → per-kid fact grid (mastered/learning/unseen),
   accuracy & speed trends, suggested next set to enable.

---

## 8. API Sketch

```
POST /api/auth/signup            { email, password, timezone }
POST /api/auth/login             { email, password }
POST /api/auth/logout

GET  /api/profiles               -> [Profile]
POST /api/profiles               { displayName, avatar }
PATCH/api/profiles/:id           { settings }
GET  /api/profiles/:id/factsets  -> available + enabled sets
PUT  /api/profiles/:id/factsets  { enabledIds }

POST /api/profiles/:id/session   -> { sessionId, deck: [Card…], thresholds }
                                 // Card: { fact, answer, isNew }  (answer embedded, §4.7)
                                 // thresholds: per-operation fast cutoff (§4.5)
POST /api/sessions/:id/answer    { factId, given, responseMs }   // report, non-blocking
                                 -> { correct, fast, updatedProgress,
                                      injects?: [{ factId, afterOffset }],
                                      appendCards?: [Card…],
                                      caughtUp?: boolean }        // §4.9, §4.10
POST /api/sessions/:id/complete  -> { summary }                  // server reconciles state

GET  /api/profiles/:id/progress  -> fact grid + trends for the dashboard
```

---

## 9. Roadmap

**v1 (MVP)**

- Adult auth + kid profiles + timezone
- **All four operations**, full-grid seed catalog (§3.3)
- Two-tier scheduling engine + adaptive threshold + session planner
- Client-holds-deck / server-injects session player (§4.9): study-first intro,
  typed number pad, wrong-answer reveal, "all caught up" goal (§4.10)
- Fact grid progress view + daily streak + points

**v1.1**

- Adult dashboard with accuracy/speed trends
- Unlockable avatars/themes

**Later**

- Calibrate engine constants (§4.5) from `Attempt` history
- Offline play with sync
- Lightweight classroom mode (many profiles, quick switch)
- Fact-family framing (link `7×8` ↔ `56÷7`) for transfer

---

## 10. Defaults chosen for ambiguous points (for the record)

These were resolved to keep implementation unambiguous; revisit if needed:

- **Streaks** = consecutive **days** with ≥1 completed session. **Points** =
  +1 per correct, +1 bonus per correct-and-fast; cosmetic only.
- **Division/subtraction** generated as inverses (no negatives, no ÷0, whole
  quotients) — §3.1.
- **Commutative canonicalization** — `a+b`/`a·b` stored once with `a ≤ b`.
- **Multiple sessions/day allowed**; spaced repetition naturally resists cramming
  because boxes ≥ 1 won't come due again same-day. Replays past "nothing due"
  fall through the §4.4 fill order.
- **Timezone** lives on the `Account`; all `≥1 day` interval math snaps to that
  zone's calendar days.
- **Session counting:** the study screen is a preface, not a counted card; the
  recall attempt is. Re-shows count toward a hard ceiling of **~30 total
  presentations** so a session stays ~3 min even with many misses.
- **Abandoned session:** reopened the _same day_ → resume from `workingState`;
  otherwise discard and plan fresh. Streak/points credited only on `complete`.
- **One active session per profile** at a time.
- **Avatars:** a predefined picker (emoji/illustration set), no uploads.
- **Zero enabled sets:** "Play" is disabled with a "grown-up, pick some facts"
  prompt — a session can't be built from nothing.
- **EWMA α = 0.2** for `medianMsEwma` / `accuracyEwma` (tunable).
- **Answers in payload:** cards embed their answer for instant client feedback;
  kids aren't an adversarial threat model (§4.7). Server stays sole state writer.
- **Config via env:** `PORT`, `DATABASE_URL` (`sqlite:` path vs `postgres:` URL
  selects the adapter), `COOKIE_SECRET`; DB seeding runs as part of migrate.
- **Fact grid:** one 2-D grid per operation (operand A × operand B), cells
  colored by box.
- **Disabling a set retains progress:** disabling a set stops drawing its facts
  into new sessions but keeps existing `FactProgress`, so re-enabling restores
  mastery rather than wiping it.

## 11. Open Questions (still genuinely open)

- Exact tuning of fluency constants (`K`, floor, ceiling, cold-start sample
  count) — needs a first pass then calibration on real data.
- Starting fact-set defaults per typical grade band.
- How aggressively to raise `newPerSession` for a kid racing ahead (auto-bump vs
  adult-controlled).

## 12. Addendum — Number Munchers interaction (supersedes §4.6 step 2, §4.7)

The recall interaction pivoted from typed entry to a **Number Munchers–style
grid game**, to make practice feel like play. This _replaces_ the typed
number-pad (§4.7) and step 2 of the study-first intro (§4.6); everything else
in §4 is unchanged — crucially, the **spaced-repetition + fluency engine still
chooses which facts appear and still owns all scheduling state.** Munching is a
new _interaction layer_ over the same brain.

- **A round:** the fact's expression (e.g. `3 × 4`) shows at the top with a
  relation — \*munch everything **equal to** / **less than** / **greater than\***
  it — over a 5×5 grid of numbers. The kid drives a muncher (arrows/WASD +
  Space, or tap) to eat the cells satisfying the relation vs the answer.
- **Board generation** is a pure, seeded function (`engine/munch.ts`): correct
  cells + plausible distractors, ≥1 correct guaranteed, `<` only when feasible.
  Boards travel in the `Card` and persist in `workingState` (resume replays the
  same board).
- **Grading reuse:** `gradeAnswer` now takes `correct` (not `given`) — the
  round decides it: `correct` = a **clean clear** (all correct eaten, zero wrong
  munches); `responseMs` = **time to first correct munch** (recognition speed,
  feeding the same per-op `fast` threshold). Promotion/demotion, boxes, dueAt,
  operation stats, dashboard, coins/themes, streaks all carry over unchanged.
- **Non-punitive (§4.8):** no chasing enemies, no visible countdown. Study-first
  still teaches a brand-new fact before its first munch round.
