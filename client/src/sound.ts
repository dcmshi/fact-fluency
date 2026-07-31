/**
 * Tiny sound-effect kit, synthesized with the Web Audio API so there are no
 * binary assets to ship. Warm, short, non-punitive cues (DESIGN.md §4.8) — a
 * wrong answer gets a soft low blip, never a harsh buzzer. Muteable; the choice
 * persists. The AudioContext is created lazily on the first play (which always
 * follows a tap), satisfying browser autoplay rules.
 */
const MUTE_KEY = 'ff_muted';

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx ??= new Ctor();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

export function isMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    // Same reason setMuted swallows: storage access throws outright in some
    // privacy modes. Every sound in the app goes through here, so an unguarded
    // read doesn't lose the mute preference — it takes down play.
    return false;
  }
}

/** Set mute and return the new state. */
export function setMuted(muted: boolean): boolean {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    /* ignore */
  }
  return muted;
}

/** Play one shaped note. `at` is an offset (s) from now for sequencing. */
function note(freq: number, at: number, dur: number, type: OscillatorType, vol: number): void {
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime + at;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function play(notes: () => void): void {
  if (isMuted()) return;
  notes();
}

/** Correct (not fast): a friendly rising two-note. */
export function playCorrect(): void {
  play(() => {
    note(523.25, 0, 0.14, 'sine', 0.16); // C5
    note(659.25, 0.085, 0.16, 'sine', 0.16); // E5
  });
}

/** Correct AND fast: a brighter little sparkle arpeggio. */
export function playFast(): void {
  play(() => {
    note(1046.5, 0, 0.1, 'triangle', 0.15); // C6
    note(1318.5, 0.06, 0.1, 'triangle', 0.15); // E6
    note(1568.0, 0.12, 0.16, 'triangle', 0.15); // G6
  });
}

/** Wrong: a soft, low, non-punitive descending blip. */
export function playWrong(): void {
  play(() => {
    note(311.13, 0, 0.16, 'triangle', 0.12); // Eb4
    note(233.08, 0.12, 0.22, 'triangle', 0.12); // Bb3
  });
}

/** The displayed fact just changed: a bright, quick two-note "ding" so kids
 *  notice the new target while they're busy steering. Distinct from
 *  correct/wrong so it never reads as a score cue. */
export function playFactChange(): void {
  play(() => {
    note(880.0, 0, 0.09, 'triangle', 0.14); // A5
    note(1174.66, 0.07, 0.13, 'triangle', 0.14); // D6
  });
}

/** Session complete: a short ascending fanfare. */
export function playComplete(): void {
  play(() => {
    note(523.25, 0, 0.16, 'sine', 0.16); // C5
    note(659.25, 0.12, 0.16, 'sine', 0.16); // E5
    note(783.99, 0.24, 0.16, 'sine', 0.16); // G5
    note(1046.5, 0.36, 0.3, 'sine', 0.18); // C6
  });
}
