import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import type { LiveStanding, RaceResult, RaceStartResponse } from '@shared';
import { api, qk } from '../api';
import { MunchBoard, type RoundResult } from '../components/MunchBoard';
import { Muncher } from '../components/Muncher';
import { RaceQuiz } from '../components/RaceQuiz';
import { playComplete, playCorrect, playWrong } from '../sound';
import './RacePage.css';

type Phase = 'lobby' | 'room' | 'racing' | 'placing' | 'done';
type Mode = 'live' | 'bot';

const isYou = (profileId: string, id: string) => profileId === id;

/**
 * Race (MULTIPLAYER.md). Create/join a race, gather in a live room (WebSocket),
 * then clear a short munch deck while opponents (siblings live, or a bot)
 * advance alongside. Live rooms rank in real time; if the socket won't connect
 * — or you'd rather not wait — you can race the bot solo (the Phase 1 path).
 */
export function RacePage() {
  const { t } = useTranslation();
  const { profileId = '' } = useParams();
  const navigate = useNavigate();
  // The unit and the ordinal marker are both copy: 'fr' wants '12,3 s' spacing
  // and 'n° 3', 'zh' wants '秒' and '第 3 名'.
  const secs = (ms: number) => t('common.seconds', { n: (ms / 1000).toFixed(1) });

  const [phase, setPhase] = useState<Phase>('lobby');
  const [active, setActive] = useState<RaceStartResponse | null>(null);
  const [busy, setBusy] = useState(false);

  // Live room (WebSocket) state.
  const [roomRaceId, setRoomRaceId] = useState<string | null>(null);
  const [players, setPlayers] = useState<LiveStanding[]>([]);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  // 'connect' — never got a socket; 'lost' — it died mid-race; 'inProgress' —
  // the server refused a race that had already started.
  const [wsError, setWsError] = useState<null | 'connect' | 'lost' | 'inProgress'>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Racing state (shared by both modes).
  const [mode, setMode] = useState<Mode>('bot');
  const [roundIndex, setRoundIndex] = useState(0);
  const [ghostRounds, setGhostRounds] = useState(0); // bot mode only
  const perRoundRef = useRef<number[]>([]);
  const cleanRef = useRef(0);
  const raceStart = useRef(0);
  const roundStart = useRef(0);

  // Results.
  const [result, setResult] = useState<RaceResult | null>(null); // bot
  const [liveStandings, setLiveStandings] = useState<LiveStanding[] | null>(null); // live

  // The socket's close handler needs the *current* phase, not the one captured
  // when the effect ran.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const { data: races } = useQuery({
    queryKey: qk.races(profileId),
    queryFn: () => api.raceList(profileId).then((r) => r.races),
    enabled: phase === 'lobby',
  });

  function beginRacing(m: Mode) {
    setMode(m);
    perRoundRef.current = [];
    cleanRef.current = 0;
    raceStart.current = performance.now();
    roundStart.current = performance.now();
    setRoundIndex(0);
    setGhostRounds(0);
    setResult(null);
    setPhase('racing');
  }

  // Open the live-room socket once per race; keep it through racing → results.
  useEffect(() => {
    if (!roomRaceId) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${proto}://${location.host}/api/race-ws?raceId=${roomRaceId}&profileId=${profileId}`,
    );
    wsRef.current = ws;
    let intentional = false;
    ws.onmessage = (ev) => {
      let msg: {
        type?: string;
        standings?: LiveStanding[];
        ms?: number;
        code?: string;
      };
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return; // a malformed frame shouldn't take the round down with it
      }
      if (msg.type === 'state') setPlayers(msg.standings ?? []);
      else if (msg.type === 'countdown') setCountdown(Math.ceil((msg.ms ?? 0) / 1000));
      else if (msg.type === 'go') {
        setCountdown(null);
        beginRacing('live');
      } else if (msg.type === 'finished') {
        setLiveStandings(msg.standings ?? []);
        setPhase('done');
      } else if (msg.type === 'error') {
        intentional = true; // the server is about to close on purpose
        setWsError(msg.code === 'race_in_progress' ? 'inProgress' : 'connect');
      }
    };
    ws.onerror = () => setWsError((prev) => prev ?? 'connect');
    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
      // A close we asked for (leaving, switching to the bot, unmount) is not a
      // failure, and neither is one after the results already landed.
      if (intentional || phaseRef.current === 'done' || phaseRef.current === 'lobby') return;
      setWsError((prev) => prev ?? 'lost');
    };
    return () => {
      intentional = true;
      ws.close();
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [roomRaceId, profileId]);

  // Never wait forever at the finish line: if the server's `finished` broadcast
  // doesn't arrive, surface it rather than leaving a dead-end screen.
  useEffect(() => {
    if (phase !== 'placing' || mode !== 'live') return;
    const timer = setTimeout(() => setWsError((prev) => prev ?? 'lost'), 15_000);
    return () => clearTimeout(timer);
  }, [phase, mode]);

  // Bot-mode ghost car advances on its recorded splits vs the wall clock.
  useEffect(() => {
    if (phase !== 'racing' || mode !== 'bot' || !active) return;
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
  }, [phase, mode, active]);

  async function open(getter: () => Promise<RaceStartResponse>) {
    setBusy(true);
    setWsError(null);
    setReady(false);
    setPlayers([]);
    setCountdown(null);
    try {
      const r = await getter();
      setActive(r);
      setRoomRaceId(r.raceId);
      setPhase('room');
    } catch {
      // stay in the lobby
    } finally {
      setBusy(false);
    }
  }
  const newRace = () => open(() => api.raceCreate(profileId));
  const joinRace = (raceId: string) => open(() => api.raceGet(profileId, raceId));

  function markReady() {
    setReady(true);
    wsRef.current?.send(JSON.stringify({ type: 'ready', ready: true }));
  }
  function raceTheBot() {
    setRoomRaceId(null); // closes the socket (see effect cleanup)
    beginRacing('bot');
  }

  function onRoundComplete(r: RoundResult) {
    perRoundRef.current.push(Math.round(performance.now() - roundStart.current));
    if (r.correct) cleanRef.current += 1;
    if (!active) return;
    const done = roundIndex + 1;
    if (mode === 'live' && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'progress', rounds: done }));
    }
    if (done < active.deck.length) {
      roundStart.current = performance.now();
      setRoundIndex(done);
    } else {
      finishRace();
    }
  }

  function finishRace() {
    playComplete();
    const totalMs = perRoundRef.current.reduce((a, b) => a + b, 0);
    if (mode === 'live') {
      // send() on a closing/closed socket is silently discarded, which would
      // strand the kid on 'placing' waiting for a broadcast that never comes.
      const sock = wsRef.current;
      if (sock?.readyState === WebSocket.OPEN)
        sock.send(JSON.stringify({ type: 'finish', totalMs }));
      else setWsError((prev) => prev ?? 'lost');
      setPhase('placing'); // the server's `finished` broadcast flips us to 'done'
      return;
    }
    setPhase('placing');
    api
      .raceRun(profileId, active!.raceId, {
        perRoundMs: perRoundRef.current,
        totalMs,
        correctCount: cleanRef.current,
      })
      .then(setResult)
      .catch(() => {
        const beat = totalMs < active!.ghost.totalMs;
        setResult({
          placement: beat ? 1 : 2,
          racers: 2,
          coinsEarned: 0,
          standings: [],
          personalBest: false,
        });
      })
      .finally(() => setPhase('done'));
  }

  function leave() {
    setRoomRaceId(null);
    navigate('/');
  }

  // ---- lobby ----
  if (phase === 'lobby') {
    return (
      <div className="screen center-y">
        <div className="stack rise" style={{ textAlign: 'center' }}>
          <div className="big-emoji" aria-hidden="true">
            🏁
          </div>
          <h1>{t('race.title')}</h1>
          <p className="muted" style={{ marginTop: '-0.4rem' }}>
            {t('race.lobbySub')}
          </p>
          <button className="btn sun full" onClick={newRace} disabled={busy}>
            {busy ? t('race.starting') : t('race.newRace')}
          </button>
          {races && races.length > 0 && (
            <div className="race-list">
              <div className="race-list-title">{t('race.joinTitle')}</div>
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
                    {t('race.raceMeta', { facts: rc.factCount, raced: rc.runCount })}
                  </span>
                  <span className="race-list-cta">
                    {rc.played ? t('race.rematch') : t('race.join')}
                  </span>
                </button>
              ))}
            </div>
          )}
          <button className="btn ghost" onClick={() => navigate('/')} disabled={busy}>
            {t('common.back')}
          </button>
        </div>
      </div>
    );
  }

  // ---- the live socket died mid-race ----
  // Without this the kid is stranded: 'placing' renders only a heading, and a
  // dead socket during 'racing' means nothing they do can ever be scored.
  if (wsError === 'lost' && (phase === 'racing' || phase === 'placing')) {
    return (
      <div className="screen center-y">
        <div className="stack rise" style={{ textAlign: 'center' }}>
          <div className="big-emoji" aria-hidden="true">
            📡
          </div>
          <h1>{t('race.wsLost')}</h1>
          <p className="muted" style={{ marginTop: '-0.4rem' }}>
            {t('race.wsLostHint')}
          </p>
          <button className="btn sun full" onClick={raceTheBot}>
            {t('race.raceBot')}
          </button>
          <button className="btn ghost" onClick={leave}>
            {t('common.back')}
          </button>
        </div>
      </div>
    );
  }

  // ---- live room / waiting ----
  if (phase === 'room') {
    return (
      <div className="screen center-y">
        <div className="stack rise" style={{ textAlign: 'center' }}>
          <div className="big-emoji" aria-hidden="true">
            🏁
          </div>
          <h1>{t('race.roomTitle')}</h1>
          {countdown != null ? (
            <div className="race-countdown" role="status">
              {countdown}
            </div>
          ) : (
            <p className="muted" style={{ marginTop: '-0.4rem' }}>
              {wsError === 'inProgress'
                ? t('race.inProgress')
                : wsError === 'lost'
                  ? t('race.wsLostHint')
                  : wsError
                    ? t('race.wsError')
                    : t('race.roomHint')}
            </p>
          )}

          {!wsError && (
            <div className="race-roster">
              {players.map((p) => (
                <span
                  key={p.profileId}
                  className={`race-roster-chip ${isYou(profileId, p.profileId) ? 'you' : ''}`}
                >
                  <span aria-hidden="true">{p.avatar}</span> {p.name}
                  {isYou(profileId, p.profileId) && ` (${t('race.youWord')})`}
                </span>
              ))}
            </div>
          )}

          {countdown == null && !wsError && (
            <button className="btn sun full" onClick={markReady} disabled={ready}>
              {ready ? t('race.readyWaiting') : t('race.imReady')}
            </button>
          )}
          <button className="btn full" onClick={raceTheBot}>
            {t('race.raceBot')}
          </button>
          <button className="btn ghost" onClick={leave}>
            {t('common.back')}
          </button>
        </div>
      </div>
    );
  }

  // ---- placing (submitting / awaiting finish) ----
  if (phase === 'placing') {
    return (
      <div className="screen center-y">
        <div className="stack rise" style={{ textAlign: 'center' }}>
          <div className="big-emoji" aria-hidden="true">
            🏁
          </div>
          <h1>{t('race.placing')}</h1>
        </div>
      </div>
    );
  }

  // ---- results ----
  if (phase === 'done') {
    const standings: {
      name: string;
      avatar: string;
      placement: number;
      totalMs: number | null;
      you: boolean;
      coins?: number;
    }[] = liveStandings
      ? liveStandings.map((s) => ({
          name: s.name,
          avatar: s.avatar,
          placement: s.placement,
          totalMs: s.finishMs,
          you: isYou(profileId, s.profileId),
          coins: s.coinsEarned,
        }))
      : (result?.standings ?? []).map((s) => ({
          name: s.isBot ? t('race.botName') : s.name,
          avatar: s.avatar,
          placement: s.placement,
          totalMs: s.totalMs,
          you: s.isYou,
          coins: undefined,
        }));
    const myPlace = standings.find((s) => s.you)?.placement ?? result?.placement ?? 1;
    const myCoins = liveStandings
      ? (standings.find((s) => s.you)?.coins ?? 0)
      : (result?.coinsEarned ?? 0);
    const place = ['🥇', '🥈', '🥉'][myPlace - 1] ?? t('race.placeNum', { n: myPlace });
    return (
      <div className="screen center-y">
        <div className="card stack rise" style={{ textAlign: 'center' }}>
          <div className="big-emoji" aria-hidden="true">
            {myPlace === 1 ? '🏆' : '🏁'}
          </div>
          <h1>{myPlace === 1 ? t('race.youWon') : t('race.niceRacing')}</h1>
          <p className="muted" style={{ marginTop: '-0.4rem' }}>
            {place}
            {result?.personalBest && ` · ${t('race.newBest')}`}
          </p>
          {standings.length > 0 && (
            <div className="race-standings">
              {standings.map((s) => (
                <div
                  key={`${s.placement}-${s.name}`}
                  className={`race-standing ${s.you ? 'you' : ''}`}
                >
                  <span className="race-place">{s.placement}</span>
                  <span aria-hidden="true">{s.avatar}</span>
                  <span className="race-standing-name">
                    {s.name}
                    {s.you && ` (${t('race.youWord')})`}
                  </span>
                  <span className="race-standing-time">
                    {s.totalMs != null ? secs(s.totalMs) : '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
          {myCoins > 0 && (
            <div className="race-coins">
              <span aria-hidden="true">⭐</span> {t('race.coinsPlus', { count: myCoins })}
            </div>
          )}
          <button
            className="btn sun full"
            onClick={() => {
              setRoomRaceId(null);
              setLiveStandings(null);
              setPhase('lobby');
            }}
          >
            {t('race.raceAgain')}
          </button>
          <button className="btn ghost" onClick={leave}>
            {t('common.done')}
          </button>
        </div>
      </div>
    );
  }

  // ---- racing ----
  const deck = active!;
  const current = deck.deck[roundIndex];
  const total = deck.deck.length;
  const lanes =
    mode === 'live'
      ? players.map((p) => (
          <Lane
            key={p.profileId}
            pct={(p.rounds / total) * 100}
            label={isYou(profileId, p.profileId) ? t('race.youLabel') : p.name}
          >
            {isYou(profileId, p.profileId) ? (
              <Muncher animal={deck.muncher} state="still" size={26} />
            ) : (
              <span className="race-ghost-avatar">{p.avatar}</span>
            )}
          </Lane>
        ))
      : [
          <Lane key="you" pct={(roundIndex / total) * 100} label={t('race.youLabel')}>
            <Muncher animal={deck.muncher} state="still" size={26} />
          </Lane>,
          <Lane
            key="ghost"
            pct={(Math.min(ghostRounds, total) / total) * 100}
            label={deck.ghost.isBot ? t('race.botName') : deck.ghost.name}
          >
            <span className="race-ghost-avatar">{deck.ghost.avatar}</span>
          </Lane>,
        ];

  return (
    <div className="screen race">
      <header className="play-header">
        <button className="btn ghost" onClick={leave}>
          <span aria-hidden="true">← </span>
          {t('play.quit')}
        </button>
        <div className="race-round muted">
          {t('race.roundOf', { current: roundIndex + 1, total })}
        </div>
      </header>

      <div className="race-track" aria-hidden="true">
        {lanes}
      </div>

      <div className="play-center">
        {current.choices ? (
          <RaceQuiz
            key={roundIndex}
            fact={current.fact}
            choices={current.choices}
            onAnswer={(correct) => (correct ? playCorrect() : playWrong())}
            onComplete={onRoundComplete}
          />
        ) : (
          <MunchBoard
            key={roundIndex}
            board={current.board!}
            fact={current.fact}
            muncher={deck.muncher}
            effect={deck.effect}
            onMunch={(correct) => (correct ? playCorrect() : playWrong())}
            onComplete={onRoundComplete}
          />
        )}
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
