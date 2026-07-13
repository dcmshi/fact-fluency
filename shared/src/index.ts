/**
 * Shared types for Fact Fluency.
 *
 * These are consumed via `import type` on both the server and client, so they
 * are fully erased at build time — no runtime coupling between packages.
 * See DESIGN.md for the meaning of each field.
 */

export type Operation = 'add' | 'sub' | 'mul' | 'div';

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
  /** The curriculum expectation this set maps to (Ontario/BC + Common Core) —
   *  shown to adults as a standards-alignment signal. */
  standards?: string;
}

/** A starting preset: a grade band maps to the fact sets to enable at
 *  onboarding, so an adult can pick a level instead of hand-picking sets. */
export interface GradeBand {
  id: string;
  label: string;
  setIds: string[];
  /** Start with equality-only munch rounds (no `<`/`>`) for this band. */
  comparisons?: false;
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
  /** Include smaller/bigger (`<`/`>`) munch rounds; false = equality only
   *  (young or pre-reading kids). Absent on older rows = true. */
  comparisons?: boolean;
  // Accessibility toggles (COMPETITORS.md) — all default off/absent.
  /** A clearer, more spaced type treatment for easier reading. */
  easyReadFont?: boolean;
  /** Stronger contrast for low-vision / bright-room use. */
  highContrast?: boolean;
  /** Calm mode: hide fast/slow speed feedback so there's no time pressure. */
  calmMode?: boolean;
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
  /** Facts due/learning today across enabled sets — filled by GET /profiles
   *  for the picker's "N to review!" chip; absent elsewhere. */
  dueToday?: number;
  /** The kid has completed a session today (daily practice goal met) — drives
   *  the picker's soft "Done for today ✓" state instead of a review-count nag. */
  doneToday?: boolean;
}

// ---------------------------------------------------------------------------
// Rewards — unlockable avatars/themes bought with earned points (roadmap v1.1)
// ---------------------------------------------------------------------------

export type RewardKind = 'avatar' | 'theme' | 'muncher' | 'effect' | 'perk';

/** A catalog entry a kid can unlock and equip. Cost 0 = free / starter item. */
export interface RewardItem {
  id: string;
  kind: RewardKind;
  label: string;
  /** Coins to unlock; 0 means owned by default. */
  cost: number;
  /** avatar → the emoji; theme → the `body[data-theme]` id; muncher → the
   *  animal key; effect → the celebration-burst key. All client-rendered. */
  value: string;
  /** Theme preview swatch colors (hex); omitted for the others. */
  swatches?: string[];
  /** Months (1-12) the item is purchasable — omitted = always. Seasonal items
   *  a kid already owns stay owned/equipped out of season. */
  months?: number[];
}

