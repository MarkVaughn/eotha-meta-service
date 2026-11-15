import { verify } from 'node:crypto';
import {
  BASE_COSTS_CREDITS,
  DETAIL_KEYS,
  FREE_AMBIENT_COUNT,
  INTEL_CATEGORIES,
  INTEL_HOUR_MS,
  VOUCHER_CATEGORIES,
  POOL_MAX_ITEMS,
  POOL_MIN_ITEMS
} from '../config/intel.js';
import { FACTION_IDS } from '../config/factions.js';
import { DOCKED_ENTITY_ID_PATTERN } from './docked-receipt.js';
import { H3_PATTERN, UUID_PATTERN } from '../config/patterns.js';

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
// copy verifies as the full one. `item` is a normalized item (see normalizeEngineItem). Throws on a malformed field;
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

const snake = (key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

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

// The detail the engine sent for `category`, snake_cased and cut to the category's own fields; null when it sent none.
function detailOf(raw, category) {
  const spec = DETAIL_KEYS[category];
  const source = raw?.[snake(spec.wire)] ?? raw?.[spec.wire] ?? raw?.[spec.wire.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const detail = {};
  for (const [key, value] of Object.entries(source)) {
    if (spec.fields.includes(snake(key))) detail[snake(key)] = value;
  }
  return detail;
}

/**
 * One item of the engine's pool (the proto-JSON of `IntelItem`, camelCase, `detail` as `{ missionLead: {...} }` and so
 * on) as the service handles it, or null when a field is missing or out of range. Fields 1 to 12 are what the engine
 * signed; `headline`, `body`, `veracity` and `detail` are its unsigned text, which this service decides whether to send.
 */
export function normalizeEngineItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const category = categoryOf(raw.category);
  if (!category) return null;
  const item = {
    intelId: raw.intelId,
    category,
    stationEntityId: typeof raw.stationEntityId === 'string' ? raw.stationEntityId.toLowerCase() : raw.stationEntityId,
    systemH3: raw.systemH3,
    hourEpoch: uint(raw.hourEpoch),
    slotIndex: uint32(raw.slotIndex),
    isFreeAmbient: raw.isFreeAmbient === true,
    baseCostCredits: uint(raw.baseCostCredits),
    requiredStanding: int32(raw.requiredStanding ?? 0),
    requiredStandingFactionId: raw.requiredStandingFactionId ?? '',
    issuedAtMs: uint(raw.issuedAtMs),
    expiresAtMs: uint(raw.expiresAtMs),
    signature: raw.signature,
    headline: typeof raw.headline === 'string' ? raw.headline : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    veracity: Number.isInteger(raw.veracity) ? raw.veracity : 0,
    detail: detailOf(raw.detail, category)
  };
  const numbers = [item.hourEpoch, item.slotIndex, item.baseCostCredits, item.requiredStanding, item.issuedAtMs, item.expiresAtMs];
  if (numbers.some((n) => n === null)) return null;
  if (typeof item.intelId !== 'string' || item.intelId.length < 1 || item.intelId.length > 256) return null;
  if (typeof item.stationEntityId !== 'string' || !ENTITY_ID.test(item.stationEntityId)) return null;
  if (typeof item.systemH3 !== 'string' || !SYSTEM_H3.test(item.systemH3)) return null;
  if (typeof item.requiredStandingFactionId !== 'string' || (item.requiredStandingFactionId && !FACTION_IDS.includes(item.requiredStandingFactionId))) return null;
  if (typeof item.signature !== 'string' || !item.detail) return null;
  return item;
}

export class IntelPoolError extends Error {}

/**
 * The engine's `items` for the dock of `receipt` in `hourEpoch` as normalized items in slot order, or an IntelPoolError
 * naming what is wrong: a pool is 8 to 12 items with distinct ids and slots, exactly 2 free ambient items (free if and
 * only if the list price is 0), every one for this dock and this hour, expiring when the hour ends, and signed by the
 * engine. A pool that is not is never shown, so a misbehaving engine cannot mint prices or leak another dock's intel.
 */
export function validatePool(rawItems, { stationEntityId, systemH3, hourEpoch }, publicKey) {
  if (!Array.isArray(rawItems) || rawItems.length < POOL_MIN_ITEMS || rawItems.length > POOL_MAX_ITEMS) {
    throw new IntelPoolError(`The pool must hold ${POOL_MIN_ITEMS} to ${POOL_MAX_ITEMS} items.`);
  }
  const items = rawItems.map(normalizeEngineItem);
  const seenIds = new Set();
  const seenSlots = new Set();
  for (const item of items) {
    if (!item) throw new IntelPoolError('An item of the pool is malformed.');
    if (item.stationEntityId !== stationEntityId || item.systemH3 !== systemH3 || item.hourEpoch !== hourEpoch) {
      throw new IntelPoolError('An item of the pool is for another dock or hour.');
    }
    if (item.slotIndex >= POOL_MAX_ITEMS || item.expiresAtMs !== (hourEpoch + 1) * INTEL_HOUR_MS) {
      throw new IntelPoolError('An item of the pool has a slot or expiry outside its hour.');
    }
    if (!BASE_COSTS_CREDITS.includes(item.baseCostCredits) || item.isFreeAmbient !== (item.baseCostCredits === 0)) {
      throw new IntelPoolError('An item of the pool has a list price its free flag does not match.');
    }
    if (seenIds.has(item.intelId) || seenSlots.has(item.slotIndex)) throw new IntelPoolError('The pool repeats an item.');
    seenIds.add(item.intelId);
    seenSlots.add(item.slotIndex);
    // The unsigned detail the service acts on must be usable: a lead's mission id (what its voucher unlocks), a tip's tier.
    if (VOUCHER_CATEGORIES.includes(item.category) && !(typeof item.detail.mission_id === 'string' && UUID_PATTERN.test(item.detail.mission_id))) {
      throw new IntelPoolError('A lead of the pool names no mission.');
    }
    if (item.category === INTEL_CATEGORIES.INTEL_CATEGORY_OUTFITTER_TIP && !(Number.isInteger(item.detail.tier) && item.detail.tier >= 1 && item.detail.tier <= 5)) {
      throw new IntelPoolError('An outfitter tip of the pool has no tier.');
    }
    if (!verifyIntelItem(item, publicKey)) throw new IntelPoolError('An item of the pool is not signed by the engine.');
  }
  if (items.filter((item) => item.isFreeAmbient).length !== FREE_AMBIENT_COUNT) {
    throw new IntelPoolError(`The pool must hold exactly ${FREE_AMBIENT_COUNT} free ambient items.`);
  }
  return items.sort((a, b) => a.slotIndex - b.slotIndex);
}
