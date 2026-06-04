/**
 * Shared types for Fact Fluency.
 *
 * These are consumed via `import type` on both the server and client, so they
 * are fully erased at build time — no runtime coupling between packages.
 * See DESIGN.md for the meaning of each field.
 */

export type Operation = 'add' | 'sub' | 'mul' | 'div';

export const OPERATIONS: readonly Operation[] = ['add', 'sub', 'mul', 'div'];

/** A 2-D operand range; interpreted per operation — see DESIGN.md §3.1. */
export interface RangeSpec {
  aMin: number;
  aMax: number;
  bMin: number;
  bMax: number;
}

/** A single generated arithmetic problem. */
export interface Fact {
  /** Canonical, stable id, e.g. "mul:3x7", "sub:15-7", "div:56/7". */
  id: string;
  operation: Operation;
  operandA: number;
  operandB: number;
  answer: number;
}

/** Catalog entry an adult can enable per kid. */
export interface FactSet {
  id: string;
  operation: Operation;
  label: string;
  rangeSpec: RangeSpec;
}

/** A starting preset: a grade band maps to the fact sets to enable at
 *  onboarding, so an adult can pick a level instead of hand-picking sets. */
export interface GradeBand {
  id: string;
  label: string;
  setIds: string[];
}

/** Leitner box 0 (learning) … 5 (mastered). */
export type Box = 0 | 1 | 2 | 3 | 4 | 5;

export type FactState = 'learning' | 'review' | 'mastered';

/** Derived current state of one fact for one profile. */
export interface FactProgress {
  profileId: string;
  factId: string;
  box: Box;
  state: FactState;
  /** Epoch ms; when the fact should next surface in the persistent schedule. */
  dueAt: number;
  lastSeenAt: number;
  reps: number;
  fastCorrect: number;
  correctStreak: number;
  accuracyEwma: number;
  medianMsEwma: number;
}

/** Per-(profile, operation) rolling stats backing the adaptive threshold. */
export interface OperationStat {
  profileId: string;
  operation: Operation;
  medianMsEwma: number;
  correctSamples: number;
}

export interface ProfileSettings {
  sessionCards: number;
  sessionSeconds: number;
  newPerSession: number;
}

