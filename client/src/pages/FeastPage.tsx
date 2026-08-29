import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import type { FeastSnapshot, FeastStanding } from '@shared';
import { Muncher } from '../components/Muncher';
import { OP_SYMBOL } from '../ops';
import { playComplete, playCorrect, playFactChange, playWrong } from '../sound';
import {
  ARENA_RENDER_RADIUS,
  clampToArena,
  normalizeVector,
  pickTarget,
  plateArenaPoint,
  PLATE_RENDER_RADIUS,
  pointInArena,
  pointOnBelt,
  pointerSteerInput,
  resolvePlayerCollisions,
  stepArenaMotion,
  tongueEnd,
  vectorLength,
  type Vec2,
} from './feastArena';
import { useDocumentTitle } from '../useDocumentTitle';
import './FeastPage.css';

type Phase = 'connecting' | 'lobby' | 'countdown' | 'playing' | 'finished';

/** Normalized arena movement below this is visually sub-pixel. */
const MOVE_EPSILON = 0.0005;
/** Long enough to read as a tongue strike without making repeat shots sluggish. */
const TONGUE_VISIBLE_MS = 260;

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
 * server snapshots (belt of plates + players + fact + timer); steer with a
 * pointer or keyboard and fire the tongue to grab a plate. The server is
 * authoritative for game truth; the client owns immediate movement/aiming.
 */
