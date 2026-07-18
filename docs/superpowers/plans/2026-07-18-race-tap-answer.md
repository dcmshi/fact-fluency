# Race Tap-the-Answer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn each multiplayer Race round into a single `a op b = ?` equation answered by tapping one of 5 number choices (strictly the `=` form), lengthen a race to 10 rounds, and re-tune the bot to the faster pace — leaving solo Play and the Feast arena untouched.

**Architecture:** Reuse the existing pure `buildChoices(fact, rng, count)` in `engine/placement.ts` (already used by the calibration warm-up) to generate the race round's choices — no new engine function. The race deck (`Card[]`) gains an optional `choices` field; the deck builder emits `choices` (strictly `=`) instead of a munch `board`. A new client `RaceQuiz` component renders the prompt + choice buttons and reports the **same** `RoundResult` the RacePage deck loop already consumes, so the race-track / live-room / results / coins code is unchanged.

**Tech Stack:** TypeScript (strict) monorepo — `shared` (type-only) / `server` (Express + `ws`, esbuild, vitest) / `client` (Vite + React + react-i18next, vitest + jsdom).

## Global Constraints

- **TypeScript strict everywhere.** `npm run typecheck` (all three workspaces) stays green.
- **Shared stays type-only** — never export a runtime value from `shared/`.
- **Engine purity** — `engine/*` imports no framework/DB, uses injected `rng`, no `Date.now()`. Gameplay-truth changes are unit-tested.
- **DRY** — reuse `engine/placement.ts`'s `buildChoices`; do NOT add a second choices builder.
- **Race stays isolated** — never writes the scheduler or attempt log; coins-only. Solo Play, `MunchBoard`, and Feast are not modified.
- **Localize every user-facing string** in all four dictionaries (`client/src/i18n/en|es|fr|zh.ts`); `es/fr/zh` are typed `typeof en`, so a missing key fails the client build.
- **Commit messages:** no `Co-Authored-By` or other trailers.
- **Run harness for manual (client) verification** (used by Tasks 3–4):
  - `npm run dev` (Express :3001 + Vite :5173, `/api` proxied).
  - Browser `http://localhost:5173` → **Play for fun** (guest) → **Skip — just play** (enables default sets) → navigate to `/race/<profileId>` (the profileId is in the `/play/<id>` or `/calibrate/<id>` URL) → **Race the bot** to reach the racing view without needing a second device.

---

## Task 1: Engine tunables — 10 rounds + faster bot

**Files:**

- Modify: `server/src/engine/race.ts` (`RACE_ROUNDS` ~line 13; add `RACE_CHOICES`; `buildBotGhost` ~lines 41-49)
- Test: `server/src/engine/race.test.ts` (the `buildBotGhost` range assertion ~lines 42-43)

**Interfaces:**

- Produces: `RACE_ROUNDS = 10`, new `export const RACE_CHOICES = 5`, and `buildBotGhost` splits in the 2000–4000ms band. Consumed by Task 2.

