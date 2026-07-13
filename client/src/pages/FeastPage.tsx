import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import type { FeastSnapshot, FeastStanding } from '@shared';
import { Muncher } from '../components/Muncher';
import { OP_SYMBOL } from '../ops';
import { playComplete, playCorrect, playWrong } from '../sound';
import './FeastPage.css';

type Phase = 'connecting' | 'lobby' | 'countdown' | 'playing' | 'finished';

interface LobbyPlayer {
  profileId: string;
  name: string;
  avatar: string;
  muncher: string;
  isBot: boolean;
  ready: boolean;
  connected: boolean;
}

/**
 * Number Feast — the real-time arena client (FEAST.md, slice 3). Renders
 * server snapshots (belt of plates + players + fact + timer); tap a plate to
 * grab it, tap a rival to bump. The server is authoritative — this only renders
 * and sends inputs. Plate motion is smoothed by a CSS transition on `left`,
 * so no client-side interpolation loop is needed for ~15 Hz snapshots.
 */
export function FeastPage() {
  const { t } = useTranslation();
  const { profileId = '' } = useParams();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<Phase>('connecting');
  const [lobby, setLobby] = useState<LobbyPlayer[]>([]);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [snap, setSnap] = useState<FeastSnapshot | null>(null);
  const [standings, setStandings] = useState<FeastStanding[] | null>(null);
  const [ready, setReady] = useState(false);
  const [wsError, setWsError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const myScore = useRef(0);
  const myStunned = useRef(false);

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/feast-ws?profileId=${profileId}`);
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      switch (msg.type) {
        case 'joined':
          setPhase('lobby');
          break;
        case 'lobby':
          setLobby(msg.players);
          setPhase((p) => (p === 'connecting' ? 'lobby' : p === 'finished' ? 'lobby' : p));
          if (p2Ready(msg.players, profileId) === false) setReady(false);
          break;
        case 'countdown':
          setPhase('countdown');
          setCountdown(Math.ceil((msg.ms ?? 0) / 1000));
          break;
        case 'snapshot': {
          setPhase('playing');
          setSnap(msg as FeastSnapshot);
          // Local feedback from my own score/stun changes.
          const me = (msg as FeastSnapshot).players.find((pl) => pl.profileId === profileId);
          if (me) {
            if (me.score > myScore.current) playCorrect();
            if (me.stunned && !myStunned.current) playWrong();
            myScore.current = me.score;
            myStunned.current = me.stunned;
          }
          break;
        }
        case 'finished':
          setStandings(msg.standings);
          setPhase('finished');
          playComplete();
          break;
        case 'error':
          setWsError(msg.code === 'no_enabled_sets' ? t('feast.noFacts') : t('errors.generic'));
          break;
      }
    };
    ws.onerror = () => setWsError(t('feast.wsError'));
    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  const send = (payload: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };
  const markReady = () => {
    setReady(true);
    send({ type: 'ready' });
  };
  const leave = () => {
    wsRef.current?.close();
    navigate('/');
  };

  // Countdown tick down for display (server drives the real start).
  useEffect(() => {
    if (phase !== 'countdown' || countdown == null || countdown <= 0) return;
    const id = setTimeout(() => setCountdown((c) => (c == null ? null : c - 1)), 1000);
    return () => clearTimeout(id);
  }, [phase, countdown]);

  // ---- lobby ----
  if (phase === 'connecting' || phase === 'lobby') {
    return (
      <div className="screen center-y">
        <div className="stack rise" style={{ textAlign: 'center' }}>
          <div className="big-emoji" aria-hidden="true">
            🍣
          </div>
          <h1>{t('feast.title')}</h1>
          {wsError ? (
            <p className="error-banner">{wsError}</p>
          ) : phase === 'connecting' ? (
            <p className="muted">{t('feast.connecting')}</p>
          ) : (
            <>
              <p className="muted" style={{ marginTop: '-0.4rem' }}>
                {t('feast.lobbyHint')}
              </p>
              <div className="feast-roster">
                {lobby.map((p) => (
                  <span
                    key={p.profileId}
                    className={`feast-roster-chip ${p.profileId === profileId ? 'you' : ''}`}
                  >
                    <span aria-hidden="true">{p.avatar}</span> {p.name}
                    {p.ready && ' ✓'}
                  </span>
                ))}
              </div>
              <button className="btn full" onClick={() => send({ type: 'addBot' })}>
                {t('feast.addBot')}
              </button>
              <button className="btn sun full" onClick={markReady} disabled={ready}>
                {ready ? t('feast.waiting') : t('feast.imReady')}
              </button>
            </>
          )}
          <button className="btn ghost" onClick={leave}>
            {t('common.back')}
          </button>
        </div>
      </div>
    );
  }

  // ---- countdown ----
  if (phase === 'countdown') {
    return (
      <div className="screen center-y">
        <div className="stack rise" style={{ textAlign: 'center' }}>
          <div className="big-emoji" aria-hidden="true">
            🍣
          </div>
          <div className="feast-countdown" role="status">
            {countdown && countdown > 0 ? countdown : t('feast.go')}
          </div>
        </div>
      </div>
    );
  }

  // ---- results ----
  if (phase === 'finished' && standings) {
    const me = standings.find((s) => s.profileId === profileId);
    const won = me?.placement === 1;
    return (
      <div className="screen center-y">
        <div className="card stack rise" style={{ textAlign: 'center' }}>
          <div className="big-emoji" aria-hidden="true">
            {won ? '🏆' : '🍣'}
          </div>
          <h1>{won ? t('feast.youWon') : t('feast.niceGame')}</h1>
          <div className="feast-standings">
            {standings.map((s) => (
              <div
                key={s.profileId}
                className={`feast-standing ${s.profileId === profileId ? 'you' : ''}`}
              >
                <span className="feast-place">
                  {['🥇', '🥈', '🥉'][s.placement - 1] ?? s.placement}
                </span>
                <span aria-hidden="true">{s.avatar}</span>
                <span className="feast-standing-name">{s.name}</span>
                <span className="feast-standing-score">
                  {t('feast.points', { count: s.score })}
                </span>
                {s.coinsEarned ? (
                  <span className="feast-standing-coins">+{s.coinsEarned} ⭐</span>
                ) : null}
              </div>
            ))}
          </div>
          <button
            className="btn sun full"
            onClick={() => {
              myScore.current = 0;
              myStunned.current = false;
              setReady(false);
              setStandings(null);
              send({ type: 'again' });
            }}
          >
            {t('feast.playAgain')}
          </button>
          <button className="btn ghost" onClick={leave}>
            {t('common.done')}
          </button>
        </div>
      </div>
    );
  }

  // ---- playing ----
  const me = snap?.players.find((p) => p.profileId === profileId);
  const seconds = snap ? Math.ceil(snap.timeLeftMs / 1000) : 0;
  return (
    <div className="screen feast">
      <header className="feast-header">
        <button className="btn ghost" onClick={leave}>
          <span aria-hidden="true">← </span>
          {t('play.quit')}
        </button>
        <div className="feast-fact" aria-live="polite">
          {snap ? (
            <>
              {snap.factA} <span className="feast-op">{OP_SYMBOL[snap.factOp]}</span> {snap.factB}{' '}
              <span className="feast-op">=</span> <span className="feast-q">?</span>
            </>
          ) : null}
        </div>
        <div className={`feast-timer ${seconds <= 10 ? 'low' : ''}`}>{seconds}s</div>
      </header>

      {/* The belt. Plates are positioned by `pos` (0→1) and glide via a CSS
          transition; tapping one sends a grab. */}
      <div className="feast-belt" aria-label={t('feast.beltLabel')}>
        {snap?.plates.map((plate) => (
          <button
            key={plate.id}
            className="feast-plate"
            style={{ left: `${plate.pos * 100}%` }}
            onClick={() => send({ type: 'grab', plateId: plate.id })}
            disabled={me?.stunned}
            aria-label={String(plate.value)}
          >
            {plate.value}
          </button>
        ))}
      </div>

      {/* Players: tap a rival to bump them. */}
      <div className="feast-players">
        {snap?.players.map((p) => {
          const you = p.profileId === profileId;
          return (
            <button
              key={p.profileId}
              className={`feast-player ${you ? 'you' : ''} ${p.stunned ? 'stunned' : ''}`}
              onClick={() => !you && send({ type: 'bump', targetId: p.profileId })}
              disabled={you}
              aria-label={you ? p.name : t('feast.bumpLabel', { name: p.name })}
            >
              <span className="feast-player-muncher">
                <Muncher animal={p.muncher} state={p.stunned ? 'bleh' : 'still'} size={32} />
                {p.stunned && (
                  <span className="feast-stun" aria-hidden="true">
                    💫
                  </span>
                )}
              </span>
              <span className="feast-player-name">{you ? t('feast.you') : p.name}</span>
              <span className="feast-player-score">{p.score}</span>
            </button>
          );
        })}
      </div>

      <p className="feast-hint muted">{t('feast.tapHint')}</p>
    </div>
  );
}

/** Whether the given profile is marked ready in a lobby broadcast (used to
 *  reset the local ready flag when the server bumps everyone back to the lobby). */
function p2Ready(players: LobbyPlayer[], profileId: string): boolean {
  return players.find((p) => p.profileId === profileId)?.ready ?? false;
}
