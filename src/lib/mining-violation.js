import { verify } from 'node:crypto';
import { H3_PATTERN } from '../config/patterns.js';
import { FACTION_IDS } from '../config/factions.js';
import { NONCE_B64_PATTERN, SIGNATURE_B64_PATTERN } from './docked-receipt.js';

export const MINING_VIOLATION_DOMAIN = Buffer.from('EOTHA_MINING_VIOLATION_V1', 'utf8'); // 25 bytes

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

// Mirrors the `MiningViolationNotice` layout in eotha-contracts `rtse/v1/simulation.proto` and the vector in
// `scripts/check-mining-violation-vector.js`: the domain, lp(pilot_id), lp(system_h3), lp(controlling_faction_id),
// u64le issued_at_ms and the 16 nonce bytes. `notice` carries { pilotId, systemH3, controllingFactionId, issuedAtMs,
// nonce (base64, 16 bytes) }. Throws on a malformed nonce; `verifyMiningViolation` is the caller that never does.
export function canonicalMiningViolationPayload(notice) {
  const nonce = Buffer.from(notice.nonce, 'base64');
  if (nonce.length !== 16) throw new Error('nonce must be 16 bytes.');
  return Buffer.concat([
    MINING_VIOLATION_DOMAIN,
    lenPrefixed(notice.pilotId),
    lenPrefixed(notice.systemH3),
    lenPrefixed(notice.controllingFactionId),
    u64(notice.issuedAtMs),
    nonce
  ]);
}

// Whether `notice` is one the engine signed: a controlling faction that is one of the three (never '' or
// 'independent': an independent system has no patrol to alert), and a valid Ed25519 signature (`notice.signature`,
// base64 of 64 bytes) by `publicKey`. Never throws.
export function verifyMiningViolation(notice, publicKey) {
  if (!publicKey || !notice || typeof notice.signature !== 'string') return false;
  if (!FACTION_IDS.includes(notice.controllingFactionId)) return false;
  const sig = Buffer.from(notice.signature, 'base64');
  if (sig.length !== 64) return false;
  try {
    return verify(null, canonicalMiningViolationPayload(notice), publicKey, sig);
  } catch {
    return false;
  }
}

const uint = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };

// The `notice` of a request body: a `MiningViolationNotice` as camelCase proto-JSON, the nonce and signature as base64.
export const miningViolationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['pilotId', 'systemH3', 'controllingFactionId', 'issuedAtMs', 'nonce', 'signature'],
  properties: {
    pilotId: { type: 'string', minLength: 1, maxLength: 256 },
    systemH3: { type: 'string', pattern: H3_PATTERN },
    controllingFactionId: { type: 'string', enum: FACTION_IDS },
    issuedAtMs: uint,
    nonce: { type: 'string', pattern: NONCE_B64_PATTERN },
    signature: { type: 'string', pattern: SIGNATURE_B64_PATTERN }
  }
};
