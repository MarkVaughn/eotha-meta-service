import { verify } from 'node:crypto';
import { DOCKED_RECEIPT_MAX_SKEW_MS, DOCKED_RECEIPT_TTL_MS } from '../config/docking.js';
import { H3_PATTERN } from '../config/patterns.js';

export const DOCKED_RECEIPT_DOMAIN = Buffer.from('EOTHA_DOCKED_RECEIPT_V3', 'utf8'); // 23 bytes

// The governing faction a receipt may sign: a faction key, or '' for an independent system. `independent`
// is never a value. There is one signing layout, V3, and no fallback: a V1 receipt (no faction) or a V2 receipt
// (no outfitting catalog, which could otherwise read as "stocks everything") has a different domain, so its
// signature never verifies here.
export const CONTROLLING_FACTION_IDS = Object.freeze(['', 'alpha', 'beta', 'gamma']);

// The wire form of a UUID: lowercase and hyphenated. The signed bytes are the raw 16, so no other
// spelling can ever reach the payload.
export const DOCKED_ENTITY_ID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
// Standard base64 of exactly 16 bytes (the nonce) and of exactly 64 bytes (the signature).
export const NONCE_B64_PATTERN = '^[A-Za-z0-9+/]{22}==$';
export const SIGNATURE_B64_PATTERN = '^[A-Za-z0-9+/]{86}==$';

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

// Whether `receipt`'s catalog is in the one form the engine signs: entries strictly ascending by component type
// (so none repeats), none UNSPECIFIED (0) or of tier 0, and bit 0 (UNSPECIFIED) of the quality mask clear. Every
// number is a u32. A catalog in any other form has no valid signature, so refusing it also keeps the signed
// bytes from depending on how the client ordered the list.
function hasCanonicalCatalog({ outfittingStock, stockedQualityMask, artisanMaxTier }) {
  const isU32 = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
  if (!Array.isArray(outfittingStock) || !isU32(stockedQualityMask) || !isU32(artisanMaxTier)) return false;
  if (stockedQualityMask & 1) return false;
  let previous = 0;
  for (const entry of outfittingStock) {
    if (!entry || !isU32(entry.componentType) || !isU32(entry.maxTier)) return false;
    if (entry.componentType <= previous || entry.maxTier < 1) return false;
    previous = entry.componentType;
  }
  return true;
}

// Mirrors eotha-rtse `docked_receipt_signing_payload` and the vector in eotha-contracts
// `scripts/check-docked-receipt-vector.js`. `receipt` carries { pilotId, dockedEntityId (lowercase
// hyphenated UUID), systemH3, dockedAtMs, issuedAtMs, nonce (base64, 16 bytes),
// controllingFactionId ('' or a faction key), outfittingStock ([{ componentType, maxTier }] as enum numbers,
// strictly ascending), stockedQualityMask, artisanMaxTier }. Throws on a malformed id, nonce or catalog;
// `verifyDockedReceipt` is the caller that never does.
export function canonicalDockedReceiptPayload(receipt) {
  const entityId = Buffer.from(receipt.dockedEntityId.replaceAll('-', ''), 'hex');
  const nonce = Buffer.from(receipt.nonce, 'base64');
  if (entityId.length !== 16) throw new Error('dockedEntityId must be a 16-byte UUID.');
  if (nonce.length !== 16) throw new Error('nonce must be 16 bytes.');
  if (!hasCanonicalCatalog(receipt)) throw new Error('outfitting catalog must be strictly ascending by component type, tiers of at least 1, quality bit 0 clear.');
  return Buffer.concat([
    DOCKED_RECEIPT_DOMAIN,
    lenPrefixed(receipt.pilotId),
    entityId,
    lenPrefixed(receipt.systemH3),
    u64(receipt.dockedAtMs),
    u64(receipt.issuedAtMs),
    nonce,
    lenPrefixed(receipt.controllingFactionId),
    u32(receipt.outfittingStock.length),
    ...receipt.outfittingStock.map((entry) => Buffer.concat([u32(entry.componentType), u32(entry.maxTier)])),
    u32(receipt.stockedQualityMask),
    u32(receipt.artisanMaxTier)
  ]);
}

// `receipt.signature` is the base64-encoded 64-byte Ed25519 signature. Never throws.
export function verifyDockedReceipt(receipt, publicKey) {
  if (!publicKey || !receipt || typeof receipt.signature !== 'string') return false;
  if (!CONTROLLING_FACTION_IDS.includes(receipt.controllingFactionId)) return false;
  const sig = Buffer.from(receipt.signature, 'base64');
  if (sig.length !== 64) return false;
  try {
    return verify(null, canonicalDockedReceiptPayload(receipt), publicKey, sig);
  } catch {
    return false;
  }
}

