import './Muncher.css';

/** Animation state for a muncher character. */
export type MuncherState = 'idle' | 'chomp' | 'happy' | 'bleh';

const INK = '#3a3350';
const BLUSH = '#ff8fae';

interface AnimalSpec {
  label: string;
  fill: string;
  /** Lighter muzzle/belly patch color (optional). */
  muzzle?: string;
  /** Behind the head (ears, horns, floppy bits). */
  back?: JSX.Element;
  /** On the head, under the eyes (patches, snout details, frog eye-bumps). */
  front?: JSX.Element;
  /** A small nose, drawn just above the mouth. */
  nose?: JSX.Element;
  /** Above everything (e.g. bunny teeth). */
  overlay?: JSX.Element;
  /** Skip the shared face eyes (e.g. the frog carries its eyes on its bumps). */
  noFaceEyes?: boolean;
}

const stroke = { stroke: INK, strokeWidth: 3.5, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const };
const heartNose = (fill: string) => (
  <path d="M45 56 Q50 52 50 57 Q50 52 55 56 Q55 61 50 63 Q45 61 45 56 Z" fill={fill} {...stroke} strokeWidth={1.6} />
);

const ANIMALS: Record<string, AnimalSpec> = {
  cat: {
    label: 'Cat',
    fill: '#a9b4c4',
    muzzle: '#d7dde6',
    back: (
      <>
        <path d="M21,33 C17,11 25,4 31,9 C40,15 45,26 48,32 Z" fill="#a9b4c4" {...stroke} />
        <path d="M79,33 C83,11 75,4 69,9 C60,15 55,26 52,32 Z" fill="#a9b4c4" {...stroke} />
        <path d="M27,28 C25,15 29,10 32,13 C36,17 38,24 39,28 Z" fill="#ffb3c7" />
        <path d="M73,28 C75,15 71,10 68,13 C64,17 62,24 61,28 Z" fill="#ffb3c7" />
      </>
    ),
    nose: heartNose('#ff7a9c'),
    front: (
      <g {...stroke} strokeWidth={1.5} opacity={0.55}>
        <line x1="11" y1="60" x2="26" y2="61" />
        <line x1="11" y1="66" x2="26" y2="64" />
        <line x1="89" y1="60" x2="74" y2="61" />
        <line x1="89" y1="66" x2="74" y2="64" />
      </g>
    ),
  },
  dog: {
    label: 'Dog',
    fill: '#e0b075',
    muzzle: '#f6e6c8',
    back: (
      <>
        <ellipse cx="13" cy="50" rx="12" ry="23" fill="#c4914d" {...stroke} transform="rotate(-16 13 50)" />
        <ellipse cx="87" cy="50" rx="12" ry="23" fill="#c4914d" {...stroke} transform="rotate(16 87 50)" />
      </>
    ),
    front: <ellipse cx="65" cy="41" rx="13" ry="11" fill="#c4914d" opacity="0.6" />,
    nose: <ellipse cx="50" cy="58" rx="6.5" ry="5.5" fill={INK} {...stroke} strokeWidth={1.5} />,
  },
  fox: {
    label: 'Fox',
    fill: '#ff8f43',
    muzzle: '#fff3e2',
    back: (
      <>
        <path d="M19,32 C15,9 24,3 30,8 C40,15 45,25 48,31 Z" fill="#ff8f43" {...stroke} />
        <path d="M81,32 C85,9 76,3 70,8 C60,15 55,25 52,31 Z" fill="#ff8f43" {...stroke} />
        <path d="M24,23 C22,11 27,7 30,10 C34,15 36,22 37,26 Z" fill={INK} />
        <path d="M76,23 C78,11 73,7 70,10 C66,15 64,22 63,26 Z" fill={INK} />
      </>
    ),
    nose: <ellipse cx="50" cy="58" rx="5.5" ry="4.5" fill={INK} {...stroke} strokeWidth={1.4} />,
  },
  frog: {
    label: 'Frog',
    fill: '#79c94e',
    muzzle: '#a6e07f',
    noFaceEyes: true, // the big eyes live on the bumps, drawn on top of the head
    front: (
      <>
        <circle cx="32" cy="25" r="13" fill="#79c94e" {...stroke} />
        <circle cx="68" cy="25" r="13" fill="#79c94e" {...stroke} />
        <g className="m-eye">
          <circle cx="32" cy="25" r="8" fill="#fffef7" />
          <circle cx="32" cy="26" r="5" fill={INK} />
          <circle cx="29.8" cy="23.5" r="2.1" fill="#fff" />
        </g>
        <g className="m-eye">
          <circle cx="68" cy="25" r="8" fill="#fffef7" />
          <circle cx="68" cy="26" r="5" fill={INK} />
          <circle cx="65.8" cy="23.5" r="2.1" fill="#fff" />
        </g>
      </>
    ),
    nose: (
      <g fill={INK}>
        <circle cx="46" cy="57" r="1.5" />
        <circle cx="54" cy="57" r="1.5" />
      </g>
    ),
  },
  bunny: {
    label: 'Bunny',
    fill: '#f6eef6',
    muzzle: '#fff7fb',
    back: (
      <>
        <ellipse cx="37" cy="11" rx="7.5" ry="24" fill="#f6eef6" {...stroke} transform="rotate(-8 37 11)" />
        <ellipse cx="63" cy="11" rx="7.5" ry="24" fill="#f6eef6" {...stroke} transform="rotate(8 63 11)" />
        <ellipse cx="37" cy="12" rx="3.4" ry="17" fill="#ffc2d6" transform="rotate(-8 37 12)" />
        <ellipse cx="63" cy="12" rx="3.4" ry="17" fill="#ffc2d6" transform="rotate(8 63 12)" />
      </>
    ),
    nose: heartNose('#ff7a9c'),
    overlay: (
      <g fill="#fffef7" {...stroke} strokeWidth={1.3}>
        <rect x="46.4" y="74" width="3.4" height="6.5" rx="1.4" />
        <rect x="50.2" y="74" width="3.4" height="6.5" rx="1.4" />
      </g>
    ),
  },
  panda: {
    label: 'Panda',
    fill: '#fbfbfb',
    back: (
      <>
        <circle cx="22" cy="26" r="12" fill={INK} />
        <circle cx="78" cy="26" r="12" fill={INK} />
        <circle cx="22" cy="26" r="5" fill="#6b6478" />
        <circle cx="78" cy="26" r="5" fill="#6b6478" />
      </>
    ),
    front: (
      <>
        <ellipse cx="34" cy="52" rx="9.5" ry="12" fill={INK} transform="rotate(-14 34 52)" />
        <ellipse cx="66" cy="52" rx="9.5" ry="12" fill={INK} transform="rotate(14 66 52)" />
      </>
    ),
    nose: <ellipse cx="50" cy="58" rx="5" ry="4" fill={INK} {...stroke} strokeWidth={1.4} />,
  },
  dragon: {
    label: 'Dragon',
    fill: '#4cb6a6',
    muzzle: '#8fd9cc',
    back: (
      <>
        <path d="M31,27 C30,11 36,5 39,9 C42,13 43,22 44,29 Z" fill="#ffd98a" {...stroke} />
        <path d="M69,27 C70,11 64,5 61,9 C58,13 57,22 56,29 Z" fill="#ffd98a" {...stroke} />
      </>
    ),
    front: (
      <g fill="#ffd98a" {...stroke} strokeWidth={2}>
        <path d="M44 21 L50 13 L56 21 Z" />
      </g>
    ),
    nose: (
      <g fill={INK}>
        <ellipse cx="45.5" cy="58" rx="1.7" ry="2.3" />
        <ellipse cx="54.5" cy="58" rx="1.7" ry="2.3" />
      </g>
    ),
  },
};

