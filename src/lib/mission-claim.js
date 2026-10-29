import { verify } from 'node:crypto';
import { lotsPayload } from './cargo.js';

const DOMAIN = Buffer.from('EOTHA_MISSION_CLAIM_V1', 'utf8'); // 22 bytes
const DOMAIN_V2 = Buffer.from('EOTHA_MISSION_CLAIM_V2', 'utf8');
// The gather domain: the cargo suffix's lots carry provenance, which V1 and V2 gather layouts did not.
const DOMAIN_GATHER = Buffer.from('EOTHA_MISSION_CLAIM_V3', 'utf8');

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

function i32(value) {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(value);
  return buf;
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

// The raw 16 bytes of a lowercase hyphenated UUID spelling.
const uuidBytes = (uuid) => Buffer.from(uuid.replaceAll('-', ''), 'hex');

// Canonical byte layout defined in proto/eotha/rtse/v1/mission.proto (MissionCompletionClaim).
// A GATHER claim (`gather`, decided by the caller from the stored offer's signed type, never from the claim) is
// signed under EOTHA_MISSION_CLAIM_V3, whatever its offer's visibility, and also signs the cargo suffix: lease_id (16)
// || session_id (16) || u64le(cargo_seq) || u32le(count) || per remaining lot the CargoLot layout of the cargo
// records (lp(resource_type) || u32le(units_milli) || u32le(grade) || u32le(purity_bp) || lp(origin_system_h3) ||
// lp(origin_faction_id) || lp(customs_status), see lotsPayload). The claim then carries { leaseId, sessionId (UUID
// spellings), cargoSeq, remaining }. There is no fallback: a gather claim is never verified under V1 or V2, nor any
// other claim under V3.
// `version` is selected from the stored signed offer, not inferred from claim contents. V2 (a faction mission) swaps
// the domain of a non-gather claim and appends attribution AFTER any cargo suffix; omitted zero fields stay zero.
export function canonicalClaimPayload(claim, gather = false, version = 1) {
  if (version !== 1 && version !== 2) throw new Error('Unknown mission signing version.');
  if (version === 1 && ((claim.wasDetected ?? false) !== false || (claim.exposureScoreMilli ?? 0) !== 0
      || (claim.opposedReputationChange ?? 0) !== 0 || BigInt(claim.bribePaidCredits ?? 0) !== 0n)) {
    throw new Error('A V1 claim cannot carry unsigned V2 fields.');
  }
  const domain = gather ? DOMAIN_GATHER : version === 2 ? DOMAIN_V2 : DOMAIN;
  const v1 = [
    domain,
    lenPrefixed(claim.missionId),
    lenPrefixed(claim.playerShipId),
    lenPrefixed(claim.destinationStationId),
    u64(claim.acceptedAtMs),
    u64(claim.completedAtMs),
    u64(claim.rewardCredits),
    i32(claim.reputationChange)
  ];
  const cargo = gather ? [
    uuidBytes(claim.leaseId),
    uuidBytes(claim.sessionId),
    u64(claim.cargoSeq),
    lotsPayload(claim.remaining ?? []) // proto-JSON omits an empty list
  ] : [];
  const v2 = version === 2 ? [
    Buffer.from([claim.wasDetected ? 1 : 0]),
    u32(claim.exposureScoreMilli ?? 0),
    i32(claim.opposedReputationChange ?? 0),
    u64(claim.bribePaidCredits ?? 0)
  ] : [];
  return Buffer.concat([...v1, ...cargo, ...v2]);
}

// `signature` is the base64-encoded 64-byte Ed25519 signature. Never throws.
export function verifyClaimSignature(claim, publicKey, gather = false, version = 1) {
  if (!publicKey || !claim || typeof claim.signature !== 'string') return false;
  const sig = Buffer.from(claim.signature, 'base64');
  if (sig.length !== 64) return false;
  try {
    return verify(null, canonicalClaimPayload(claim, gather, version), publicKey, sig);
  } catch {
    return false;
  }
}
