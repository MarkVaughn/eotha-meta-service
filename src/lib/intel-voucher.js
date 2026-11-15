import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DOSSIER_LIFETIME_MS, VOUCHER_CATEGORIES } from '../config/intel.js';

export const MISSION_VOUCHER_DOMAIN = Buffer.from('EOTHA_MISSION_VOUCHER_V1', 'utf8'); // 24 bytes

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

// Mirrors `MissionUnlockVoucher.signature` in eotha-contracts `common/v1/intel.proto`. `voucher` carries
// { issuerKeyId, pilotId, missionId (empty: see issueVoucher), intelId, category, stationEntityId (lowercase hyphenated UUID), systemH3,
// issuedAtMs, expiresAtMs, nonce (16 bytes) }.
export function canonicalVoucherPayload(voucher) {
  const station = Buffer.from(voucher.stationEntityId.replaceAll('-', ''), 'hex');
  if (station.length !== 16) throw new Error('stationEntityId must be a 16-byte UUID.');
  if (voucher.nonce.length !== 16) throw new Error('nonce must be 16 bytes.');
  if (!VOUCHER_CATEGORIES.includes(voucher.category)) throw new Error('category must be one of the five intel categories.');
  return Buffer.concat([
    MISSION_VOUCHER_DOMAIN,
    lenPrefixed(voucher.issuerKeyId),
    lenPrefixed(voucher.pilotId),
    lenPrefixed(voucher.missionId),
    lenPrefixed(voucher.intelId),
    u32(voucher.category),
    station,
    lenPrefixed(voucher.systemH3),
    u64(voucher.issuedAtMs),
    u64(voucher.expiresAtMs),
    voucher.nonce
  ]);
}

// A fresh random 16-byte voucher nonce.
export const newVoucherNonce = () => randomBytes(16);

/**
 * The voucher for an unlock row, signed with `voucherKey` (`{ keyId, privateKey }`). It lives until `expiresAt`,
 * four hours after the gather (DOSSIER_LIFETIME_MS), and is rebuilt identically from the row each time it is asked for.
 * Every gathered item gets one, whatever its category (contracts 1.14.0). `mission_id` is signed as the empty string: the pilot
 * gathered an item whose detail this service never sees (the engine redacts it and a relayed detail is not trusted), so the
 * voucher binds the pilot to the item, `intel_id`, which the engine resolves (to the item's detail, and for a mission lead or
 * faction call to the mission) when the voucher is presented, echoing it as a classified offer's `intel_lead_id`.
 * The wire form: bytes as base64, the station as its UUID, like every other id this service sends.
 */
export function issueVoucher(voucherKey, { playerId, unlock }) {
  const fields = {
    issuerKeyId: voucherKey.keyId,
    pilotId: playerId,
    missionId: '',
    intelId: unlock.intelId,
    category: unlock.category,
    stationEntityId: unlock.stationEntityId,
    systemH3: unlock.systemH3,
    issuedAtMs: unlock.issuedAt.getTime(),
    expiresAtMs: unlock.expiresAt.getTime(),
    nonce: Buffer.from(unlock.voucherNonce)
  };
  const signature = sign(null, canonicalVoucherPayload(fields), voucherKey.privateKey);
  return {
    issuer_key_id: fields.issuerKeyId,
    pilot_id: fields.pilotId,
    mission_id: fields.missionId,
    intel_id: fields.intelId,
    category: fields.category,
    station_entity_id: fields.stationEntityId,
    system_h3: fields.systemH3,
    issued_at_ms: fields.issuedAtMs,
    expires_at_ms: fields.expiresAtMs,
    nonce: fields.nonce.toString('base64'),
    signature: signature.toString('base64')
  };
}

export const unlockExpiryOf = (issuedAtMs) => new Date(issuedAtMs + DOSSIER_LIFETIME_MS);

/**
 * `{ keyId, privateKey }` read from the PEM file `keyFile`, or null when none is configured. This key is the
 * meta-service's own and is never the login or claim key; the engine holds the public half, provisioned out of band.
 */
export function loadVoucherKey({ keyFile, keyId }) {
  if (!keyFile) return null;
  return { keyId, privateKey: createPrivateKey(readFileSync(keyFile)) };
}
