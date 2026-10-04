import { verify } from 'node:crypto';
export { loadRtsePublicKey } from './mission-claim.js';

export const PLANET_CHART_DOMAIN = Buffer.from('EOTHA_PLANET_CHART_V1', 'utf8'); // 21 bytes
export const SYSTEM_CHART_DOMAIN = Buffer.from('EOTHA_SYSTEM_CHART_V1', 'utf8'); // 21 bytes

// Deterministic JSON (sorted object keys) used when the RTSE's raw survey bytes are not supplied.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

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

export function canonicalSystemChartPayload(key) {
  return Buffer.concat([
    SYSTEM_CHART_DOMAIN,
    lenPrefixed(key.pilotId),
    lenPrefixed(key.systemH3),
    u32(key.totalBodiesCharted),
    u64(key.chartedAtMs)
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

export function verifyPlanetChartSignature(key, surveyHashBuffer, publicKey) {
  if (!Buffer.isBuffer(surveyHashBuffer) || surveyHashBuffer.length !== 32) return false;
  try {
    return verifyPayload(canonicalPlanetChartPayload(key, surveyHashBuffer), key.signature, publicKey);
  } catch {
    return false;
  }
}

export function verifySystemChartSignature(key, publicKey) {
  try {
    return verifyPayload(canonicalSystemChartPayload(key), key.signature, publicKey);
  } catch {
    return false;
  }
}
