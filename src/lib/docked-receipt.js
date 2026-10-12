import { verify } from 'node:crypto';
import { DOCKED_RECEIPT_MAX_SKEW_MS, DOCKED_RECEIPT_TTL_MS } from '../config/docking.js';

export const DOCKED_RECEIPT_DOMAIN = Buffer.from('EOTHA_DOCKED_RECEIPT_V1', 'utf8'); // 23 bytes

// The wire form of a UUID: lowercase and hyphenated. The signed bytes are the raw 16, so no other
// spelling can ever reach the payload.
export const DOCKED_ENTITY_ID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
// Standard base64 of exactly 16 bytes (the nonce) and of exactly 64 bytes (the signature).
export const NONCE_B64_PATTERN = '^[A-Za-z0-9+/]{22}==$';
export const SIGNATURE_B64_PATTERN = '^[A-Za-z0-9+/]{86}==$';

function lenPrefixed(value) {
  const bytes = Buffer.from(value, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
}

function u64(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

// Mirrors eotha-rtse `docked_receipt_signing_payload` and the vector in eotha-contracts
// `scripts/check-docked-receipt-vector.js`. `receipt` carries { pilotId, dockedEntityId (lowercase
// hyphenated UUID), systemH3, dockedAtMs, issuedAtMs, nonce (base64, 16 bytes) }. Throws on a
// malformed id or nonce; `verifyDockedReceipt` is the caller that never does.
export function canonicalDockedReceiptPayload(receipt) {
  const entityId = Buffer.from(receipt.dockedEntityId.replaceAll('-', ''), 'hex');
  const nonce = Buffer.from(receipt.nonce, 'base64');
  if (entityId.length !== 16) throw new Error('dockedEntityId must be a 16-byte UUID.');
  if (nonce.length !== 16) throw new Error('nonce must be 16 bytes.');
  return Buffer.concat([
    DOCKED_RECEIPT_DOMAIN,
    lenPrefixed(receipt.pilotId),
    entityId,
    lenPrefixed(receipt.systemH3),
    u64(receipt.dockedAtMs),
    u64(receipt.issuedAtMs),
    nonce
  ]);
}

// `receipt.signature` is the base64-encoded 64-byte Ed25519 signature. Never throws.
export function verifyDockedReceipt(receipt, publicKey) {
  if (!publicKey || !receipt || typeof receipt.signature !== 'string') return false;
  const sig = Buffer.from(receipt.signature, 'base64');
  if (sig.length !== 64) return false;
  try {
    return verify(null, canonicalDockedReceiptPayload(receipt), publicKey, sig);
  } catch {
    return false;
  }
}

// True while `receipt` can still be redeemed at `nowMs`: it was issued no later than `skew` from
// now, no earlier than `ttl` ago, and the docking it vouches for did not complete after it.
export function isDockedReceiptFresh(
  receipt,
  nowMs,
  { ttlMs = DOCKED_RECEIPT_TTL_MS, maxSkewMs = DOCKED_RECEIPT_MAX_SKEW_MS } = {}
) {
  if (receipt.dockedAtMs > receipt.issuedAtMs) return false;
  if (receipt.issuedAtMs > nowMs + maxSkewMs) return false;
  return nowMs - receipt.issuedAtMs <= ttlMs;
}
