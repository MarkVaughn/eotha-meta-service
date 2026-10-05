import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import env from '../config/env.js';

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

// Canonical byte layout defined in proto/eotha/rtse/v1/mission.proto (MissionCompletionClaim).
export function canonicalClaimPayload(claim) {
  return Buffer.concat([
    DOMAIN,
    lenPrefixed(claim.missionId),
    lenPrefixed(claim.playerShipId),
    lenPrefixed(claim.destinationStationId),
    u64(claim.acceptedAtMs),
    u64(claim.completedAtMs),
    u64(claim.rewardCredits),
    i32(claim.reputationChange)
  ]);
}

export function loadRtsePublicKey(path = join(resolve(env.KEYS_DIR), 'public.pem')) {
  try {
    return createPublicKey(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// `signature` is the base64-encoded 64-byte Ed25519 signature. Never throws.
export function verifyClaimSignature(claim, publicKey) {
  if (!publicKey || typeof claim.signature !== 'string') return false;
  const sig = Buffer.from(claim.signature, 'base64');
  if (sig.length !== 64) return false;
  try {
    return verify(null, canonicalClaimPayload(claim), publicKey, sig);
  } catch {
    return false;
  }
}
