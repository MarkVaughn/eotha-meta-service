import { verify } from 'node:crypto';
import { DOCKED_RECEIPT_MAX_SKEW_MS, DOCKED_RECEIPT_TTL_MS } from '../config/docking.js';
import { H3_PATTERN } from '../config/patterns.js';

export const DOCKED_RECEIPT_DOMAIN = Buffer.from('EOTHA_DOCKED_RECEIPT_V2', 'utf8'); // 23 bytes

// The governing faction a receipt may sign: a faction key, or '' for an independent system. `independent`
// is never a value, and a V1 receipt (no faction) is rejected rather than read as independent: its
// domain differs, so its signature never verifies here.
export const CONTROLLING_FACTION_IDS = Object.freeze(['', 'alpha', 'beta', 'gamma']);

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
// hyphenated UUID), systemH3, dockedAtMs, issuedAtMs, nonce (base64, 16 bytes),
// controllingFactionId ('' or a faction key) }. Throws on a
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
    nonce,
    lenPrefixed(receipt.controllingFactionId)
  ]);
}

// `receipt.signature` is the base64-encoded 64-byte Ed25519 signature. Never throws.
export function verifyDockedReceipt(receipt, publicKey) {
  if (!publicKey || !receipt || typeof receipt.signature !== 'string') return false;
  if (!CONTROLLING_FACTION_IDS.includes(receipt.controllingFactionId)) return false;
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

const uint = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };

// The `dockedReceipt` of a request body.
export const dockedReceiptSchema = {
  type: 'object',
  required: ['pilotId', 'dockedEntityId', 'systemH3', 'dockedAtMs', 'issuedAtMs', 'nonce', 'controllingFactionId', 'signature'],
  properties: {
    pilotId: { type: 'string', minLength: 1, maxLength: 256 },
    dockedEntityId: { type: 'string', pattern: DOCKED_ENTITY_ID_PATTERN },
    systemH3: { type: 'string', pattern: H3_PATTERN },
    dockedAtMs: uint,
    issuedAtMs: uint,
    nonce: { type: 'string', pattern: NONCE_B64_PATTERN },
    controllingFactionId: { type: 'string', enum: CONTROLLING_FACTION_IDS },
    signature: { type: 'string', pattern: SIGNATURE_B64_PATTERN }
  }
};

// Why a present `receipt` does not prove that `pilotId` is docked at `nowMs`, as the `{ error, code }`
// body of a 403, or null when it does.
export function dockedReceiptRefusal(receipt, { pilotId, publicKey, nowMs, log }) {
  if (receipt.pilotId !== pilotId || !verifyDockedReceipt(receipt, publicKey)) {
    return { error: 'The docked receipt is not valid for this pilot.', code: 'docked_receipt_invalid' };
  }
  log?.debug({ receiptAgeMs: nowMs - receipt.issuedAtMs }, 'docked receipt age');
  if (!isDockedReceiptFresh(receipt, nowMs)) {
    return { error: 'The docked receipt has expired. Request a new one and retry.', code: 'docked_receipt_expired' };
  }
  return null;
}
