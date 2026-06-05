import './Muncher.css';

/** Animation state for a muncher character. */
export type MuncherState = 'idle' | 'chomp' | 'happy' | 'bleh';

const INK = '#2b2440';

interface AnimalSpec {
  label: string;
  fill: string;
  /** Behind the face (ears, horns). */
  back?: JSX.Element;
  /** On the face (patches, muzzle, eye-whites, nose, cheeks). */
  front?: JSX.Element;
  /** Above everything (e.g. teeth). */
  overlay?: JSX.Element;
}

const ear = (d: string, fill: string) => (
  <path d={d} fill={fill} stroke={INK} strokeWidth="4" strokeLinejoin="round" />
);

const ANIMALS: Record<string, AnimalSpec> = {
  cat: {
    label: 'Cat',
    fill: '#aeb7c2',
    back: (
      <>
        {ear('M27 36 L33 11 L49 31 Z', '#aeb7c2')}
        {ear('M73 36 L67 11 L51 31 Z', '#aeb7c2')}
        <path d="M31 30 L34 18 L42 29 Z" fill="#ff9ab0" />
        <path d="M69 30 L66 18 L58 29 Z" fill="#ff9ab0" />
      </>
    ),
    front: (
      <>
        <path d="M46 60 L54 60 L50 65 Z" fill="#ff9ab0" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
        <g stroke={INK} strokeWidth="1.6" strokeLinecap="round">
          <line x1="16" y1="60" x2="30" y2="61" />
          <line x1="16" y1="66" x2="30" y2="65" />
          <line x1="84" y1="60" x2="70" y2="61" />
          <line x1="84" y1="66" x2="70" y2="65" />
        </g>
      </>
    ),
  },
  dog: {
    label: 'Dog',
    fill: '#d9a869',
    back: (
      <>
        <ellipse cx="20" cy="54" rx="11" ry="20" fill="#b9863f" stroke={INK} strokeWidth="4" transform="rotate(-12 20 54)" />
        <ellipse cx="80" cy="54" rx="11" ry="20" fill="#b9863f" stroke={INK} strokeWidth="4" transform="rotate(12 80 54)" />
      </>
    ),
    front: (
      <>
        <ellipse cx="50" cy="66" rx="19" ry="14" fill="#efd9b5" />
        <ellipse cx="50" cy="58" rx="6.5" ry="5.5" fill={INK} />
      </>
    ),
  },
  fox: {
    label: 'Fox',
    fill: '#ff8a3d',
    back: (
      <>
        {ear('M25 34 L31 8 L48 30 Z', '#ff8a3d')}
        {ear('M75 34 L69 8 L52 30 Z', '#ff8a3d')}
        <path d="M27 22 L31 8 L39 23 Z" fill={INK} />
        <path d="M73 22 L69 8 L61 23 Z" fill={INK} />
      </>
    ),
    front: (
      <>
        <path d="M50 50 Q30 56 34 74 Q50 82 66 74 Q70 56 50 50 Z" fill="#fff7ec" />
        <ellipse cx="50" cy="60" rx="5.5" ry="4.5" fill={INK} />
      </>
    ),
  },
  frog: {
    label: 'Frog',
    fill: '#74c34a',
    front: (
      <>
        <circle cx="38" cy="49" r="9" fill="#fffef7" stroke={INK} strokeWidth="3" />
        <circle cx="62" cy="49" r="9" fill="#fffef7" stroke={INK} strokeWidth="3" />
        <circle cx="44" cy="62" r="1.7" fill={INK} />
        <circle cx="56" cy="62" r="1.7" fill={INK} />
      </>
    ),
  },
  bunny: {
    label: 'Bunny',
    fill: '#f4ecf3',
    back: (
      <>
        <ellipse cx="40" cy="16" rx="7" ry="21" fill="#f4ecf3" stroke={INK} strokeWidth="4" />
        <ellipse cx="60" cy="16" rx="7" ry="21" fill="#f4ecf3" stroke={INK} strokeWidth="4" />
        <ellipse cx="40" cy="17" rx="3.2" ry="15" fill="#ffc2d6" />
        <ellipse cx="60" cy="17" rx="3.2" ry="15" fill="#ffc2d6" />
      </>
    ),
    front: <path d="M46 59 L54 59 L50 64 Z" fill="#ff9ab0" stroke={INK} strokeWidth="2" strokeLinejoin="round" />,
    overlay: (
      <g fill="#fffef7" stroke={INK} strokeWidth="1.4">
        <rect x="46.5" y="73" width="3.4" height="6" rx="1.2" />
        <rect x="50.1" y="73" width="3.4" height="6" rx="1.2" />
      </g>
    ),
  },
  panda: {
    label: 'Panda',
    fill: '#ffffff',
    back: (
      <>
        <circle cx="27" cy="27" r="11" fill={INK} />
        <circle cx="73" cy="27" r="11" fill={INK} />
      </>
    ),
    front: (
      <>
        <ellipse cx="38" cy="50" rx="9" ry="12" fill={INK} transform="rotate(-12 38 50)" />
        <ellipse cx="62" cy="50" rx="9" ry="12" fill={INK} transform="rotate(12 62 50)" />
        <circle cx="38" cy="50" r="5.5" fill="#fffef7" />
        <circle cx="62" cy="50" r="5.5" fill="#fffef7" />
        <ellipse cx="50" cy="60" rx="4.5" ry="3.5" fill={INK} />
      </>
    ),
  },
  dragon: {
    label: 'Dragon',
    fill: '#4fb3a6',
    back: (
      <>
        {ear('M33 26 L38 5 L45 25 Z', '#ffd98a')}
        {ear('M67 26 L62 5 L55 25 Z', '#ffd98a')}
      </>
    ),
    front: (
      <>
        <circle cx="30" cy="60" r="5" fill="#ff9ab0" opacity="0.75" />
        <circle cx="70" cy="60" r="5" fill="#ff9ab0" opacity="0.75" />
        <ellipse cx="45" cy="60" rx="1.8" ry="2.4" fill={INK} />
        <ellipse cx="55" cy="60" rx="1.8" ry="2.4" fill={INK} />
        <path d="M44 24 L50 16 L56 24 Z" fill="#ffd98a" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
      </>
    ),
  },
};

export const MUNCHER_KEYS = Object.keys(ANIMALS);

const Eye = ({ cx }: { cx: number }) => (
  <g className="m-eye">
    <circle cx={cx} cy="50" r="5" fill={INK} />
    <circle cx={cx + 1.6} cy="48.4" r="1.7" fill="#fff" />
  </g>
);

/**
 * A cute illustrated animal that drives the munch board. `state` triggers the
 * shared CSS rig (idle bob, chomp, happy bounce, bleh recoil). Falls back to the
 * cat for unknown keys.
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
        {spec.back}
        <circle cx="50" cy="55" r="32" fill={spec.fill} stroke={INK} strokeWidth="4" />
        {spec.front}
        <Eye cx={38} />
        <Eye cx={62} />
        <g className="m-mouth">
          <ellipse cx="50" cy="68" rx="11" ry="8.5" fill="#5b2333" />
          <ellipse className="m-tongue" cx="50" cy="70" rx="6.5" ry="5" fill="#ff7a9c" />
        </g>
        {spec.overlay}
      </g>
    </svg>
  );
}
