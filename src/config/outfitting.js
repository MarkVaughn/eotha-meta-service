// Outfitting (redesign Epic 1): quality grades, the 50% health rule for advanced mechanics, and the
// pricing engine. Pure data and functions; the route is src/routes/ship/index.js. Station capability
// verification (what a dock stocks) is a later ticket and deliberately absent here.
import { createHash } from 'node:crypto';

// --- Quality grades -------------------------------------------------------------------------------------

// The contracts' QualityGrade, in ascending order of quality. A component without a (valid) stored grade
// is BASIC, which is also what every row that predates the column was grandfathered as.
export const QUALITY_GRADES = Object.freeze(['CHEAP', 'BASIC', 'ARTISAN']);
export const DEFAULT_QUALITY = 'BASIC';

export const isQualityGrade = (quality) => QUALITY_GRADES.includes(quality);
export const normalizeQuality = (quality) => (isQualityGrade(quality) ? quality : DEFAULT_QUALITY);
export const qualityRank = (quality) => QUALITY_GRADES.indexOf(normalizeQuality(quality));

// What a grade multiplies: the price of the part and the attributes it delivers.
export const QUALITY_PRICE_MULT = Object.freeze({ CHEAP: 0.6, BASIC: 1.0, ARTISAN: 2.5 });
export const QUALITY_EFFECTIVENESS = Object.freeze({ CHEAP: 0.85, BASIC: 1.0, ARTISAN: 1.18 });

// The attributes a component's quality scales, `higher is better` ones multiplied by the grade's
// effectiveness. Structural values (tiers, masses, berths, hull_tier, sensor_tier) never change with quality.
export const QUALITY_SCALED_ATTRIBUTES = Object.freeze({
  HULL: ['max_hull_hp'],
  SHIELDS: ['max_shield_hp', 'shield_regen_rate'],
  RADAR: ['radar_range_m', 'identification_range_m'],
  CARGO: ['cargo_capacity_m3'],
  STEALTH: ['stealth_rating'],
  WEAPONS: ['weapon_dps', 'weapon_range_m'],
  ENERGY: ['energy_capacity', 'energy_regen_rate'],
  COMMS: ['comms_range_m'],
  ENGINES: ['max_speed_mps'],
  SENSORS: ['sensor_range_m']
});
// A cooldown multiplier is better when lower, so effectiveness divides it.
export const QUALITY_INVERSE_ATTRIBUTES = Object.freeze({ SENSORS: ['sensor_cooldown_mult'] });
// Ceilings no grade can lift an attribute past: Mach 1 for the drive, and stealth below total invisibility.
export const QUALITY_ATTRIBUTE_CEILINGS = Object.freeze({ max_speed_mps: 343, stealth_rating: 0.95 });

// --- The 50% health rule --------------------------------------------------------------------------------

// Below this healthPct a component's advanced (tier-driven) mechanics switch off until it is repaired to
// it again; baseline stats keep scaling linearly with health.
export const ADVANCED_MECHANICS_MIN_HEALTH_PCT = 50;
export const advancedMechanicsActive = (healthPct) => !Number.isFinite(healthPct) || healthPct >= ADVANCED_MECHANICS_MIN_HEALTH_PCT;

// The reserved outfitting capability bits (contracts 1.8.0) and the component whose damage clears each.
// Crew capability bits are NOT gated by component damage (captain's decision), so only these are. Every
// owner is unassigned (null) until a mechanic claims its bit: assigning one is a one-line change here.
export const OUTFITTING_CAPABILITY_BITS = Object.freeze({
  RESERVED_0x20: 0x20,
  RESERVED_0x100: 0x100,
  RESERVED_0x200: 0x200
});
export const OUTFITTING_CAPABILITY_OWNERS = Object.freeze({
  [OUTFITTING_CAPABILITY_BITS.RESERVED_0x20]: null,
  [OUTFITTING_CAPABILITY_BITS.RESERVED_0x100]: null,
  [OUTFITTING_CAPABILITY_BITS.RESERVED_0x200]: null
});

/** `flags` with every outfitting bit whose owning component (`health[type]`, a healthPct) is below 50% cleared. */
export function gateOutfittingCapabilities(flags, health, owners = OUTFITTING_CAPABILITY_OWNERS) {
  let gated = flags;
  for (const [bit, owner] of Object.entries(owners)) {
    if (owner && !advancedMechanicsActive(health[owner])) gated &= ~Number(bit);
  }
  return gated;
}

// --- Standing -------------------------------------------------------------------------------------------

// A pilot's standing with the faction governing the dock sets its band (score ranges from the faction
// design): at or below HOSTILE_MAX_STANDING the pilot is barred from civilian terminals.
export const HOSTILE_MAX_STANDING = -500;
export const UNFRIENDLY_MAX_STANDING = -150;
export const FRIENDLY_MIN_STANDING = 150;
export const TRUSTED_MIN_STANDING = 450;
export const FLYING_COLORS_MIN_STANDING = 500;
export const PARAGON_MIN_STANDING = 800;

export const STANDING_BANDS = Object.freeze({
  HOSTILE: 'HOSTILE', // includes Nemesis (-750 and below)
  UNFRIENDLY: 'UNFRIENDLY',
  NEUTRAL: 'NEUTRAL',
  FRIENDLY: 'FRIENDLY',
  TRUSTED: 'TRUSTED',
  FLYING_COLORS: 'FLYING_COLORS',
  PARAGON: 'PARAGON'
});

