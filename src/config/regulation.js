// Regulated mining and ore trade (Factions stage F5, design-factions §7): the standing tiers, what a mining
// permit costs, the export toll, the amnesty on poached ore sold at home and the reputation domestic ore earns.
// Pure data and functions; the database side is src/lib/mining-permits.js, src/lib/export-toll.js and
// src/lib/domestic-sale.js. The engine owns where the pilot is and what the ore is; the meta-service owns the wallet.

// --- Standing tiers ---------------------------------------------------------------------------------------

// The seven tiers of a standing with a faction, best first, each from its `min` standing up. Mirrors the engine's
// `standing_inspect_mult` bands (eotha-rtse `customs.rs`).
export const STANDING_TIERS = Object.freeze([
  Object.freeze({ id: 'PARAGON', min: 800 }),
  Object.freeze({ id: 'TRUSTED', min: 450 }),
  Object.freeze({ id: 'FRIENDLY', min: 150 }),
  Object.freeze({ id: 'NEUTRAL', min: -149 }),
  Object.freeze({ id: 'UNFRIENDLY', min: -499 }),
  Object.freeze({ id: 'HOSTILE', min: -749 }),
  Object.freeze({ id: 'NEMESIS', min: -Infinity })
]);

export const standingTier = (standing) => STANDING_TIERS.find((tier) => standing >= tier.min).id;

// A standing at or below this is Hostile: its faction refuses the pilot a permit, a docking code and a hail.
export const HOSTILE_STANDING_MAX = -500;

// --- Mining permits (§7.1) --------------------------------------------------------------------------------

// A permit lasts two hours (a docking code, the engine's, one).
export const MINING_PERMIT_TTL_MS = 2 * 60 * 60_000;

// What a permit costs by tier, in credits. A Trusted or better pilot, and one flying the faction's colors, is
// exempt (0); a Hostile or Nemesis pilot is not sold one (null).
export const MINING_PERMIT_COSTS = Object.freeze({
  PARAGON: 0, TRUSTED: 0, FRIENDLY: 150, NEUTRAL: 400, UNFRIENDLY: 900, HOSTILE: null, NEMESIS: null
});

// A hail receipt is relayed within this long of `issuedAtMs`; the future it may claim is the engine and
// meta-service clocks' disagreement (eotha-contracts StationHailReceipt: 60 s, 5 s of skew).
export const HAIL_RECEIPT_TTL_MS = 60_000;
export const HAIL_RECEIPT_MAX_SKEW_MS = 5_000;

// StationHailIntent.REQUEST_MINING_PERMIT, the one intent a receipt may be redeemed for here.
export const HAIL_INTENT_REQUEST_MINING_PERMIT = 2;

/**
 * The credits a mining permit with `factionId` costs a pilot at `standing` who flies `activeColors`, or null when
 * the faction will not sell the pilot one. Flying the faction's colors needs a standing of 500, so the colors
 * exemption is the Trusted one with a name; it is kept apart so a lowered colors threshold would still exempt.
 */
export function miningPermitCost(standing, factionId, activeColors) {
  if (activeColors != null && activeColors === factionId) return 0;
  return MINING_PERMIT_COSTS[standingTier(standing)];
}

// --- The mining violation (§7.2) --------------------------------------------------------------------------

// The reputation a Patrol Alert that filled costs with the faction governing the system, and how long the
// pilot's transponder stays flagged for a mandatory customs inspection at that faction's docks.
export const MINING_VIOLATION_REPUTATION = -10;
export const CUSTOMS_FLAG_MS = 60 * 60_000;
// A notice from further ahead than this of our clock is refused (it is signed by the engine; a clock this far
// out is a fault, not a notice). A notice never expires on a clock: its nonce is what makes it once-only.
export const MINING_VIOLATION_MAX_FUTURE_SKEW_MS = 60_000;

// --- Export toll (§7.3) -----------------------------------------------------------------------------------

// The share of ore's baseline market value paid to clear it for export from the faction's system, by tier, in
// basis points: 12% standard, 6% Friendly, 3% Trusted, none for a Paragon or a pilot flying the faction's colors.
export const EXPORT_TOLL_BP = Object.freeze({
  PARAGON: 0, TRUSTED: 300, FRIENDLY: 600, NEUTRAL: 1200, UNFRIENDLY: 1200, HOSTILE: 1200, NEMESIS: 1200
});

export function exportTollBp(standing, factionId, activeColors) {
  if (activeColors != null && activeColors === factionId) return 0;
  return EXPORT_TOLL_BP[standingTier(standing)];
}

// The customs statuses of a CargoLot (eotha-contracts `cargo.proto`). A lot stored before provenance has none ('').
export const CUSTOMS_STATUS = Object.freeze({
  DOMESTIC_OR_FREE: 'DOMESTIC_OR_FREE',
  PERMITTED_UNDECLARED_EXPORT: 'PERMITTED_UNDECLARED_EXPORT',
  EXPORT_CLEARED: 'EXPORT_CLEARED',
  UNLICENSED_POACHED: 'UNLICENSED_POACHED'
});
const KNOWN_STATUSES = new Set(['', ...Object.values(CUSTOMS_STATUS)]);

// A status the toll clears: ore leaving the system without its toll paid, whether or not it was mined legally.
export const isClearableStatus = (status) =>
  status === CUSTOMS_STATUS.PERMITTED_UNDECLARED_EXPORT || status === CUSTOMS_STATUS.UNLICENSED_POACHED;

// Poached ore is what the engine calls UNLICENSED_POACHED, and, as the contract says, any status this service does
// not know: a reader that does not know a value treats the lot as it treats the strictest.
export const isPoachedStatus = (status) => status === CUSTOMS_STATUS.UNLICENSED_POACHED || !KNOWN_STATUSES.has(status);

// --- Domestic sales (§7.3) --------------------------------------------------------------------------------

// Domestic ore (mined in the system whose controlling faction owns the station it is sold at, under a permit or
// with an exemption) earns one reputation point per 50 units sold, at most 6 a sale. The part of 50 units a sale
// leaves over is kept in PlayerReputation.domesticOreRemainder, in milli-units.
export const DOMESTIC_ORE_UNITS_PER_REPUTATION = 50;
export const DOMESTIC_ORE_MILLI_PER_REPUTATION = DOMESTIC_ORE_UNITS_PER_REPUTATION * 1000;
export const DOMESTIC_ORE_MAX_REPUTATION_PER_SALE = 6;

// The amnesty: poached ore sold at home is not seized; the permit it should have had, plus this late surcharge
// (in basis points), comes off the sale's proceeds, never more than the proceeds.
export const AMNESTY_SURCHARGE_BP = 1000;
// A pilot the faction will not sell a permit (Hostile, Nemesis) pays the dearest permit's price.
export const AMNESTY_DENIED_TIER_COST = MINING_PERMIT_COSTS.UNFRIENDLY;

/** The fee the amnesty asks of a pilot at `standing` flying `activeColors` before the proceeds cap, in credits. */
export function amnestyFee(standing, factionId, activeColors) {
  const permit = miningPermitCost(standing, factionId, activeColors) ?? AMNESTY_DENIED_TIER_COST;
  return Math.ceil(permit * (10_000 + AMNESTY_SURCHARGE_BP) / 10_000);
}
