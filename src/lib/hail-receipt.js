import { verify } from 'node:crypto';
import { HAIL_RECEIPT_MAX_SKEW_MS, HAIL_RECEIPT_TTL_MS } from '../config/regulation.js';
import { H3_PATTERN } from '../config/patterns.js';
import { CONTROLLING_FACTION_IDS, DOCKED_ENTITY_ID_PATTERN, NONCE_B64_PATTERN, SIGNATURE_B64_PATTERN } from './docked-receipt.js';

export const HAIL_RECEIPT_DOMAIN = Buffer.from('EOTHA_HAIL_RECEIPT_V1', 'utf8'); // 21 bytes

const lenPrefixed = (value) => {
  const bytes = Buffer.from(value, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
};
const u32 = (value) => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
};
const u64 = (value) => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
};

// Mirrors the `StationHailReceipt` layout in eotha-contracts `rtse/v1/simulation.proto` and the vectors in
// `scripts/check-hail-receipt-vector.js`: the domain, lp(pilot_id), the 16 raw station id bytes, lp(system_h3),
// lp(controlling_faction_id), u32le hail_intent, u64le issued_at_ms and the 16 nonce bytes. `receipt` carries
// { pilotId, stationEntityId (lowercase hyphenated UUID), systemH3, controllingFactionId ('' or a faction key),
// hailIntent, issuedAtMs, nonce (base64, 16 bytes) }. Throws on a malformed id or nonce; `verifyHailReceipt` is
// the caller that never does.
export function canonicalHailReceiptPayload(receipt) {
  const station = Buffer.from(receipt.stationEntityId.replaceAll('-', ''), 'hex');
  const nonce = Buffer.from(receipt.nonce, 'base64');
  if (station.length !== 16) throw new Error('stationEntityId must be a 16-byte UUID.');
  if (nonce.length !== 16) throw new Error('nonce must be 16 bytes.');
  return Buffer.concat([
    HAIL_RECEIPT_DOMAIN,
    lenPrefixed(receipt.pilotId),
    station,
    lenPrefixed(receipt.systemH3),
    lenPrefixed(receipt.controllingFactionId),
    u32(receipt.hailIntent),
    u64(receipt.issuedAtMs),
    nonce
  ]);
}

// Whether `receipt` is one the engine signed: a faction that is '' (an independent system) or a faction key, and a
// valid Ed25519 signature (`receipt.signature`, base64 of 64 bytes) by `publicKey`. Never throws.
export function verifyHailReceipt(receipt, publicKey) {
  if (!publicKey || !receipt || typeof receipt.signature !== 'string') return false;
  if (!CONTROLLING_FACTION_IDS.includes(receipt.controllingFactionId)) return false;
  const sig = Buffer.from(receipt.signature, 'base64');
  if (sig.length !== 64) return false;
  try {
    return verify(null, canonicalHailReceiptPayload(receipt), publicKey, sig);
  } catch {
    return false;
  }
}

// True while `receipt` can still be redeemed at `nowMs`: issued no later than the skew from now and no earlier
// than the relay window ago.
export function isHailReceiptFresh(receipt, nowMs, { ttlMs = HAIL_RECEIPT_TTL_MS, maxSkewMs = HAIL_RECEIPT_MAX_SKEW_MS } = {}) {
  if (receipt.issuedAtMs > nowMs + maxSkewMs) return false;
  return nowMs - receipt.issuedAtMs <= ttlMs;
}

const uint = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };

// The `hailReceipt` of a request body: a `StationHailReceipt` as camelCase proto-JSON, the station id as a UUID and
// the nonce and signature as base64. Proto-JSON omits an empty string, so an independent system's faction is optional.
export const hailReceiptSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['pilotId', 'stationEntityId', 'systemH3', 'hailIntent', 'issuedAtMs', 'nonce', 'signature'],
  properties: {
    pilotId: { type: 'string', minLength: 1, maxLength: 256 },
    stationEntityId: { type: 'string', pattern: DOCKED_ENTITY_ID_PATTERN },
    systemH3: { type: 'string', pattern: H3_PATTERN },
    controllingFactionId: { type: 'string', enum: CONTROLLING_FACTION_IDS, default: '' },
    hailIntent: { type: 'integer', minimum: 0, maximum: 4_294_967_295 },
    issuedAtMs: uint,
    nonce: { type: 'string', pattern: NONCE_B64_PATTERN },
    signature: { type: 'string', pattern: SIGNATURE_B64_PATTERN }
  }
};
