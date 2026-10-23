import { verify } from 'node:crypto';

const DOMAIN = Buffer.from('EOTHA_MISSION_CLAIM_V1', 'utf8'); // 22 bytes

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
// A GATHER claim (`gather`, decided by the caller from the stored offer's signed type, never from
// the claim) also signs the cargo suffix: lease_id (16) || session_id (16) || u64le(cargo_seq) ||
// u32le(count) || per remaining lot: lp(resource_type) || u32le(units_milli) || u32le(grade) ||
// u32le(purity_bp). The claim then carries { leaseId, sessionId (UUID spellings), cargoSeq, remaining }.
// `version` is selected from the stored signed offer, not inferred from claim contents. V2 swaps
// the domain and appends attribution AFTER any cargo suffix; omitted zero fields stay zero.
export function canonicalClaimPayload(claim, gather = false, version = 1) {
  if (version !== 1 && version !== 2) throw new Error('Unknown mission signing version.');
  if (version === 1 && ((claim.wasDetected ?? false) !== false || (claim.exposureScoreMilli ?? 0) !== 0
      || (claim.opposedReputationChange ?? 0) !== 0 || BigInt(claim.bribePaidCredits ?? 0) !== 0n)) {
    throw new Error('A V1 claim cannot carry unsigned V2 fields.');
  }
  const v1 = [
    version === 2 ? Buffer.from('EOTHA_MISSION_CLAIM_V2', 'utf8') : DOMAIN,
    lenPrefixed(claim.missionId),
    lenPrefixed(claim.playerShipId),
    lenPrefixed(claim.destinationStationId),
    u64(claim.acceptedAtMs),
    u64(claim.completedAtMs),
    u64(claim.rewardCredits),
    i32(claim.reputationChange)
  ];
  const remaining = claim.remaining ?? []; // proto-JSON omits an empty list
  const cargo = gather ? [
    uuidBytes(claim.leaseId),
    uuidBytes(claim.sessionId),
    u64(claim.cargoSeq),
    u32(remaining.length),
    ...remaining.flatMap((lot) => [lenPrefixed(lot.resourceType), u32(lot.unitsMilli), u32(lot.grade), u32(lot.purityBp)])
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