export const MUNCHER_KEYS = Object.keys(ANIMALS);

const Eye = ({ cx }: { cx: number }) => (
  <g className="m-eye">
    <circle cx={cx} cy="53" r="7.5" fill={INK} />
    <circle cx={cx - 2.4} cy="50" r="3" fill="#fff" />
    <circle cx={cx + 2.2} cy="55.5" r="1.4" fill="#fff" />
  </g>
);

/**
 * A cute illustrated animal that drives the munch board. `state` triggers the
 * shared CSS rig (idle bob, chomp, happy bounce, bleh recoil). Falls back to the
 * cat for unknown keys. A wide, rounded "Hello Kitty"–style head with big
 * sparkly eyes, rosy cheeks, a soft top shine, a tiny smile and little feet.
 */
export function Muncher({
  animal,
  state = 'idle',
  size = 120,
}: {
  animal: string;
  state?: MuncherState;
  size?: number | string;
}) {
  const spec = ANIMALS[animal] ?? ANIMALS.cat;
  return (
    <svg
      className="muncher"
      data-state={state}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role="img"
      aria-label={`${spec.label} muncher`}
    >
      <g className="m-rig">
        {/* little feet peeking out the bottom */}
        <ellipse cx="37" cy="87" rx="8" ry="5.5" fill={spec.fill} {...stroke} />
        <ellipse cx="63" cy="87" rx="8" ry="5.5" fill={spec.fill} {...stroke} />
        {spec.back}
        {/* wide rounded head */}
        <ellipse cx="50" cy="52" rx="38" ry="30" fill={spec.fill} stroke={INK} strokeWidth="4" />
        {spec.muzzle && <ellipse cx="50" cy="64" rx="21" ry="14" fill={spec.muzzle} />}
        {/* soft top shine */}
        <ellipse cx="38" cy="33" rx="17" ry="9" fill="#fff" opacity="0.22" />
        {spec.front}
        {/* rosy cheeks */}
        <ellipse cx="24" cy="63" rx="7" ry="4.4" fill={BLUSH} opacity="0.72" />
        <ellipse cx="76" cy="63" rx="7" ry="4.4" fill={BLUSH} opacity="0.72" />
        {spec.nose}
        {!spec.noFaceEyes && (
          <>
            <Eye cx={34} />
            <Eye cx={66} />
          </>
        )}
        <g className="m-mouth">
          <path
            className="m-smile"
            d="M42 69 Q50 76 58 69"
            fill="none"
            stroke={INK}
            strokeWidth="3"
            strokeLinecap="round"
          />
          <g className="m-maw">
            <path d="M40 66 Q50 64 60 66 Q58 80 50 80 Q42 80 40 66 Z" fill="#6b2b3d" />
            <ellipse className="m-tongue" cx="50" cy="75" rx="6" ry="4.5" fill="#ff7a9c" />
          </g>
        </g>
        {spec.overlay}
      </g>
    </svg>
  );
}
