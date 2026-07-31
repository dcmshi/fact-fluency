/**
 * Per-route SEO tags for the SPA shell.
 *
 * client/index.html carries one hardcoded canonical (the landing page), but the
 * production catch-all serves that same shell for every route — so
 * /how-it-works would declare the homepage as its canonical and get folded into
 * it, dropping it from the index even though sitemap.xml lists it. Rewrite the
 * canonical (and og:url, the same per-page claim for social) per route.
 *
 * The origin is read back out of the shell's existing canonical rather than
 * configured here: index.html is already the one place the deployed origin is
 * written down, and deriving it from the request's Host header would let a
 * spoofed Host poison the canonical we hand crawlers.
 */

/** Public, indexable routes — mirrors client/public/sitemap.xml. */
const PUBLIC_ROUTES = new Set(['/', '/how-it-works']);

const CANONICAL_HREF = /(<link\s+rel="canonical"\s+href=")([^"]*)(")/;
const OG_URL_CONTENT = /(<meta\s+property="og:url"\s+content=")([^"]*)(")/;

/**
 * The route a given request path should claim as canonical. Non-public paths
 * (auth-gated, robots-disallowed) collapse to the landing page — a
 * self-referencing canonical on e.g. /play/:profileId would invite indexing a
 * URL that only ever renders the logged-out landing content to a crawler.
 */
export function canonicalPath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '') || '/';
  return PUBLIC_ROUTES.has(trimmed) ? trimmed : '/';
}

/**
 * Point the shell's canonical and og:url at `pathname`'s canonical route.
 * Returns the HTML unchanged if the tags aren't found — seo.test.ts pins the
 * real client/index.html against these patterns, so a reformat fails there
 * rather than silently shipping the wrong canonical.
 */
export function withCanonical(html: string, pathname: string): string {
  const base = html.match(CANONICAL_HREF)?.[2];
  if (!base) return html;
  const url = new URL(canonicalPath(pathname), base).href;
  return html.replace(CANONICAL_HREF, `$1${url}$3`).replace(OG_URL_CONTENT, `$1${url}$3`);
}