export interface RewardsView {
  coins: number;
  catalog: RewardItem[];
  /** Item ids the kid owns (includes all cost-0 items). */
  owned: string[];
  /** Currently-equipped avatar emoji, theme id, muncher animal, and effect. */
  equippedAvatar: string;
  equippedTheme: string;
  equippedMuncher: string;
  equippedEffect: string;
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

/**
 * A translatable string the server emits for the client to render via i18next
 * (`t(key, params)`). The server never builds user-facing prose itself — all
 * copy lives in the client dictionaries, keyed by `key`, with `params`
 * interpolated. Param values that are themselves labels (e.g. a fact-set id)
 * are resolved by the client at render time.
 */
export interface LocalizedText {
  key: string;
  params?: Record<string, string | number>;
}

/** A card the client plays. `answer` is embedded for instant feedback (§4.7). */
export interface Card {
  fact: Fact;
  answer: number;
  isNew: boolean;
  /** For a new sub/div intro: the known mul/add sibling shown on the study card. */
  family?: FactHint;
  /** A warm derivation strategy shown on the study card (new facts only). */
  strategy?: LocalizedText;
  /** The munch grid for this round (server-generated). */
  board?: MunchBoard;
}

// ---------------------------------------------------------------------------
// Guest calibration — a short tap-answer "warm-up" that places a new kid at
// their fluency edge instead of the easiest fact (server: engine/placement.ts).
// ---------------------------------------------------------------------------

/** One warm-up question: the fact to show plus tap choices (one is the answer). */
export interface CalibrationQuestion {
  fact: Fact;
  choices: number[];
}

export interface CalibrationStartResponse {
  questions: CalibrationQuestion[];
}

/** What the kid tapped for one question; the server re-grades `given` against
 *  the fact's real answer (client isn't trusted for scheduling decisions). */
export interface CalibrationAnswer {
  factId: string;
  given: number;
  responseMs: number;
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
  /** The kid's equipped muncher animal key (the character on the board). */
  muncher: string;
  /** The kid's equipped celebration-effect key (burst on a correct munch). */
  effect: string;
  /** Per-kid accessibility toggles applied on the play screen (COMPETITORS.md). */
  accessibility: { easyReadFont: boolean; highContrast: boolean; calmMode: boolean };
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
  /** Every fact in the kid's enabled sets is mastered — there's nothing left to
   *  practice here until a grown-up enables more (DESIGN.md §4.4). */
  allMastered: boolean;
  /** The facts that reached mastery *this session* — celebration chips. */
  masteredFacts: Fact[];
  /** A Streak Shield was consumed on this completion to save a missed-day
   *  streak — surfaced as a celebratory moment on the summary. */
  streakSaved: boolean;
  /** The kid currently owns a Streak Shield (ready to save a future missed
   *  day) — shown as a small "shield ready" status. */
  streakShieldReady: boolean;
}

// ---------------------------------------------------------------------------
// Multiplayer race (MULTIPLAYER.md) — a short seeded deck, ranked by time.
// ---------------------------------------------------------------------------

/** An opponent to race against: a prior run's splits, or a generated bot. */
export interface RaceGhost {
  name: string;
  avatar: string;
  /** Per-round times (ms); the ghost's car advances on these. */
  perRoundMs: number[];
  totalMs: number;
  isBot: boolean;
}

/** A joinable/recent race for the lobby. */
export interface RaceSummary {
  id: string;
  createdByName: string;
  createdByAvatar: string;
  factCount: number;
  createdAt: number;
  /** Runs recorded so far (how many have raced it). */
  runCount: number;
  /** This profile has already run it (→ "rematch" vs "join"). */
  played: boolean;
}

/** Start/join response: the shared deck + an opponent to chase, plus the kid's
 *  equipped muncher/effect so the race board matches their solo game. */
export interface RaceStartResponse {
  raceId: string;
  deck: Card[];
  ghost: RaceGhost;
  muncher: string;
  effect: string;
}

/** A finished run the client reports (client-timed; server sanity-clamps). */
export interface RaceRunRequest {
  perRoundMs: number[];
  totalMs: number;
  correctCount: number;
}

export interface RaceStanding {
  name: string;
  avatar: string;
  totalMs: number;
  placement: number;
  isBot: boolean;
  isYou: boolean;
}

/** Result of submitting a run: your placement, the field, and coins earned. */
export interface RaceResult {
  placement: number;
  racers: number;
  coinsEarned: number;
  standings: RaceStanding[];
  personalBest: boolean;
}

/** A live-room standing pushed over the race WebSocket (Phase 2, live rooms). */
export interface LiveStanding {
  profileId: string;
  name: string;
  avatar: string;
  rounds: number;
  finishMs: number | null;
  connected: boolean;
  placement: number;
  /** Present only in the final `finished` broadcast. */
  coinsEarned?: number;
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
  reason: LocalizedText;
}

/** One hard fact for the "trickiest facts" panel (reps >= 3, not mastered). */
export interface TrickyFact {
  operandA: number;
  operandB: number;
  operation: Operation;
  answer: number;
  /** Rolling accuracy 0..1 and typical correct-answer speed (ms). */
  accuracy: number;
  medianMs: number;
}

/** "This week" recap vs the week before (from the attempt log). */
export interface WeeklyRecap {
  sessions: number;
  attempts: number;
  /** Accuracy 0..1 this week, or null with no attempts. */
  accuracy: number | null;
  /** accuracy minus last week's, or null when either week is empty. */
  accuracyDelta: number | null;
  /** Facts at box 5 touched this week (~newly or re-confirmed mastered). */
  mastered: number;
}

/** "Getting faster" signal — recent vs earlier typical answer speed over the
 *  window. The app's differentiator is a per-kid *adaptive* fast bar, so this
 *  makes progress on speed (not just accuracy) visible to parents. */
export interface SpeedTrend {
  /** Median correct-answer speed (ms) over the recent half of active days. */
  recentMs: number;
  /** …over the earlier half. */
  priorMs: number;
  /** (priorMs - recentMs) / priorMs — positive means faster now than before. */
  fasterPct: number;
}

export interface DashboardView {
  displayName: string;
  streak: number;
  windowDays: number;
  trends: DayTrend[];
  summary: DashboardSummary;
  suggestion: SetSuggestion | null;
  trickiest: TrickyFact[];
  weekly: WeeklyRecap;
  /** Per-operation adaptive "fast enough" cutoffs (ms) — the personalized speed
   *  bar, surfaced so parents can see it (competitors use fixed timers). */
  thresholds: Thresholds;
  /** Recent-vs-earlier speed trend, or null without enough active days. */
  speed: SpeedTrend | null;
}
