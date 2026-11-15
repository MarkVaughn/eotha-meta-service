import { verify } from 'node:crypto';
import {
  BASE_COSTS_CREDITS,
  INTEL_CATEGORIES,
  INTEL_HOUR_MS,
  POOL_MAX_ITEMS,
  hourEpochOf
} from '../config/intel.js';
import { FACTION_IDS } from '../config/factions.js';
import { DOCKED_ENTITY_ID_PATTERN } from './docked-receipt.js';
import { H3_PATTERN } from '../config/patterns.js';

export const INTEL_OFFER_DOMAIN = Buffer.from('EOTHA_INTEL_OFFER_V1', 'utf8'); // 20 bytes

const ENTITY_ID = new RegExp(DOCKED_ENTITY_ID_PATTERN);
const SYSTEM_H3 = new RegExp(H3_PATTERN);
const SIGNATURE_BYTES = 64;

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
const i32 = (value) => {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(value);
  return buf;
};
const u64 = (value) => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
};

// Mirrors `IntelItem.signature` in eotha-contracts `common/v1/intel.proto`: the domain, then the item's identity and
// base terms, little-endian, strings length-prefixed, the station as its 16 raw bytes. Never the detail, so a redacted
// copy verifies as the full one. `item` is a normalized item (see normalizeRelayedItem). Throws on a malformed field;
// `verifyIntelItem` is the caller that never does.
export function canonicalIntelItemPayload(item) {
  const station = Buffer.from(item.stationEntityId.replaceAll('-', ''), 'hex');
  if (station.length !== 16) throw new Error('stationEntityId must be a 16-byte UUID.');
  return Buffer.concat([
    INTEL_OFFER_DOMAIN,
    lenPrefixed(item.intelId),
    u32(item.category),
    station,
    lenPrefixed(item.systemH3),
    u64(item.hourEpoch),
    u32(item.slotIndex),
    Buffer.from([item.isFreeAmbient ? 1 : 0]),
    u64(item.baseCostCredits),
    i32(item.requiredStanding),
    lenPrefixed(item.requiredStandingFactionId),
    u64(item.issuedAtMs),
    u64(item.expiresAtMs)
  ]);
}

// `item.signature` is the base64 of the 64-byte Ed25519 signature by the engine's claim key. Never throws.
export function verifyIntelItem(item, publicKey) {
  if (!publicKey || !item || typeof item.signature !== 'string') return false;
  const sig = Buffer.from(item.signature, 'base64');
  if (sig.length !== SIGNATURE_BYTES) return false;
  try {
    return verify(null, canonicalIntelItemPayload(item), publicKey, sig);
  } catch {
    return false;
  }
}

// The clock skew tolerated between the engine's `issued_at_ms` and this service's clock.
export const ISSUED_AT_SKEW_MS = 60_000;

// A field of a proto-JSON message as camelCase (the engine's own JSON) or snake_case (this service's wire) names it.
const camel = (key) => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const field = (raw, snakeKey) => raw[snakeKey] ?? raw[camel(snakeKey)];

