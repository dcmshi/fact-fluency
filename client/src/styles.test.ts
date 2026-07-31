import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Invariants over the stylesheets themselves — the things nothing else can
 * catch, because CSS has no build-time checks and the failure mode is usually
 * invisible in the default theme on the developer's machine.
 *
 * The design system leans on companion tokens (`--sun` / `--on-sun`) so a theme
 * that remaps a surface also remaps the ink that has to stay readable on it.
 * Midnight remapped `--ink` and not its companion, and the default `.btn` went
 * white-on-white with nobody noticing. So: assert the resolved contrast ratios,
 * that the reduced-motion reset actually stops animations, and that route
 * stylesheets don't fight over the one global class namespace they share.
 */
// Resolved through a parameter, not a literal: Vite rewrites a statically
// analysable `new URL('…', import.meta.url)` into a served asset URL.
const resolve = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const readCss = (path: string) => readFileSync(resolve(path), 'utf8');

const indexCss = readCss('./index.css');

/** Custom-property declarations inside one selector's block. */
function declarations(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`selector not found: ${selector}`);
  const block = css.slice(at, css.indexOf('}', at));
  const out: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[name] = value.trim();
  }
  return out;
}

const THEMES = [...indexCss.matchAll(/body\[data-theme='(\w+)'\]/g)].map((m) => m[1]);
const root = declarations(indexCss, ':root');

/** The token table a page sees under `theme` ('classic' = no data-theme). */
function palette(theme: string): Record<string, string> {
  const merged =
    theme === 'classic'
      ? { ...root }
      : { ...root, ...declarations(indexCss, `body[data-theme='${theme}']`) };
  // One level of indirection is enough — a token either holds a literal or
  // points at a sibling token in the same table.
  for (const [k, v] of Object.entries(merged)) {
    const ref = /^var\((--[\w-]+)\)$/.exec(v);
    if (ref) merged[k] = merged[ref[1]] ?? v;
  }
  return merged;
}

const ALL_THEMES = ['classic', ...THEMES];

// --- WCAG 2.1 relative luminance / contrast (SC 1.4.3) ---
const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a 6-digit hex color: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const cssFiles = readdirSync(resolve('.'), { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.css'))
  .map((f) => f.replaceAll('\\', '/'));

describe('one global CSS namespace', () => {
  // Route stylesheets ride along with lazy-loaded chunks, so they all land in
  // one global namespace in whatever order the kid happens to navigate. Two
  // files declaring the same bare class means the winner depends on that order:
  // `.big-emoji` existed three times at two sizes, and a stale `.muncher` rule
  // in MunchBoard.css restyled the race-track and feast-belt munchers.
  it('found the stylesheets', () => {
    expect(cssFiles).toContain('index.css');
    expect(cssFiles.length).toBeGreaterThan(10);
  });

  it('declares each bare class selector in exactly one stylesheet', () => {
    const owners = new Map<string, Set<string>>();
    for (const file of cssFiles) {
      // Rules whose whole selector is one or more bare classes — `.a`, or a
      // `.a,\n.b {` group. Anything more specific (`.a .b`, `.a.b`, `.a:hover`)
      // is deliberate layering, not a collision.
      for (const [, group] of readCss(`./${file}`).matchAll(
        /^((?:\.[\w-]+,\s*\n)*\.[\w-]+)\s*\{/gm,
      )) {
        for (const [sel] of group.matchAll(/\.[\w-]+/g)) {
          (owners.get(sel) ?? owners.set(sel, new Set()).get(sel)!).add(file);
        }
      }
    }
    const shared = [...owners]
      .filter(([, files]) => files.size > 1)
      .map(([sel, files]) => `${sel}: ${[...files].sort().join(', ')}`);
    expect(shared).toEqual([]);
  });
});

describe('prefers-reduced-motion', () => {
  it('stops infinite animations instead of running them at full speed', () => {
    const at = indexCss.indexOf('@media (prefers-reduced-motion: reduce) {');
    expect(at, 'global reduced-motion rule missing').toBeGreaterThan(-1);
    const rule = indexCss.slice(at, indexCss.indexOf('\n}', at));
    expect(rule).toContain('animation-duration: 0.001ms !important;');
    // Without this, `animation: … infinite` keeps looping — at 0.001ms a cycle.
    expect(rule).toContain('animation-iteration-count: 1 !important;');
  });
});

describe('theme companion tokens', () => {
  it('found the themes and the base palette', () => {
    expect(THEMES).toEqual(['ocean', 'candy', 'forest', 'sunset', 'midnight']);
    expect(root['--ink']).toBe('#2b2440');
  });

  // A theme that remaps a surface without remapping its companion ink is
  // exactly the midnight white-on-white bug — so assert the resolved contrast
  // rather than the presence of the override (light themes rightly inherit the
  // base `--on-ink`).
  it('keeps the default .btn label readable on its --ink fill in every theme', () => {
    // `.btn` fills with --ink and labels with --on-ink; the label is 1.05rem/800,
    // i.e. small text, so it needs 4.5:1.
    expect(indexCss).toMatch(/\.btn \{[^}]*color: var\(--on-ink\);/);
    for (const theme of ALL_THEMES) {
      const p = palette(theme);
      expect(contrast(p['--on-ink'], p['--ink']), `--on-ink on --ink (${theme})`).toBeGreaterThan(
        4.5,
      );
    }
  });

  it('keeps sun-colored surfaces readable in every theme', () => {
    for (const theme of ALL_THEMES) {
      const p = palette(theme);
      expect(contrast(p['--on-sun'], p['--sun']), `--on-sun on --sun (${theme})`).toBeGreaterThan(
        4.5,
      );
    }
  });
});

describe('readable inks', () => {
  // The candy palette is tuned as a *fill*. White on it is 2.1–3.7:1 — below
  // even the 3:1 large-text bar for three of the four — so anything drawing text
  // on an operation or feedback color has to use --on-op.
  it('--on-op clears AA on every operation and feedback fill', () => {
    const p = palette('classic');
    for (const fill of ['--add', '--sub', '--mul', '--div', '--correct', '--wrong']) {
      expect(contrast(p['--on-op'], p[fill]), `--on-op on ${fill}`).toBeGreaterThan(4.5);
    }
  });

  it('--ink-accent is readable as text on paper and on a card, per theme', () => {
    for (const theme of ALL_THEMES) {
      const p = palette(theme);
      for (const bg of ['--paper', '--paper-2', '--card']) {
        const label = `--ink-accent on ${bg} (${theme})`;
        expect(contrast(p['--ink-accent'], p[bg]), label).toBeGreaterThan(4.5);
      }
    }
  });

  // Only used at display sizes (the feast timer, 1.4rem/700), so 3:1 applies.
  it('--ink-wrong is readable as text on paper, per theme', () => {
    for (const theme of ALL_THEMES) {
      const p = palette(theme);
      const label = `--ink-wrong on --paper (${theme})`;
      expect(contrast(p['--ink-wrong'], p['--paper']), label).toBeGreaterThan(3);
    }
  });

  // The rule the tokens above exist to enforce: a literal white foreground is
  // how every one of those failures got in, and it hides which fill it sits on.
  it('no stylesheet hardcodes a white text color', () => {
    const offenders = cssFiles.flatMap((file) =>
      [...readCss(`./${file}`).matchAll(/^\s*color:\s*(#fff\b|#ffffff\b|white\b).*$/gim)].map(
        (m) => `${file}:${m[0].trim()}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
