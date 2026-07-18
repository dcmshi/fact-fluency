# Race → tap-the-answer redesign

**Date:** 2026-07-18
**Status:** Approved (design), pending implementation plan
**Touches:** `shared/src/index.ts`, `server/src/engine/munch.ts`,
`server/src/engine/race.ts`, `server/src/session/race.ts`,
`client/src/pages/RacePage.tsx` (+ a new `RaceQuiz` component & CSS),
`client/src/i18n/*`, `MULTIPLAYER.md`

## Goal

Simplify the multiplayer **Race** so each round is a single equation the player
answers with **one tap**, instead of clearing a Number-Munchers grid:

1. Each round shows `a op b = ?` — **strictly the `=` form** (never the
   bigger/smaller comparison variants), regardless of the kid's `comparisons`
   setting.
2. The player **taps one number** from a row of **5** choices (one correct +
   plausible distractors) to clear the round and advance their car.
3. A wrong tap is **non-punitive** — it doesn't advance and briefly locks the
   buttons (~0.8s), so it costs a little time but never a "life".
4. A race is **10 rounds** (up from 6) so the faster per-round pace still yields
   a ~30–45s race, and the bot opponent is re-tuned to that pace.

Only the Race changes. Solo Play (the munch grid) and the live Feast arena are
untouched.

## Non-goals

- No change to solo Play, the `MunchBoard`, or the Feast arena.
- No change to the race data model, endpoints, live-room protocol, ghost/leaderboard
  mechanics, coins, or ranking (still by total time; `correctCount` still =
  rounds cleared with no wrong tap).
- Race still **never** touches the scheduler or the attempt log; still coins-only.
- No new question types (no typed input / keypad — chosen format is tap-one-of-5).

## Current state (baseline)

- A race deck is `Card[]` (`RaceStartResponse.deck`). Each `Card` currently
  carries a `board?: MunchBoard` grid; the racing view renders `<MunchBoard>`
  and calls `onRoundComplete(RoundResult)` when the grid is cleared.
- `session/race.ts` `buildDeckCards` builds one board per fact, seeded per
  `(raceId, factId, index)`; relation is `'='` only when
  `profile.settings.comparisons === false`, else `pickRelation(...)` (can be
  `<`/`>`).
- `engine/race.ts`: `RACE_ROUNDS = 6`; `buildBotGhost` = `3500 + rng*2000`
  (3.5–5.5s/round); `rankRuns`/`placementCoins` rank by total time.
- `engine/munch.ts`: `buildBoard` fills a grid with N correct cells + distractors
  drawn from `[0 .. target+10]`.
- `RoundResult = { correct: boolean; responseMs: number; wrongMunches: number }`
  — `RacePage` uses `r.correct` (clean clear) for `correctCount` and records
  `performance.now() - roundStart` as the per-round ms.

## Design

### 1. Data / DTO (`shared/src/index.ts`)

Add an optional `choices` to `Card`, parallel to the optional `board`:

```ts
export interface Card {
  fact: Fact;
  answer: number;
  isNew: boolean;
  family?: FactHint;
  strategy?: LocalizedText;
  /** The munch grid for this round (solo / legacy race rounds). */
  board?: MunchBoard;
  /** Tap-the-answer choices for a race round: one correct + distractors,
   *  shuffled. Present on race decks; the client renders these as buttons. */
  choices?: number[];
}
```

### 2. Engine — `buildChoices` (`server/src/engine/munch.ts`)

A pure, deterministic builder for the answer choices. Distractors prefer
plausible near-misses (small offsets, ±10), fall back to the `[0..answer+10]`
range to fill, are unique, non-negative, and never equal the answer.

```ts
export interface BuildChoicesInput {
  answer: number;
  rng: () => number;
  count?: number; // total buttons incl. the correct one; default 5
}

/** Build `count` answer choices — exactly one === answer, the rest unique,
 *  non-negative, plausible distractors — shuffled. Deterministic via `rng`. */
export function buildChoices(input: BuildChoicesInput): number[] {
  const { answer, rng } = input;
  const count = Math.max(2, input.count ?? 5);

  const candidates = new Set<number>();
  for (const off of [1, 2, 3, 4, 5, 10, -1, -2, -3, -4, -5, -10]) {
    const v = answer + off;
    if (v >= 0 && v !== answer) candidates.add(v);
  }
  // Only widen when the near-miss offsets didn't yield enough distractors (small
  // answers, e.g. 0/1). Otherwise keep choices tight around the answer — pulling
  // in far values like 0/1/2 next to 42 would read as implausible.
  for (let v = 0; v <= answer + 12 && candidates.size < count; v++) {
    if (v !== answer) candidates.add(v);
  }

  const pool = [...candidates];
  // Fisher–Yates partial shuffle, take count-1 distractors.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const distractors = pool.slice(0, count - 1);

  const choices = [answer, ...distractors];
  for (let i = choices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  return choices;
}
```

### 3. Engine tunables (`server/src/engine/race.ts`)

