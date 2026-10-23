import { verify } from 'node:crypto';
import { UUID_PATTERN } from '../config/patterns.js';

export const MISSION_OFFER_DOMAIN = Buffer.from('EOTHA_MISSION_OFFER_V1', 'utf8'); // 22 bytes

// `MissionType` numbers (eotha-contracts `rtse/v1/mission.proto`); the payload signs the number.
export const MISSION_TYPES = { MISSION_TYPE_PASSAGE: 1, MISSION_TYPE_RESEARCH: 2, MISSION_TYPE_GATHER: 3 };
export const MISSION_VISIBILITIES = {
  MISSION_VISIBILITY_UNSPECIFIED: 0, MISSION_VISIBILITY_OVERT: 1, MISSION_VISIBILITY_COVERT: 2
};
export const MISSION_ARCHETYPES = Object.fromEntries([
  'UNSPECIFIED', 'DIPLOMAT_ESCORT', 'SABOTEUR_INSERTION', 'SYNDICATE_EXTRACTION',
  'STRATEGIC_RECON', 'FORBIDDEN_PLANET_SURVEY', 'ARMS_DELIVERY', 'ILLEGAL_CARGO_SMUGGLE', 'TRAITOR_DEFECTOR_OP'
].map((name, value) => [`MISSION_ARCHETYPE_${name}`, value]));

export function missionEnum(value, values) {
  if (value === undefined) return 0;
  if (typeof value === 'number' && Object.values(values).includes(value)) return value;
  if (Object.hasOwn(values, value)) return values[value];
  throw new Error('Unknown mission enum value.');
}

// Visibility, never the presence of claim fields, selects both signing domains. A V1 offer
// must not acquire unsigned V2 fields; omitted proto zero values are equivalent to explicit zeros.
export function missionOfferVersion(offer) {
  const visibility = missionEnum(offer.visibility, MISSION_VISIBILITIES);
  const archetype = missionEnum(offer.archetype, MISSION_ARCHETYPES);
  if (visibility !== 0) return 2;
  if (archetype !== 0 || (offer.opposed_faction_id ?? '') !== ''
      || (offer.opposed_reputation_change ?? 0) !== 0 || BigInt(offer.clandestine_bonus_credits ?? 0) !== 0n
      || (offer.carries_contraband_or_operative ?? false) !== false
      || (offer.required_flying_colors_faction_id ?? '') !== '') {
    throw new Error('V2 mission fields require visibility.');
  }
  return 1;
}

export const isCovert = (offer) => missionEnum(offer.visibility, MISSION_VISIBILITIES) === 2;

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
  const version = missionOfferVersion(offer);
  const v1 = [
    version === 2 ? Buffer.from('EOTHA_MISSION_OFFER_V2', 'utf8') : MISSION_OFFER_DOMAIN,
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
  ];
  // Only GATHER appends the suffix, so passage and research payloads are unchanged.
  const gather = offer.type === 'MISSION_TYPE_GATHER'
    ? [
        lenPrefixed(offer.resource_type),
        u32(offer.min_grade),
        u32(offer.quantity_m3),
        lenPrefixed(offer.source_body_id),
        lenPrefixed(offer.source_system_h3),
        lenPrefixed(offer.source_node_h3),
        f64(offer.source_lat),
        f64(offer.source_lng)
      ]
    : [];
  const v2 = version === 2 ? [
    u32(missionEnum(offer.visibility, MISSION_VISIBILITIES)),
    u32(missionEnum(offer.archetype, MISSION_ARCHETYPES)),
    lenPrefixed(offer.opposed_faction_id ?? ''),
    i32(offer.opposed_reputation_change ?? 0),
    u64(offer.clandestine_bonus_credits ?? 0),
    Buffer.from([offer.carries_contraband_or_operative ? 1 : 0]),
    lenPrefixed(offer.required_flying_colors_faction_id ?? '')
  ] : [];
  return Buffer.concat([...v1, ...gather, ...v2]);
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

// A mission stored before offers were signed by the engine (legacy id, no exact coordinates, or no
// signature) can never be claimed: the engine would not recognise its offer. It is removed when the
// pilot's missions are next listed, abandoned or completed, or an accept succeeds, and never counts
// against a limit; accepting it charged nothing and boarded no one, so there is nothing to refund or
// unboard.
export const isLegacyRow = (row) =>
  !UUID_PATTERN.test(row.missionId)
  || !Array.isArray(row.offer?.exact_destination)
  || row.offer.exact_destination.length !== 2
  || typeof row.offer.signature !== 'string';
