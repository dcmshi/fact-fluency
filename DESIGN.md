# Fact Fluency — Design Doc

## 1. Vision

A browser-based app that helps kids build **fact fluency** in the four math
operations (addition, subtraction, multiplication, division) through **spaced
repetition**, without it feeling like a worksheet grind.

"Fluency" here means more than *getting the right answer* — it means recalling a
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
- No video lessons or teaching of *concepts* — this is a **fluency drill**, it
  assumes the concept is already understood.
- No native mobile app (responsive web only).

---

## 2. Users & Roles

| Role | Who | Can do |
| --- | --- | --- |
| **Adult** (parent/teacher) | Owns the account | Create/manage kid profiles, pick which operations & fact ranges are active, view progress dashboards |
| **Kid** | A profile under an adult | Pick their profile, play sessions, see their own progress map and rewards |

- One **adult account** (email + password) holds **many kid profiles**.
- Kids do **not** log in with a password — they tap their profile avatar from a
  profile picker on the adult's device/session. This keeps it frictionless for
  young kids while keeping data behind the adult's auth.
- A kid profile is scoped to exactly one adult account.

---

## 3. The Fact Model

The core unit is a **Fact**: a single arithmetic problem.

```
Fact {
  id            // stable, e.g. "mul:7x8"
  operation     // 'add' | 'sub' | 'mul' | 'div'
  operandA      // 7
  operandB      // 8
  answer        // 56
}
```

- Facts are **generated**, not stored per-row in their own table — the universe
  of facts is small and deterministic (e.g. multiplication 0–12 × 0–12 = 169
  facts). A pure function produces the fact set for a given operation/range.
- Subtraction and division are framed as the inverse of their partner fact
  (`15 − 7` relates to `7 + 8`; `56 ÷ 7` relates to `7 × 8`) — useful later for
  "fact family" grouping, but each direction is tracked as its own fact for
  scheduling.

### Fact sets / "decks"

An adult enables **fact sets** per kid, e.g. "Multiplication 0–5", "Addition to
20". A kid only ever sees facts from their enabled sets. This lets an adult
follow a curriculum sequence instead of dumping all 169 multiplication facts at
once.

---

## 4. Spaced Repetition & Fluency Engine

This is the heart of the app. We combine **two ideas**:

1. **Spaced repetition** — schedule each fact to reappear at growing intervals,
   so review effort concentrates on weak facts and barely touches mastered ones.
2. **Fluency gating** — a fact isn't "known" until it's answered both
   *correctly* **and** *quickly* (under a per-kid response-time threshold).
   Speed is a first-class signal, not just accuracy.

### 4.1 Per-fact state

For each `(profile, fact)` pair we store a `FactProgress` row:

```
FactProgress {
  profileId
  factId
  box           // Leitner box / mastery level: 0 (new) … 5 (mastered)
  dueAt         // when this fact should next be shown
  lastSeenAt
  reps          // total attempts
  correctStreak // consecutive correct-and-fast answers
  accuracy      // rolling % correct (EWMA)
  medianMs      // rolling median response time (EWMA)
  state         // 'new' | 'learning' | 'review' | 'mastered'
}
```

### 4.2 Scheduling — modified Leitner boxes

We use a **Leitner box** system (simple, transparent, kid-friendly) rather than
full SM-2, because:

- It's robust to the *noisy, fast* answers young kids give.
- Intervals are easy to reason about and tune.
- Fluency (speed) maps naturally onto promotion/demotion rules.

| Box | Interval until due again |
| --- | --- |
| 0 (new/learning) | same session (re-show after a few other cards) |
| 1 | ~10 minutes (later in session / next session) |
| 2 | 1 day |
| 3 | 3 days |
| 4 | 7 days |
| 5 (mastered) | 21 days |

**Promotion / demotion rules** (evaluated per answer):

