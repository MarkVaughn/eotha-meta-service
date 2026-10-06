import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

// DER SubjectPublicKeyInfo prefix of an Ed25519 key; the 32 raw key bytes follow.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const HEX_KEY = /^[0-9a-fA-F]{64}$/;

export class ClaimKeyError extends Error {}

function fromHex(hex) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, 'hex')]),
    format: 'der',
    type: 'spki'
  });
}

function fromFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch (err) {
    throw new ClaimKeyError(`CLAIM_PUBLIC_KEY_FILE ${path} could not be read (${err.code ?? err.message}).`);
  }
  if (HEX_KEY.test(text)) return fromHex(text);
  try {
    const key = createPublicKey(text);
    if (key.asymmetricKeyType === 'ed25519') return key;
  } catch {
    // Reported below with the other failure.
  }
  throw new ClaimKeyError(`CLAIM_PUBLIC_KEY_FILE ${path} holds neither 64 hex characters nor an Ed25519 PEM public key.`);
}

/** Short stable identifier for a public key: first 16 hex characters of the SHA-256 of its raw bytes. */
export function claimKeyFingerprint(key) {
  const raw = key.export({ format: 'der', type: 'spki' }).subarray(ED25519_SPKI_PREFIX.length);
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * Loads the public key that engine-signed claims (mission completions, charts) must verify against.
 * This is a dedicated key pair, not the login token key in `keys/`. Returns `{ key, fingerprint }`,
 * or `null` when none is configured. Throws ClaimKeyError when one is configured but unusable, so a
 * typo cannot silently turn into "claims are refused".
 *
 * @param {{ CLAIM_PUBLIC_KEY?: string, CLAIM_PUBLIC_KEY_FILE?: string }} source
 */
export function loadClaimPublicKey({ CLAIM_PUBLIC_KEY: hex, CLAIM_PUBLIC_KEY_FILE: file } = {}) {
  const fromEnv = hex ? fromHex(hex) : null;
  const fromPath = file ? fromFile(file) : null;
  if (fromEnv && fromPath && claimKeyFingerprint(fromEnv) !== claimKeyFingerprint(fromPath)) {
    throw new ClaimKeyError('CLAIM_PUBLIC_KEY and CLAIM_PUBLIC_KEY_FILE name different keys.');
  }
  const key = fromEnv ?? fromPath;
  return key ? { key, fingerprint: claimKeyFingerprint(key) } : null;
}
