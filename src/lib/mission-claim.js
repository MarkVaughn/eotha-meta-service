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
export function canonicalClaimPayload(claim, gather = false) {
  const v1 = [
    DOMAIN,
    lenPrefixed(claim.missionId),
    lenPrefixed(claim.playerShipId),
    lenPrefixed(claim.destinationStationId),
    u64(claim.acceptedAtMs),
    u64(claim.completedAtMs),
    u64(claim.rewardCredits),
    i32(claim.reputationChange)
  ];
  if (!gather) return Buffer.concat(v1);
  const remaining = claim.remaining ?? []; // proto-JSON omits an empty list
  return Buffer.concat([
    ...v1,
    uuidBytes(claim.leaseId),
    uuidBytes(claim.sessionId),
    u64(claim.cargoSeq),
    u32(remaining.length),
    ...remaining.flatMap((lot) => [lenPrefixed(lot.resourceType), u32(lot.unitsMilli), u32(lot.grade), u32(lot.purityBp)])
  ]);
}

// `signature` is the base64-encoded 64-byte Ed25519 signature. Never throws.
export function verifyClaimSignature(claim, publicKey, gather = false) {
  if (!publicKey || typeof claim.signature !== 'string') return false;
  const sig = Buffer.from(claim.signature, 'base64');
  if (sig.length !== 64) return false;
  try {
    return verify(null, canonicalClaimPayload(claim, gather), publicKey, sig);
  } catch {
    return false;
  }
}
