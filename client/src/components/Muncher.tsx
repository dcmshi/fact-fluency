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
  /** On the head, under the eyes (patches, snout details). */
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
        <path d="M25,35 C21,15 27,7 33,11 C40,16 45,27 48,33 Z" fill="#a9b4c4" {...stroke} />
        <path d="M75,35 C79,15 73,7 67,11 C60,16 55,27 52,33 Z" fill="#a9b4c4" {...stroke} />
        <path d="M30,30 C28,19 31,14 34,16 C38,19 41,26 42,29 Z" fill="#ffb3c7" />
        <path d="M70,30 C72,19 69,14 66,16 C62,19 59,26 58,29 Z" fill="#ffb3c7" />
      </>
    ),
    nose: heartNose('#ff7a9c'),
    front: (
      <g {...stroke} strokeWidth={1.5} opacity={0.55}>
        <line x1="14" y1="62" x2="28" y2="63" />
        <line x1="14" y1="68" x2="28" y2="66" />
        <line x1="86" y1="62" x2="72" y2="63" />
        <line x1="86" y1="68" x2="72" y2="66" />
      </g>
    ),
  },
  dog: {
    label: 'Dog',
    fill: '#e0b075',
    muzzle: '#f6e6c8',
    back: (
      <>
        <ellipse cx="17" cy="50" rx="12" ry="23" fill="#c4914d" {...stroke} transform="rotate(-16 17 50)" />
        <ellipse cx="83" cy="50" rx="12" ry="23" fill="#c4914d" {...stroke} transform="rotate(16 83 50)" />
      </>
    ),
    front: <ellipse cx="64" cy="40" rx="13" ry="11" fill="#c4914d" opacity="0.65" />,
    nose: <ellipse cx="50" cy="58" rx="6.5" ry="5.5" fill={INK} {...stroke} strokeWidth={1.5} />,
  },
  fox: {
    label: 'Fox',
    fill: '#ff8f43',
    muzzle: '#fff3e2',
    back: (
      <>
        <path d="M24,34 C20,12 27,6 33,10 C41,16 46,27 49,33 Z" fill="#ff8f43" {...stroke} />
        <path d="M76,34 C80,12 73,6 67,10 C59,16 54,27 51,33 Z" fill="#ff8f43" {...stroke} />
        <path d="M28,24 C26,13 30,9 33,12 C37,16 39,23 40,27 Z" fill={INK} />
        <path d="M72,24 C74,13 70,9 67,12 C63,16 61,23 60,27 Z" fill={INK} />
      </>
    ),
    nose: <ellipse cx="50" cy="58" rx="5.5" ry="4.5" fill={INK} {...stroke} strokeWidth={1.4} />,
  },
  frog: {
    label: 'Frog',
    fill: '#79c94e',
    muzzle: '#a6e07f',
    noFaceEyes: true, // the big eyes live on the bumps
    back: (
      <>
        <circle cx="33" cy="30" r="14" fill="#79c94e" {...stroke} />
        <circle cx="67" cy="30" r="14" fill="#79c94e" {...stroke} />
        <g className="m-eye">
          <circle cx="33" cy="30" r="8" fill="#fffef7" />
          <circle cx="33" cy="31" r="5" fill={INK} />
          <circle cx="30.8" cy="28.5" r="2.1" fill="#fff" />
        </g>
        <g className="m-eye">
          <circle cx="67" cy="30" r="8" fill="#fffef7" />
          <circle cx="67" cy="31" r="5" fill={INK} />
          <circle cx="64.8" cy="28.5" r="2.1" fill="#fff" />
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
        <ellipse cx="39" cy="13" rx="7.5" ry="24" fill="#f6eef6" {...stroke} transform="rotate(-7 39 13)" />
        <ellipse cx="61" cy="13" rx="7.5" ry="24" fill="#f6eef6" {...stroke} transform="rotate(7 61 13)" />
        <ellipse cx="39" cy="14" rx="3.4" ry="17" fill="#ffc2d6" transform="rotate(-7 39 14)" />
        <ellipse cx="61" cy="14" rx="3.4" ry="17" fill="#ffc2d6" transform="rotate(7 61 14)" />
      </>
    ),
    nose: heartNose('#ff7a9c'),
    overlay: (
      <g fill="#fffef7" {...stroke} strokeWidth={1.3}>
        <rect x="46.4" y="73" width="3.4" height="6.5" rx="1.4" />
        <rect x="50.2" y="73" width="3.4" height="6.5" rx="1.4" />
      </g>
    ),
  },
  panda: {
    label: 'Panda',
    fill: '#fbfbfb',
    back: (
      <>
        <circle cx="26" cy="24" r="12" fill={INK} />
        <circle cx="74" cy="24" r="12" fill={INK} />
        <circle cx="26" cy="24" r="5" fill="#6b6478" />
        <circle cx="74" cy="24" r="5" fill="#6b6478" />
      </>
    ),
    front: (
      <>
        <ellipse cx="37" cy="51" rx="9.5" ry="12.5" fill={INK} transform="rotate(-14 37 51)" />
        <ellipse cx="63" cy="51" rx="9.5" ry="12.5" fill={INK} transform="rotate(14 63 51)" />
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
        <path d="M33,25 C32,11 37,6 40,9 C43,12 44,21 45,27 Z" fill="#ffd98a" {...stroke} />
        <path d="M67,25 C68,11 63,6 60,9 C57,12 56,21 55,27 Z" fill="#ffd98a" {...stroke} />
      </>
    ),
    front: (
      <g fill="#ffd98a" {...stroke} strokeWidth={2}>
        <path d="M44 20 L50 13 L56 20 Z" />
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
    <circle cx={cx} cy="52" r="7.5" fill={INK} />
    <circle cx={cx - 2.4} cy="49" r="3" fill="#fff" />
    <circle cx={cx + 2.2} cy="54.5" r="1.4" fill="#fff" />
  </g>
);

/**
 * A cute illustrated animal that drives the munch board. `state` triggers the
 * shared CSS rig (idle bob, chomp, happy bounce, bleh recoil). Falls back to the
 * cat for unknown keys. Built from chunky rounded shapes with big sparkly eyes,
 * rosy cheeks, a soft top shine and little feet.
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
        <ellipse cx="38" cy="89" rx="7.5" ry="5.5" fill={spec.fill} {...stroke} />
        <ellipse cx="62" cy="89" rx="7.5" ry="5.5" fill={spec.fill} {...stroke} />
        {spec.back}
        {/* head */}
        <circle cx="50" cy="51" r="33" fill={spec.fill} stroke={INK} strokeWidth="4" />
        {spec.muzzle && <ellipse cx="50" cy="64" rx="19" ry="15" fill={spec.muzzle} />}
        {/* soft top shine */}
        <ellipse cx="40" cy="33" rx="15" ry="10" fill="#fff" opacity="0.22" />
        {spec.front}
        {/* rosy cheeks */}
        <ellipse cx="28" cy="63" rx="6.5" ry="4.3" fill={BLUSH} opacity="0.72" />
        <ellipse cx="72" cy="63" rx="6.5" ry="4.3" fill={BLUSH} opacity="0.72" />
        {spec.nose}
        {!spec.noFaceEyes && (
          <>
            <Eye cx={37} />
            <Eye cx={63} />
          </>
        )}
        <g className="m-mouth">
          <path
            className="m-smile"
            d="M43 68 Q50 75 57 68"
            fill="none"
            stroke={INK}
            strokeWidth="3"
            strokeLinecap="round"
          />
          <g className="m-maw">
            <path d="M41 65 Q50 63 59 65 Q57 79 50 79 Q43 79 41 65 Z" fill="#6b2b3d" />
            <ellipse className="m-tongue" cx="50" cy="74" rx="6" ry="4.5" fill="#ff7a9c" />
          </g>
        </g>
        {spec.overlay}
      </g>
    </svg>
  );
}