// True while `receipt` can still be redeemed at `nowMs`: it was issued no later than `skew` from
// now, no earlier than `ttl` ago, and the docking it vouches for did not complete after it.
export function isDockedReceiptFresh(
  receipt,
  nowMs,
  { ttlMs = DOCKED_RECEIPT_TTL_MS, maxSkewMs = DOCKED_RECEIPT_MAX_SKEW_MS } = {}
) {
  if (receipt.dockedAtMs > receipt.issuedAtMs) return false;
  if (receipt.issuedAtMs > nowMs + maxSkewMs) return false;
  return nowMs - receipt.issuedAtMs <= ttlMs;
}

const uint = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const u32Schema = { type: 'integer', minimum: 0, maximum: 0xffffffff };
// The most entries a catalog can hold is one per component type, so a larger list is never a real receipt.
const MAX_OUTFITTING_STOCK_ENTRIES = 32;

// The `dockedReceipt` of a request body.
export const dockedReceiptSchema = {
  type: 'object',
  required: [
    'pilotId', 'dockedEntityId', 'systemH3', 'dockedAtMs', 'issuedAtMs', 'nonce', 'controllingFactionId',
    'outfittingStock', 'stockedQualityMask', 'artisanMaxTier', 'signature'
  ],
  properties: {
    pilotId: { type: 'string', minLength: 1, maxLength: 256 },
    dockedEntityId: { type: 'string', pattern: DOCKED_ENTITY_ID_PATTERN },
    systemH3: { type: 'string', pattern: H3_PATTERN },
    dockedAtMs: uint,
    issuedAtMs: uint,
    nonce: { type: 'string', pattern: NONCE_B64_PATTERN },
    controllingFactionId: { type: 'string', enum: CONTROLLING_FACTION_IDS },
    // The station's outfitting catalog: the highest tier stocked per ComponentType (enum number, hull included),
    // the stocked QualityGrades as a bitmask (bit n for grade n) and the tier Artisan work stops at (0 = no cap).
    outfittingStock: {
      type: 'array',
      maxItems: MAX_OUTFITTING_STOCK_ENTRIES,
      items: {
        type: 'object',
        required: ['componentType', 'maxTier'],
        properties: { componentType: u32Schema, maxTier: u32Schema }
      }
    },
    stockedQualityMask: u32Schema,
    artisanMaxTier: u32Schema,
    signature: { type: 'string', pattern: SIGNATURE_B64_PATTERN }
  }
};

// Fastify's validator coerces types by default ("1700000000000" becomes 1700000000000, null becomes 0, true becomes 1),
// which would let a receipt whose JSON types differ from the contract's pass validation. The contract fixes them (the
// `invalid_bodies` in eotha-contracts' golden fixtures), so this checks `value` against `dockedReceiptSchema`'s
// types on the raw body, before the validator can coerce anything. Returns the first mismatch as a Fastify-style
// validation message, or null. It checks types only; required fields, patterns and ranges stay with the validator.
const JSON_TYPE_OF = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === 'string',
  integer: (v) => typeof v === 'number'
};

function typeViolation(value, schema, path) {
  if (value === undefined) return null; // a missing field is the validator's `required`, not a type
  if (!JSON_TYPE_OF[schema.type](value)) return `${path} must be ${schema.type}`;
  if (schema.type === 'object') {
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      const violation = typeViolation(value[name], property, `${path}/${name}`);
      if (violation) return violation;
    }
  } else if (schema.type === 'array') {
    for (const [i, item] of value.entries()) {
      const violation = typeViolation(item, schema.items, `${path}/${i}`);
      if (violation) return violation;
    }
  }
  return null;
}

// `body` is a request's raw parsed body; only its `dockedReceipt`, the one the schema above describes, is checked.
export function dockedReceiptTypeViolation(body) {
  if (body === null || typeof body !== 'object' || Buffer.isBuffer(body)) return null;
  return typeViolation(body.dockedReceipt, dockedReceiptSchema, 'body/dockedReceipt');
}

// Why a present `receipt` does not prove that `pilotId` is docked at `nowMs`, as the `{ error, code }`
// body of a 403, or null when it does.
export function dockedReceiptRefusal(receipt, { pilotId, publicKey, nowMs, log }) {
  if (receipt.pilotId !== pilotId || !verifyDockedReceipt(receipt, publicKey)) {
    return { error: 'The docked receipt is not valid for this pilot.', code: 'docked_receipt_invalid' };
  }
  log?.debug({ receiptAgeMs: nowMs - receipt.issuedAtMs }, 'docked receipt age');
  if (!isDockedReceiptFresh(receipt, nowMs)) {
    return { error: 'The docked receipt has expired. Request a new one and retry.', code: 'docked_receipt_expired' };
  }
  return null;
}
