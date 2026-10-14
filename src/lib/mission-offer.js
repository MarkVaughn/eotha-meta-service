import { verify } from 'node:crypto';

export const MISSION_OFFER_DOMAIN = Buffer.from('EOTHA_MISSION_OFFER_V1', 'utf8'); // 22 bytes

// `MissionType` numbers (eotha-contracts `rtse/v1/mission.proto`); the payload signs the number.
export const MISSION_TYPES = { MISSION_TYPE_PASSAGE: 1, MISSION_TYPE_RESEARCH: 2 };

function lenPrefixed(value) {
  const bytes = Buffer.from(value, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

function i32(value) {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(value);
  return buf;
}

function u64(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

// The IEEE-754 bits of the double, so a coordinate one ulp off no longer verifies.
function f64(value) {
  if (typeof value !== 'number') throw new Error('coordinates must be numbers.');
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(value);
  return buf;
}

// Mirrors the `MissionOffer.signature` layout in eotha-contracts `rtse/v1/mission.proto` and the
// vector in `scripts/check-mission-offer-vector.js`. `offer` is proto-JSON (snake_case fields, the
// type as its enum name). Throws on a malformed field; `verifyMissionOffer` is the caller that
// never does.
export function canonicalMissionOfferPayload(offer) {
  const type = MISSION_TYPES[offer.type];
  if (type === undefined) throw new Error('type must be a MissionType name.');
  return Buffer.concat([
    MISSION_OFFER_DOMAIN,
    lenPrefixed(offer.pilot_id),
    u64(offer.offered_at_ms),
    lenPrefixed(offer.mission_id),
    u32(type),
    lenPrefixed(offer.title),
    lenPrefixed(offer.description),
    lenPrefixed(offer.origin_station_id),
    lenPrefixed(offer.origin_system_h3),
    lenPrefixed(offer.destination_station_id),
    lenPrefixed(offer.destination_system_h3),
    lenPrefixed(offer.destination_node_h3),
    f64(offer.destination_lat),
    f64(offer.destination_lng),
    u32(offer.distance_hexes),
    u32(offer.required_berths),
    u64(offer.duration_limit_ms),
    u64(offer.reward_credits),
    i32(offer.reputation_change),
    lenPrefixed(offer.faction_id),
    u64(offer.expires_at_ms)
  ]);
}

// `offer.signature` is the base64-encoded 64-byte Ed25519 signature. Never throws.
export function verifyMissionOffer(offer, publicKey) {
  if (!publicKey || !offer || typeof offer.signature !== 'string') return false;
  const sig = Buffer.from(offer.signature, 'base64');
  if (sig.length !== 64) return false;
  try {
    return verify(null, canonicalMissionOfferPayload(offer), publicKey, sig);
  } catch {
    return false;
  }
}
