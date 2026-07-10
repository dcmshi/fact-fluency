/**
 * Progress view (DESIGN.md §7) — the adult fact grid. Overlays a kid's
 * FactProgress onto the full candidate universe of their enabled sets, so
 * never-seen facts show up as `unseen` cells.
 */
import type { Operation, Profile, ProgressCell, ProgressView } from '@shared';
import { SEED_CATALOG } from './data/catalog';
import type { Db } from './db';
import { generateFactsForSets } from './engine/facts';
import { OPERATIONS } from './engine/operations';

export async function getProgressView(db: Db, profile: Profile): Promise<ProgressView> {
  const profileId = profile.id; // ownership checked by the route middleware

  const enabled = new Set(await db.listEnabledSetIds(profileId));
  const sets = SEED_CATALOG.filter((s) => enabled.has(s.id));
  const facts = generateFactsForSets(sets);

  const progressByFactId = new Map((await db.getProgress(profileId)).map((p) => [p.factId, p]));

  const cellsByOp = new Map<Operation, ProgressCell[]>();
  for (const fact of facts) {
    const p = progressByFactId.get(fact.id);
    const cell: ProgressCell = {
      operandA: fact.operandA,
      operandB: fact.operandB,
      answer: fact.answer,
      box: p ? p.box : null,
      state: p ? p.state : 'unseen',
    };
    const list = cellsByOp.get(fact.operation) ?? [];
    list.push(cell);
    cellsByOp.set(fact.operation, list);
  }

  return {
    grids: OPERATIONS.filter((op) => cellsByOp.has(op)).map((operation) => ({
      operation,
      cells: cellsByOp.get(operation)!,
    })),
  };
}
