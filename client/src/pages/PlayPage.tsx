import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Card, SessionResponse, SessionSummary } from '@shared';
import { api, ApiError } from '../api';
import { Confetti } from '../components/Confetti';
import { NumberPad } from '../components/NumberPad';
import { OP_CLASS, OP_SYMBOL } from '../ops';
import './PlayPage.css';

type Phase = 'loading' | 'study' | 'prompt' | 'feedback' | 'done' | 'error';
const MAX_DIGITS = 3;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function PlayPage() {
  const { profileId = '' } = useParams();
  const navigate = useNavigate();

  const [session, setSession] = useState<SessionResponse | null>(null);
  const [queue, setQueue] = useState<Card[]>([]);
  const [phase, setPhase] = useState<Phase>('loading');
  const [entry, setEntry] = useState('');
  const [result, setResult] = useState<{ correct: boolean; fast: boolean } | null>(null);
  const [studyReady, setStudyReady] = useState(false);
  const [played, setPlayed] = useState(0);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [caughtUp, setCaughtUp] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const timerStart = useRef(0);
  const sessionRef = useRef<SessionResponse | null>(null);

  const current = queue[0] ?? null;

  const goNext = useCallback(
    async (nextQueue: Card[]) => {
      if (nextQueue.length === 0) {
        const s = sessionRef.current!;
        try {
          setSummary(await api.complete(s.sessionId));
        } catch {
          /* summary is best-effort */
        }
        setPhase('done');
        return;
      }
      setQueue(nextQueue);
      setEntry('');
      setResult(null);
      if (nextQueue[0].isNew) {
        setStudyReady(false);
        setPhase('study');
      } else {
        timerStart.current = performance.now();
        setPhase('prompt');
      }
    },
    [],
  );

  const start = useCallback(async () => {
    setPhase('loading');
    setPlayed(0);
    setSummary(null);
    setCaughtUp(false);
    try {
      const s = await api.startSession(profileId);
      sessionRef.current = s;
      setSession(s);
      await goNext(s.deck);
    } catch (e) {
      setErrorCode(e instanceof ApiError ? e.code : 'unknown');
      setPhase('error');
    }
  }, [profileId, goNext]);

  useEffect(() => {
    start();
  }, [start]);

  // Study card becomes dismissible after a short beat (study-first, §4.6).
  useEffect(() => {
    if (phase !== 'study') return;
    const t = setTimeout(() => setStudyReady(true), 1500);
    return () => clearTimeout(t);
  }, [phase, current?.fact.id]);

  const beginRecall = useCallback(() => {
    timerStart.current = performance.now();
    setEntry('');
    setPhase('prompt');
  }, []);

  const submit = useCallback(async () => {
    if (!current || entry === '' || !session) return;
    const responseMs = Math.round(performance.now() - timerStart.current);
    const given = Number(entry);
    const op = current.fact.operation;
    const correct = given === current.answer;
    const fast = correct && responseMs <= session.thresholds[op];

    setResult({ correct, fast });
    setPhase('feedback');
    setPlayed((n) => n + 1);
    // Subtle haptic on touch devices: a tap for correct, a double-buzz for a miss.
    navigator.vibrate?.(correct ? 18 : [40, 50, 40]);

    let injects: { factId: string; afterOffset: number }[] = [];
    let caught = false;
    try {
      const resp = await api.answer(session.sessionId, { factId: current.fact.id, given, responseMs });
      injects = resp.injects ?? [];
      caught = !!resp.caughtUp;
    } catch {
      /* deck is client-held; a dropped report is reconciled on complete */
    }

    await delay(correct ? 700 : 1600); // hold longer on a miss so the answer reads
    if (caught) setCaughtUp(true);

    let next = queue.slice(1);
    for (const inj of injects) {
      const card = session.deck.find((c) => c.fact.id === inj.factId);
      if (!card) continue;
      const at = Math.min(inj.afterOffset, next.length);
      next = [...next.slice(0, at), { ...card, isNew: false }, ...next.slice(at)];
    }
    await goNext(next);
  }, [current, entry, session, queue, goNext]);

  // Hardware keyboard support.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (phase === 'study' && studyReady && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        beginRecall();
      } else if (phase === 'prompt') {
        if (e.key >= '0' && e.key <= '9') setEntry((s) => (s.length < MAX_DIGITS ? s + e.key : s));
        else if (e.key === 'Backspace') setEntry((s) => s.slice(0, -1));
        else if (e.key === 'Enter') submit();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, studyReady, beginRecall, submit]);

  const opClass = current ? OP_CLASS[current.fact.operation] : '';
  const progress = session ? Math.min(100, (played / Math.max(1, session.deck.length)) * 100) : 0;

  return (
    <div className={`screen play ${opClass}`}>
      <header className="play-header">
        <button className="btn ghost" onClick={() => navigate('/')} aria-label="Back">
          ← Quit
        </button>
        {phase !== 'done' && phase !== 'error' && (
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
        )}
      </header>

      {phase === 'loading' && <div className="play-center muted">Setting up…</div>}

      {phase === 'error' && (
        <div className="play-center stack" style={{ textAlign: 'center' }}>
          <div className="big-emoji">📚</div>
          <h2>{errorCode === 'no_enabled_sets' ? 'No facts picked yet' : 'Something went wrong'}</h2>
          <p className="muted">
            {errorCode === 'no_enabled_sets'
              ? 'Ask a grown-up to choose some fact sets first.'
              : 'Let’s head back and try again.'}
          </p>
          <button className="btn sun" onClick={() => navigate('/')}>
            Back to profiles
          </button>
        </div>
      )}

      {(phase === 'study' || phase === 'prompt' || phase === 'feedback') && current && (
        <div className="play-center">
          {phase === 'study' ? (
            <div className="card study-card rise" key={current.fact.id}>
              <div className="study-tag">New fact — take a look!</div>
              <div className="equation big">
                <span>{current.fact.operandA}</span>
                <span className="op">{OP_SYMBOL[current.fact.operation]}</span>
                <span>{current.fact.operandB}</span>
                <span className="op">=</span>
                <span className="answer-reveal">{current.answer}</span>
              </div>
              <button className="btn sun full" disabled={!studyReady} onClick={beginRecall}>
                {studyReady ? 'Got it!' : '…'}
              </button>
            </div>
          ) : (
            <div className={`card quiz-card ${result ? (result.correct ? 'is-correct' : 'is-wrong') : ''}`}>
              <div className="equation big">
                <span>{current.fact.operandA}</span>
                <span className="op">{OP_SYMBOL[current.fact.operation]}</span>
                <span>{current.fact.operandB}</span>
                <span className="op">=</span>
                <span className={`entry ${phase === 'feedback' && result && !result.correct ? 'struck' : ''}`}>
                  {entry || (phase === 'prompt' ? <span className="caret">_</span> : '?')}
                </span>
              </div>

              {phase === 'feedback' && result && (
                <div className={`verdict ${result.correct ? 'ok' : 'no'}`}>
                  {result.correct ? (
                    <>
                      {result.fast ? '⚡ Lightning fast!' : '✓ Correct!'}
                    </>
                  ) : (
                    <>
                      Almost — it’s <strong>{current.answer}</strong>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {phase === 'prompt' && (
            <NumberPad
              onDigit={(d) => setEntry((s) => (s.length < MAX_DIGITS ? s + d : s))}
              onBackspace={() => setEntry((s) => s.slice(0, -1))}
              onSubmit={submit}
              canSubmit={entry !== ''}
            />
          )}
          {phase === 'feedback' && <div className="pad-spacer" />}
        </div>
      )}

      {phase === 'done' && summary && (
        <div className="play-center stack done-card rise" style={{ textAlign: 'center' }}>
          {caughtUp && <Confetti />}
          <div className="big-emoji">{caughtUp ? '🎉' : '🌟'}</div>
          <h1>{caughtUp ? 'All caught up!' : 'Nice work!'}</h1>
          {summary.streak > 1 && (
            <div className="streak-ribbon">🔥 {summary.streak}-day streak!</div>
          )}
          <div className="summary-stats">
            <Stat label="Played" value={summary.cardsPlayed} />
            <Stat label="Correct" value={summary.correct} />
            <Stat label="Mastered" value={summary.mastered} />
            <Stat label="Points" value={summary.pointsEarned} accent />
          </div>
          <button className="btn sun full" onClick={start}>
            Play again
          </button>
          <button className="btn ghost" onClick={() => navigate('/')}>
            Done for now
          </button>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={`stat ${accent ? 'accent' : ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
