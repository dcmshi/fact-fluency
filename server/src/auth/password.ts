/**
 * Password hashing — argon2id (DESIGN.md §2). @node-rs/argon2 ships prebuilt
 * binaries (no native build step) and defaults to the argon2id variant.
 */
import { hash, verify } from '@node-rs/argon2';

export function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain);
  } catch {
    // Malformed hash, etc. — treat as a failed verification rather than throwing.
    return false;
  }
}
