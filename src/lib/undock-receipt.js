import { verify } from 'node:crypto';
import { UNDOCK_RECEIPT_MAX_SKEW_MS, UNDOCK_RECEIPT_TTL_MS } from '../config/docking.js';
import { H3_PATTERN } from '../config/patterns.js';
import { CONTROLLING_FACTION_IDS, DOCKED_ENTITY_ID_PATTERN, NONCE_B64_PATTERN, SIGNATURE_B64_PATTERN } from './docked-receipt.js';

export const UNDOCK_RECEIPT_DOMAIN = Buffer.from('EOTHA_UNDOCK_RECEIPT_V1', 'utf8'); // 23 bytes

const lenPrefixed = (value) => {
  const bytes = Buffer.from(value, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
};
const u64 = (value) => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
};

// Mirrors the `UndockReceipt` layout in eotha-contracts `rtse/v1/simulation.proto` and the vectors in
// eotha-contracts `scripts/check-undock-receipt-vector.js`: the domain, lp(pilot_id), the 16 raw station id bytes, lp(system_h3),
// u64le docked_at_ms, u64le undocked_at_ms, the 16 nonce bytes and lp(controlling_faction_id). `receipt` carries
// { pilotId, stationEntityId (lowercase hyphenated UUID), systemH3, dockedAtMs, undockedAtMs, nonce (base64, 16
// bytes), controllingFactionId ('' or a faction key) }. Throws on a malformed id or nonce; `verifyUndockReceipt`
// is the caller that never does.
export function canonicalUndockReceiptPayload(receipt) {
  const station = Buffer.from(receipt.stationEntityId.replaceAll('-', ''), 'hex');
  const nonce = Buffer.from(receipt.nonce, 'base64');
  if (station.length !== 16) throw new Error('stationEntityId must be a 16-byte UUID.');
  if (nonce.length !== 16) throw new Error('nonce must be 16 bytes.');
  return Buffer.concat([
    UNDOCK_RECEIPT_DOMAIN,
    lenPrefixed(receipt.pilotId),
    station,
    lenPrefixed(receipt.systemH3),
    u64(receipt.dockedAtMs),
    u64(receipt.undockedAtMs),
    nonce,
    lenPrefixed(receipt.controllingFactionId)
  ]);
}

// Whether `receipt` is one the engine signed: a faction that is '' (an independent system) or a faction key, and a
// valid Ed25519 signature (`receipt.signature`, base64 of 64 bytes) by `publicKey`. Never throws.
export function verifyUndockReceipt(receipt, publicKey) {
  if (!publicKey || !receipt || typeof receipt.signature !== 'string') return false;
  if (!CONTROLLING_FACTION_IDS.includes(receipt.controllingFactionId)) return false;
  const sig = Buffer.from(receipt.signature, 'base64');
  if (sig.length !== 64) return false;
  try {
    return verify(null, canonicalUndockReceiptPayload(receipt), publicKey, sig);
  } catch {
    return false;
  }
}

// True while `receipt` can still be applied at `nowMs`: the docking it follows did not complete after the cast-off,
// the cast-off is no later than the skew from now, and no earlier than the relay window ago.
export function isUndockReceiptFresh(
  receipt,
  nowMs,
  { ttlMs = UNDOCK_RECEIPT_TTL_MS, maxSkewMs = UNDOCK_RECEIPT_MAX_SKEW_MS } = {}
) {
  if (receipt.dockedAtMs > receipt.undockedAtMs) return false;
  if (receipt.undockedAtMs > nowMs + maxSkewMs) return false;
  return nowMs - receipt.undockedAtMs <= ttlMs;
}

// The replay key of `receipt` (`UndockRecord.nonce`): the hex of its 16 nonce bytes, as the other signed records
// store theirs.
export const undockReceiptNonceKey = (receipt) => Buffer.from(receipt.nonce, 'base64').toString('hex');

const uint = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };

// The `undockReceipt` of a request body: an `UndockReceipt` as camelCase proto-JSON, the station id as a UUID and
// the nonce and signature as base64. Proto-JSON omits an empty string, so an independent system's faction is optional.
export const undockReceiptSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['pilotId', 'stationEntityId', 'systemH3', 'dockedAtMs', 'undockedAtMs', 'nonce', 'signature'],
  properties: {
    pilotId: { type: 'string', minLength: 1, maxLength: 256 },
    stationEntityId: { type: 'string', pattern: DOCKED_ENTITY_ID_PATTERN },
    systemH3: { type: 'string', pattern: H3_PATTERN },
    dockedAtMs: uint,
    undockedAtMs: uint,
    nonce: { type: 'string', pattern: NONCE_B64_PATTERN },
    controllingFactionId: { type: 'string', enum: CONTROLLING_FACTION_IDS, default: '' },
    signature: { type: 'string', pattern: SIGNATURE_B64_PATTERN }
  }
};
