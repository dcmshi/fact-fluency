import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Fact, MunchBoard as Board, MunchRelation } from '@shared';
import { onInteractive } from '../keys';
import { OP_SYMBOL } from '../ops';
import { CelebrationBurst } from './CelebrationBurst';
import { Muncher, type MuncherState } from './Muncher';
import './MunchBoard.css';

// Kid-friendly wording (drives both the on-screen prompt and the SR announce):
// "smaller/bigger" reads more easily for young/pre-reading kids than the formal
// "less/greater than".
const RELATION_PHRASE: Record<MunchRelation, string> = {
  '=': 'the same as',
  '<': 'smaller than',
  '>': 'bigger than',
};
const OP_WORD: Record<string, string> = {
  add: 'plus',
  sub: 'minus',
  mul: 'times',
  div: 'divided by',
};

function satisfies(relation: MunchRelation, target: number, value: number): boolean {
  return relation === '=' ? value === target : relation === '<' ? value < target : value > target;
}

export interface RoundResult {
  correct: boolean;
  responseMs: number;
  wrongMunches: number;
}

/**
 * Number Munchers–style round: a grid of numbers; munch every cell satisfying
 * the relation vs the fact's answer. Move with arrows/WASD + Space/Enter, or tap
 * a cell to move-and-munch. The round ends when all correct cells are eaten;
 * `correct` = a clean clear (no wrong munches), `responseMs` = time to the first
 * correct munch (recognition speed). Remount (via a changing `key`) per round.
 */
