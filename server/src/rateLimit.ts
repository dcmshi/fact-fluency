/**
 * Tiny dependency-free rate limiter for the auth endpoints (brute-force /
 * signup-spam protection). Fixed-window, in-memory, keyed per IP — fine for the
 * single-instance Render deploy; swap in a shared store (Redis) if we ever scale
 * horizontally. The decision logic is a pure-ish class with injectable `now` so
 * it unit-tests without HTTP or the clock; the Express middleware is a thin edge.
 */
import type { RequestHandler } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  windowMs: number;
  /** Max requests allowed per window per key. */
  max: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface HitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly max: number;
  private readonly now: () => number;
  private lastSweep = 0;

  constructor(opts: RateLimitOptions) {
    this.windowMs = opts.windowMs;
    this.max = opts.max;
    this.now = opts.now ?? Date.now;
  }

  /** Record a hit for `key`; returns whether it's allowed plus retry info. */
  hit(key: string): HitResult {
    const t = this.now();
    // Lazy GC so the map can't grow unbounded (no timers to leak in tests/ops).
    if (t - this.lastSweep > this.windowMs) {
      this.sweep(t);
      this.lastSweep = t;
    }
    let b = this.buckets.get(key);
    if (!b || t >= b.resetAt) {
      b = { count: 0, resetAt: t + this.windowMs };
      this.buckets.set(key, b);
    }
    b.count++;
    const allowed = b.count <= this.max;
    return {
      allowed,
      remaining: Math.max(0, this.max - b.count),
      retryAfterMs: allowed ? 0 : b.resetAt - t,
    };
  }

  /** Drop expired buckets. */
  sweep(at = this.now()): void {
    for (const [k, b] of this.buckets) if (at >= b.resetAt) this.buckets.delete(k);
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** Express middleware enforcing a per-IP fixed-window limit. `keyPrefix` lets
 *  separate routes share an IP space without colliding (e.g. 'login:'). */
export function rateLimit(opts: RateLimitOptions & { keyPrefix?: string }): RequestHandler {
  const limiter = new RateLimiter(opts);
  const prefix = opts.keyPrefix ?? '';
  return (req, res, next) => {
    const { allowed, remaining, retryAfterMs } = limiter.hit(prefix + (req.ip ?? 'unknown'));
    res.setHeader('X-RateLimit-Limit', String(opts.max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    if (!allowed) {
      const retryAfter = Math.ceil(retryAfterMs / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'rate_limited', retryAfter });
      return;
    }
    next();
  };
}
