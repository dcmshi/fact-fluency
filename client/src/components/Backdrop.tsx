/**
 * Decorative atmosphere for wide screens: a fixed layer of big, faint numbers
 * and operation glyphs drifting slowly behind the content, so a desktop
 * viewport isn't a narrow column floating in empty paper. Purely ornamental —
 * aria-hidden, pointer-transparent, hidden below 900px (phones/tablets need
 * the pixels), and stilled by the global prefers-reduced-motion rule. Colors
 * come from the operation tokens, so every unlockable theme re-tints it.
 */
const GLYPHS = [
  { ch: '7', x: '6%', y: '16%', size: '3.4rem', color: 'var(--add)', dur: '13s', delay: '-2s' },
  { ch: '×', x: '13%', y: '62%', size: '2.8rem', color: 'var(--mul)', dur: '17s', delay: '-6s' },
  { ch: '3', x: '4%', y: '84%', size: '2.4rem', color: 'var(--div)', dur: '11s', delay: '-4s' },
  { ch: '÷', x: '16%', y: '36%', size: '2.2rem', color: 'var(--sub)', dur: '15s', delay: '-9s' },
  { ch: '5', x: '90%', y: '12%', size: '3rem', color: 'var(--sub)', dur: '14s', delay: '-3s' },
  { ch: '+', x: '85%', y: '52%', size: '3.2rem', color: 'var(--add)', dur: '12s', delay: '-7s' },
  { ch: '9', x: '93%', y: '80%', size: '2.5rem', color: 'var(--mul)', dur: '16s', delay: '-1s' },
  { ch: '−', x: '80%', y: '30%', size: '2.3rem', color: 'var(--div)', dur: '18s', delay: '-11s' },
] as const;

export function Backdrop() {
  return (
    <div className="backdrop" aria-hidden="true">
      {GLYPHS.map((g, i) => (
        <span
          key={i}
          className="backdrop-glyph"
          style={{
            left: g.x,
            top: g.y,
            fontSize: g.size,
            color: g.color,
            animationDuration: g.dur,
            animationDelay: g.delay,
          }}
        >
          {g.ch}
        </span>
      ))}
    </div>
  );
}