export function MunchBoard({
  board,
  fact,
  muncher,
  effect,
  onMunch,
  onComplete,
  announce,
}: {
  board: Board;
  fact: Fact;
  muncher: string;
  effect: string;
  onMunch: (correct: boolean) => void;
  onComplete: (r: RoundResult) => void;
  announce?: (msg: string) => void;
}) {
  const { size, cells, relation, target } = board;
  const correctIdx = useMemo(() => {
    const s = new Set<number>();
    cells.forEach((v, i) => {
      if (satisfies(relation, target, v)) s.add(i);
    });
    return s;
  }, [cells, relation, target]);

  const [pos, setPos] = useState(Math.floor((size * size) / 2));
  const [eaten, setEaten] = useState<Set<number>>(new Set());
  // Source of truth for what's been munched, read/written synchronously in the
  // munch handler so effects fire exactly once; `eaten` state mirrors it for render.
  const eatenRef = useRef<Set<number>>(eaten);
  const [flash, setFlash] = useState<{ idx: number; ok: boolean } | null>(null);
  const [muncherState, setMuncherState] = useState<MuncherState>('idle');
  const [bursts, setBursts] = useState<{ id: number; idx: number }[]>([]);

  const posRef = useRef(pos);
  posRef.current = pos;
  // Roving tabindex support: when the muncher moves and keyboard focus is
  // inside the grid, carry focus to the new cell so Space keeps munching there.
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !grid.contains(document.activeElement)) return;
    (grid.children[pos] as HTMLElement | undefined)?.focus?.();
  }, [pos]);
  const burstId = useRef(0);
  // Drive the muncher: chomp → (happy | bleh) → idle, cleaned up on unmount.
  const stateTimers = useRef<number[]>([]);
  // Flash/burst/complete timeouts — tracked so they're cleared if the round
  // unmounts (remount per round via `key`) before they fire.
  const timers = useRef<number[]>([]);
  useEffect(
    () => () => {
      stateTimers.current.forEach((t) => clearTimeout(t));
      timers.current.forEach((t) => clearTimeout(t));
    },
    [],
  );
  const reactMuncher = useCallback((correct: boolean) => {
    stateTimers.current.forEach((t) => clearTimeout(t));
    setMuncherState('chomp');
    stateTimers.current = [
      window.setTimeout(() => setMuncherState(correct ? 'happy' : 'bleh'), 300),
      window.setTimeout(() => setMuncherState('idle'), correct ? 900 : 800),
    ];
  }, []);
  const startRef = useRef(performance.now());
  const firstCorrectRef = useRef<number | null>(null);
  const wrongRef = useRef(0);
  const doneRef = useRef(false);

  useEffect(() => {
    announce?.(
      `Munch everything ${RELATION_PHRASE[relation]} ${fact.operandA} ${OP_WORD[fact.operation] ?? fact.operation} ${fact.operandB}.`,
    );
    // announce only once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const munchAt = useCallback(
    (idx: number) => {
      // Guard against re-munching an eaten cell from a ref/eaten check rather
      // than inside the setState updater: side effects (sound, haptics, the
      // wrong-munch count, onComplete) must run exactly once per munch. React
      // can call a setState updater more than once (StrictMode does in dev),
      // so doing effects in there double-fires them and inflates wrongMunches.
      if (doneRef.current || eatenRef.current.has(idx)) return;
      const isCorrect = correctIdx.has(idx);
      eatenRef.current = new Set(eatenRef.current).add(idx);
      setEaten(eatenRef.current);

      if (isCorrect) {
        if (firstCorrectRef.current == null) {
          firstCorrectRef.current = Math.round(performance.now() - startRef.current);
        }
      } else {
        wrongRef.current += 1;
      }
      // Mid-round SR feedback: each munch replaces the last announcement (the
      // live region is a single message, so rapid munching self-throttles).
      // The round-complete announcement from the parent supersedes the last one.
      const left = [...correctIdx].filter((i) => !eatenRef.current.has(i)).length;
      if (left > 0) {
        announce?.(
          isCorrect ? `Munched ${cells[idx]}. ${left} left.` : `Oops — ${cells[idx]} isn't one.`,
        );
      }
      onMunch(isCorrect);
      reactMuncher(isCorrect);
      setFlash({ idx, ok: isCorrect });
      timers.current.push(
        window.setTimeout(() => setFlash((f) => (f && f.idx === idx ? null : f)), 350),
      );
      if (isCorrect) {
        const id = ++burstId.current;
        setBursts((b) => [...b, { id, idx }]);
        timers.current.push(
          window.setTimeout(() => setBursts((b) => b.filter((x) => x.id !== id)), 900),
        );
      }

      if ([...correctIdx].every((i) => eatenRef.current.has(i))) {
        doneRef.current = true;
        const responseMs =
          firstCorrectRef.current ?? Math.round(performance.now() - startRef.current);
        timers.current.push(
          window.setTimeout(
            () =>
              onComplete({
                correct: wrongRef.current === 0,
                responseMs,
                wrongMunches: wrongRef.current,
              }),
            260,
          ),
        );
      }
    },
    [correctIdx, cells, announce, onMunch, onComplete, reactMuncher],
  );

  const move = useCallback(
    (dr: number, dc: number) => {
      setPos((p) => {
        const r = Math.floor(p / size);
        const c = p % size;
        const nr = Math.min(size - 1, Math.max(0, r + dr));
        const nc = Math.min(size - 1, Math.max(0, c + dc));
        return nr * size + nc;
      });
    },
    [size],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.repeat) return; // discrete presses only — no auto-repeat zooming
      switch (e.key) {
        case 'ArrowUp':
        case 'w':
        case 'W':
          e.preventDefault();
          move(-1, 0);
          break;
        case 'ArrowDown':
        case 's':
        case 'S':
          e.preventDefault();
          move(1, 0);
          break;
        case 'ArrowLeft':
        case 'a':
        case 'A':
          e.preventDefault();
          move(0, -1);
          break;
        case 'ArrowRight':
        case 'd':
        case 'D':
          e.preventDefault();
          move(0, 1);
          break;
        case ' ':
        case 'Enter':
          // Yield to a focused button (Quit, mute, a grid cell) — its native
          // activation is what the user meant. Movement keys stay global since
          // focus sits on a cell button after any tap.
          if (onInteractive(e)) return;
          e.preventDefault();
          munchAt(posRef.current);
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move, munchAt]);

  const remaining = [...correctIdx].filter((i) => !eaten.has(i)).length;

  return (
    <div className="munch">
      <div className="munch-prompt">
        <span className="munch-instruction">Munch everything {RELATION_PHRASE[relation]}</span>
        <span className="munch-expr">
          {fact.operandA} <span className="munch-op">{OP_SYMBOL[fact.operation]}</span>{' '}
          {fact.operandB}
        </span>
        <span className="munch-remaining">{remaining} left</span>
      </div>

      {/* role=group, not grid: no row/gridcell structure is exposed, and grid
          semantics would promise arrow-key cell navigation APIs we don't have. */}
      <div
        ref={gridRef}
        className="munch-grid"
        style={{ gridTemplateColumns: `repeat(${size}, 1fr)` }}
        role="group"
        aria-label={`Munch grid, ${remaining} cells left`}
      >
        {cells.map((v, i) => {
          const isEaten = eaten.has(i);
          const isHere = i === pos;
          const f = flash?.idx === i ? (flash.ok ? 'flash-ok' : 'flash-no') : '';
          return (
            <button
              key={i}
              className={`munch-cell ${isEaten ? 'eaten' : ''} ${isHere ? 'here' : ''} ${f}`}
              onClick={() => {
                // aria-disabled (with this guard), not disabled: disabling a
                // just-munched cell would drop keyboard focus to <body>.
                if (eatenRef.current.has(i)) return;
                setPos(i);
                munchAt(i);
              }}
              aria-label={isEaten ? 'munched' : String(v)}
              aria-disabled={isEaten}
              // Roving tabindex: one tab stop (the muncher's cell); arrows/WASD
              // move it, so Tab exits the 25-cell grid in one step.
              tabIndex={isHere ? 0 : -1}
            >
              <span className="munch-num">{isEaten ? '' : v}</span>
              {isHere && (
                <span className="muncher-slot" aria-hidden="true">
                  <Muncher animal={muncher} state={muncherState} size="100%" />
                </span>
              )}
              {bursts.some((b) => b.idx === i) && <CelebrationBurst variant={effect} />}
            </button>
          );
        })}
      </div>

      <div className="munch-hint muted">
        <span className="hint-kbd">
          Arrow keys / WASD to move · Space to munch · or tap a number
        </span>
        <span className="hint-touch">Tap a number to munch it</span>
      </div>
    </div>
  );
}
