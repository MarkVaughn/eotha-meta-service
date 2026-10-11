import { verify } from 'node:crypto';

export const PLANET_CHART_DOMAIN = Buffer.from('EOTHA_PLANET_CHART_V1', 'utf8'); // 21 bytes
export const SYSTEM_CHART_DOMAIN = Buffer.from('EOTHA_SYSTEM_CHART_V2', 'utf8'); // 21 bytes

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

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

export function canonicalPlanetChartPayload(key, surveyHashBuffer) {
  return Buffer.concat([
    PLANET_CHART_DOMAIN,
    lenPrefixed(key.pilotId),
    lenPrefixed(key.planetId),
    lenPrefixed(key.systemH3),
    u64(key.completedAtMs),
    surveyHashBuffer // 32 bytes SHA-256
  ]);
}

// Mirrors eotha-rtse `system_chart_signing_payload`. `systemDigest` is the 32-byte SHA-256 over the
// survey hashes of every planet in the system, ordered by planet id.
export function canonicalSystemChartPayload(key, systemDigestBuffer) {
  return Buffer.concat([
    SYSTEM_CHART_DOMAIN,
    lenPrefixed(key.pilotId),
    lenPrefixed(key.systemH3),
    u32(key.totalBodiesCharted),
    u64(key.chartedAtMs),
    systemDigestBuffer // 32 bytes SHA-256
  ]);
}

// `key.signature` is the base64-encoded 64-byte Ed25519 signature. Never throws.
function verifyPayload(payload, signature, publicKey) {
  if (!publicKey || typeof signature !== 'string') return false;
  const sig = Buffer.from(signature, 'base64');
  if (sig.length !== 64) return false;
  try {
    return verify(null, payload, publicKey, sig);
  } catch {
    return false;
  }
}

// `chartKey` carries { planetId, pilotId, systemH3, completedAtMs }; `signature` is base64;
// `surveyHash` must be the 32-byte SHA-256 of the exact survey protobuf bytes the RTSE signed.
export function verifyPlanetChartKey(chartKey, signature, surveyHash, publicKey) {
  if (!Buffer.isBuffer(surveyHash) || surveyHash.length !== 32) return false;
  try {
    return verifyPayload(canonicalPlanetChartPayload(chartKey, surveyHash), signature, publicKey);
  } catch {
    return false;
  }
}

// `key` carries { systemH3, pilotId, totalBodiesCharted, chartedAtMs, signature }; `systemDigest`
// must be the 32-byte digest the RTSE signed. A key without one (a V1 key) never verifies.
export function verifySystemChartSignature(key, systemDigest, publicKey) {
  if (!Buffer.isBuffer(systemDigest) || systemDigest.length !== 32) return false;
  try {
    return verifyPayload(canonicalSystemChartPayload(key, systemDigest), key.signature, publicKey);
  } catch {
    return false;
  }
}
