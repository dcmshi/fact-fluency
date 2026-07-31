import type {
  Card,
  DashboardView,
  Fact,
  FeastSnapshot,
  Operation,
  Profile,
  ProgressView,
  SessionResponse,
  Thresholds,
} from '@shared';

/**
 * Server payloads, shaped like the real thing.
 *
 * Typed against the shared interfaces rather than cast, so a server-side field
 * change breaks the fixtures at typecheck instead of leaving the page tests
 * asserting against a payload the server no longer sends.
 */
export const thresholds: Thresholds = { add: 2500, sub: 2800, mul: 3000, div: 3200 };

export const profile: Profile = {
  id: 'p1',
  accountId: 'a1',
  displayName: 'Ada',
  avatar: '🦊',
  settings: { sessionCards: 20, sessionSeconds: 300, newPerSession: 2 },
  streak: 3,
  lastPlayedDay: null,
  coins: 40,
  theme: 'classic',
  createdAt: 0,
};

export const fact = (
  operation: Operation,
  operandA: number,
  operandB: number,
  answer: number,
): Fact => ({ id: `${operation}:${operandA}-${operandB}`, operation, operandA, operandB, answer });

export const card = (f: Fact, isNew = false): Card => ({
  fact: f,
  answer: f.answer,
  isNew,
  // Internally consistent is enough — munch logic has its own engine tests.
  board: {
    target: f.answer,
    relation: '=',
    size: 5,
    cells: Array.from({ length: 25 }, (_, i) => (i === 0 ? f.answer : f.answer + i + 1)),
  },
});

export const session = (overrides: Partial<SessionResponse> = {}): SessionResponse => ({
  sessionId: 's1',
  deck: [card(fact('mul', 3, 4, 12)), card(fact('mul', 6, 7, 42))],
  thresholds,
  sessionSeconds: 300,
  theme: 'classic',
  muncher: 'cat',
  effect: 'confetti',
  accessibility: { easyReadFont: false, highContrast: false, calmMode: false, narrate: false },
  ...overrides,
});

export const dashboard = (overrides: Partial<DashboardView> = {}): DashboardView => ({
  displayName: 'Ada',
  streak: 3,
  windowDays: 14,
  trends: [
    {
      day: '2026-07-30',
      attempts: 20,
      correct: 18,
      fastCorrect: 12,
      accuracy: 0.9,
      medianMs: 2100,
    },
    {
      day: '2026-07-31',
      attempts: 18,
      correct: 15,
      fastCorrect: 9,
      accuracy: 0.83,
      medianMs: 2400,
    },
  ],
  summary: {
    totalFacts: 40,
    mastered: 12,
    review: 18,
    learning: 6,
    unseen: 4,
    attempts: 38,
    accuracy: 0.87,
    daysActive: 2,
  },
  suggestion: null,
  trickiest: [
    { operation: 'mul', operandA: 7, operandB: 8, answer: 56, accuracy: 0.4, medianMs: 4200 },
  ],
  weekly: { sessions: 3, attempts: 38, accuracy: 0.87, accuracyDelta: 0.04, mastered: 2 },
  thresholds,
  speed: null,
  ...overrides,
});

/** One grid with every cell mastered — the state that offers the certificate. */
export const masteredProgress: ProgressView = {
  grids: [
    {
      operation: 'add',
      cells: [
        { operandA: 1, operandB: 1, answer: 2, box: 5, state: 'mastered' },
        { operandA: 1, operandB: 2, answer: 3, box: 5, state: 'mastered' },
      ],
    },
  ],
};

export const feastSnapshot = (overrides: Partial<FeastSnapshot> = {}): FeastSnapshot => ({
  timeLeftMs: 45_000,
  factA: 6,
  factOp: 'mul',
  factB: 7,
  plates: [
    { id: 1, value: 42, pos: 0.25 },
    { id: 2, value: 40, pos: 0.75 },
  ],
  players: [
    {
      profileId: 'p1',
      name: 'Ada',
      avatar: '🦊',
      muncher: 'cat',
      score: 0,
      stunned: false,
      isBot: false,
      rimPos: 0.5,
      aim: 0.5,
      firing: false,
    },
  ],
  ...overrides,
});
