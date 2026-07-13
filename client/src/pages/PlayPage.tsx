import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import type { Card, Operation, SessionResponse, SessionSummary } from '@shared';
import { tLabel } from '../i18n';
import { api, ApiError, qk } from '../api';
import { Confetti } from '../components/Confetti';
import { MunchBoard, type RoundResult } from '../components/MunchBoard';
import { spliceInject } from '../injects';
import { onInteractive } from '../keys';
import { OP_CLASS, OP_SYMBOL } from '../ops';
import { isMuted, playComplete, playCorrect, playFast, playWrong, setMuted } from '../sound';
import { speak, speechAvailable, stopSpeaking } from '../speech';
import { enqueueAnswer, flushAnswers, markPendingComplete } from '../syncQueue';
import { useTheme } from '../useTheme';
import './PlayPage.css';

/** Mirrors the server's REHEARSAL_GAP for offline self-requeues (§4.4). */
const REHEARSAL_GAP = 3;

type Phase = 'loading' | 'study' | 'munch' | 'done' | 'error';

export function PlayPage() {
  const { t, i18n } = useTranslation();
  const { profileId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Spoken form of an equation, for screen-reader announcements.
  const spokenEq = useCallback(
    (a: number, op: Operation, b: number, answer: number) =>
      t('play.equationSpoken', { a, op: t(`play.opWords.${op}`), b, answer }),
    [t],
  );

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
  const [studySeen, setStudySeen] = useState(false);
  const [muted, setMutedState] = useState(isMuted());

  const sessionStart = useRef(0);
  const sessionRef = useRef<SessionResponse | null>(null);
  // Live mirrors of `queue`/`played` state, so the async answer-response
  // handler (which lands between renders) always sees the current values, and
  // all queue updates compose instead of clobbering each other.
  const queueRef = useRef<Card[]>([]);
  const playedRef = useRef(0);
  // Fact ids already shown on a study card this session. A missed *new* fact is
  // re-shown by reusing its (isNew) deck card, so without this it would greet
  // the kid as brand new again — instead we flip the copy to a gentle reminder.
  const studiedRef = useRef<Set<string>>(new Set());
  // Answer POSTs in flight — play no longer blocks on them, but completion
  // must wait for them so the server scores a full attempt log.
  const inflightRef = useRef<Set<Promise<void>>>(new Set());

  useTheme(session?.theme);

  // Apply the kid's accessibility toggles to the play screen (COMPETITORS.md).
  useEffect(() => {
    const a = session?.accessibility;
    document.body.classList.toggle('ff-easy-read', a?.easyReadFont === true);
    document.body.classList.toggle('ff-high-contrast', a?.highContrast === true);
    return () => document.body.classList.remove('ff-easy-read', 'ff-high-contrast');
  }, [session?.accessibility]);

  const current = queue[0] ?? null;
  // Narrated audio (accessibility): read prompts aloud on-device when the kid's
  // profile opts in. Off by default; parent-set per profile.
  const narrate = session?.accessibility?.narrate === true;

  /** All queue changes go through here so the ref and state never diverge. */
  const applyQueue = useCallback((fn: (q: Card[]) => Card[]) => {
    queueRef.current = fn(queueRef.current);
    setQueue(queueRef.current);
  }, []);

  // Begin a munch round for the current card (fresh MunchBoard via roundNonce).
  const startRound = useCallback(() => {
    setRoundNonce((n) => n + 1);
    setPhase('munch');
  }, []);

  // Speak the study card's equation (with the answer, which is shown here).
  const narrateStudy = useCallback(() => {
    if (!current) return;
    const f = current.fact;
    const text = `${studySeen ? t('play.srRemember') : t('play.srNew')}. ${spokenEq(
      f.operandA,
      f.operation,
      f.operandB,
      current.answer,
    )}.`;
    speak(text, i18n.resolvedLanguage ?? 'en');
  }, [current, studySeen, t, spokenEq, i18n]);

  // Auto-narrate on the study card and at the start of each munch round (the
  // munch prompt is spoken as a question — no answer — so it doesn't give it
  // away). Stop any narration when leaving play.
  useEffect(() => {
    if (!narrate || phase !== 'study') return;
    narrateStudy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, current?.fact.id]);
  useEffect(() => {
    if (!narrate || phase !== 'munch' || !current) return;
    const f = current.fact;
    speak(
      t('play.equationPrompt', {
        a: f.operandA,
        op: t(`play.opWords.${f.operation}`),
        b: f.operandB,
      }),
      i18n.resolvedLanguage ?? 'en',
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, roundNonce]);
  useEffect(() => () => stopSpeaking(), []);

  const goNext = useCallback(
    async (nextQueue: Card[]) => {
      const s = sessionRef.current;
      // Soft time cap (§4.4): once the budget is spent, wrap up between rounds.
      const timeUp =
        s != null && performance.now() - sessionStart.current >= s.sessionSeconds * 1000;
      if (nextQueue.length === 0 || timeUp) {
        const sid = sessionRef.current!.sessionId;
        try {
          // Rounds don't block on their answer POSTs, so the last few may
          // still be in flight — wait for them to land (or fail into the
          // offline queue) before completing, or the server would score an
          // incomplete attempt log.
          await Promise.allSettled([...inflightRef.current]);
          // flushAnswers returns false (it doesn't throw) when answers are
          // still queued. Completing anyway would have the server score an
          // incomplete attempt log and 409 the late replays — so a partial
          // drain takes the offline-finish path and completes on reconnect.
          if (!(await flushAnswers())) throw new Error('answers_pending');
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
        setAnnounce(t('play.announceComplete'));
        setPhase('done');
        return;
      }
      applyQueue(() => nextQueue);
      if (nextQueue[0].isNew) {
        const f = nextQueue[0].fact;
        const seen = studiedRef.current.has(f.id);
        studiedRef.current.add(f.id);
        setStudySeen(seen);
        setAnnounce(
          `${seen ? t('play.srRemember') : t('play.srNew')}. ${spokenEq(f.operandA, f.operation, f.operandB, nextQueue[0].answer)}.`,
        );
        setStudyReady(false);
        setPhase('study');
      } else {
        startRound();
      }
    },
    [startRound, queryClient, profileId, applyQueue, t, spokenEq],
  );

  const start = useCallback(async () => {
    setPhase('loading');
    playedRef.current = 0;
    setPlayed(0);
    setSummary(null);
    setCaughtUp(false);
    setOfflineFinish(false);
    setStudySeen(false);
    studiedRef.current = new Set();
    inflightRef.current = new Set();
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
      playedRef.current += 1;
      setPlayed(playedRef.current);
      navigator.vibrate?.(r.correct ? 18 : [40, 50, 40]);

      const body = {
        factId: current.fact.id,
        correct: r.correct,
        responseMs: r.responseMs,
        wrongMunches: r.wrongMunches,
      };
      // §4.7: the session ships per-op thresholds precisely so fast/slow
      // feedback renders instantly — no waiting on the answer round trip, and
      // an offline kid still hears "super fast!". The server recomputes `fast`
      // authoritatively for scheduling; this copy is presentation-only.
      // Calm mode (accessibility) hides speed feedback entirely — no fast
      // sparkle, no "super fast" — so there's no time pressure. The server
      // still scores speed authoritatively for scheduling.
      const calm = s.accessibility?.calmMode === true;
      const fast = !calm && r.correct && r.responseMs <= s.thresholds[current.fact.operation];
      if (fast) playFast(); // the fluency win gets its sparkle (sound.ts)
      setAnnounce(
        r.correct ? (fast ? t('play.munchFast') : t('play.munchDone')) : t('play.munchMiss'),
      );

      // Don't block the next card on the answer round trip (200-800ms of dead
      // time per card on a slow link, ~20x a session): advance immediately and
      // reconcile when the response lands — injects splice into the *live*
      // queue with the position adjusted for rounds played meanwhile
      // (spliceInject), and caughtUp just flips state. Completion waits on
      // `inflightRef` so the attempt log is whole before the session is scored.
      const playedAtPost = playedRef.current;
      const report: Promise<void> = api
        .answer(s.sessionId, body)
        .then((resp) => {
          if (resp.caughtUp) setCaughtUp(true);
          for (const inj of resp.injects ?? []) {
            const injectCard = s.deck.find((c) => c.fact.id === inj.factId);
            if (!injectCard) continue;
            applyQueue((q) =>
              spliceInject(q, injectCard, inj.afterOffset, playedRef.current - playedAtPost),
            );
          }
        })
        .catch(() => {
          // Offline (or a blip): queue the report; it replays on reconnect.
          enqueueAnswer(s.sessionId, body);
          // No server injects while offline — self-requeue a missed fact
          // locally at the same rehearsal gap so it still gets its in-session
          // re-show (the queued report re-grades it server-side later).
          if (!r.correct && current) {
            applyQueue((q) =>
              spliceInject(q, current, REHEARSAL_GAP, playedRef.current - playedAtPost),
            );
          }
        })
        .finally(() => {
          inflightRef.current.delete(report);
        });
      inflightRef.current.add(report);

      await goNext(queueRef.current.slice(1));
    },
    [current, goNext, applyQueue, t],
  );

  // Study card: Enter/Space dismisses to start the round.
  useEffect(() => {
    if (phase !== 'study') return;
    function onKey(e: KeyboardEvent) {
      if (e.repeat) return; // a held key shouldn't fire multiple round starts
      if (onInteractive(e)) return; // let a focused button (Quit, mute, Got it!) activate
      if (studyReady && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        startRound();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, studyReady, startRound]);

  const opClass = current ? OP_CLASS[current.fact.operation] : '';
  // Denominator = cards actually remaining (the live queue grows when misses
  // inject re-shows), not the starter deck — so the bar never promises "done!"
  // while cards are still coming (§4.8's clear finish line stays honest).
  const progress = session ? Math.min(100, (played / Math.max(1, played + queue.length)) * 100) : 0;

  return (
    <div className={`screen play ${opClass}`}>
      <header className="play-header">
        {/* No aria-label override: the accessible name must match the visible
            "Quit" (WCAG 2.5.3, label in name). The arrow is decoration. */}
        <button className="btn ghost" onClick={() => navigate('/')}>
          <span aria-hidden="true">← </span>
          {t('play.quit')}
        </button>
        {phase !== 'done' && phase !== 'error' && (
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
        )}
        <button
          className="btn ghost mute-btn"
          aria-label={muted ? t('play.unmute') : t('play.mute')}
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

      {phase === 'loading' && <div className="play-center muted">{t('play.settingUp')}</div>}

      {phase === 'error' && (
        <div className="play-center stack" style={{ textAlign: 'center' }}>
          <div className="big-emoji" aria-hidden="true">
            📚
          </div>
          <h2>
            {errorCode === 'no_enabled_sets'
              ? t('play.errNoFactsTitle')
              : t('play.errGenericTitle')}
          </h2>
          <p className="muted">
            {errorCode === 'no_enabled_sets' ? t('play.errNoFactsBody') : t('play.errGenericBody')}
          </p>
          <button className="btn sun" onClick={() => navigate('/')}>
            {t('play.backToProfiles')}
          </button>
        </div>
      )}

      {phase === 'study' && current && (
        <div className="play-center">
          <div className="card study-card rise" key={current.fact.id}>
            <div className="study-tag">
              {studySeen ? t('play.studyRemember') : t('play.studyNew')}
            </div>
            {current.family && (
              <div className="family-hint">
                <span className="family-eq">
                  {current.family.operandA} {OP_SYMBOL[current.family.operation]}{' '}
                  {current.family.operandB} = {current.family.answer}
                </span>
                <span className="family-so">{t('play.familySo')}</span>
              </div>
            )}
            <div className="equation big">
              <span>{current.fact.operandA}</span>
              <span className="op">{OP_SYMBOL[current.fact.operation]}</span>
              <span>{current.fact.operandB}</span>
              <span className="op">=</span>
              <span className="answer-reveal">{current.answer}</span>
            </div>
            {current.strategy && (
              <div className="strategy-hint">
                <span aria-hidden="true">💡</span>{' '}
                {tLabel(t, current.strategy.key, '', current.strategy.params)}
              </div>
            )}
            {narrate && speechAvailable() && (
              <button
                type="button"
                className="btn ghost narrate-btn"
                onClick={narrateStudy}
                aria-label={t('play.replayAudio')}
              >
                🔊
              </button>
            )}
            <button
              className={`btn sun full ${studyReady ? 'ready-pulse' : ''}`}
              disabled={!studyReady}
              onClick={startRound}
            >
              {studyReady ? t('play.gotIt') : t('play.lookAtIt')}
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
          <div className="big-emoji" aria-hidden="true">
            📡
          </div>
          <h1>{t('play.offlineTitle')}</h1>
          <p className="muted">{t('play.offlineBody')}</p>
          <button className="btn sun full" onClick={() => navigate('/')}>
            {t('common.done')}
          </button>
        </div>
      )}

      {phase === 'done' && summary && (
        <div className="play-center stack done-card rise" style={{ textAlign: 'center' }}>
          {(caughtUp || summary.allMastered) && <Confetti />}
          <div className="big-emoji" aria-hidden="true">
            {summary.allMastered ? '🏆' : caughtUp ? '🎉' : '🌟'}
          </div>
          <h1>
            {summary.allMastered
              ? t('play.masteredAllTitle')
              : caughtUp
                ? t('play.caughtUpTitle')
                : t('play.niceWorkTitle')}
          </h1>
          {summary.allMastered && <p className="muted">{t('play.masteredAllBody')}</p>}
          {summary.streak > 1 && (
            <div className="streak-ribbon">
              <span aria-hidden="true">🔥</span> {t('play.streakRibbon', { count: summary.streak })}
            </div>
          )}
          {summary.streakSaved && (
            <div className="shield-ribbon">
              <span aria-hidden="true">🛡️</span> {t('play.shieldSaved', { count: summary.streak })}
            </div>
          )}
          {!summary.streakSaved && summary.streakShieldReady && (
            <div className="shield-note">
              <span aria-hidden="true">🛡️</span> {t('play.shieldReady')}
            </div>
          )}
          <div className="today-done">
            <span aria-hidden="true">🎉</span> {t('play.todayDone')}
          </div>

          {summary.masteredFacts.length > 0 && (
            <div className="mastered-chips">
              <span className="mastered-chips-label">{t('play.masteredToday')}</span>
              {summary.masteredFacts.map((f) => (
                <span key={f.id} className={`mastered-chip ${OP_CLASS[f.operation]}`}>
                  {f.operandA} {OP_SYMBOL[f.operation]} {f.operandB} = {f.answer}
                </span>
              ))}
            </div>
          )}
          <div className="summary-stats">
            <Stat label={t('play.statPlayed')} value={summary.cardsPlayed} />
            <Stat label={t('play.statCorrect')} value={summary.correct} />
            <Stat label={t('play.statMastered')} value={summary.mastered} />
            <Stat label={t('play.statCoins')} value={summary.pointsEarned} accent />
          </div>
          <div className="coin-total">
            <span aria-hidden="true">⭐</span> {t('play.coinsToSpend', { count: summary.coins })}
          </div>
          {summary.coins > 0 && (
            <button
              className="btn full spend-coins"
              onClick={() => navigate(`/?rewards=${profileId}`)}
            >
              <span aria-hidden="true">⭐</span> {t('play.spendCoins')}
            </button>
          )}
          {summary.allMastered ? (
            <>
              <button className="btn sun full" onClick={() => navigate('/')}>
                {t('common.done')}
              </button>
              <button className="btn full" onClick={start}>
                {t('play.bonusRound')}
              </button>
            </>
          ) : (
            <>
              <button className="btn sun full" onClick={start}>
                {t('play.playAgain')}
              </button>
              <button className="btn full done-for-now" onClick={() => navigate('/')}>
                {t('play.doneForNow')}
              </button>
            </>
          )}
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
