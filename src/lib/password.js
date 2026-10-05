import { createHash, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';

// Hashes written before argon2 was introduced: unsalted SHA-256, 64 lowercase hex chars.
const LEGACY_SHA256 = /^[0-9a-f]{64}$/;

export const hashPassword = (password) => argon2.hash(password, { type: argon2.argon2id });

const legacyHash = (password) => createHash('sha256').update(password).digest('hex');

function legacyMatches(password, stored) {
  const a = Buffer.from(legacyHash(password));
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

// A real hash to verify against when the account does not exist, so unknown emails cost the same as wrong passwords.
const decoyHash = await hashPassword('decoy-password-for-constant-time-login');

/**
 * Checks a password against a stored hash. Returns `{ valid, upgradedHash }`;
 * `upgradedHash` is set when the stored value is a legacy SHA-256 digest (or an argon2 hash with
 * outdated parameters) that matched, and should be persisted in place of the old one.
 */
export async function verifyPassword(password, stored) {
  if (stored == null) {
    await argon2.verify(decoyHash, password);
    return { valid: false };
  }
  if (LEGACY_SHA256.test(stored)) {
    if (!legacyMatches(password, stored)) return { valid: false };
    return { valid: true, upgradedHash: await hashPassword(password) };
  }
  let valid = false;
  try {
    valid = await argon2.verify(stored, password);
  } catch {
    return { valid: false }; // unrecognised hash format (e.g. a dev-login account's unusable marker)
  }
  if (!valid) return { valid: false };
  return argon2.needsRehash(stored) ? { valid: true, upgradedHash: await hashPassword(password) } : { valid: true };
}

// Stored for accounts that must never log in with a password (dev-login pilots); matches neither hash format.
export const UNUSABLE_PASSWORD_HASH = '!';