// An unsigned 64-bit field as proto-JSON gives it, a number or a decimal string, as a safe integer; else null.
function uint(value) {
  const n = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
const uint32 = (value) => {
  const n = uint(value);
  return n !== null && n <= 4_294_967_295 ? n : null;
};
const int32 = (value) => (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? value : null);

// The category as its number, from the number or the enum name; 0 when it is neither.
export function categoryOf(value) {
  if (typeof value === 'number' && Object.values(INTEL_CATEGORIES).includes(value)) return value;
  return INTEL_CATEGORIES[value] ?? 0;
}

// The station as a lowercase hyphenated UUID, from that or from the base64 of its 16 bytes (proto-JSON of a `bytes` field).
function stationIdOf(value) {
  if (typeof value !== 'string') return null;
  if (ENTITY_ID.test(value)) return value.toLowerCase();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 16 || bytes.toString('base64') !== value) return null;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The signed part of an `IntelItem` a client relayed (proto-JSON, camelCase or snake_case) as the service handles it, or
 * null when a signed field is missing or out of range. Fields 1 to 12 and the signature are all it keeps: the engine
 * signed those. Everything else a client sends with it (headline, body, veracity, the detail) is unsigned and a client
 * is never believed about it, so it is dropped here and nothing downstream can read it.
 */
export function normalizeRelayedItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const category = categoryOf(raw.category);
  if (!category) return null;
  const item = {
    intelId: field(raw, 'intel_id'),
    category,
    stationEntityId: stationIdOf(field(raw, 'station_entity_id')),
    systemH3: field(raw, 'system_h3'),
    hourEpoch: uint(field(raw, 'hour_epoch')),
    slotIndex: uint32(field(raw, 'slot_index')),
    isFreeAmbient: field(raw, 'is_free_ambient') === true,
    baseCostCredits: uint(field(raw, 'base_cost_credits')),
    requiredStanding: int32(field(raw, 'required_standing') ?? 0),
    requiredStandingFactionId: field(raw, 'required_standing_faction_id') ?? '',
    issuedAtMs: uint(field(raw, 'issued_at_ms')),
    expiresAtMs: uint(field(raw, 'expires_at_ms')),
    signature: raw.signature
  };
  const numbers = [item.hourEpoch, item.slotIndex, item.baseCostCredits, item.requiredStanding, item.issuedAtMs, item.expiresAtMs];
  if (numbers.some((n) => n === null)) return null;
  if (typeof item.intelId !== 'string' || item.intelId.length < 1 || item.intelId.length > 256) return null;
  if (!item.stationEntityId) return null;
  if (typeof item.systemH3 !== 'string' || !SYSTEM_H3.test(item.systemH3)) return null;
  if (typeof item.requiredStandingFactionId !== 'string' || (item.requiredStandingFactionId && !FACTION_IDS.includes(item.requiredStandingFactionId))) return null;
  if (typeof item.signature !== 'string') return null;
  return item;
}

export class IntelItemError extends Error {
  constructor(message, code = 'intel_item_invalid') {
    super(message);
    this.code = code;
  }
}

/**
 * The relayed `raw` item as a normalized item, once it is proven to be one the engine signed for the dock the pilot is
 * docked at and still current at `nowMs`; else an IntelItemError. In the order checked: the signed fields are well formed
 * and the signature (EOTHA_INTEL_OFFER_V1) verifies under `publicKey`, the engine's claim key; the item is for this
 * `stationEntityId` and `systemH3`; its list price is one the engine sells and its free flag matches (free if and only
 * if the price is 0); and its hour is the current one, ending when the hour ends, with an issue time that is not in the
 * future. A stale or future hour is the `intel_pool_expired` code, anything else `intel_item_invalid`. A relayed item that is
 * not proven this way is never charged for.
 */
export function validateRelayedItem(raw, { stationEntityId, systemH3, nowMs }, publicKey) {
  const item = normalizeRelayedItem(raw);
  if (!item) throw new IntelItemError('The intel item is malformed.');
  if (!verifyIntelItem(item, publicKey)) throw new IntelItemError('The intel item is not signed by the engine.');
  if (item.stationEntityId !== stationEntityId || item.systemH3 !== systemH3) {
    throw new IntelItemError('The intel item is for another station.');
  }
  if (item.slotIndex >= POOL_MAX_ITEMS || !BASE_COSTS_CREDITS.includes(item.baseCostCredits) || item.isFreeAmbient !== (item.baseCostCredits === 0)) {
    throw new IntelItemError('The intel item has terms the engine does not issue.');
  }
  if (item.hourEpoch !== hourEpochOf(nowMs)) throw new IntelItemError('That pool has rotated.', 'intel_pool_expired');
  if (item.expiresAtMs !== (item.hourEpoch + 1) * INTEL_HOUR_MS || item.issuedAtMs > nowMs + ISSUED_AT_SKEW_MS) {
    throw new IntelItemError('The intel item has a time outside its hour.');
  }
  return item;
}
