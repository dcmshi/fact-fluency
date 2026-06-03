/**
 * Seeded fact-set catalog — DESIGN.md §3.3. Broad coverage across all four
 * operations; adults enable what each kid needs. Sets are named by operand
 * range (not by sum) to match the full-grid model.
 */
import type { FactSet } from '@shared';

export const SEED_CATALOG: FactSet[] = [
  { id: 'add-0-5', operation: 'add', label: 'Addition 0–5', rangeSpec: { aMin: 0, aMax: 5, bMin: 0, bMax: 5 } },
  { id: 'add-0-10', operation: 'add', label: 'Addition 0–10', rangeSpec: { aMin: 0, aMax: 10, bMin: 0, bMax: 10 } },
  { id: 'add-0-12', operation: 'add', label: 'Addition 0–12', rangeSpec: { aMin: 0, aMax: 12, bMin: 0, bMax: 12 } },

  { id: 'sub-0-10', operation: 'sub', label: 'Subtraction within 10', rangeSpec: { aMin: 0, aMax: 10, bMin: 0, bMax: 10 } },
  { id: 'sub-0-20', operation: 'sub', label: 'Subtraction within 20', rangeSpec: { aMin: 0, aMax: 20, bMin: 0, bMax: 20 } },

  { id: 'mul-0-5', operation: 'mul', label: 'Multiplication 0–5', rangeSpec: { aMin: 0, aMax: 5, bMin: 0, bMax: 5 } },
  { id: 'mul-0-10', operation: 'mul', label: 'Multiplication 0–10', rangeSpec: { aMin: 0, aMax: 10, bMin: 0, bMax: 10 } },
  { id: 'mul-0-12', operation: 'mul', label: 'Multiplication 0–12', rangeSpec: { aMin: 0, aMax: 12, bMin: 0, bMax: 12 } },

  { id: 'div-0-5', operation: 'div', label: 'Division 0–5', rangeSpec: { aMin: 0, aMax: 5, bMin: 0, bMax: 5 } },
  { id: 'div-0-10', operation: 'div', label: 'Division 0–10', rangeSpec: { aMin: 0, aMax: 10, bMin: 0, bMax: 10 } },
  { id: 'div-0-12', operation: 'div', label: 'Division 0–12', rangeSpec: { aMin: 0, aMax: 12, bMin: 0, bMax: 12 } },
];

/** Pre-checked at onboarding (DESIGN.md §3.3). */
export const DEFAULT_ENABLED_SET_IDS = ['add-0-10', 'mul-0-5'];
