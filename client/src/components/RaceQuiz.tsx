import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Fact } from '@shared';
import { OP_SYMBOL } from '../ops';
import { activeNow } from '../timing';
import type { RoundResult } from './MunchBoard';
import './RaceQuiz.css';

/**
 * One race round: show `a op b = ?` and a row of number buttons; tap the correct
 * one to clear the round. A wrong tap is non-punitive — it shakes, briefly locks
 * the buttons (costing a little time), and is counted, but never ends the round.
 * Reports the same `RoundResult` the RacePage deck loop consumes. Remount per
 * round via a changing `key`.
 */
const LOCK_MS = 800;

export function RaceQuiz({
  fact,
  choices,
  onAnswer,
  onComplete,
}: {
  fact: Fact;
  choices: number[];
  onAnswer: (correct: boolean) => void;
  onComplete: (r: RoundResult) => void;
}) {
  const { t } = useTranslation();
  const [locked, setLocked] = useState(false);
  const [wrongIdx, setWrongIdx] = useState<number | null>(null);
  const wrongTaps = useRef(0);
  const start = useRef(activeNow());
  const done = useRef(false);
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach((id) => clearTimeout(id));
    },
    [],
  );

  const pick = (idx: number) => {
    if (done.current || locked || idx < 0 || idx >= choices.length) return;
    const correct = choices[idx] === fact.answer;
    onAnswer(correct);
    if (correct) {
      done.current = true;
      onComplete({
        correct: wrongTaps.current === 0,
        responseMs: Math.round(activeNow() - start.current),
        wrongMunches: wrongTaps.current,
      });
      return;
    }
    wrongTaps.current += 1;
    setWrongIdx(idx);
    setLocked(true);
    timers.current.push(
      window.setTimeout(() => {
        setLocked(false);
        setWrongIdx((w) => (w === idx ? null : w));
      }, LOCK_MS),
    );
  };

  // Number keys 1-n pick a choice. The handler routes through a ref rather than
  // capturing `pick`: `pick` closes over `locked` *and* over props, and
  // RacePage's onComplete captures its current roundIndex, so a handler pinned
  // to one render would report a stale round for keyboard players the moment
  // anything else in that closure starts changing mid-round.
  const pickRef = useRef(pick);
  pickRef.current = pick;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.repeat) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) {
        e.preventDefault();
        pickRef.current(n - 1);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [choices.length]);

  return (
    <div className="race-quiz">
      <div className="race-quiz-prompt">
        {fact.operandA} <span className="race-quiz-op">{OP_SYMBOL[fact.operation]}</span>{' '}
        {fact.operandB} <span className="race-quiz-op">=</span>{' '}
        <span className="race-quiz-q">?</span>
      </div>
      <div className="race-quiz-choices" role="group" aria-label={t('race.tapAnswer')}>
        {choices.map((v, i) => (
          <button
            key={i}
            className={`race-quiz-choice ${wrongIdx === i ? 'wrong' : ''}`}
            onClick={() => pick(i)}
            // aria-disabled, not `disabled` — the real thing ejects keyboard
            // focus to <body> for the 800ms wrong-tap lock, so a keyboard user
            // has to Tab back into the row after every miss, mid-race. `pick`
            // already ignores taps while locked. (Same pattern as MunchBoard.)
            aria-disabled={locked}
            aria-label={String(v)}
          >
            {v}
          </button>
        ))}
      </div>
      <p className="race-quiz-hint muted">{t('race.tapAnswer')}</p>
    </div>
  );
}
