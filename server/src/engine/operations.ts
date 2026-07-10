import type { Operation } from '@shared';

/**
 * All operations, in stable display order — which is also the curriculum order
 * for cross-operation introductions (add → sub → mul → div, DESIGN.md §7).
 * Lives here (not in `shared`) because `shared` is a type-only package:
 * everything imports it via `import type`, so a runtime value exported from it
 * is un-importable — exactly the hazard CLAUDE.md's type-only note warns about.
 */
export const OPERATIONS: readonly Operation[] = ['add', 'sub', 'mul', 'div'];
