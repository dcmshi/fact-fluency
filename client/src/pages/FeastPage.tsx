import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import type { FeastSnapshot, FeastStanding } from '@shared';
import { Muncher } from '../components/Muncher';
import { OP_SYMBOL } from '../ops';
import { playComplete, playCorrect, playFactChange, playWrong } from '../sound';
import {
  clamp01,
  fracFromPoint,
  inBumpRange,
  invPlateFrac,
  pickTarget,
  plateFrac,
  pointOnCircle,
  stepRimPos,
} from './feastArena';
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
  // Bumped on each of my correct grabs to replay the score-pop animation.
  const [pulse, setPulse] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const myScore = useRef(0);
  const myStunned = useRef(false);

  // Client-owned spatial layer (the server owns scoring/stun; see FEAST.md).
  const ringRef = useRef<HTMLDivElement | null>(null);
  const selfPos = useRef(0.5); // muncher position (belt 0→1), owned locally
  const selfAim = useRef(0.5); // pointer target (belt 0→1)
  const platesRef = useRef<FeastSnapshot['plates']>([]);
  const snapRef = useRef<FeastSnapshot | null>(null); // latest snapshot, for fresh reads in the rAF loop
  const seededPos = useRef(false); // have we placed the muncher at the server's seed yet?
  const [selfRender, setSelfRender] = useState({ pos: 0.5, aim: 0.5 });
  const [firing, setFiring] = useState(0); // >0 while the tongue is out
  const lastFact = useRef(''); // detect fact rotation to fire the cue
  const [factPulse, setFactPulse] = useState(0); // remounts the fact banner to replay its pop
  const bumpAt = useRef(0); // local anti-spam gate for positional bump

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/feast-ws?profileId=${profileId}`);
    wsRef.current = ws;
    // React 18 StrictMode double-invokes this effect in dev: the first socket is
    // closed mid-handshake by the cleanup below. Ignore that aborted socket's
    // error/messages so it can't mask the second, live connection.
    let cancelled = false;
    ws.onmessage = (ev) => {
      if (cancelled) return;
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
          seededPos.current = false; // re-seed the muncher position for a rematch
          lastFact.current = ''; // avoid a spurious cue on the first snapshot of a rematch
          break;
        case 'snapshot': {
          setPhase('playing');
          setSnap(msg as FeastSnapshot);
          platesRef.current = (msg as FeastSnapshot).plates;
          snapRef.current = msg as FeastSnapshot;
          // Fact rotated → cue + banner pop so kids notice the new target.
          {
            const fk = `${(msg as FeastSnapshot).factA}${(msg as FeastSnapshot).factOp}${(msg as FeastSnapshot).factB}`;
            if (lastFact.current && lastFact.current !== fk) {
              playFactChange();
              setFactPulse((n) => n + 1);
            }
            lastFact.current = fk;
          }
          // Local feedback from my own score/stun changes.
          const me = (msg as FeastSnapshot).players.find((pl) => pl.profileId === profileId);
          if (me) {
            if (!seededPos.current) {
              seededPos.current = true;
              selfPos.current = me.rimPos;
              selfAim.current = me.rimPos;
              setSelfRender({ pos: me.rimPos, aim: me.rimPos });
            }
            if (me.score > myScore.current) {
              playCorrect();
              setPulse((n) => n + 1);
            }
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
    ws.onerror = () => {
      if (!cancelled) setWsError(t('feast.wsError'));
    };
    return () => {
      cancelled = true;
      ws.close();
    };
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

  // Steering + throttled move broadcast while playing. The muncher eases toward
  // the pointer target (selfAim); scoring stays server-side.
  useEffect(() => {
    if (phase !== 'playing') return;
    let raf = 0;
    let last = 0;
    let lastSent = 0;
    const loop = (t: number) => {
      const dt = last ? t - last : 16;
      last = t;
      const meNow = snapRef.current?.players.find((p) => p.profileId === profileId);
      if (!meNow?.stunned) {
        selfPos.current = stepRimPos(selfPos.current, selfAim.current, dt);
      }
      setSelfRender({ pos: selfPos.current, aim: selfAim.current });
      if (t - lastSent > 80) {
        lastSent = t;
        send({ type: 'move', rimPos: selfPos.current, aim: selfAim.current, firing: firing > 0 });
      }
      // Positional bump: steer into a rival to stun them (server enforces the
      // real cooldown; this local gate just avoids spamming the socket).
      if (!meNow?.stunned && t - bumpAt.current > 400) {
        for (const other of snapRef.current?.players ?? []) {
          if (other.profileId === profileId) continue;
          if (inBumpRange(selfPos.current, other.rimPos)) {
            bumpAt.current = t;
            send({ type: 'bump', targetId: other.profileId });
            break;
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, firing]);

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

  // Point-to-aim: the pointer sets both where the muncher steers (selfAim, eased
  // in the rAF loop) and where the tongue points. Fire shoots at the nearest
  // in-reach plate; the server decides right/wrong.
  const aimAt = (clientX: number, clientY: number) => {
    const el = ringRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    selfAim.current = invPlateFrac(fracFromPoint(cx, cy, clientX, clientY));
  };
  const fire = () => {
    if (me?.stunned) return;
    const id = pickTarget(platesRef.current, selfPos.current, selfAim.current);
    if (id != null) send({ type: 'grab', plateId: id });
    setFiring((n) => n + 1);
    window.setTimeout(() => setFiring((n) => Math.max(0, n - 1)), 180);
  };
  const onRingPointerMove = (e: ReactPointerEvent) => aimAt(e.clientX, e.clientY);
  const onKeyControl = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowLeft') selfAim.current = clamp01(selfAim.current - 0.05);
    else if (e.key === 'ArrowRight') selfAim.current = clamp01(selfAim.current + 0.05);
    else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      fire();
    }
  };

  return (
    <div className="screen feast">
      <header className="feast-header">
        <button className="btn ghost" onClick={leave}>
          <span aria-hidden="true">← </span>
          {t('play.quit')}
        </button>
        <div className="feast-fact" aria-live="polite" key={factPulse}>
          {snap ? (
            <>
              {snap.factA} <span className="feast-op">{OP_SYMBOL[snap.factOp]}</span> {snap.factB}{' '}
              <span className="feast-op">=</span> <span className="feast-q">?</span>
            </>
          ) : null}
        </div>
        <div className={`feast-timer ${seconds <= 10 ? 'low' : ''}`}>{seconds}s</div>
      </header>

      {/* The round belt. Plates ride an inner ring; munchers sit on the rim.
          Point anywhere to steer + aim; tap/click (or FIRE) shoots the tongue. */}
      <div
        className="feast-ring"
        ref={ringRef}
        aria-label={t('feast.beltLabel')}
        onPointerMove={onRingPointerMove}
        onPointerDown={(e) => {
          aimAt(e.clientX, e.clientY);
          fire();
        }}
        tabIndex={0}
        onKeyDown={onKeyControl}
      >
        <div className="feast-ring-track" aria-hidden="true" />
        {snap?.plates.map((plate) => {
          const { x, y } = pointOnCircle(50, 50, 38, plateFrac(plate.pos));
          return (
            <button
              key={plate.id}
              className="feast-plate"
              style={{ left: `${x}%`, top: `${y}%` }}
              onClick={() => send({ type: 'grab', plateId: plate.id })}
              disabled={me?.stunned}
              aria-label={String(plate.value)}
            >
              {plate.value}
            </button>
          );
        })}
        {snap?.players
          .filter((p) => p.profileId !== profileId)
          .map((p) => {
            const { x, y } = pointOnCircle(50, 50, 48, p.rimPos);
            return (
              <span
                key={p.profileId}
                className={`feast-muncher ${p.stunned ? 'stunned' : ''}`}
                style={{ left: `${x}%`, top: `${y}%` }}
              >
                <Muncher animal={p.muncher} state={p.stunned ? 'bleh' : 'still'} size={44} />
                {p.stunned && (
                  <span className="feast-stun" aria-hidden="true">
                    💫
                  </span>
                )}
                {p.firing && <span className="feast-tongue-mini" aria-hidden="true" />}
              </span>
            );
          })}
        {me &&
          (() => {
            const { x, y } = pointOnCircle(50, 50, 48, selfRender.pos);
            return (
              <span
                className={`feast-muncher you ${me.stunned ? 'stunned' : ''} ${firing > 0 ? 'firing' : ''}`}
                style={{ left: `${x}%`, top: `${y}%` }}
              >
                <Muncher animal={me.muncher} state={me.stunned ? 'bleh' : 'still'} size={48} />
                {me.stunned && (
                  <span className="feast-stun" aria-hidden="true">
                    💫
                  </span>
                )}
              </span>
            );
          })()}
      </div>

      {/* Display-only scoreboard (bumping is positional now). */}
      <div className="feast-players">
        {snap?.players.map((p) => {
          const you = p.profileId === profileId;
          return (
            <span
              key={p.profileId}
              className={`feast-player ${you ? 'you' : ''} ${p.stunned ? 'stunned' : ''}`}
            >
              <span aria-hidden="true">{p.avatar}</span>
              <span className="feast-player-name">{you ? t('feast.you') : p.name}</span>
              {/* Keying my score by `pulse` remounts it on each correct grab so
                  the pop animation replays. */}
              <span className="feast-player-score" key={you ? pulse : undefined}>
                {p.score}
              </span>
            </span>
          );
        })}
      </div>

      <button className="btn sun feast-fire" onClick={fire} disabled={me?.stunned}>
        {t('feast.fire')}
      </button>

      <p className="feast-hint muted">{t('feast.tapHint')}</p>
    </div>
  );
}

/** Whether the given profile is marked ready in a lobby broadcast (used to
 *  reset the local ready flag when the server bumps everyone back to the lobby). */
function p2Ready(players: LobbyPlayer[], profileId: string): boolean {
  return players.find((p) => p.profileId === profileId)?.ready ?? false;
}
