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
// Comments are stripped: these tests scan for declarations, and the stylesheets
// discuss the very patterns being scanned for (a comment explaining why there is
// no `outline: none` here reads as an `outline: none`).
const readCss = (path: string) => readFileSync(resolve(path), 'utf8').replace(/\/\*[^]*?\*\//g, '');

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

const channels = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb: number[]) =>
  `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/**
 * Resolve a CSS color expression to a hex literal under one theme's palette.
 *
 * Handles the three forms the stylesheets use: a literal, `var(--token)`, and
 * `color-mix(in srgb, <a> N%, <b>)` — the last is how every warm tint in the app
 * is derived, so a resolver without it can't check the surfaces most likely to
 * be unreadable on a dark theme.
 */
function resolveColor(expr: string, p: Record<string, string>): string {
  const value = expr.trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;

  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  if (ref) return resolveColor(p[ref[1]] ?? '', p);

  const mix = /^color-mix\(in srgb,\s*(.+?)\s+(\d+)%,\s*(.+)\)$/.exec(value);
  if (mix) {
    const [, a, pct, b] = mix;
    const weight = Number(pct) / 100;
    // `transparent` over an opaque base is just the base, faded — for contrast
    // purposes the composite against that base is the base itself.
    if (b.trim() === 'transparent') return resolveColor(a, p);
    const [ca, cb] = [resolveColor(a, p), resolveColor(b, p)].map(channels);
    return toHex(ca.map((v, i) => v * weight + cb[i] * (1 - weight)));
  }
  throw new Error(`unresolvable color: ${expr}`);
}

/** The `color` and `background` a rule declares, as raw CSS expressions. */
function ruleColors(file: string, selector: string): { color?: string; background?: string } {
  const css = readCss(file);
  const at = css.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`${file}: selector not found: ${selector}`);
  const block = css.slice(at, css.indexOf('}', at));
  return {
    color: /(?:^|\s)color:\s*([^;]+);/.exec(block)?.[1],
    background: /(?:^|\s)background:\s*([^;]+);/.exec(block)?.[1],
  };
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

describe('touch targets', () => {
  // A `clamp()` on a tap target is only as good as its floor — the vw term
  // bottoms out on a narrow phone, which is the device this is played on.
  it('never drops a kid-facing tap target below 44px', () => {
    const targets = [
      ['./pages/FeastPage.css', '.feast-plate'],
      ['./components/RaceQuiz.css', '.race-quiz-choice'],
    ] as const;
    for (const [file, selector] of targets) {
      const css = readCss(file);
      // `.race-quiz-choice` is a prefix of `.race-quiz-choices`, so anchor on
      // the opening brace rather than the bare selector.
      const at = css.indexOf(`${selector} {`);
      const block = css.slice(at, css.indexOf('}', at));
      const floors = [...block.matchAll(/(?:min-)?(?:width|height):\s*clamp\((\d+)px/g)];
      expect(floors.length, `${selector}: no clamped size found`).toBeGreaterThan(0);
      for (const [, px] of floors) {
        expect(Number(px), `${selector} in ${file}`).toBeGreaterThanOrEqual(44);
      }
    }
  });
});

describe('keyboard focus', () => {
  it('never suppresses the outline outside a :focus-visible rule', () => {
    // The global `:focus-visible { outline: 3px solid … }` is the only focus
    // indicator in the app, and it is easy to outrank by accident: `outline:
    // none` on a plain selector wins on specificity in every state, silently
    // leaving a control with no visible focus at all (WCAG 2.4.7).
    const suppressed = cssFiles.flatMap((file) => {
      const css = readCss(`./${file}`);
      return [...css.matchAll(/([^{}]*)\{[^}]*outline:\s*(none|0)\b/g)]
        .map(([, selector]) => `${file}: ${selector.trim().split('\n').pop()}`)
        .filter((hit) => !hit.includes(':focus-visible'));
    });
    expect(suppressed).toEqual([]);
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

  // --ink-soft is the second most-used text color in the app (every .muted line,
  // every stat label, .btn.ghost, .btn.done-for-now) and always at small sizes,
  // so it needs the full 4.5:1 against every surface it can land on.
  it('keeps muted text readable on every surface, per theme', () => {
    for (const theme of ALL_THEMES) {
      const p = palette(theme);
      for (const bg of ['--paper', '--paper-2', '--card', '--field']) {
        const label = `--ink-soft on ${bg} (${theme})`;
        expect(contrast(p['--ink-soft'], resolveColor(p[bg], p)), label).toBeGreaterThan(4.5);
      }
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

  // Warm tinted panels used to be literal creams, which meant a bright island
  // on a dark theme (the play summary's streak and shield ribbons are on the one
  // screen themes actually apply to). They are derived from the palette now, so
  // check that every theme's derivation is still readable.
  it.each([
    ['./index.css', '.error-banner'],
    ['./pages/PlayPage.css', '.streak-ribbon'],
    ['./pages/PlayPage.css', '.shield-ribbon'],
    ['./pages/ProfilesPage.css', '.streak-badge'],
    ['./components/AvatarPicker.css', '.avatar-option.selected'],
    ['./pages/ProfilesPage.css', '.set-pill'],
  ])('keeps %s > %s readable in every theme', (file, selector) => {
    const rule = ruleColors(file, selector);
    expect(rule.background, `${selector} declares no background`).toBeDefined();
    for (const theme of ALL_THEMES) {
      const p = palette(theme);
      // No `color` of its own means it inherits the body's --ink.
      const fg = resolveColor(rule.color ?? 'var(--ink)', p);
      const bg = resolveColor(rule.background!, p);
      expect(contrast(fg, bg), `${selector} (${theme}): ${fg} on ${bg}`).toBeGreaterThan(4.5);
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
