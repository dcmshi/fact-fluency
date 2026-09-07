import './Icon.css';

/**
 * The app's inline SVG icon set — replaces the OS-emoji UI chrome (⭐ 🔥 👁 🔊
 * ✕ arrows) with glyphs drawn in the same chunky, rounded language as the
 * munchers. Two families: `fill` icons (star, flame, spark — solid candy
 * shapes) and stroke icons (everything else — round caps, ~2.2 weight), both
 * painted in `currentColor` so they tint with the theme and the control they
 * sit in. Decorative by default: icons always accompany a visible text label
 * or an aria-label on the control, so each ships `aria-hidden`.
 */

export type IconName =
  | 'spark'
  | 'star'
  | 'flame'
  | 'eye'
  | 'eye-off'
  | 'volume'
  | 'volume-off'
  | 'close'
  | 'back'
  | 'chevron-up'
  | 'chevron-down'
  | 'print'
  | 'flag'
  | 'bowl'
  | 'gift'
  | 'sticker'
  | 'chart'
  | 'grid'
  | 'gear'
  | 'check';

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const GLYPHS: Record<IconName, JSX.Element> = {
  // Filled candy shapes -----------------------------------------------------
  spark: (
    <path
      d="M12 2.5 L14.4 9.6 L21.5 12 L14.4 14.4 L12 21.5 L9.6 14.4 L2.5 12 L9.6 9.6 Z"
      fill="currentColor"
    />
  ),
  star: (
    <path
      d="M12 2.6 L14.8 8.5 L21.2 9.3 L16.5 13.8 L17.7 20.1 L12 17 L6.3 20.1 L7.5 13.8 L2.8 9.3 L9.2 8.5 Z"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinejoin="round"
    />
  ),
  flame: (
    <path
      d="M12 2.5 C12.8 4.6 14.7 6.2 16.3 8.4 C18.7 11.6 19 15.4 16.9 18.4 C15.6 20.3 13.8 21.2 12 21.2 C10.2 21.2 8.4 20.3 7.1 18.4 C5 15.4 5.3 11.6 7.7 8.4 C8.4 7.5 9.1 6.7 9.6 5.8 C10 6.7 10.7 7.5 11.6 7.9 C11.5 6 11.6 4.2 12 2.5 Z"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinejoin="round"
    />
  ),
  // Stroke glyphs -----------------------------------------------------------
  eye: (
    <>
      <path d="M2.5 12 C5 7.2 8.4 4.8 12 4.8 C15.6 4.8 19 7.2 21.5 12 C19 16.8 15.6 19.2 12 19.2 C8.4 19.2 5 16.8 2.5 12 Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M9.9 5.2 C10.6 5 11.3 4.8 12 4.8 C15.6 4.8 19 7.2 21.5 12 C20.6 13.7 19.4 15.2 18 16.4 M14.2 18.5 C13.5 18.9 12.8 19.2 12 19.2 C8.4 19.2 5 16.8 2.5 12 C3.6 10 5.1 8.3 6.8 7" />
      <path d="M4 20 L20 4" />
    </>
  ),
  volume: (
    <>
      <path
        d="M4 9.5 L8 9.5 L13 5 L13 19 L8 14.5 L4 14.5 Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
      <path d="M16 9.5 C17.3 11 17.3 13 16 14.5" {...stroke} />
      <path d="M18.5 7 C21 9.5 21 14.5 18.5 17" {...stroke} />
    </>
  ),
  'volume-off': (
    <>
      <path
        d="M4 9.5 L8 9.5 L13 5 L13 19 L8 14.5 L4 14.5 Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
      <path d="M16.5 9.5 L21 14.5 M21 9.5 L16.5 14.5" {...stroke} />
    </>
  ),
  close: <path d="M6 6 L18 18 M18 6 L6 18" />,
  back: <path d="M20 12 L5 12 M10.5 6.5 L5 12 L10.5 17.5" />,
  'chevron-up': <path d="M5 15 L12 8 L19 15" />,
  'chevron-down': <path d="M5 9 L12 16 L19 9" />,
  print: (
    <>
      <path d="M7 8 L7 3.5 L17 3.5 L17 8" />
      <rect x="3.5" y="8" width="17" height="7.5" rx="2" />
      <path d="M7 13 L17 13 L17 20.5 L7 20.5 Z" />
    </>
  ),
  flag: (
    <>
      <path d="M5.5 21.5 L5.5 3.5" />
      <path d="M5.5 4 C8 2.6 10.6 5.2 13.4 4 C15.4 3.1 17.6 3.4 18.5 4 L18.5 12 C17.6 11.4 15.4 11.1 13.4 12 C10.6 13.2 8 10.6 5.5 12" />
    </>
  ),
  bowl: (
    <>
      <path d="M3.5 11.5 L20.5 11.5 C20.5 16.4 16.7 20.2 12 20.2 C7.3 20.2 3.5 16.4 3.5 11.5 Z" />
      <path d="M8.5 4 C8.5 5.4 9.6 5.6 9.6 7.2 M13.5 3.5 C13.5 5.4 15 5.6 15 7.7" />
    </>
  ),
  gift: (
    <>
      <rect x="4" y="10" width="16" height="10.5" rx="1.5" />
      <path d="M12 10 L12 20.5 M3 10 L21 10" />
      <path d="M12 10 C9 10 6.5 8.8 6.5 6.8 C6.5 5.2 8.8 4.6 10 5.8 C11 6.8 12 10 12 10 Z M12 10 C15 10 17.5 8.8 17.5 6.8 C17.5 5.2 15.2 4.6 14 5.8 C13 6.8 12 10 12 10 Z" />
    </>
  ),
  sticker: (
    <>
      <path d="M5 3.5 L14.5 3.5 L19 8 L19 20.5 L5 20.5 Z" />
      <path d="M14.5 3.5 L14.5 8 L19 8" />
      <path d="M8.5 13.5 L9.6 15.3 L11.6 15.6 L10.1 17 L10.4 18.9 L8.5 18 L6.6 18.9 L6.9 17 L5.4 15.6 L7.4 15.3 Z" />
    </>
  ),
  chart: (
    <>
      <path d="M4 4 L4 20 L20 20" />
      <path d="M8.5 16.5 L8.5 11.5 M12.5 16.5 L12.5 8 M16.5 16.5 L16.5 13" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.8" />
      <rect x="13" y="4" width="7" height="7" rx="1.8" />
      <rect x="4" y="13" width="7" height="7" rx="1.8" />
      <rect x="13" y="13" width="7" height="7" rx="1.8" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3.4" />
      <path d="M12 2.8 L12 5.6 M12 18.4 L12 21.2 M2.8 12 L5.6 12 M18.4 12 L21.2 12 M5.3 5.3 L7.3 7.3 M16.7 16.7 L18.7 18.7 M18.7 5.3 L16.7 7.3 M7.3 16.7 L5.3 18.7" />
    </>
  ),
  check: <path d="M4.5 12.5 L9.5 17.5 L19.5 6.5" />,
};

// Stroke icons spread `stroke` on every path; the filled family declares its
// own paint per path above. `data-fill` exists so Icon.css can tell them apart
// without a second map.
const FILLED: ReadonlySet<IconName> = new Set(['spark', 'star', 'flame']);

export function Icon({ name, size }: { name: IconName; size?: number | string }) {
  return (
    <svg
      className="icon"
      data-fill={FILLED.has(name) || undefined}
      viewBox="0 0 24 24"
      width={size ?? '1em'}
      height={size ?? '1em'}
      aria-hidden="true"
      focusable="false"
      {...(FILLED.has(name) ? {} : stroke)}
    >
      {GLYPHS[name]}
    </svg>
  );
}
