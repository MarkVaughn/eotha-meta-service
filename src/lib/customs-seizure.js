import { verify } from 'node:crypto';
import { CONTROLLING_FACTION_IDS, DOCKED_ENTITY_ID_PATTERN, NONCE_B64_PATTERN, SIGNATURE_B64_PATTERN } from './docked-receipt.js';
import { H3_PATTERN } from '../config/patterns.js';

export const CUSTOMS_SEIZURE_DOMAIN = Buffer.from('EOTHA_CUSTOMS_SEIZURE_V1', 'utf8'); // 24 bytes

// CustomsInspectionOutcome numbers a seizure claim may carry (eotha-contracts `rtse/v1/simulation.proto`).
export const OUTCOME_SEIZED = 3;
export const OUTCOME_ARMED_BOARDING = 4;

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

// Mirrors eotha-rtse `customs_seizure_signing_payload` and the vectors in eotha-contracts
// `scripts/check-customs-seizure-vector.js`: the domain, lp(pilot_id), the 16 raw station id bytes,
// lp(system_h3), lp(controlling_faction_id), lp(mission_id), u32le outcome, tier and exposure, u64le
// seized_at_ms and the 16 nonce bytes. `claim` carries { pilotId, stationEntityId (lowercase hyphenated
// UUID), systemH3, controllingFactionId ('' or a faction key), missionId ('' when not mission related),
// inspectionOutcome, captureTier, exposureScoreMilli, seizedAtMs, nonce (base64, 16 bytes) }. Throws on
// a malformed id or nonce; `verifyCustomsSeizure` is the caller that never does.
export function canonicalCustomsSeizurePayload(claim) {
  const station = Buffer.from(claim.stationEntityId.replaceAll('-', ''), 'hex');
  const nonce = Buffer.from(claim.nonce, 'base64');
  if (station.length !== 16) throw new Error('stationEntityId must be a 16-byte UUID.');
  if (nonce.length !== 16) throw new Error('nonce must be 16 bytes.');
  return Buffer.concat([
    CUSTOMS_SEIZURE_DOMAIN,
    lenPrefixed(claim.pilotId),
    station,
    lenPrefixed(claim.systemH3),
    lenPrefixed(claim.controllingFactionId),
    lenPrefixed(claim.missionId),
    u32(claim.inspectionOutcome),
    u32(claim.captureTier),
    u32(claim.exposureScoreMilli),
    u64(claim.seizedAtMs),
    nonce
  ]);
}

// Whether `claim` is a capture the engine signed: an outcome of SEIZED or ARMED_BOARDING, a tier from 1
// to 4, a faction that is '' or a faction key, and a valid Ed25519 signature (`claim.signature`, base64
// of 64 bytes) by `publicKey`. Never throws.
export function verifyCustomsSeizure(claim, publicKey) {
  if (!publicKey || !claim || typeof claim.signature !== 'string') return false;
  if (![OUTCOME_SEIZED, OUTCOME_ARMED_BOARDING].includes(claim.inspectionOutcome)) return false;
  if (!Number.isInteger(claim.captureTier) || claim.captureTier < 1 || claim.captureTier > 4) return false;
  if (!CONTROLLING_FACTION_IDS.includes(claim.controllingFactionId)) return false;
  const sig = Buffer.from(claim.signature, 'base64');
  if (sig.length !== 64) return false;
  try {
    return verify(null, canonicalCustomsSeizurePayload(claim), publicKey, sig);
  } catch {
    return false;
  }
}

const uint = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };

// The `claim` of a seizure request: a `CustomsSeizureClaim` the pilot relays from the frame that ended its
// docking, as camelCase JSON with the station id as a UUID and the nonce and signature as base64.
export const customsSeizureSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'pilotId', 'stationEntityId', 'systemH3', 'inspectionOutcome', 'captureTier', 'exposureScoreMilli',
    'seizedAtMs', 'nonce', 'signature'
  ],
  properties: {
    pilotId: { type: 'string', minLength: 1, maxLength: 256 },
    stationEntityId: { type: 'string', pattern: DOCKED_ENTITY_ID_PATTERN },
    systemH3: { type: 'string', pattern: H3_PATTERN },
    // Proto-JSON omits an empty string: an independent system and a capture not tied to a mission.
    controllingFactionId: { type: 'string', enum: CONTROLLING_FACTION_IDS, default: '' },
    missionId: { type: 'string', maxLength: 256, default: '' },
    inspectionOutcome: { type: 'integer', minimum: 0, maximum: 4_294_967_295 },
    captureTier: { type: 'integer', minimum: 0, maximum: 4_294_967_295 },
    exposureScoreMilli: { type: 'integer', minimum: 0, maximum: 4_294_967_295 },
    seizedAtMs: uint,
    nonce: { type: 'string', pattern: NONCE_B64_PATTERN },
    signature: { type: 'string', pattern: SIGNATURE_B64_PATTERN }
  }
};