// The discount D each band contributes to the price (a negative one is a tariff): Unfriendly +30%, Friendly
// -10%, Trusted -15%, Flying Colors -25%, Paragon -35%. A Hostile pilot is barred, not priced.
export const STANDING_DISCOUNT = Object.freeze({
  HOSTILE: 0,
  UNFRIENDLY: -0.3,
  NEUTRAL: 0,
  FRIENDLY: 0.1,
  TRUSTED: 0.15,
  FLYING_COLORS: 0.25,
  PARAGON: 0.35
});

/**
 * The band of a pilot at `standing` with a dock's governing faction. `flyingColors` is true when the pilot
 * flies that faction's colors; with 500+ standing that outranks Trusted, and Paragon outranks it.
 */
export function standingBand(standing, { flyingColors = false } = {}) {
  if (standing <= HOSTILE_MAX_STANDING) return STANDING_BANDS.HOSTILE;
  if (standing <= UNFRIENDLY_MAX_STANDING) return STANDING_BANDS.UNFRIENDLY;
  if (standing >= PARAGON_MIN_STANDING) return STANDING_BANDS.PARAGON;
  if (flyingColors && standing >= FLYING_COLORS_MIN_STANDING) return STANDING_BANDS.FLYING_COLORS;
  if (standing >= TRUSTED_MIN_STANDING) return STANDING_BANDS.TRUSTED;
  if (standing >= FRIENDLY_MIN_STANDING) return STANDING_BANDS.FRIENDLY;
  return STANDING_BANDS.NEUTRAL;
}

// --- Black market ---------------------------------------------------------------------------------------

// A Hostile pilot is refused at civilian terminals, but a low-sec dock refits them on the black market at
// 2.5x to 3.0x the price (fixed per dock, so the quote does not wander between visits).
export const BLACK_MARKET_MIN_MULT = 2.5;
export const BLACK_MARKET_MAX_MULT = 3.0;

/** The black-market multiplier of the dock `stationId`: deterministic, in [2.5, 3.0], to the cent. */
export function blackMarketMultiplier(stationId) {
  const byte = createHash('sha256').update(`outfit_black_market_v1|${stationId}`).digest()[0];
  const span = BLACK_MARKET_MAX_MULT - BLACK_MARKET_MIN_MULT;
  return Math.round((BLACK_MARKET_MIN_MULT + (span * byte) / 255) * 100) / 100;
}

// --- Pricing --------------------------------------------------------------------------------------------

// Labor on replacing a fitted part with a better grade, as a share of the value of the part replaced.
export const REGRADE_SURCHARGE_RATE = 0.15;
// Compounded discounts never cut more than this off, and no quote falls below the floor.
export const MAX_DISCOUNT = 0.7;
export const PRICE_FLOOR_MIN = 25;
export const PRICE_FLOOR_RATE = 0.25;

/**
 * The universal outfitting price (design-dependency-review, conflict 6):
 *
 *   max(floor, round(qualityBase x wealthMult x (1 - min(0.70, discount)) x hostileMult) + surcharge)
 *
 * `qualityBase` is the list price already weighted by quality grade (BasePrice x M_quality; for a part
 * changing grade the value of the new part less the value of the old one). `basePrice` is the unweighted
 * list price the floor is taken from: max(25 cr, 25% of it). `discount` is the sum of every discount
 * (standing, later perks and quirks; a tariff is negative), capped at 70%. `surcharge` is added after the
 * multipliers and is itself subject to the floor, not to the discounts.
 */
export function outfitPrice({ qualityBase, basePrice = qualityBase, wealthMult = 1, discount = 0, hostileMult = 1, surcharge = 0 }) {
  const floor = Math.max(PRICE_FLOOR_MIN, PRICE_FLOOR_RATE * basePrice);
  const priced = Math.round(qualityBase * wealthMult * (1 - Math.min(MAX_DISCOUNT, discount)) * hostileMult) + surcharge;
  return Math.max(Math.round(floor), priced);
}

/**
 * Prices taking a component from `from` ({ tier, quality }) to `to`, where `tierCost(fromTier, toTier)` is
 * the Basic list price of the tiers between. The new part is worth `M_quality(to) x list(0..to.tier)`, the
 * old one `M_quality(from) x list(0..from.tier)` (list from tier `floorTier`, the lowest the component can
 * sit at), and the quote charges the difference, so laddering up cheaply and then regrading never undercuts
 * buying the grade outright. A better grade over a fitted part adds the labor surcharge: 15% of the old
 * part's value (a Basic part regraded to Artisan: 15% of its Basic value). A lower grade is never quoted
 * (the caller refuses it). Returns `{ price, listPrice, qualityBase, surcharge }`.
 */
export function quoteOutfit({ from, to, tierCost, floorTier = 0, ...modifiers }) {
  const fromValue = QUALITY_PRICE_MULT[normalizeQuality(from.quality)] * tierCost(floorTier, from.tier);
  const toValue = QUALITY_PRICE_MULT[normalizeQuality(to.quality)] * tierCost(floorTier, to.tier);
  const qualityBase = toValue - fromValue;
  const tierSteps = tierCost(from.tier, to.tier);
  // A pure regrade has no tier steps: its list price is the Basic price of the part itself.
  const listPrice = tierSteps > 0 ? tierSteps : tierCost(floorTier, to.tier);
  const regrade = qualityRank(to.quality) > qualityRank(from.quality);
  const surcharge = regrade ? Math.round(REGRADE_SURCHARGE_RATE * fromValue) : 0;
  return { price: outfitPrice({ qualityBase, basePrice: listPrice, surcharge, ...modifiers }), listPrice, qualityBase, surcharge };
}
