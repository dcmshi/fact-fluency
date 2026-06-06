import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rateLimit';

describe('RateLimiter', () => {
  it('allows up to max then blocks, with a correct retry-after', () => {
    const t = 1000;
    const rl = new RateLimiter({ windowMs: 10_000, max: 3, now: () => t });

    expect(rl.hit('a')).toMatchObject({ allowed: true, remaining: 2 });
    expect(rl.hit('a')).toMatchObject({ allowed: true, remaining: 1 });
    expect(rl.hit('a')).toMatchObject({ allowed: true, remaining: 0 });

    const blocked = rl.hit('a');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(10_000); // full window left (no time passed)
  });

  it('scopes counts per key', () => {
    const t = 0;
    const rl = new RateLimiter({ windowMs: 1000, max: 1, now: () => t });
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(false);
    expect(rl.hit('b').allowed).toBe(true); // different key, own bucket
  });

  it('resets after the window elapses', () => {
    let t = 0;
    const rl = new RateLimiter({ windowMs: 1000, max: 1, now: () => t });
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(false);
    t = 1000; // window boundary reached
    expect(rl.hit('a').allowed).toBe(true);
  });

  it('sweeps expired buckets so the map does not grow unbounded', () => {
    let t = 0;
    const rl = new RateLimiter({ windowMs: 1000, max: 5, now: () => t });
    rl.hit('a');
    rl.hit('b');
    expect(rl.size).toBe(2);
    t = 5000; // well past the window — next hit triggers a lazy sweep
    rl.hit('c');
    expect(rl.size).toBe(1); // a and b swept, only c remains
  });
});
