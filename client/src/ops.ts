import type { Operation } from '@shared';

/** Display symbol for each operation. */
export const OP_SYMBOL: Record<Operation, string> = {
  add: '+',
  sub: '−',
  mul: '×',
  div: '÷',
};

// (No OP_LABEL here: operation names are user-facing copy and live in the
// dictionaries as `ops.*`. A hardcoded English map next to these constants is a
// trap — the obvious thing to reach for, and untranslatable once you do.)

export const OP_CLASS: Record<Operation, string> = {
  add: 'op-add',
  sub: 'op-sub',
  mul: 'op-mul',
  div: 'op-div',
};

/** Raw operation colors (for computed alpha shading in the fact grid). */
export const OP_HEX: Record<Operation, string> = {
  add: '#2fb87a',
  sub: '#ff6b5c',
  mul: '#3b82f6',
  div: '#f59e0b',
};

/** A small, friendly avatar set (predefined — no uploads, per DESIGN.md §10). */
export const AVATARS = ['🦊', '🐼', '🐸', '🦉', '🐙', '🦄', '🐝', '🐳', '🦁', '🐢', '🦖', '🐧'];
