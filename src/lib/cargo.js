import { verify } from 'node:crypto';
import { CARGO_MAX_LOTS } from '../config/cargo.js';
import { H3_PATTERN } from '../config/patterns.js';
import { DOCKED_ENTITY_ID_PATTERN, NONCE_B64_PATTERN, SIGNATURE_B64_PATTERN } from './docked-receipt.js';

// V1 and V2 lots carried no provenance. A verifier checks V2 and V3 only and never falls back, since accepting an
// older signature would let a pilot strip a lot's origin and customs status.
export const CARGO_MANIFEST_DOMAIN = Buffer.from('EOTHA_CARGO_MANIFEST_V2', 'utf8'); // 23 bytes
export const SALE_RECORD_DOMAIN = Buffer.from('EOTHA_SALE_RECORD_V3', 'utf8'); // 20 bytes

// What `applyCargoWrite` decided about a record (eotha-contracts README, "Cargo lease claim").
export const CARGO_WRITE = Object.freeze({
  APPLIED: 'applied', // stored as the pilot's hold
  IN_LINEAGE: 'in_lineage', // its lease and session already applied a seq at or above it
  SUPERSEDED: 'superseded', // fenced by a newer lease, another session or a newer seq elsewhere
  UNKNOWN: 'unknown' // no lease of this pilot's has that id
});

// The 409 a cargo record that cannot be credited is answered with. The client flushes what it still
// holds, leases again and reconnects.
export const CARGO_REFUSALS = Object.freeze({
  [CARGO_WRITE.UNKNOWN]: { error: 'The cargo record names no lease of this pilot.', code: 'cargo_lease_unknown' },
  [CARGO_WRITE.SUPERSEDED]: {
    error: 'The cargo record was superseded by a newer lease or session; the stored hold is unchanged.',
    code: 'cargo_superseded'
  }
});

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

