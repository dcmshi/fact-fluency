import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Invariants over the stylesheets themselves.
 *
 * The design system leans on companion tokens (`--sun` / `--on-sun`) so that a
 * theme which remaps a surface color also remaps the ink that has to stay
 * readable on it. Nothing enforces that pairing at build time, and the failure
 * mode is invisible in the default theme — midnight's near-white `--ink` turned
 * the default `.btn` into white-on-white and nobody noticed. These tests pin the
 * pairing and the resulting contrast ratios instead.
 */
const readCss = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

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
  // points at a sibling token (midnight's --ink-accent is its --sun).
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
