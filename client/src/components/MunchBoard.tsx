import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Fact, MunchBoard as Board, MunchRelation } from '@shared';
import { OP_SYMBOL } from '../ops';
import { CelebrationBurst } from './CelebrationBurst';
import { Muncher, type MuncherState } from './Muncher';
import './MunchBoard.css';

const RELATION_PHRASE: Record<MunchRelation, string> = {
  '=': 'equal to',
  '<': 'less than',
  '>': 'greater than',
};
const OP_WORD: Record<string, string> = { add: 'plus', sub: 'minus', mul: 'times', div: 'divided by' };

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
  const [flash, setFlash] = useState<{ idx: number; ok: boolean } | null>(null);
  const [muncherState, setMuncherState] = useState<MuncherState>('idle');
  const [bursts, setBursts] = useState<{ id: number; idx: number }[]>([]);

  const posRef = useRef(pos);
  posRef.current = pos;
  const burstId = useRef(0);
  // Drive the muncher: chomp → (happy | bleh) → idle, cleaned up on unmount.
  const stateTimers = useRef<number[]>([]);
  useEffect(() => () => stateTimers.current.forEach((t) => clearTimeout(t)), []);
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
      if (doneRef.current) return;
      setEaten((prev) => {
        if (prev.has(idx)) return prev;
        const isCorrect = correctIdx.has(idx);
        const next = new Set(prev).add(idx);
        if (isCorrect) {
          if (firstCorrectRef.current == null) {
            firstCorrectRef.current = Math.round(performance.now() - startRef.current);
          }
        } else {
          wrongRef.current += 1;
        }
        onMunch(isCorrect);
        reactMuncher(isCorrect);
        setFlash({ idx, ok: isCorrect });
        window.setTimeout(() => setFlash((f) => (f && f.idx === idx ? null : f)), 350);
        if (isCorrect) {
          const id = ++burstId.current;
          setBursts((b) => [...b, { id, idx }]);
          window.setTimeout(() => setBursts((b) => b.filter((x) => x.id !== id)), 900);
        }

        if ([...correctIdx].every((i) => next.has(i)) && !doneRef.current) {
          doneRef.current = true;
          const responseMs = firstCorrectRef.current ?? Math.round(performance.now() - startRef.current);
          window.setTimeout(
            () => onComplete({ correct: wrongRef.current === 0, responseMs, wrongMunches: wrongRef.current }),
            260,
          );
        }
        return next;
      });
    },
    [correctIdx, onMunch, onComplete, reactMuncher],
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
          {fact.operandA} <span className="munch-op">{OP_SYMBOL[fact.operation]}</span> {fact.operandB}
        </span>
        <span className="munch-remaining">{remaining} left</span>
      </div>

      <div
        className="munch-grid"
        style={{ gridTemplateColumns: `repeat(${size}, 1fr)` }}
        role="grid"
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
                setPos(i);
                munchAt(i);
              }}
              aria-label={isEaten ? 'munched' : String(v)}
              disabled={isEaten}
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

      <div className="munch-hint muted">Arrow keys / WASD to move · Space to munch · or tap a number</div>
    </div>
  );
}
