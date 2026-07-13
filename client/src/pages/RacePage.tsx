import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import type { RaceResult, RaceStartResponse } from '@shared';
import { api, qk } from '../api';
import { MunchBoard, type RoundResult } from '../components/MunchBoard';
import { Muncher } from '../components/Muncher';
import { playComplete, playCorrect, playWrong } from '../sound';
import './RacePage.css';

type Phase = 'lobby' | 'racing' | 'placing' | 'done';

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * Multiplayer race (MULTIPLAYER.md, Phase 1). Pick/create a race, then clear a
 * short munch deck while a ghost car (a rival's run, or a bot) races alongside
 * on its recorded splits. Ranked by total time; everyone finishes.
 */
export function RacePage() {
  const { profileId = '' } = useParams();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<Phase>('lobby');
  const [active, setActive] = useState<RaceStartResponse | null>(null);
  const [roundIndex, setRoundIndex] = useState(0);
  const [ghostRounds, setGhostRounds] = useState(0);
  const [result, setResult] = useState<RaceResult | null>(null);
  const [busy, setBusy] = useState(false);

  const perRoundRef = useRef<number[]>([]);
  const cleanRef = useRef(0);
  const raceStart = useRef(0);
  const roundStart = useRef(0);

  const { data: races } = useQuery({
    queryKey: qk.races(profileId),
    queryFn: () => api.raceList(profileId).then((r) => r.races),
    enabled: phase === 'lobby',
  });

  function begin(r: RaceStartResponse) {
    perRoundRef.current = [];
    cleanRef.current = 0;
    raceStart.current = performance.now();
    roundStart.current = performance.now();
    setActive(r);
    setRoundIndex(0);
    setGhostRounds(0);
    setResult(null);
    setPhase('racing');
  }

  async function newRace() {
    setBusy(true);
    try {
      begin(await api.raceCreate(profileId));
    } catch {
      setBusy(false); // stay in the lobby on failure
    }
  }
  async function joinRace(raceId: string) {
    setBusy(true);
    try {
      begin(await api.raceGet(profileId, raceId));
    } catch {
      setBusy(false);
    }
  }

  // Ghost car advances on its recorded per-round splits vs the wall clock.
  useEffect(() => {
    if (phase !== 'racing' || !active) return;
    const cum: number[] = [];
    active.ghost.perRoundMs.reduce((s, ms, i) => (cum[i] = s + ms), 0);
    let raf = 0;
    const tick = () => {
      const elapsed = performance.now() - raceStart.current;
      let done = 0;
      while (done < cum.length && cum[done] <= elapsed) done++;
      setGhostRounds(done);
      if (done < cum.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, active]);

  async function finish(total: number, deck: RaceStartResponse) {
    setPhase('placing');
    playComplete();
    const totalMs = total;
    try {
      setResult(
        await api.raceRun(profileId, deck.raceId, {
          perRoundMs: perRoundRef.current,
          totalMs,
          correctCount: cleanRef.current,
        }),
      );
    } catch {
      // Offline / error: show a local result vs the ghost (not persisted).
      const beat = totalMs < deck.ghost.totalMs;
      setResult({
        placement: beat ? 1 : 2,
        racers: 2,
        coinsEarned: 0,
        standings: [],
        personalBest: false,
      });
    }
    setPhase('done');
  }

  function onRoundComplete(r: RoundResult) {
    perRoundRef.current.push(Math.round(performance.now() - roundStart.current));
    if (r.correct) cleanRef.current += 1;
    if (!active) return;
    const next = roundIndex + 1;
    if (next < active.deck.length) {
      roundStart.current = performance.now();
      setRoundIndex(next);
    } else {
      void finish(
        perRoundRef.current.reduce((a, b) => a + b, 0),
        active,
      );
    }
  }

  if (phase === 'lobby') {
    return (
      <div className="screen center-y">
        <div className="stack rise" style={{ textAlign: 'center' }}>
          <div className="big-emoji" aria-hidden="true">
            🏁
          </div>
          <h1>Race!</h1>
          <p className="muted" style={{ marginTop: '-0.4rem' }}>
            Clear the deck faster than your rival. First to the finish wins.
          </p>
          <button className="btn sun full" onClick={newRace} disabled={busy}>
            {busy ? 'Starting…' : '🏁 New race'}
          </button>
          {races && races.length > 0 && (
            <div className="race-list">
              <div className="race-list-title">Recent races</div>
              {races.map((rc) => (
                <button
                  key={rc.id}
                  className="race-list-item"
                  disabled={busy}
                  onClick={() => joinRace(rc.id)}
                >
                  <span className="race-list-who">
                    <span aria-hidden="true">{rc.createdByAvatar}</span> {rc.createdByName}
                  </span>
                  <span className="race-list-meta">
                    {rc.factCount} facts · {rc.runCount} raced
                  </span>
                  <span className="race-list-cta">{rc.played ? 'Rematch' : 'Join'}</span>
                </button>
              ))}
            </div>
          )}
          <button className="btn ghost" onClick={() => navigate('/')} disabled={busy}>
            ← Back
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
            🏁
          </div>
          <h1>At the finish line…</h1>
        </div>
      </div>
    );
  }

  if (phase === 'done' && result) {
    const place = ['🥇', '🥈', '🥉'][result.placement - 1] ?? `#${result.placement}`;
    const totalMs = perRoundRef.current.reduce((a, b) => a + b, 0);
    return (
      <div className="screen center-y">
        <div className="card stack rise" style={{ textAlign: 'center' }}>
          <div className="big-emoji" aria-hidden="true">
            {result.placement === 1 ? '🏆' : '🏁'}
          </div>
          <h1>{result.placement === 1 ? 'You won!' : 'Nice racing!'}</h1>
          <p className="muted" style={{ marginTop: '-0.4rem' }}>
            {place} · your time {secs(totalMs)}
            {result.personalBest && ' · new best ⭐'}
          </p>
          {result.standings.length > 0 && (
            <div className="race-standings">
              {result.standings.map((s) => (
                <div
                  key={`${s.placement}-${s.name}`}
                  className={`race-standing ${s.isYou ? 'you' : ''}`}
                >
                  <span className="race-place">{s.placement}</span>
                  <span aria-hidden="true">{s.avatar}</span>
                  <span className="race-standing-name">
                    {s.name}
                    {s.isYou && ' (you)'}
                  </span>
                  <span className="race-standing-time">{secs(s.totalMs)}</span>
                </div>
              ))}
            </div>
          )}
          {result.coinsEarned > 0 && (
            <div className="race-coins">
              <span aria-hidden="true">⭐</span> +{result.coinsEarned} coins
            </div>
          )}
          <button
            className="btn sun full"
            onClick={() => {
              setPhase('lobby');
              void newRace();
            }}
          >
            Race again
          </button>
          <button className="btn ghost" onClick={() => navigate('/')}>
            Done
          </button>
        </div>
      </div>
    );
  }

  // phase === 'racing'
  const deck = active!;
  const current = deck.deck[roundIndex];
  const total = deck.deck.length;
  return (
    <div className="screen race">
      <header className="play-header">
        <button className="btn ghost" onClick={() => navigate('/')}>
          <span aria-hidden="true">← </span>Quit
        </button>
        <div className="race-round muted">
          Round {roundIndex + 1} of {total}
        </div>
      </header>

      <div className="race-track" aria-hidden="true">
        <Lane pct={(roundIndex / total) * 100} label="You">
          <Muncher animal={deck.muncher} state="still" size={26} />
        </Lane>
        <Lane pct={(Math.min(ghostRounds, total) / total) * 100} label={deck.ghost.name}>
          <span className="race-ghost-avatar">{deck.ghost.avatar}</span>
        </Lane>
      </div>

      <div className="play-center">
        <MunchBoard
          key={roundIndex}
          board={current.board!}
          fact={current.fact}
          muncher={deck.muncher}
          effect={deck.effect}
          onMunch={(correct) => (correct ? playCorrect() : playWrong())}
          onComplete={onRoundComplete}
        />
      </div>
    </div>
  );
}

function Lane({ pct, label, children }: { pct: number; label: string; children: ReactNode }) {
  return (
    <div className="race-lane">
      <span className="race-lane-label">{label}</span>
      <div className="race-rail">
        <span className="race-car" style={{ left: `${pct}%` }}>
          {children}
        </span>
        <span className="race-flag" aria-hidden="true">
          🏁
        </span>
      </div>
    </div>
  );
}
