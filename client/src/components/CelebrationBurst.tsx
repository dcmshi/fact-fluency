import type { CSSProperties } from 'react';
import './CelebrationBurst.css';

/** A short, self-removing particle burst fired at a correct munch. The variant
 *  is the kid's equipped celebration effect. Render with a unique `key` so each
 *  burst animates fresh; the parent drops it after ~900ms. */
export function CelebrationBurst({ variant }: { variant: string }) {
  const count = variant === 'fireworks' ? 20 : 14;
  const glyph = variant === 'sparkles' ? '✦' : variant === 'stars' ? '★' : '';

  const bits = Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2 + (i % 2) * 0.3;
    const dist = 26 + ((i * 13) % 26);
    const style = {
      '--dx': `${Math.cos(angle) * dist}px`,
      '--dy': `${Math.sin(angle) * dist}px`,
      '--delay': `${(i % 5) * 22}ms`,
      '--spin': `${(i % 2 ? 1 : -1) * (180 + (i % 3) * 120)}deg`,
    } as CSSProperties;
    return (
      <span key={i} className="burst-bit" style={style}>
        {glyph}
      </span>
    );
  });

  return (
    <div className={`burst burst-${variant}`} aria-hidden="true">
      {bits}
    </div>
  );
}
