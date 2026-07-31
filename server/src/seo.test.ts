import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalPath, withCanonical } from './seo';

/** The real shell — Vite copies it through, so these are the deployed tags. */
const shell = readFileSync(path.resolve(__dirname, '../../client/index.html'), 'utf8');

describe('canonicalPath', () => {
  it('keeps the public routes and collapses everything else to the landing page', () => {
    expect(canonicalPath('/')).toBe('/');
    expect(canonicalPath('/how-it-works')).toBe('/how-it-works');
    // Auth-gated routes render the logged-out landing content to a crawler.
    expect(canonicalPath('/play/abc')).toBe('/');
    expect(canonicalPath('/progress/abc')).toBe('/');
    expect(canonicalPath('/race/abc')).toBe('/');
  });

  it('normalizes trailing slashes so one route claims one canonical', () => {
    expect(canonicalPath('/how-it-works/')).toBe('/how-it-works');
    expect(canonicalPath('//')).toBe('/');
  });
});

describe('withCanonical', () => {
  it('rewrites the real shell for /how-it-works', () => {
    const html = withCanonical(shell, '/how-it-works');
    expect(html).toContain(
      '<link rel="canonical" href="https://fact-fluency.onrender.com/how-it-works" />',
    );
    expect(html).toContain(
      '<meta property="og:url" content="https://fact-fluency.onrender.com/how-it-works" />',
    );
    // The landing canonical must be gone, not merely joined by a second tag.
    expect(html).not.toContain('href="https://fact-fluency.onrender.com/"');
  });

  it('leaves the landing page pointing at the origin root', () => {
    const html = withCanonical(shell, '/');
    expect(html).toContain('<link rel="canonical" href="https://fact-fluency.onrender.com/" />');
    expect(html).toContain(
      '<meta property="og:url" content="https://fact-fluency.onrender.com/" />',
    );
  });

  it('emits exactly one canonical and one og:url', () => {
    const html = withCanonical(shell, '/how-it-works');
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html.match(/property="og:url"/g)).toHaveLength(1);
  });

  it('passes a shell without the tags through untouched', () => {
    expect(withCanonical('<html></html>', '/how-it-works')).toBe('<html></html>');
  });
});