- `RACE_ROUNDS`: `6 → 10` (update the doc comment: rounds are shorter now).
- Add `export const RACE_CHOICES = 5;`.
- `buildBotGhost`: re-tune to the faster tapping pace — `2000 + floor(rng*2000)`
  (2.0–4.0s/round) — and update its comment. (10 rounds × ~3s ≈ ~30s bot time.)

### 4. Race deck builder (`server/src/session/race.ts`)

`buildDeckCards` builds `choices` instead of a board, and is **strictly `=`** —
the `comparisons`/`pickRelation`/`buildBoard` branch is dropped for races:

```ts
function buildDeckCards(facts: ReturnType<typeof generateFactsForSets>, raceId: string): Card[] {
  return facts.map((fact, i) => {
    const rng = makeRng(seedFrom(`${raceId}:${fact.id}:${i}`));
    const choices = buildChoices({ answer: fact.answer, rng, count: RACE_CHOICES });
    return { fact, answer: fact.answer, isNew: false, choices };
  });
}
```

- Drop the now-unused `comparisons` parameter from `buildDeckCards` and its call
  in `createRace`; update imports (`buildBoard`/`pickRelation` no longer used
  here — remove them if nothing else in the file needs them; keep `makeRng`/
  `seedFrom`, add `buildChoices`, add `RACE_CHOICES`).

### 5. Client — `RaceQuiz` component + `RacePage` wiring

New `client/src/components/RaceQuiz.tsx` (+ `RaceQuiz.css`): renders the prompt
and the choice buttons; owns per-round timing/feedback; reports the **same**
`RoundResult` shape `RacePage` already consumes, so `RacePage`'s
`onRoundComplete` is unchanged.

- Props: `{ fact: Fact; choices: number[]; onAnswer: (correct: boolean) => void;
onComplete: (r: RoundResult) => void }`. Remounted per round via `key`.
- Prompt: `fact.operandA {OP_SYMBOL[op]} fact.operandB = ?` (strictly `=`).
- Buttons: one per choice. **Correct tap** → `onAnswer(true)`, `onComplete({
correct: wrongTaps === 0, responseMs: now - start, wrongMunches: wrongTaps })`.
  **Wrong tap** → `onAnswer(false)`, mark that button wrong (shake), disable all
  buttons for ~800ms (a `locked` state), increment `wrongTaps`; the round stays
  until a correct tap. `responseMs` = time to the (first) correct tap.
- Keyboard: number keys **1–5** activate the nth choice (a11y: buttons are real
  `<button>`s, so Tab/Enter also work; number keys are the fast path).
- In `RacePage`'s racing view, replace `<MunchBoard .../>` with `<RaceQuiz
fact={current.fact} choices={current.choices ?? []} onAnswer={(ok) => (ok ?
playCorrect() : playWrong())} onComplete={onRoundComplete} key={roundIndex} />`.
  **Legacy fallback:** if a joined (old) race deck has `board` but no `choices`,
  render `<MunchBoard>` as today, so pre-existing persisted races still play.

### 6. i18n (`client/src/i18n/en|es|fr|zh.ts`)

Add a small race hint + a11y label under `race:` in all four dictionaries
(e.g. `tapAnswer: 'Tap the answer!'` and `answerLabel` if needed). No
server-emitted prose. The build enforces key parity (`es/fr/zh: typeof en`).

### 7. Docs (`MULTIPLAYER.md`)

Update "The race mechanic" and the munch-input decision to describe tap-the-answer
race rounds (strictly `=`, 5 choices, 10 rounds, wrong tap costs time), noting
solo still uses the munch board.

## Testing

- **Engine (`munch.test.ts`)** — `buildChoices`: returns `count` items; exactly
  one equals the answer; all unique; none negative; distractors ≠ answer;
  deterministic for a fixed rng; handles a small answer (e.g. `0`, `1`) without
  dupes or negatives.
- **Engine (`race.test.ts`)** — update any assertion tied to `RACE_ROUNDS === 6`
  or the old bot-ghost range; add a check that `buildBotGhost` values sit in the
  new 2000–4000ms band.
- **Server (`api.test.ts` / `session.test.ts`)** — update race-deck expectations:
  deck length is now `RACE_ROUNDS` (10, capped by available facts), each card has
  `choices` (length 5, includes `answer`) and no `board`.
- **Client `RaceQuiz`** — the pure per-round logic is simple; verified by running
  a race end-to-end (bot + a live room): equation renders, correct tap advances
  the car, wrong tap shakes + briefly locks + costs time, 10 rounds → results +
  coins.
- `npm run typecheck`, `npm test`, `npm run build` green before completion.

## Risks / mitigations

- **Existing persisted races** (board-only decks) → `RacePage` legacy fallback to
  `MunchBoard` when `choices` is absent.
- **Race too short at 10 tap-rounds** → `RACE_ROUNDS` + bot pace are single
  constants; easy to retune after playtest.
- **Distractor quality for tiny answers** (e.g. `1`) → `buildChoices` widens the
  pool from `[0..answer+12]` and dedupes, guaranteeing `count` unique choices.

## Open questions

None — format (tap one of 5), strictly `=`, 10 rounds, and non-punitive wrong-tap
are all decided.
