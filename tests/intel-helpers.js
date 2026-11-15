// Station Intel test doubles: pool items signed the way the engine does (eotha-contracts `IntelItem`, domain
// EOTHA_INTEL_OFFER_V1) with the bytes assembled here rather than with src/lib/intel-offer.js, as the client relays them to
// POST /game/intel/gather, and a verifier for the vouchers the service signs, also written independently of
// src/lib/intel-voucher.js.
import { randomUUID, verify, sign } from 'node:crypto';
import { app, rtseKey, voucherPublicKey } from './helpers.js';

export const HOUR_MS = 3_600_000;
export const currentHour = () => Math.floor(Date.now() / HOUR_MS);

const CATEGORY = { TIP: 1, LEAD: 2, RECRUIT: 3, SITE: 4, SIGHTING: 5 };
export { CATEGORY };

const str = (value) => {
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

/** What a client might attach to a relayed item unsigned, a forged detail included: none of it may ever be read or sent back. */
export const forgedOf = (slot) => `FORGED-${slot}`;

function detailFor(category, slot, missionId) {
  const secret = forgedOf(slot);
  switch (category) {
    case CATEGORY.TIP:
      return { outfitterTip: { targetStationId: randomUUID(), targetStationName: secret, targetSystemH3: '88283082a9fffff', distanceHexes: 2, componentType: 'SHIELDS', tier: slot === 3 ? 5 : 2, qualityGrade: 'BASIC', priceConditionPct: 85 } };
    case CATEGORY.LEAD:
      return { missionLead: { missionId, baseMissionType: 1, archetype: 0, title: secret, narrative: secret, destinationSystemH3: '88283082a9fffff', distanceHexes: 2, rewardCredits: 4000, sponsoringFactionId: 'alpha', somethingTheEngineAdded: secret } };
    case CATEGORY.RECRUIT:
      return { factionRecruitment: { missionId, factionId: 'alpha', callSign: secret, minimumStanding: 450, missionHeadline: secret, operationalTheaterH3: '88283082a9fffff', operationalRole: 'FLEET_RECON', mobilizationBonusCredits: 900, bonusReputation: 15 } };
    case CATEGORY.SITE:
      return { awayTeamSite: { siteId: randomUUID(), planetId: randomUUID(), planetName: secret, systemH3: '88283082a9fffff', siteNodeH3: '8c283082a9001ff', biome: 2, hazardRating: 3, encounterArchetype: 'PRECURSOR_VAULT', recommendedLeadClass: 'SCIENCE', expectedLoot: ['XENOLITH_ISOTOPES'] } };
    default:
      return { playerSighting: { sightingId: randomUUID(), shipName: secret, captainName: 'Vance', hullClass: 'OBSERVABLE_HULL_CLASS_MEDIUM', weaponBracket: 'OBSERVABLE_WEAPON_BRACKET_STRONG_MILITARY', shieldBracket: 'OBSERVABLE_SHIELD_BRACKET_HEAVY_MILITARY', minutesSinceDeparture: 35, conductNote: secret } };
  }
}

/** One pool item signed by `signer`; `overrides` replace any field first (a signed one is re-signed). */
export function signedIntelItem(overrides = {}, signer = rtseKey) {
  const slot = overrides.slotIndex ?? 0;
  const category = overrides.category ?? CATEGORY.TIP;
  const hourEpoch = overrides.hourEpoch ?? currentHour();
  const item = {
    intelId: `intel-${overrides.stationEntityId ?? 'x'}-${hourEpoch}-${slot}`,
    category,
    stationEntityId: randomUUID(),
    systemH3: '8828308281fffff',
    hourEpoch,
    slotIndex: slot,
    isFreeAmbient: false,
    baseCostCredits: 100,
    requiredStanding: 0,
    requiredStandingFactionId: '',
    issuedAtMs: hourEpoch * HOUR_MS,
    expiresAtMs: (hourEpoch + 1) * HOUR_MS,
    headline: `Rumor ${slot}`,
    body: `Coarse rumor ${slot}`,
    veracity: 3,
    detail: detailFor(category, slot, randomUUID()),
    ...overrides
  };
  const payload = Buffer.concat([
    Buffer.from('EOTHA_INTEL_OFFER_V1', 'ascii'),
    str(item.intelId),
    u32(item.category),
    Buffer.from(item.stationEntityId.replaceAll('-', ''), 'hex'),
    str(item.systemH3),
    u64(item.hourEpoch),
    u32(item.slotIndex),
    Buffer.from([item.isFreeAmbient ? 1 : 0]),
    u64(item.baseCostCredits),
    i32(item.requiredStanding),
    str(item.requiredStandingFactionId),
    u64(item.issuedAtMs),
    u64(item.expiresAtMs)
  ]);
  return { ...item, signature: overrides.signature ?? sign(null, payload, signer).toString('base64') };
}

/**
 * A ten item pool for a dock, as the engine would sign it: slots 0 and 1 are the free ambient items; 2 a T2 tip (100);
 * 3 a T5 tip (250); 4 and 5 mission leads (250); 6 a faction recruitment call needing alpha 450 (500); 7 an away-team site
 * (250); 8 and 9 sightings (250). `mutate(item)` may change the unsigned fields before signing.
 */
export function signedPool({ stationEntityId, systemH3 = '8828308281fffff', hourEpoch = currentHour(), mutate } = {}) {
  const shape = [
    [CATEGORY.TIP, 0, true], [CATEGORY.SITE, 0, true],
    [CATEGORY.TIP, 100], [CATEGORY.TIP, 250], [CATEGORY.LEAD, 250], [CATEGORY.LEAD, 250],
    [CATEGORY.RECRUIT, 500, false, 450, 'alpha'], [CATEGORY.SITE, 250], [CATEGORY.SIGHTING, 250], [CATEGORY.SIGHTING, 250]
  ];
  return shape.map(([category, baseCostCredits, isFreeAmbient = false, requiredStanding = 0, requiredStandingFactionId = ''], slotIndex) => {
    const base = { category, baseCostCredits, isFreeAmbient, requiredStanding, requiredStandingFactionId, slotIndex, stationEntityId, systemH3, hourEpoch };
    return signedIntelItem({ ...base, intelId: `intel-${stationEntityId}-${hourEpoch}-${slotIndex}`, ...(mutate?.(base, slotIndex) ?? {}) });
  });
}

/** The signed item of `slot` in the pool the engine would build for the dock `receipt` names, as a client relays it. */
export function poolItem(receipt, slot, options = {}) {
  return signedPool({ stationEntityId: receipt.dockedEntityId, systemH3: receipt.systemH3, ...options })[slot];
}

/** The body of POST /game/intel/gather for `slot` of the dock's pool; `extra` replaces any field of it. */
export const gatherBody = (receipt, slot, expectedCostCredits, extra = {}) => ({
  item: poolItem(receipt, slot), expectedCostCredits, dockedReceipt: receipt, ...extra
});

/** The id of the pool item of `slot` for a dock/hour, as a pool built by signedPool names it. */
export const intelIdOf = (stationEntityId, slot, hourEpoch = currentHour()) => `intel-${stationEntityId}-${hourEpoch}-${slot}`;

const lengthPrefixed = str;

/**
 * Whether `voucher` (the proto-JSON a gather returns) carries a valid Ed25519 signature of the service's voucher key over
 * the EOTHA_MISSION_VOUCHER_V1 layout of eotha-contracts, assembled here independently.
 */
export function voucherVerifies(voucher) {
  const payload = Buffer.concat([
    Buffer.from('EOTHA_MISSION_VOUCHER_V1', 'ascii'),
    lengthPrefixed(voucher.issuer_key_id),
    lengthPrefixed(voucher.pilot_id),
    lengthPrefixed(voucher.mission_id),
    lengthPrefixed(voucher.intel_id),
    u32(voucher.category),
    Buffer.from(voucher.station_entity_id.replaceAll('-', ''), 'hex'),
    lengthPrefixed(voucher.system_h3),
    u64(voucher.issued_at_ms),
    u64(voucher.expires_at_ms),
    Buffer.from(voucher.nonce, 'base64')
  ]);
  return verify(null, payload, voucherPublicKey, Buffer.from(voucher.signature, 'base64'));
}

/** The query string of GET /game/intel/pool for `receipt`. */
export const poolUrl = (receipt, extra = '') => `/game/intel/pool?receipt=${encodeURIComponent(JSON.stringify(receipt))}${extra}`;

/** Sets the pilot's standing with `factionId` directly. */
export const setStanding = (pilot, factionId, standing) =>
  app.prisma.playerReputation.upsert({
    where: { playerId_factionId: { playerId: pilot.id, factionId } },
    update: { standing },
    create: { playerId: pilot.id, factionId, standing }
  });
