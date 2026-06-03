import { describe, expect, it } from 'vitest';
import { generateToken } from './session';

describe('generateToken', () => {
  it('is URL-safe and high-entropy', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes, base64url
  });

  it('is unique across calls', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateToken()));
    expect(tokens.size).toBe(100);
  });
});