function u64(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

// The raw 16 bytes of a lowercase hyphenated UUID; throws on any other spelling.
export function uuidBytes(uuid) {
  if (typeof uuid !== 'string' || !new RegExp(DOCKED_ENTITY_ID_PATTERN).test(uuid)) {
    throw new Error('expected a lowercase hyphenated UUID.');
  }
  return Buffer.from(uuid.replaceAll('-', ''), 'hex');
}

// The lowercase hyphenated UUID spelling of 16 raw bytes.
export function bytesToUuid(bytes) {
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// `CargoLot` layout: lp(resource_type) || u32le(units_milli) || u32le(grade) || u32le(purity_bp) ||
// lp(origin_system_h3) || lp(origin_faction_id) || lp(customs_status), the list prefixed with its u32le count. An
// empty provenance string is a valid signed value (a zero length prefix); proto-JSON omits it, hence the defaults.
// The gather mission claim signs its `remaining` lots in this same layout (see src/lib/mission-claim.js).
export function lotsPayload(lots) {
  return Buffer.concat([
    u32(lots.length),
    ...lots.flatMap((lot) => [
      lenPrefixed(lot.resourceType), u32(lot.unitsMilli), u32(lot.grade), u32(lot.purityBp ?? 0),
      lenPrefixed(lot.originSystemH3 ?? ''), lenPrefixed(lot.originFactionId ?? ''), lenPrefixed(lot.customsStatus ?? '')
    ])
  ]);
}

// Mirrors the `CargoManifest` layout in eotha-contracts `rtse/v1/simulation.proto` and the vector in
// `scripts/check-cargo-manifest-vector.js`. `manifest` carries { pilotId, leaseId, sessionId (both
// lowercase hyphenated UUID spellings of the 16 bytes), seq, lots (CargoLot, camelCase), issuedAtMs }.
// Throws on a malformed field; `verifyCargoManifest` is the caller that never does.
export function canonicalCargoManifestPayload(manifest) {
  return Buffer.concat([
    CARGO_MANIFEST_DOMAIN,
    lenPrefixed(manifest.pilotId),
    uuidBytes(manifest.leaseId),
    uuidBytes(manifest.sessionId),
    u64(manifest.seq),
    lotsPayload(manifest.lots),
    u64(manifest.issuedAtMs)
  ]);
}

// Mirrors the `SaleRecord` V3 layout in eotha-contracts `rtse/v1/simulation.proto` and the vector in
// `scripts/check-sale-record-vector.js`. `record` carries { pilotId, stationId, items, totalCredits,
// soldAtMs, nonce (base64, 16 bytes), leaseId, sessionId, seq, remaining }. Throws on a malformed
// field; `verifySaleRecord` is the caller that never does.
export function canonicalSaleRecordPayload(record) {
  const nonce = Buffer.from(record.nonce, 'base64');
  if (nonce.length !== 16) throw new Error('nonce must be 16 bytes.');
  return Buffer.concat([
    SALE_RECORD_DOMAIN,
    lenPrefixed(record.pilotId),
    lenPrefixed(record.stationId),
    lotsPayload(record.items),
    u64(record.totalCredits),
    u64(record.soldAtMs),
    nonce,
    uuidBytes(record.leaseId),
    uuidBytes(record.sessionId),
    u64(record.seq),
    lotsPayload(record.remaining)
  ]);
}

function verifySigned(record, publicKey, payload) {
  if (!publicKey || !record || typeof record.signature !== 'string') return false;
  const sig = Buffer.from(record.signature, 'base64');
  if (sig.length !== 64) return false;
  try {
    return verify(null, payload(record), publicKey, sig);
  } catch {
    return false;
  }
}

// `signature` is the base64-encoded 64-byte Ed25519 signature. Never throws.
export const verifyCargoManifest = (manifest, publicKey) =>
  verifySigned(manifest, publicKey, canonicalCargoManifestPayload);

// `signature` is the base64-encoded 64-byte Ed25519 signature. Never throws.
export const verifySaleRecord = (record, publicKey) => verifySigned(record, publicKey, canonicalSaleRecordPayload);

// Signed lots (camelCase, as relayed) in the stored and lease-claim form (snake_case). The provenance keys are kept
// only when set, so a lot from before provenance (or without any) stays four keys and reads back as empty strings.
export const toStoredLots = (lots) =>
  lots.map((lot) => ({
    resource_type: lot.resourceType,
    units_milli: lot.unitsMilli,
    grade: lot.grade,
    purity_bp: lot.purityBp ?? 0,
    ...(lot.originSystemH3 && { origin_system_h3: lot.originSystemH3 }),
    ...(lot.originFactionId && { origin_faction_id: lot.originFactionId }),
    ...(lot.customsStatus && { customs_status: lot.customsStatus })
  }));

// A stored lot's provenance, '' for what it does not carry.
export const provenanceOf = (stored) => ({
  originSystemH3: stored.origin_system_h3 ?? '',
  originFactionId: stored.origin_faction_id ?? '',
  customsStatus: stored.customs_status ?? ''
});

// Volume of a stored hold in m3.
export const usedM3 = (lots) => lots.reduce((sum, lot) => sum + lot.units_milli, 0) / 1000;

// The pilot's current lease (the highest generation), or null before the first.
export const currentLease = (db, playerId) =>
  db.cargoLease.findFirst({ where: { playerId }, orderBy: { generation: 'desc' } });

/**
 * The fencing rule every cargo record passes. Inside a transaction that holds the pilot's lock
 * (`lockActiveShip`), with `rec = { leaseId, sessionId, seq, lots }` taken from a verified engine
 * signature (`sessionId` as its UUID spelling, `seq` a number, `lots` in stored form):
 *
 * - APPLIED when the lease is the pilot's current one, its session is unbound or this one (the first
 *   writer binds it), and `seq` is above the last applied: `lots` becomes the stored hold.
 * - IN_LINEAGE when the lease already applied this session's records up to `seq` or beyond: the
 *   stored lineage already reflects the record, so nothing is stored but it may still be credited.
 * - SUPERSEDED otherwise: nothing is stored and the record must not be credited.
 * - UNKNOWN when the pilot has no lease with that id.
 *
 * Returns `{ outcome, lease }`, `lease` being the row as it stands afterwards.
 */
export async function applyCargoWrite(tx, playerId, rec) {
  const lease = await tx.cargoLease.findFirst({ where: { id: rec.leaseId, playerId } });
  if (!lease) return { outcome: CARGO_WRITE.UNKNOWN, lease: null };
  const sessionId = uuidBytes(rec.sessionId);
  const seq = BigInt(rec.seq);
  const sameSession = lease.sessionId !== null && Buffer.from(lease.sessionId).equals(sessionId);

  const current = (await currentLease(tx, playerId)).id === lease.id;
  if (current && (lease.sessionId === null || sameSession) && seq > lease.lastSeq) {
    const updated = await tx.cargoLease.update({
      where: { id: lease.id },
      data: { sessionId, lastSeq: seq, lots: rec.lots }
    });
    return { outcome: CARGO_WRITE.APPLIED, lease: updated };
  }
  if (sameSession && seq <= lease.lastSeq) return { outcome: CARGO_WRITE.IN_LINEAGE, lease };
  return { outcome: CARGO_WRITE.SUPERSEDED, lease };
}

const uint = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const uint32 = { type: 'integer', minimum: 0, maximum: 4_294_967_295 };
const uuid = { type: 'string', pattern: DOCKED_ENTITY_ID_PATTERN };

// The factions a lot's origin may name: the three, or `independent` for free space. Empty is a lot from before
// provenance, which the engine signs as a zero length prefix.
const ORIGIN_FACTION_IDS = ['', 'alpha', 'beta', 'gamma', 'independent'];

// A `CargoLot` (eotha-contracts `rtse/v1/cargo.proto`) as proto-JSON. Proto-JSON may omit a field
// holding its zero value, so purity and each provenance field default to it. `customsStatus` is an open string: a
// later value needs no schema change here.
export const cargoLotSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['resourceType', 'unitsMilli', 'grade'],
  properties: {
    resourceType: { type: 'string', minLength: 1, maxLength: 32 },
    unitsMilli: uint32,
    grade: { type: 'integer', minimum: 1, maximum: 5 },
    purityBp: { type: 'integer', minimum: 0, maximum: 10_000, default: 0 },
    originSystemH3: { type: 'string', pattern: `^$|${H3_PATTERN}`, default: '' },
    originFactionId: { type: 'string', enum: ORIGIN_FACTION_IDS, default: '' },
    customsStatus: { type: 'string', maxLength: 64, default: '' }
  }
};

// Proto-JSON omits an empty repeated field, so a list defaults to empty.
const lots = { type: 'array', maxItems: CARGO_MAX_LOTS, items: cargoLotSchema, default: [] };

// The `manifest` of a request body: a `CargoManifest`, ids as lowercase hyphenated UUIDs.
export const cargoManifestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['pilotId', 'leaseId', 'sessionId', 'seq', 'issuedAtMs', 'signature'],
  properties: {
    pilotId: { type: 'string', minLength: 1, maxLength: 256 },
    leaseId: uuid,
    sessionId: uuid,
    seq: uint,
    lots,
    issuedAtMs: uint,
    signature: { type: 'string', pattern: SIGNATURE_B64_PATTERN }
  }
};

// The `saleRecord` of a request body: a `SaleRecord` (V3), ids as lowercase hyphenated UUIDs.
export const saleRecordSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['pilotId', 'stationId', 'totalCredits', 'soldAtMs', 'nonce', 'signature', 'leaseId', 'sessionId', 'seq'],
  properties: {
    pilotId: { type: 'string', minLength: 1, maxLength: 256 },
    stationId: { type: 'string', minLength: 1, maxLength: 256 },
    items: lots,
    totalCredits: uint,
    soldAtMs: uint,
    nonce: { type: 'string', pattern: NONCE_B64_PATTERN },
    signature: { type: 'string', pattern: SIGNATURE_B64_PATTERN },
    leaseId: uuid,
    sessionId: uuid,
    seq: uint,
    remaining: lots
  }
};
