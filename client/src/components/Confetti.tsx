import { memo } from 'react';
import './Confetti.css';

const COLORS = ['#ffc83d', '#2fb87a', '#ff6b5c', '#3b82f6', '#f59e0b'];
const PIECES = 28;

/** Pure-CSS confetti burst. Deterministic positions (no layout deps). Memoized:
 *  it takes no props, so it never needs to re-render once mounted. */
export const Confetti = memo(function Confetti() {
  return (
    <div className="confetti" aria-hidden="true">
      {Array.from({ length: PIECES }, (_, i) => {
        const left = (i * 37) % 100;
        const delay = (i % 7) * 0.12;
        const duration = 1.8 + (i % 5) * 0.25;
        const color = COLORS[i % COLORS.length];
        const rotate = (i * 53) % 360;
        return (
          <span
            key={i}
            className="confetti-piece"
            style={{
              left: `${left}%`,
              background: color,
              animationDelay: `${delay}s`,
              animationDuration: `${duration}s`,
              transform: `rotate(${rotate}deg)`,
            }}
          />
        );
      })}
    </div>
  );
});
