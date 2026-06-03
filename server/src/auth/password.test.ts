import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';

describe('password hashing', () => {
  it('produces an argon2id hash distinct from the plaintext', async () => {
    const hash = await hashPassword('correcthorse');
    expect(hash).not.toBe('correcthorse');
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('verifies the correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correcthorse');
    expect(await verifyPassword(hash, 'correcthorse')).toBe(true);
    expect(await verifyPassword(hash, 'batterystaple')).toBe(false);
  });

  it('returns false (does not throw) for a malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', 'whatever')).toBe(false);
  });
});
