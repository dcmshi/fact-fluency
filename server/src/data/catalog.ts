/**
 * Seeded fact-set catalog — DESIGN.md §3.3. Broad coverage across all four
 * operations; adults enable what each kid needs. Sets are named by operand
 * range (not by sum) to match the full-grid model.
 */
import type { FactSet, GradeBand } from '@shared';

export const SEED_CATALOG: FactSet[] = [
  {
    id: 'add-0-5',
    operation: 'add',
    label: 'Addition 0–5',
    rangeSpec: { aMin: 0, aMax: 5, bMin: 0, bMax: 5 },
  },
  {
    id: 'add-0-10',
    operation: 'add',
    label: 'Addition 0–10',
    rangeSpec: { aMin: 0, aMax: 10, bMin: 0, bMax: 10 },
  },
  {
    id: 'add-0-12',
    operation: 'add',
    label: 'Addition 0–12',
    rangeSpec: { aMin: 0, aMax: 12, bMin: 0, bMax: 12 },
  },

  {
    id: 'sub-0-10',
    operation: 'sub',
    label: 'Subtraction within 10',
    rangeSpec: { aMin: 0, aMax: 10, bMin: 0, bMax: 10 },
  },
  {
    id: 'sub-0-20',
    operation: 'sub',
    label: 'Subtraction within 20',
    rangeSpec: { aMin: 0, aMax: 20, bMin: 0, bMax: 20 },
  },

  {
    id: 'mul-0-5',
    operation: 'mul',
    label: 'Multiplication 0–5',
    rangeSpec: { aMin: 0, aMax: 5, bMin: 0, bMax: 5 },
  },
  {
    id: 'mul-0-10',
    operation: 'mul',
    label: 'Multiplication 0–10',
    rangeSpec: { aMin: 0, aMax: 10, bMin: 0, bMax: 10 },
  },
  {
    id: 'mul-0-12',
    operation: 'mul',
    label: 'Multiplication 0–12',
    rangeSpec: { aMin: 0, aMax: 12, bMin: 0, bMax: 12 },
  },

  {
    id: 'div-0-5',
    operation: 'div',
    label: 'Division 0–5',
    rangeSpec: { aMin: 0, aMax: 5, bMin: 0, bMax: 5 },
  },
  {
    id: 'div-0-10',
    operation: 'div',
    label: 'Division 0–10',
    rangeSpec: { aMin: 0, aMax: 10, bMin: 0, bMax: 10 },
  },
  {
    id: 'div-0-12',
    operation: 'div',
    label: 'Division 0–12',
    rangeSpec: { aMin: 0, aMax: 12, bMin: 0, bMax: 12 },
  },
];

/** Pre-checked at onboarding when no grade band is chosen (DESIGN.md §3.3). */
export const DEFAULT_ENABLED_SET_IDS = ['add-0-10', 'mul-0-5'];

/**
 * Starting presets by grade band. An adult can pick a level at profile
 * creation (and guest calibration bounds its probe to the band's sets); the
 * kid's enabled sets default to these. Bands are intentionally coarse and easy
 * to edit — the adult can always fine-tune sets afterward from the Facts screen.
 *
 * Grounded in the Ontario (2020) and BC math curricula:
 *  - Ontario: recall add/sub facts to 20 by G2; multiplication ×2/5/10 and
 *    related division by G3; full ×/÷ to 12×12 by G4.
 *  - BC: add facts to 20 by end of G3; multiplicative fluency building in G4
 *    (2/3/5×); many multiplication facts recalled by G5.
 * BC runs slightly later than Ontario, so bands are biased a little
 * conservative — calibration then pushes a fluent kid past the easy facts.
 */
export const GRADE_BANDS: GradeBand[] = [
  // K–1 also start with equality-only munch rounds ('smaller/bigger' judgments
  // come later — DESIGN.md §11).
  { id: 'k', label: 'Kindergarten', setIds: ['add-0-5'], comparisons: false },
  {
    id: 'grade-1',
    label: 'Grade 1',
    setIds: ['add-0-10', 'sub-0-10'],
    comparisons: false,
  },
  { id: 'grade-2', label: 'Grade 2', setIds: ['add-0-10', 'sub-0-20'] },
  {
    id: 'grade-3',
    label: 'Grade 3',
    setIds: ['add-0-12', 'sub-0-20', 'mul-0-5', 'div-0-5'],
  },
  { id: 'grade-4', label: 'Grade 4', setIds: ['mul-0-10', 'div-0-10'] },
  { id: 'grade-5-plus', label: 'Grade 5 and up', setIds: ['mul-0-12', 'div-0-12'] },
];

export function gradeBandById(id: string): GradeBand | undefined {
  return GRADE_BANDS.find((b) => b.id === id);
}