export function FeastPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('titles.feast'));
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
  const selfPos = useRef<Vec2>({ x: 0, y: -0.45 }); // normalized arena position
  const selfVelocity = useRef<Vec2>({ x: 0, y: 0 });
  const selfImpactPos = useRef<Vec2>({ x: 0, y: -0.45 });
  const selfImpactVelocity = useRef<Vec2>({ x: 0, y: 0 });
  const lastServerPush = useRef<Vec2>({ x: 0, y: 0 });
  const selfAim = useRef<Vec2>({ x: 0, y: -1 }); // unit tongue/facing direction
  const pointerTarget = useRef<Vec2>({ x: 0, y: -0.45 });
  const controlMode = useRef<'pointer' | 'keyboard'>('pointer');
  const keyboardInput = useRef<Vec2>({ x: 0, y: 0 });
  const keyboardHeld = useRef({ left: false, right: false, up: false, down: false });
  const fireAction = useRef<() => void>(() => {});
  const platesRef = useRef<FeastSnapshot['plates']>([]);
  const snapRef = useRef<FeastSnapshot | null>(null); // latest snapshot, for fresh reads in the rAF loop
  const seededPos = useRef(false); // have we placed the muncher at the server's seed yet?
  const [selfRender, setSelfRender] = useState({
    pos: { x: 0, y: -0.45 },
    aim: { x: 0, y: -1 },
  });
  const [firing, setFiring] = useState(0); // >0 while the tongue is out (renders)
  const firingRef = useRef(0); // the same count, for the steering loop to read
  const fireTimers = useRef<number[]>([]); // pending tongue-retract timers
  const lastFact = useRef(''); // detect fact rotation to fire the cue
  const [factPulse, setFactPulse] = useState(0); // remounts the fact banner to replay its pop

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const query = new URLSearchParams({ profileId });
    const ws = new WebSocket(`${proto}://${location.host}/api/feast-ws?${query}`);
    wsRef.current = ws;
    // React 18 StrictMode double-invokes this effect in dev: the first socket is
    // closed mid-handshake by the cleanup below. Ignore that aborted socket's
    // error/messages so it can't mask the second, live connection.
    let cancelled = false;
    ws.onmessage = (ev) => {
      if (cancelled) return;
      let msg: Partial<FeastSnapshot> & {
        type?: string;
        code?: string;
        players?: LobbyPlayer[];
        ms?: number;
        standings?: FeastStanding[];
      };
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return; // a malformed frame shouldn't drop the arena
      }
      switch (msg.type) {
        case 'joined':
          setPhase('lobby');
          break;
        case 'lobby': {
          const roster = msg.players ?? [];
          setLobby(roster);
          setPhase((p) => (p === 'connecting' ? 'lobby' : p === 'finished' ? 'lobby' : p));
          if (p2Ready(roster, profileId) === false) setReady(false);
          break;
        }
        case 'countdown':
          setPhase('countdown');
          setCountdown(Math.ceil((msg.ms ?? 0) / 1000));
          seededPos.current = false; // re-seed the muncher position for a rematch
          lastServerPush.current = { x: 0, y: 0 };
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
              selfPos.current = { x: me.x, y: me.y };
              selfVelocity.current = { x: 0, y: 0 };
              selfImpactPos.current = { x: me.x, y: me.y };
              selfImpactVelocity.current = { x: 0, y: 0 };
              lastServerPush.current = { x: me.pushX, y: me.pushY };
              selfAim.current = { x: me.aimX, y: me.aimY };
              pointerTarget.current = selfPos.current;
              setSelfRender({ pos: selfPos.current, aim: selfAim.current });
            } else {
              const requestedPush = {
                x: me.pushX - lastServerPush.current.x,
                y: me.pushY - lastServerPush.current.y,
              };
              lastServerPush.current = { x: me.pushX, y: me.pushY };
              if (Math.hypot(requestedPush.x, requestedPush.y) > MOVE_EPSILON) {
                const before = selfPos.current;
                selfPos.current = clampToArena({
                  x: before.x + requestedPush.x,
                  y: before.y + requestedPush.y,
                });
                const appliedPush = {
                  x: selfPos.current.x - before.x,
                  y: selfPos.current.y - before.y,
                };
                selfVelocity.current = { x: me.pushVx, y: me.pushVy };
                // Preserve pointer-steering intent: the shove moves both the
                // muncher and its virtual-stick target by the same amount.
                pointerTarget.current = {
                  x: pointerTarget.current.x + appliedPush.x,
                  y: pointerTarget.current.y + appliedPush.y,
                };
                setSelfRender({ pos: { ...selfPos.current }, aim: { ...selfAim.current } });
              }
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
          setStandings(msg.standings ?? []);
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
    ws.onclose = () => {
      // Without this the arena just freezes: snapshots stop, the timer sticks,
      // and taps do nothing (send() is readyState-guarded) with nothing said.
      if (cancelled) return;
      setPhase((p) => (p === 'finished' ? p : 'connecting'));
      setWsError((prev) => prev ?? t('feast.wsLost'));
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

  // Steering + throttled move broadcast while playing. Physics mirrors the
  // original Sushi-Go-Round ratios: quick pickup, heavier braking/reversal.
  useEffect(() => {
    if (phase !== 'playing') return;
    let raf = 0;
    let last = 0;
    let lastSent = 0;
    const loop = (t: number) => {
      const dt = last ? t - last : 16;
      last = t;
      const meNow = snapRef.current?.players.find((p) => p.profileId === profileId);
      let moved = { pos: selfPos.current, velocity: selfVelocity.current };
      if (!meNow?.stunned) {
        const input =
          controlMode.current === 'keyboard'
            ? keyboardInput.current
            : pointerSteerInput(selfPos.current, pointerTarget.current);
        moved = stepArenaMotion(selfPos.current, selfVelocity.current, input, dt);
        if (vectorLength(input) > 0) selfAim.current = normalizeVector(input, selfAim.current);
      } else {
        moved = { pos: selfPos.current, velocity: { x: 0, y: 0 } };
      }
      selfImpactPos.current = moved.pos;
      selfImpactVelocity.current = moved.velocity;
      const collision = resolvePlayerCollisions(
        moved.pos,
        moved.velocity,
        (snapRef.current?.players ?? [])
          .filter((p) => p.profileId !== profileId)
          .map((p) => ({
            id: p.profileId,
            pos: { x: p.x, y: p.y },
            velocity: { x: p.vx, y: p.vy },
          })),
        dt,
      );
      selfPos.current = collision.pos;
      selfVelocity.current = collision.velocity;
      // Only re-render when the muncher actually moved. A fresh object every
      // frame reconciled the whole arena — every plate, rival, and the
      // scoreboard — 60×/s even while standing still, which is real dropped
      // frames on the older tablets this is meant to run on.
      setSelfRender((prev) =>
        Math.abs(prev.pos.x - selfPos.current.x) < MOVE_EPSILON &&
        Math.abs(prev.pos.y - selfPos.current.y) < MOVE_EPSILON &&
        Math.abs(prev.aim.x - selfAim.current.x) < MOVE_EPSILON &&
        Math.abs(prev.aim.y - selfAim.current.y) < MOVE_EPSILON
          ? prev
          : { pos: { ...selfPos.current }, aim: { ...selfAim.current } },
      );
      if (t - lastSent > 80) {
        lastSent = t;
        send({
          type: 'move',
          x: selfPos.current.x,
          y: selfPos.current.y,
          vx: selfVelocity.current.x,
          vy: selfVelocity.current.y,
          impactX: selfImpactPos.current.x,
          impactY: selfImpactPos.current.y,
          impactVx: selfImpactVelocity.current.x,
          impactVy: selfImpactVelocity.current.y,
          aimX: selfAim.current.x,
          aimY: selfAim.current.y,
          firing: firingRef.current > 0,
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // Not `firing`: the loop only needs its current value, which it reads from
    // firingRef. Depending on the state tore the whole steering loop down and
    // restarted it on every tongue shot — twice per shot, mid-play.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Stadium controls belong to the game, not to whichever child happened to
  // receive focus. Listen for them for the whole playing phase so clicking a
  // plate or FIRE cannot silently disable movement.
  useEffect(() => {
    if (phase !== 'playing') return;
    type Direction = keyof typeof keyboardHeld.current;
    const directionFor = (key: string): Direction | null => {
      switch (key.toLowerCase()) {
        case 'arrowleft':
        case 'a':
          return 'left';
        case 'arrowright':
        case 'd':
          return 'right';
        case 'arrowup':
        case 'w':
          return 'up';
        case 'arrowdown':
        case 's':
          return 'down';
        default:
          return null;
      }
    };
    const refreshInput = () => {
      keyboardInput.current = {
        x: Number(keyboardHeld.current.right) - Number(keyboardHeld.current.left),
        y: Number(keyboardHeld.current.down) - Number(keyboardHeld.current.up),
      };
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const direction = directionFor(event.key);
      if (direction) {
        event.preventDefault();
        controlMode.current = 'keyboard';
        keyboardHeld.current[direction] = true;
        refreshInput();
        if (vectorLength(keyboardInput.current) > 0) {
          selfAim.current = normalizeVector(keyboardInput.current, selfAim.current);
        }
        return;
      }
      if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
        // Native buttons synthesize their own click for Space/Enter.
        if (event.target instanceof HTMLButtonElement) return;
        event.preventDefault();
        fireAction.current();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const direction = directionFor(event.key);
      if (!direction) return;
      event.preventDefault();
      keyboardHeld.current[direction] = false;
      refreshInput();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      keyboardHeld.current = { left: false, right: false, up: false, down: false };
      keyboardInput.current = { x: 0, y: 0 };
    };
  }, [phase]);

  // A quit mid-tongue must not leave a retract timer to fire into an unmounted
  // arena.
  useEffect(() => () => fireTimers.current.forEach((id) => clearTimeout(id)), []);

  // ---- lobby ----
  if (phase === 'connecting' || phase === 'lobby') {
    return (
      <main className="screen center-y">
        <div className="stack rise" style={{ textAlign: 'center' }}>
          <div className="big-emoji" aria-hidden="true">
            🍣
          </div>
          <h1>{t('feast.title')}</h1>
          {wsError ? (
            <p className="error-banner" role="alert">
              {wsError}
            </p>
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
      </main>
    );
  }

  // ---- countdown ----
  if (phase === 'countdown') {
    return (
      <main className="screen center-y">
        <div className="stack rise" style={{ textAlign: 'center' }}>
          <div className="big-emoji" aria-hidden="true">
            🍣
          </div>
          <div className="feast-countdown" role="status">
            {countdown && countdown > 0 ? countdown : t('feast.go')}
          </div>
        </div>
      </main>
    );
  }

  // ---- results ----
  if (phase === 'finished' && standings) {
    const me = standings.find((s) => s.profileId === profileId);
    const won = me?.placement === 1;
    return (
      <main className="screen center-y">
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
      </main>
    );
  }

  // ---- playing ----
  const me = snap?.players.find((p) => p.profileId === profileId);
  const seconds = snap ? Math.ceil(snap.timeLeftMs / 1000) : 0;

  // The pointer is a virtual analogue stick: its vector from the muncher sets
  // both movement and facing. Coordinates are normalized by the playable
  // interior radius, so a belt plate sits just outside the movement boundary.
  const aimAt = (clientX: number, clientY: number) => {
    const el = ringRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const target = {
      x: (clientX - cx) / ((r.width * ARENA_RENDER_RADIUS) / 100),
      y: (clientY - cy) / ((r.height * ARENA_RENDER_RADIUS) / 100),
    };
    controlMode.current = 'pointer';
    pointerTarget.current = target;
    selfAim.current = normalizeVector(
      { x: target.x - selfPos.current.x, y: target.y - selfPos.current.y },
      selfAim.current,
    );
  };
  /** Keep the render state and the loop's ref copy of the tongue count in step. */
  const bumpFiring = (delta: number) => {
    firingRef.current = Math.max(0, firingRef.current + delta);
    setFiring(firingRef.current);
  };
  const fire = () => {
    if (me?.stunned) return;
    const id = pickTarget(platesRef.current, selfPos.current, selfAim.current);
    if (id != null) send({ type: 'grab', plateId: id });
    bumpFiring(1);
    const timer = window.setTimeout(() => {
      fireTimers.current = fireTimers.current.filter((t) => t !== timer);
      bumpFiring(-1);
    }, TONGUE_VISIBLE_MS);
    fireTimers.current.push(timer);
  };
  fireAction.current = fire;
  const onRingPointerMove = (e: ReactPointerEvent) => aimAt(e.clientX, e.clientY);

  const tongueLines = [
    ...(snap?.players
      .filter((p) => p.profileId !== profileId && p.firing)
      .map((p) => ({
        id: p.profileId,
        from: { x: p.x, y: p.y },
        aim: { x: p.aimX, y: p.aimY },
        you: false,
      })) ?? []),
    ...(me && firing > 0
      ? [{ id: profileId, from: selfPos.current, aim: selfAim.current, you: true }]
      : []),
  ];

  return (
    <main className="screen feast">
      <header className="feast-header">
        <button className="btn ghost" onClick={leave}>
          <span aria-hidden="true">← </span>
          {t('play.quit')}
        </button>
        {/* The live region itself must stay mounted — a remounted one usually
            fails to announce at all. `factPulse` keys the inner span instead, so
            the pop animation still replays on each fact rotation. */}
        <div className="feast-fact" aria-live="polite">
          {snap ? (
            <span className="feast-fact-pop" key={factPulse}>
              {snap.factA} <span className="feast-op">{OP_SYMBOL[snap.factOp]}</span> {snap.factB}{' '}
              <span className="feast-op">=</span> <span className="feast-q">?</span>
            </span>
          ) : null}
        </div>
        <div className={`feast-timer ${seconds <= 10 ? 'low' : ''}`}>
          {t('common.seconds', { n: seconds })}
        </div>
      </header>

      {/* Plates ride the belt while munchers move freely inside it. Pointer or
          keyboard input steers; tap/click (or FIRE) shoots the tongue. */}
      <div
        className="feast-ring"
        ref={ringRef}
        // A focusable div with its own keyboard model and no role reads as
        // nothing at all. `application` is the honest one here: the arrows and
        // space are live game controls, not document navigation, so a screen
        // reader should hand them straight through.
        role="application"
        aria-label={t('feast.beltLabel')}
        onPointerMove={onRingPointerMove}
        onPointerDown={(e) => {
          aimAt(e.clientX, e.clientY);
          fire();
        }}
        tabIndex={0}
      >
        <div className="feast-ring-track" aria-hidden="true" />
        {snap?.plates.map((plate) => {
          const { x, y } = pointOnBelt(50, 50, PLATE_RENDER_RADIUS, plate.pos);
          return (
            <button
              key={plate.id}
              className="feast-plate"
              style={{ left: `${x}%`, top: `${y}%` }}
              // Plates sit inside the ring, so a tap used to fire twice: the
              // ring's pointerdown shot the tongue at whatever was nearest *in
              // reach* of the aim, and the button sent a second grab for the
              // plate actually tapped. Tapping a far plate could therefore
              // munch a different, wrong-valued one and stun the kid for a tap
              // that was right. One path now: aim at this plate, then fire —
              // same tongue mechanic as tapping the belt, reach still honoured.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                const target = plateArenaPoint(plate.pos);
                controlMode.current = 'pointer';
                pointerTarget.current = target;
                selfAim.current = normalizeVector(
                  { x: target.x - selfPos.current.x, y: target.y - selfPos.current.y },
                  selfAim.current,
                );
                fire();
              }}
              disabled={me?.stunned}
              aria-label={String(plate.value)}
            >
              {plate.value}
            </button>
          );
        })}
        {tongueLines.length > 0 && (
          <svg
            className="feast-tongues"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {tongueLines.map((line) => {
              const from = pointInArena(50, 50, ARENA_RENDER_RADIUS, line.from);
              const to = pointInArena(50, 50, ARENA_RENDER_RADIUS, tongueEnd(line.from, line.aim));
              return (
                <line
                  key={line.id}
                  className={line.you ? 'you' : undefined}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                />
              );
            })}
          </svg>
        )}
        {snap?.players
          .filter((p) => p.profileId !== profileId)
          .map((p) => {
            const { x, y } = pointInArena(50, 50, ARENA_RENDER_RADIUS, {
              x: p.x,
              y: p.y,
            });
            return (
              <span
                key={p.profileId}
                className={`feast-muncher ${p.stunned ? 'stunned' : ''}`}
                style={{ left: `${x}%`, top: `${y}%` }}
              >
                <Muncher animal={p.muncher} state={p.stunned ? 'bleh' : 'still'} size="100%" />
                {p.stunned && (
                  <span className="feast-stun" aria-hidden="true">
                    💫
                  </span>
                )}
              </span>
            );
          })}
        {me &&
          (() => {
            const { x, y } = pointInArena(50, 50, ARENA_RENDER_RADIUS, selfRender.pos);
            return (
              <span
                className={`feast-muncher you ${me.stunned ? 'stunned' : ''}`}
                style={{ left: `${x}%`, top: `${y}%` }}
              >
                <Muncher animal={me.muncher} state={me.stunned ? 'bleh' : 'still'} size="100%" />
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
    </main>
  );
}

/** Whether the given profile is marked ready in a lobby broadcast (used to
 *  reset the local ready flag when the server bumps everyone back to the lobby). */
function p2Ready(players: LobbyPlayer[], profileId: string): boolean {
  return players.find((p) => p.profileId === profileId)?.ready ?? false;
}