export interface Profile {
  id: string;
  accountId: string;
  displayName: string;
  /** Currently-equipped avatar (an emoji from the reward catalog). */
  avatar: string;
  settings: ProfileSettings;
  /** Consecutive days with a completed session (DESIGN.md §4.10). */
  streak: number;
  /** Spendable reward balance (DESIGN.md §10 — earned per session). */
  coins: number;
  /** Currently-equipped theme id (palette); 'classic' is the default look. */
  theme: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Rewards — unlockable avatars/themes bought with earned points (roadmap v1.1)
// ---------------------------------------------------------------------------

export type RewardKind = 'avatar' | 'theme';

/** A catalog entry a kid can unlock and equip. Cost 0 = free / starter item. */
export interface RewardItem {
  id: string;
  kind: RewardKind;
  label: string;
  /** Coins to unlock; 0 means owned by default. */
  cost: number;
  /** avatar → the emoji; theme → the theme id applied as `body[data-theme]`. */
  value: string;
  /** Theme preview swatch colors (hex); omitted for avatars. */
  swatches?: string[];
}

export interface RewardsView {
  coins: number;
  catalog: RewardItem[];
  /** Item ids the kid owns (includes all cost-0 items). */
  owned: string[];
  /** Currently-equipped avatar emoji + theme id. */
  equippedAvatar: string;
  equippedTheme: string;
}

// ---------------------------------------------------------------------------
// Session DTOs — client-holds-deck / server-injects (DESIGN.md §4.9)
// ---------------------------------------------------------------------------

/** An inverse "sibling" fact that explains a new sub/div fact (fact-family
 *  framing — e.g. 7×8=56 framing 56÷7=8). See DESIGN.md §9 "Later". */
export interface FactHint {
  operandA: number;
  operandB: number;
  operation: Operation;
  answer: number;
}

/** Comparison a munch round asks for: cells equal to / less than / greater than
 *  the fact's answer (Number Munchers–style play). */
export type MunchRelation = '=' | '<' | '>';

/** A pre-generated munch board: a `size`×`size` grid (row-major `cells`) where
 *  the cells satisfying `relation` vs `target` are the ones to munch. */
export interface MunchBoard {
  target: number;
  relation: MunchRelation;
  size: number;
  cells: number[];
}

/** A card the client plays. `answer` is embedded for instant feedback (§4.7). */
export interface Card {
  fact: Fact;
  answer: number;
  isNew: boolean;
  /** For a new sub/div intro: the known mul/add sibling shown on the study card. */
  family?: FactHint;
  /** The munch grid for this round (server-generated). */
  board?: MunchBoard;
}

/** Per-operation "fast enough" cutoffs (ms), sent so the client can render
 *  instant fast/slow feedback; the server recomputes authoritatively. */
export type Thresholds = Record<Operation, number>;

export interface SessionResponse {
  sessionId: string;
  deck: Card[];
  thresholds: Thresholds;
  /** Soft time budget (seconds) for the session; the client wraps up between
   *  cards once it's spent — a silent cap, never a visible countdown (§4.4, §4.8). */
  sessionSeconds: number;
  /** The kid's equipped theme id, so the player screen renders in their palette. */
  theme: string;
}

export interface AnswerRequest {
  factId: string;
  /** Round outcome decided by the client interaction (a clean munch clear). The
   *  server is still the sole writer of scheduling state from this report. */
  correct: boolean;
  /** Recognition latency — time to the first correct munch (ms). Feeds `fast`. */
  responseMs: number;
  /** Optional: wrong munches this round (logged for tuning; not used in grading). */
  wrongMunches?: number;
}

/** Splice a re-show `afterOffset` cards later in the client's deck (§4.9). */
export interface Inject {
  factId: string;
  afterOffset: number;
}

export interface AnswerResponse {
  correct: boolean;
  fast: boolean;
  updatedProgress: FactProgress;
  injects?: Inject[];
  appendCards?: Card[];
  /** True the moment the due queue empties — triggers "all caught up" (§4.10). */
  caughtUp?: boolean;
}

export interface SessionSummary {
  cardsPlayed: number;
  correct: number;
  fastCorrect: number;
  mastered: number;
  pointsEarned: number;
  /** Day streak after this session (DESIGN.md §4.10). */
  streak: number;
  /** Spendable coin balance after this session (credited once on completion). */
  coins: number;
}

// ---------------------------------------------------------------------------
// Progress view — the adult fact grid (DESIGN.md §7)
// ---------------------------------------------------------------------------

export type CellState = 'unseen' | FactState;

export interface ProgressCell {
  operandA: number;
  operandB: number;
  answer: number;
  box: Box | null;
  state: CellState;
}

export interface ProgressGrid {
  operation: Operation;
  cells: ProgressCell[];
}

export interface ProgressView {
  grids: ProgressGrid[];
}

// ---------------------------------------------------------------------------
// Adult dashboard — accuracy/speed trends + next-set suggestion (DESIGN.md §7)
// ---------------------------------------------------------------------------

/** One calendar day (account tz) of play, for the trend chart. */
export interface DayTrend {
  /** YYYY-MM-DD in the account timezone. */
  day: string;
  attempts: number;
  correct: number;
  fastCorrect: number;
  /** correct / attempts, 0..1 (0 when no attempts that day). */
  accuracy: number;
  /** Median responseMs of correct attempts that day, or null if none. */
  medianMs: number | null;
}

/** Headline counts over a kid's enabled facts + the trend window. */
export interface DashboardSummary {
  totalFacts: number;
  mastered: number;
  review: number;
  learning: number;
  unseen: number;
  /** Attempts within the trend window. */
  attempts: number;
  /** Overall accuracy within the window, 0..1. */
  accuracy: number;
  /** Distinct days with ≥1 attempt within the window. */
  daysActive: number;
}

/** A catalog set the adult could enable next, with a kid-friendly rationale. */
export interface SetSuggestion {
  setId: string;
  operation: Operation;
  label: string;
  reason: string;
}

export interface DashboardView {
  displayName: string;
  streak: number;
  windowDays: number;
  trends: DayTrend[];
  summary: DashboardSummary;
  suggestion: SetSuggestion | null;
}
