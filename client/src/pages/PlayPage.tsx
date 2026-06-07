import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import type { Card, SessionResponse, SessionSummary } from '@shared';
import { api, ApiError, qk } from '../api';
import { Confetti } from '../components/Confetti';
import { MunchBoard, type RoundResult } from '../components/MunchBoard';
import { OP_CLASS, OP_SYMBOL } from '../ops';
import { isMuted, playComplete, playCorrect, playWrong, setMuted } from '../sound';
import { enqueueAnswer, flushAnswers, markPendingComplete } from '../syncQueue';
import { useTheme } from '../useTheme';
import './PlayPage.css';

/** Spoken form of an operation, for screen-reader announcements. */
const OP_WORD: Record<string, string> = {
  add: 'plus',
  sub: 'minus',
  mul: 'times',
  div: 'divided by',
};
const eqText = (a: number, op: string, b: number, answer: number) =>
  `${a} ${OP_WORD[op] ?? op} ${b} equals ${answer}`;

type Phase = 'loading' | 'study' | 'munch' | 'done' | 'error';

export function PlayPage() {
  const { profileId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [session, setSession] = useState<SessionResponse | null>(null);
  const [queue, setQueue] = useState<Card[]>([]);
  const [phase, setPhase] = useState<Phase>('loading');
  const [studyReady, setStudyReady] = useState(false);
  const [played, setPlayed] = useState(0);
  const [roundNonce, setRoundNonce] = useState(0);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [caughtUp, setCaughtUp] = useState(false);
  const [offlineFinish, setOfflineFinish] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [muted, setMutedState] = useState(isMuted());

  const sessionStart = useRef(0);
  const sessionRef = useRef<SessionResponse | null>(null);

  useTheme(session?.theme);

  const current = queue[0] ?? null;

  // Begin a munch round for the current card (fresh MunchBoard via roundNonce).
  const startRound = useCallback(() => {
    setRoundNonce((n) => n + 1);
    setPhase('munch');
  }, []);

  const goNext = useCallback(
    async (nextQueue: Card[]) => {
      const s = sessionRef.current;
      // Soft time cap (§4.4): once the budget is spent, wrap up between rounds.
      const timeUp =
        s != null && performance.now() - sessionStart.current >= s.sessionSeconds * 1000;
      if (nextQueue.length === 0 || timeUp) {
        const sid = sessionRef.current!.sessionId;
        try {
          await flushAnswers();
          setSummary(await api.complete(sid));
          // Completion credits coins + streak and advances mastery — refresh the
          // picker and progress views so they're current when the kid returns.
          void queryClient.invalidateQueries({ queryKey: qk.profiles });
          void queryClient.invalidateQueries({ queryKey: qk.progress(profileId) });
          void queryClient.invalidateQueries({ queryKey: qk.dashboard(profileId) });
        } catch {
          markPendingComplete(sid);
          setOfflineFinish(true);
        }
        playComplete();
        setAnnounce('Session complete. Nice work!');
        setPhase('done');
        return;
      }
      setQueue(nextQueue);
      if (nextQueue[0].isNew) {
        const f = nextQueue[0].fact;
        setAnnounce(
          `New fact. ${eqText(f.operandA, f.operation, f.operandB, nextQueue[0].answer)}.`,
        );
        setStudyReady(false);
        setPhase('study');
      } else {
        startRound();
      }
    },
    [startRound, queryClient, profileId],
  );

  const start = useCallback(async () => {
    setPhase('loading');
    setPlayed(0);
    setSummary(null);
    setCaughtUp(false);
    setOfflineFinish(false);
    try {
      const s = await api.startSession(profileId);
      sessionRef.current = s;
      sessionStart.current = performance.now();
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

  const onMunch = useCallback((correct: boolean) => {
    if (correct) playCorrect();
    else playWrong();
  }, []);

  const finishRound = useCallback(
    async (r: RoundResult) => {
      const s = sessionRef.current;
      if (!current || !s) return;
      setPlayed((n) => n + 1);
      navigator.vibrate?.(r.correct ? 18 : [40, 50, 40]);

      const body = {
        factId: current.fact.id,
        correct: r.correct,
        responseMs: r.responseMs,
        wrongMunches: r.wrongMunches,
      };
      let injects: { factId: string; afterOffset: number }[] = [];
      let caught = false;
      let fast = false;
      try {
        const resp = await api.answer(s.sessionId, body);
        injects = resp.injects ?? [];
        caught = !!resp.caughtUp;
        fast = resp.fast;
      } catch {
        // Offline (or a blip): queue the report; it replays on reconnect.
        enqueueAnswer(s.sessionId, body);
      }
      setAnnounce(
        r.correct
          ? fast
            ? 'All munched, super fast!'
            : 'All munched!'
          : 'Some were wrong — keep going!',
      );
      if (caught) setCaughtUp(true);

      let next = queue.slice(1);
      for (const inj of injects) {
        const card = s.deck.find((c) => c.fact.id === inj.factId);
        if (!card) continue;
        const at = Math.min(inj.afterOffset, next.length);
        next = [...next.slice(0, at), { ...card, isNew: false }, ...next.slice(at)];
      }
      await goNext(next);
    },
    [current, queue, goNext],
  );

  // Study card: Enter/Space dismisses to start the round.
  useEffect(() => {
    if (phase !== 'study') return;
    function onKey(e: KeyboardEvent) {
      if (e.repeat) return; // a held key shouldn't fire multiple round starts
      if (studyReady && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        startRound();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, studyReady, startRound]);

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
        <button
          className="btn ghost mute-btn"
          aria-label={muted ? 'Unmute sounds' : 'Mute sounds'}
          aria-pressed={muted}
          onClick={() => setMutedState(setMuted(!muted))}
        >
          {muted ? '🔇' : '🔊'}
        </button>
      </header>

      {/* Screen-reader announcements for study intros and munch instructions. */}
      <div className="sr-only" role="status" aria-live="assertive">
        {announce}
      </div>

      {phase === 'loading' && <div className="play-center muted">Setting up…</div>}

      {phase === 'error' && (
        <div className="play-center stack" style={{ textAlign: 'center' }}>
          <div className="big-emoji">📚</div>
          <h2>
            {errorCode === 'no_enabled_sets' ? 'No facts picked yet' : 'Something went wrong'}
          </h2>
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

      {phase === 'study' && current && (
        <div className="play-center">
          <div className="card study-card rise" key={current.fact.id}>
            <div className="study-tag">New fact — take a look!</div>
            {current.family && (
              <div className="family-hint">
                <span className="family-eq">
                  {current.family.operandA} {OP_SYMBOL[current.family.operation]}{' '}
                  {current.family.operandB} = {current.family.answer}
                </span>
                <span className="family-so">so…</span>
              </div>
            )}
            <div className="equation big">
              <span>{current.fact.operandA}</span>
              <span className="op">{OP_SYMBOL[current.fact.operation]}</span>
              <span>{current.fact.operandB}</span>
              <span className="op">=</span>
              <span className="answer-reveal">{current.answer}</span>
            </div>
            <button className="btn sun full" disabled={!studyReady} onClick={startRound}>
              {studyReady ? 'Got it!' : '…'}
            </button>
          </div>
        </div>
      )}

      {phase === 'munch' && current && current.board && (
        <div className="play-center">
          <MunchBoard
            key={roundNonce}
            board={current.board}
            fact={current.fact}
            muncher={session?.muncher ?? 'cat'}
            effect={session?.effect ?? 'confetti'}
            onMunch={onMunch}
            onComplete={finishRound}
            announce={setAnnounce}
          />
        </div>
      )}

      {phase === 'done' && !summary && offlineFinish && (
        <div className="play-center stack done-card rise" style={{ textAlign: 'center' }}>
          <div className="big-emoji">📡</div>
          <h1>Great practicing!</h1>
          <p className="muted">
            You’re offline right now — your work is saved. Your coins and streak will update as soon
            as you’re back online.
          </p>
          <button className="btn sun full" onClick={() => navigate('/')}>
            Done
          </button>
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
            <Stat label="Coins +" value={summary.pointsEarned} accent />
          </div>
          <div className="coin-total">⭐ {summary.coins} coins to spend in Rewards</div>
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