- **Correct AND fast** (response time ≤ kid's fluency threshold for that op):
  promote one box.
- **Correct but slow**: stay in the same box (knows it, not yet automatic),
  reschedule sooner.
- **Incorrect**: demote toward box 0 and mark for near-term re-show within the
  same session (this is the "repair" step — see *incremental rehearsal* below).

The **fluency threshold** is adaptive per kid and per operation: it starts
lenient (e.g. 6s) and tightens as the kid speeds up, targeting genuine
automaticity rather than a fixed clock that frustrates beginners.

### 4.3 Session composition — keeping it "just right"

Research on motivation says keep the **success rate high (~80%)** and sessions
**short**. Each session is assembled by a `SessionPlanner`:

- **Length:** ~20 questions or ~3 minutes, whichever comes first (configurable).
- **Mix:** mostly *due review* facts the kid can mostly get right, salted with a
  **small number of new facts** (default 2–4 per session) so it never feels like
  a wall of unknowns.
- **Interleaving:** new/weak facts are spaced out among easy wins, not clustered.
- **Incremental rehearsal:** when a kid misses a fact, it's reintroduced a few
  cards later among known facts, then again a bit further out — a
  well-evidenced technique for cementing missed facts without frustration.
- **Recency guard:** never show the same fact twice back-to-back.

### 4.4 Why this won't feel tedious

| Anti-tedium lever | How |
| --- | --- |
| Short bursts | 2–3 min sessions; always a clear, near finish line |
| Adaptive difficulty | High success rate; new facts trickle in, never flood |
| Immediate feedback | Instant correct/incorrect with warm, non-punitive tone |
| Visible progress | A **fact grid** that lights up as facts master; streaks |
| Gentle gamification | Points, streaks, unlockable avatars/themes — *rewarding*, never *punishing* slow answers |
| Variety | Multiple question presentations (typed answer, multiple choice for new facts, fact-family framing) |
| Respect the kid | No harsh timers shown to beginners; speed is encouraged, not weaponized |

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
│   - Fluency/scheduling engine (pure functions)   │
│   - Serves built SPA static files in production  │
└──────────────────┬───────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────┐
│  SQLite (dev & small deploy) → Postgres (Render)  │
│   via a thin DB layer so the swap is one adapter  │
└───────────────────────────────────────────────────┘
```

### 5.1 Tech choices

- **Frontend:** Vite + React + TypeScript. Client-side routing. State kept
  simple (React Query for server state, minimal local state).
- **Backend:** Node + Express + TypeScript. Cookie-based sessions for the adult.
- **DB:** SQLite locally and for tiny deploys; a single DB adapter interface so
  Postgres can be dropped in for Render without touching app logic. Migrations
  via a lightweight migration runner.
- **The engine is pure:** all scheduling/fluency logic lives in framework-free,
  fully unit-tested pure functions (`engine/`). The DB and HTTP layers only feed
  it state and persist its output. This is the most important part to get right,
  so it must be the easiest to test in isolation.

### 5.2 Single-service deploy

In production the Express server serves the built React bundle as static files,
so there's **one** service to deploy on Render (plus a Postgres add-on). Locally,
Vite dev server proxies `/api` to Express.

---

## 6. Data Model (initial)

```
Account      { id, email, passwordHash, createdAt }
Profile      { id, accountId, displayName, avatar, createdAt }
FactSet      { id, operation, label, rangeSpec }        // catalog, seeded
ProfileFactSet { profileId, factSetId, enabled }        // which sets a kid does
FactProgress { profileId, factId, box, dueAt, lastSeenAt,
               reps, correctStreak, accuracy, medianMs, state }
Attempt      { id, profileId, factId, correct, responseMs, answeredAt }  // event log
```

- `Attempt` is an append-only event log — useful for the adult dashboard and for
  tuning the engine later. `FactProgress` is the derived current state.

---

## 7. Key User Flows

1. **Adult onboarding:** sign up → create first kid profile → pick starting fact
   sets (sensible defaults pre-checked) → hand device to kid.
2. **Kid plays:** profile picker → "Play" → session player runs ~20 cards →
   celebratory summary (facts mastered, streak, points) → done.
3. **Adult checks in:** dashboard → per-kid fact grid (mastered/learning/new),
   accuracy & speed trends, suggested next fact set to enable.

---

## 8. API Sketch

```
POST /api/auth/signup            { email, password }
POST /api/auth/login             { email, password }
POST /api/auth/logout

GET  /api/profiles               -> [Profile]
POST /api/profiles               { displayName, avatar }
GET  /api/profiles/:id/factsets  -> available + enabled sets
PUT  /api/profiles/:id/factsets  { enabledIds }

POST /api/profiles/:id/session   -> { sessionId, cards: [Fact…] }   // planner builds it
POST /api/sessions/:id/answer    { factId, answer, responseMs }
                                 -> { correct, expected, updatedProgress }
POST /api/sessions/:id/complete  -> { summary }

GET  /api/profiles/:id/progress  -> fact grid + trends for the dashboard
```

---

## 9. Roadmap

**v1 (MVP)**
- Adult auth + kid profiles
- Multiplication & addition fact sets
- Leitner + fluency engine with session planner
- Session player with typed-answer + multiple-choice
- Fact grid progress view + basic streaks/points

**v1.1**
- Subtraction & division + fact-family framing
- Adult dashboard with accuracy/speed trends
- Unlockable avatars/themes

**Later**
- Adaptive fluency-threshold tuning from `Attempt` history
- Offline play with sync
- Lightweight classroom mode (many profiles, quick switch)

---

## 10. Open Questions

- Exact starting fluency thresholds per operation/grade — needs a first pass then
  tuning against real `Attempt` data.
- Multiple-choice vs typed-answer balance for the youngest kids (motor/typing
  ability varies).
- How aggressively to introduce new facts for a kid who's racing ahead.