This is a tuning change; the retune breaks the existing bot-ghost range test (that's the red), then we fix the assertion (green).

- [ ] **Step 1: Retune the constants**

In `server/src/engine/race.ts`, change `RACE_ROUNDS` and its comment:

```ts
/** Rounds in a race — each round is a quick tap-the-answer question (~2-4s), so
 *  10 rounds keeps a race ~30-45s. */
export const RACE_ROUNDS = 10;

/** Number of answer buttons per race round (one correct + distractors). */
export const RACE_CHOICES = 5;
```

Retune `buildBotGhost`:

```ts
/**
 * Bot opponent splits (ms per round) — a friendly, beatable ~2-4s/round pace for
 * tap-the-answer rounds, so a solo racer (or a first race with no human ghost
 * yet) always has someone to chase. Deterministic via rng (seed it from the race
 * id so the same race always faces the same bot).
 */
export function buildBotGhost(rounds: number, rng: () => number): number[] {
  return Array.from({ length: rounds }, () => 2000 + Math.floor(rng() * 2000));
}
```

- [ ] **Step 2: Run tests to see the bot-ghost range test go red**

Run: `npm run test -w server -- race`
Expected: FAIL — `buildBotGhost` test asserts `>= 3500` / `< 5500`, now getting 2000–4000.

- [ ] **Step 3: Fix the test's range assertion**

In `server/src/engine/race.test.ts`, update the `buildBotGhost` range check:

```ts
a.forEach((ms) => {
  expect(ms).toBeGreaterThanOrEqual(2000);
  expect(ms).toBeLessThan(4000);
});
```

(Keep the surrounding determinism + length assertions as-is. The `buildRaceDeck` tests pass an explicit `count`, so `RACE_ROUNDS` changing to 10 doesn't affect them.)

- [ ] **Step 4: Run tests to verify all pass**

Run: `npm run test -w server -- race`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/engine/race.ts server/src/engine/race.test.ts
git commit -m "Race quiz: 10 rounds + bot re-tuned to the tap-answer pace"
```

---

## Task 2: Race deck builds tap-answer choices (strictly `=`)

Add `Card.choices`, make the race deck emit choices via the existing `buildChoices`, drop the board/comparisons branch for races, and cover it with tests.

**Files:**

- Modify: `shared/src/index.ts` (`Card` interface ~lines 193-204)
- Modify: `server/src/session/race.ts` (`buildDeckCards` ~lines 41-52; `createRace` call ~line 86; imports ~lines 22-30)
- Test: `server/src/engine/placement.test.ts` (add a `buildChoices` describe)
- Test: `server/src/api/api.test.ts` (the race create test ~lines 441-445)

**Interfaces:**

- Consumes: `buildChoices(fact, rng, count)` from `engine/placement.ts`; `RACE_CHOICES` (Task 1).
- Produces: race deck `Card`s carry `choices: number[]` (length 5, incl. the answer) and no `board`. Consumed by Task 4.

- [ ] **Step 1: Add coverage for `buildChoices` (the race's answer-choice contract)**

`buildChoices` already exists (used by calibration at `count=4`); the Race relies on it at `count=5`, so these are characterization tests that lock in the contract the Race depends on — they should pass against the current implementation. Add to `server/src/engine/placement.test.ts` — extend the `@shared` import to include `Fact`, add `buildChoices` to the `./placement` import, then append:

```ts
describe('buildChoices', () => {
  const fact = (answer: number, a = 6, b = 7): Fact => ({
    id: `mul:${a}x${b}`,
    operation: 'mul',
    operandA: a,
    operandB: b,
    answer,
  });

  it('returns `count` distinct choices with exactly one correct, none negative', () => {
    const c = buildChoices(fact(42), makeRng(3), 5);
    expect(c).toHaveLength(5);
    expect(new Set(c).size).toBe(5);
    expect(c.filter((n) => n === 42)).toHaveLength(1);
    expect(c.every((n) => n >= 0)).toBe(true);
  });

  it('handles a tiny answer without dupes or negatives', () => {
    const c = buildChoices(fact(1, 0, 1), makeRng(1), 5);
    expect(c).toHaveLength(5);
    expect(new Set(c).size).toBe(5);
    expect(c.every((n) => n >= 0)).toBe(true);
    expect(c).toContain(1);
  });
});
```

(The `./placement` import becomes `import { buildCalibrationProbe, buildChoices, CALIBRATION_EDGE_BOX, ... }`; the `@shared` import becomes `import type { Fact, Operation } from '@shared';`.)

- [ ] **Step 2: Run to verify they pass**

Run: `npm run test -w server -- placement`
Expected: PASS — both cases hold against the current `buildChoices` (the `answer=1` case yields the 4 distinct distractors `{0,2,3,4}` from its offsets, so 5 distinct non-negative choices). If the tiny-answer case ever came up short, the fix would be to widen the pad-loop bound in `engine/placement.ts` (`v <= answer + count + 3` → `+ 5`) — but per the offsets above it isn't needed.

- [ ] **Step 3: Add `choices` to the shared `Card`**

In `shared/src/index.ts`, add to `Card` (after `board?`):

```ts
  /** The munch grid for this round (solo / legacy race rounds). */
  board?: MunchBoard;
  /** Tap-the-answer choices for a race round: one correct + distractors,
   *  shuffled. Present on race decks; the client renders these as buttons. */
  choices?: number[];
```

- [ ] **Step 4: Build `choices` in the race deck (strictly `=`)**

In `server/src/session/race.ts`:

1. Update imports — drop `buildBoard`/`pickRelation` (no longer used here), add `buildChoices`, add `RACE_CHOICES`:

```ts
import { makeRng, seedFrom } from '../engine/munch';
import { buildChoices } from '../engine/placement';
import {
  buildBotGhost,
  buildRaceDeck,
  placementCoins,
  RACE_CHOICES,
  RACE_ROUNDS,
  rankRuns,
} from '../engine/race';
```

2. Replace `buildDeckCards` (drop the `comparisons` param and the board/relation logic):

```ts
/** Build the playable deck: one tap-the-answer question per fact, seeded per
 *  (race, fact, index) so it's reproducible and identical for every racer.
 *  Strictly the `=` form — a race is always "solve a op b". */
function buildDeckCards(facts: ReturnType<typeof generateFactsForSets>, raceId: string): Card[] {
  return facts.map((fact, i) => {
    const rng = makeRng(seedFrom(`${raceId}:${fact.id}:${i}`));
    const choices = buildChoices(fact, rng, RACE_CHOICES);
    return { fact, answer: fact.answer, isNew: false, choices };
  });
}
```

3. In `createRace`, drop the `comparisons` argument:

```ts
const deck = buildDeckCards(facts, raceId);
```

- [ ] **Step 5: Update the api race test to expect choices**

In `server/src/api/api.test.ts`, in the "runs a race" test after `expect(deck.length).toBeGreaterThan(0);` add:

```ts
expect(
  deck.every(
    (c: { choices?: number[]; board?: unknown; fact: { answer: number } }) =>
      Array.isArray(c.choices) &&
      c.choices.length === 5 &&
      c.choices.includes(c.fact.answer) &&
      c.board === undefined,
  ),
).toBe(true);
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npm run test -w server` and `npm run typecheck`
Expected: PASS (placement, api, and race suites; all three workspaces typecheck — `Card.choices` is additive).

- [ ] **Step 7: Commit**

```bash
git add shared/src/index.ts server/src/session/race.ts server/src/engine/placement.ts server/src/engine/placement.test.ts server/src/api/api.test.ts
git commit -m "Race quiz: deck emits tap-answer choices (strictly =), not a munch board"
```

---

## Task 3: Client `RaceQuiz` component

A self-contained round component: prompt + choice buttons, per-round timing, non-punitive wrong-tap lockout, reporting the existing `RoundResult` shape. Built in isolation here (wired in Task 4). Verified by typecheck/build.

**Files:**

- Create: `client/src/components/RaceQuiz.tsx`
- Create: `client/src/components/RaceQuiz.css`

**Interfaces:**

- Consumes: `type RoundResult` from `./MunchBoard`; `OP_SYMBOL` from `../ops`; `Fact` from `@shared`.
- Produces: `RaceQuiz` (default-styled) with props `{ fact: Fact; choices: number[]; onAnswer: (correct: boolean) => void; onComplete: (r: RoundResult) => void }`. Consumed by Task 4.

- [ ] **Step 1: Create the component**

Create `client/src/components/RaceQuiz.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Fact } from '@shared';
import { OP_SYMBOL } from '../ops';
import type { RoundResult } from './MunchBoard';
import './RaceQuiz.css';

/**
 * One race round: show `a op b = ?` and a row of number buttons; tap the correct
 * one to clear the round. A wrong tap is non-punitive — it shakes, briefly locks
 * the buttons (costing a little time), and is counted, but never ends the round.
 * Reports the same `RoundResult` the RacePage deck loop consumes. Remount per
 * round via a changing `key`.
 */
const LOCK_MS = 800;

export function RaceQuiz({
  fact,
  choices,
  onAnswer,
  onComplete,
}: {
  fact: Fact;
  choices: number[];
  onAnswer: (correct: boolean) => void;
  onComplete: (r: RoundResult) => void;
}) {
  const { t } = useTranslation();
  const [locked, setLocked] = useState(false);
  const [wrongIdx, setWrongIdx] = useState<number | null>(null);
  const wrongTaps = useRef(0);
  const start = useRef(performance.now());
  const done = useRef(false);
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach((id) => clearTimeout(id));
    },
    [],
  );

  const pick = (idx: number) => {
    if (done.current || locked || idx < 0 || idx >= choices.length) return;
    const correct = choices[idx] === fact.answer;
    onAnswer(correct);
    if (correct) {
      done.current = true;
      onComplete({
        correct: wrongTaps.current === 0,
        responseMs: Math.round(performance.now() - start.current),
        wrongMunches: wrongTaps.current,
      });
      return;
    }
    wrongTaps.current += 1;
    setWrongIdx(idx);
    setLocked(true);
    timers.current.push(
      window.setTimeout(() => {
        setLocked(false);
        setWrongIdx((w) => (w === idx ? null : w));
      }, LOCK_MS),
    );
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.repeat) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) {
        e.preventDefault();
        pick(n - 1);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choices.length, locked]);

  return (
    <div className="race-quiz">
      <div className="race-quiz-prompt">
        {fact.operandA} <span className="race-quiz-op">{OP_SYMBOL[fact.operation]}</span>{' '}
        {fact.operandB} <span className="race-quiz-op">=</span>{' '}
        <span className="race-quiz-q">?</span>
      </div>
      <div className="race-quiz-choices" role="group" aria-label={t('race.tapAnswer')}>
        {choices.map((v, i) => (
          <button
            key={i}
            className={`race-quiz-choice ${wrongIdx === i ? 'wrong' : ''}`}
            onClick={() => pick(i)}
            disabled={locked}
            aria-label={String(v)}
          >
            {v}
          </button>
        ))}
      </div>
      <p className="race-quiz-hint muted">{t('race.tapAnswer')}</p>
    </div>
  );
}
```

- [ ] **Step 2: Create the CSS**

Create `client/src/components/RaceQuiz.css`:

```css
.race-quiz {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.25rem;
  width: 100%;
  max-width: 560px;
  margin: 0 auto;
}
.race-quiz-prompt {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(2rem, 9vw, 3.5rem);
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.race-quiz-op {
  color: var(--ink-soft);
}
.race-quiz-q {
  color: var(--sun-shadow);
}
.race-quiz-choices {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.75rem;
}
.race-quiz-choice {
  min-width: clamp(64px, 18vw, 96px);
  min-height: clamp(64px, 18vw, 96px);
  border-radius: var(--r-lg);
  border: 3px solid var(--sun-shadow);
  background: var(--card);
  color: var(--ink);
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(1.4rem, 5vw, 2rem);
  box-shadow: 0 4px 0 rgba(43, 36, 64, 0.15);
  cursor: pointer;
}
.race-quiz-choice:active {
  transform: translateY(2px);
  box-shadow: 0 2px 0 rgba(43, 36, 64, 0.15);
}
.race-quiz-choice:disabled {
  cursor: default;
  opacity: 0.85;
}
.race-quiz-choice.wrong {
  border-color: var(--sub);
  background: color-mix(in srgb, var(--sub) 16%, var(--card));
  animation: race-quiz-shake 0.35s ease-in-out;
}
@keyframes race-quiz-shake {
  0%,
  100% {
    transform: translateX(0);
  }
  25% {
    transform: translateX(-6px);
  }
  75% {
    transform: translateX(6px);
  }
}
.race-quiz-hint {
  font-size: 0.9rem;
}
@media (prefers-reduced-motion: reduce) {
  .race-quiz-choice.wrong {
    animation: none;
  }
  .race-quiz-choice:active {
    transform: none;
  }
}
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck -w client && npm run build -w client`
Expected: PASS (the component compiles even though it's not yet imported anywhere).

- [ ] **Step 4: Commit**

```bash
git add client/src/components/RaceQuiz.tsx client/src/components/RaceQuiz.css
git commit -m "Race quiz: RaceQuiz component (prompt + tap-one-of-5, non-punitive wrong tap)"
```

---

## Task 4: Wire RaceQuiz into RacePage + i18n

Swap the race round render from `MunchBoard` to `RaceQuiz` (keeping a legacy `MunchBoard` fallback for old board-only decks) and add the hint copy to all four dictionaries. Run-verified.

**Files:**

- Modify: `client/src/pages/RacePage.tsx` (imports; the racing-view render ~lines 441-451)
- Modify: `client/src/i18n/en.ts`, `es.ts`, `fr.ts`, `zh.ts` (the `race:` block)

**Interfaces:**

- Consumes: `RaceQuiz` (Task 3); `Card.choices` (Task 2); `race.tapAnswer` i18n key.

- [ ] **Step 1: Add the i18n key (all four dictionaries)**

In `client/src/i18n/en.ts`, in the `race:` block, add after `roundOf`:

```ts
    tapAnswer: 'Tap the answer!',
```

`es.ts`: `tapAnswer: '¡Toca la respuesta!',`
`fr.ts`: `tapAnswer: 'Touche la réponse !',`
`zh.ts`: `tapAnswer: '点击答案！',`

- [ ] **Step 2: Wire RaceQuiz into RacePage**

In `client/src/pages/RacePage.tsx`:

1. Add the import (next to the `MunchBoard` import):

```ts
import { RaceQuiz } from '../components/RaceQuiz';
```

2. In the racing view, replace the `<div className="play-center">…</div>` block that renders `<MunchBoard>` with a choices-vs-board branch:

```tsx
<div className="play-center">
  {current.choices ? (
    <RaceQuiz
      key={roundIndex}
      fact={current.fact}
      choices={current.choices}
      onAnswer={(correct) => (correct ? playCorrect() : playWrong())}
      onComplete={onRoundComplete}
    />
  ) : (
    <MunchBoard
      key={roundIndex}
      board={current.board!}
      fact={current.fact}
      muncher={deck.muncher}
      effect={deck.effect}
      onMunch={(correct) => (correct ? playCorrect() : playWrong())}
      onComplete={onRoundComplete}
    />
  )}
</div>
```

(Leave `MunchBoard` imported — it's the legacy fallback for races created before this change.)

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck -w client && npm run build -w client`
Expected: PASS.

- [ ] **Step 4: Run-verify**

Start the run harness (Global Constraints), open `/race/<profileId>`, and **Race the bot**. Confirm: each round shows `a op b = ?` with 5 number buttons; tapping the correct one advances your car; a wrong tap shakes + briefly disables the buttons + plays the wrong sound but doesn't advance; number keys 1–5 also answer; after 10 rounds the result screen shows placement + coins.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/RacePage.tsx client/src/i18n/en.ts client/src/i18n/es.ts client/src/i18n/fr.ts client/src/i18n/zh.ts
git commit -m "Race quiz: render tap-answer rounds in RacePage (+ legacy board fallback, i18n)"
```

---

## Task 5: Update MULTIPLAYER.md

**Files:**

- Modify: `MULTIPLAYER.md`

- [ ] **Step 1: Edit**

- Update the **Munch input** bullet (top) and **The race mechanic** section: a race round is now a single `a op b = ?` question answered by **tapping one of 5 numbers** (strictly `=`), not a munch grid. Your car advances one step per correct answer; a wrong tap costs a little time (brief lockout), never a life. A race is **10 rounds** (~30–45s). Note solo Play still uses the Number Munchers board, and the race deck reuses `engine/placement.ts`'s `buildChoices`.
- Update the bot line if it cites a per-round pace to ~2–4s/round.

- [ ] **Step 2: Verify docs-only + commit**

Run: `git diff --stat` (expect only `MULTIPLAYER.md`).

```bash
git add MULTIPLAYER.md
git commit -m "Docs: MULTIPLAYER.md reflects tap-the-answer race rounds"
```

---

## Final verification

- [ ] `npm run typecheck` — PASS (shared/server/client).
- [ ] `npm test` — PASS (server engine + api + client).
- [ ] `npm run build` — PASS.
- [ ] `npm run lint && npm run format` — clean.
- [ ] Race run-through: 10 tap-answer rounds, strictly `=`, 5 choices, wrong tap costs time but doesn't advance, bot is competitive, results + coins as before; solo Play and Feast unchanged.

## Spec coverage map

- Strictly `=` → Task 2 (deck builder drops the relation/comparisons branch).
- Tap one of 5 → Task 2 (`buildChoices` count 5) + Task 3 (`RaceQuiz` buttons).
- Non-punitive wrong tap → Task 3 (shake + `LOCK_MS` lockout, counted not eliminating).
- 10 rounds + bot re-tune → Task 1.
- Reuse existing `buildChoices` (DRY, deviates from spec §2's new-function sketch) → Task 2.
- Legacy board fallback → Task 4.
- Docs → Task 5. Solo/Feast untouched → enforced by scope (no edits to PlayPage/MunchBoard/feast).
