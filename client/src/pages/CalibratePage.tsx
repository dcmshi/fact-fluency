import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import type { CalibrationAnswer, CalibrationQuestion } from '@shared';
import { api, qk } from '../api';
import { OP_SYMBOL } from '../ops';
import './CalibratePage.css';

type Phase = 'grade' | 'probe' | 'placing';

/**
 * Guest placement warm-up (DESIGN.md §4.4): pick a grade band (enables its fact
 * sets), then a short tap-answer probe. The server places the kid at their
 * fluency edge from the results, so the first real game doesn't start at 1 + 1.
 * Any hiccup falls through to play — a warm-up must never block starting.
 */
export function CalibratePage() {
  const { profileId = '' } = useParams();
  const navigate = useNavigate();
  const { data: catalog } = useQuery({ queryKey: qk.catalog, queryFn: api.catalog });

  const [phase, setPhase] = useState<Phase>('grade');
  const [questions, setQuestions] = useState<CalibrationQuestion[]>([]);
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const answersRef = useRef<CalibrationAnswer[]>([]);
  const shownAt = useRef(0);
  const advanceTimer = useRef<number | null>(null);

  const goPlay = () => navigate(`/play/${profileId}`, { replace: true });

  // Stamp when each question appears, to measure recognition time on tap.
  useEffect(() => {
    if (phase === 'probe') shownAt.current = performance.now();
  }, [phase, index]);

  useEffect(() => () => window.clearTimeout(advanceTimer.current ?? undefined), []);

  async function chooseGrade(grade: string) {
    setBusy(true);
    try {
      const { questions: qs } = await api.calibrationStart(profileId, grade);
      if (qs.length === 0) return goPlay();
      answersRef.current = [];
      setQuestions(qs);
      setIndex(0);
      setPhase('probe');
    } catch {
      goPlay(); // don't strand a kid on a warm-up error
    } finally {
      setBusy(false);
    }
  }

  function tap(value: number) {
    if (picked != null) return; // ignore double taps during the feedback beat
    const q = questions[index];
    setPicked(value);
    answersRef.current.push({
      factId: q.fact.id,
      given: value,
      responseMs: performance.now() - shownAt.current,
    });
    advanceTimer.current = window.setTimeout(async () => {
      setPicked(null);
      if (index + 1 < questions.length) {
        setIndex(index + 1);
        return;
      }
      setPhase('placing');
      try {
        await api.calibrationSubmit(profileId, answersRef.current);
      } catch {
        // best-effort placement — play anyway
      }
      goPlay();
    }, 480);
  }

  if (phase === 'grade') {
    return (
      <div className="screen center-y">
        <div className="stack rise" style={{ textAlign: 'center' }}>
          <div className="big-emoji" aria-hidden="true">
            ✨
          </div>
          <h1>What grade are you in?</h1>
          <p className="muted" style={{ marginTop: '-0.5rem' }}>
            A quick warm-up so we start you at the right spot.
          </p>
          <div className="cal-grades">
            {(catalog?.gradeBands ?? []).map((b) => (
              <button
                key={b.id}
                type="button"
                className="btn sun"
                disabled={busy}
                onClick={() => chooseGrade(b.id)}
              >
                {b.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn ghost" onClick={goPlay} disabled={busy}>
            Skip — just play
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'placing') {
    return (
      <div className="screen center-y">
        <div className="stack rise" style={{ textAlign: 'center' }}>
          <div className="big-emoji" aria-hidden="true">
            🎯
          </div>
          <h1>Setting up your game…</h1>
        </div>
      </div>
    );
  }

  const q = questions[index];
  return (
    <div className="screen center-y">
      <div className="stack rise" style={{ textAlign: 'center' }}>
        <div className="cal-head muted">
          <span aria-hidden="true">⚡</span> Warm-up
        </div>
        <div className="cal-dots" aria-label={`Question ${index + 1} of ${questions.length}`}>
          {questions.map((_, i) => (
            <span key={i} className={`cal-dot ${i < index ? 'done' : i === index ? 'here' : ''}`} />
          ))}
        </div>

        <div className="cal-eq" aria-live="polite">
          <span>{q.fact.operandA}</span>
          <span className="cal-op">{OP_SYMBOL[q.fact.operation]}</span>
          <span>{q.fact.operandB}</span>
          <span className="cal-op">=</span>
          <span className="cal-q">?</span>
        </div>

        <div className="cal-choices">
          {q.choices.map((c) => {
            const state =
              picked == null ? '' : c === q.fact.answer ? 'right' : c === picked ? 'wrong' : '';
            return (
              <button
                key={c}
                type="button"
                className={`btn cal-choice ${state}`}
                disabled={picked != null}
                onClick={() => tap(c)}
              >
                {c}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
