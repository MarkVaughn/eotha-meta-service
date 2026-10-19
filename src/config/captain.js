// Captain progression: the leveling curve, the XP each verified claim awards and the 18-trait catalog.
// Pure data and functions; the database side is src/lib/captain.js.
export const MAX_CAPTAIN_LEVEL = 10;
export const TOTAL_TRAITS_DEFINED = 18;
// Points already spent in a branch before its Tier II traits, and its Tier III capstone, can be unlocked.
export const TIER_2_BRANCH_PREREQ = 2;
export const TIER_3_BRANCH_PREREQ = 4;
// Retirement (a later phase) reads these; nothing in this phase does.
export const HONORS_RETIRE_MIN_LEVEL = 8;
export const EARLY_DISCHARGE_FEE_CREDITS = 1000;
export const MAX_ACTIVE_LEGACY_DOCTRINES = 2;

// Captain.xp is a 32-bit Int; XP past it is not kept (Level 10 is reached long before).
export const MAX_CAPTAIN_XP = 2_147_483_647;

// Captain XP per verified claim. A mission's XP is set by its signed offer, never by the client:
// passage 100 + 40 x hexes + 10 x berths, research 120 + 50 x hexes, gather 150 + 60 x route hexes
// (origin to source plus source to destination), times SPEED_BONUS_XP_MULT when the claim earned
// the engine's speed bonus. Charts award a flat amount the first time each is registered or claimed.
export const MISSION_XP = Object.freeze({
  MISSION_TYPE_PASSAGE: Object.freeze({ base: 100, perHex: 40, perBerth: 10 }),
  MISSION_TYPE_RESEARCH: Object.freeze({ base: 120, perHex: 50, perBerth: 0 }),
  MISSION_TYPE_GATHER: Object.freeze({ base: 150, perHex: 60, perBerth: 0 })
});
export const SPEED_BONUS_XP_MULT = 1.25;
export const PLANET_CHART_XP = 35;
export const SYSTEM_CHART_XP = 150;

// A gather offer's `distance_hexes` is only origin to destination; its route, which the XP is paid
// on, is what the engine sized the signed time limit from: route x 5 min + 5 min of mining
// (eotha-rtse `gather_duration_limit_ms`).
export const GATHER_DURATION_PER_HEX_MS = 300_000;
export const GATHER_MINING_ALLOWANCE_MS = 300_000;

export function gatherRouteHexes(offer) {
  const route = Math.floor((offer.duration_limit_ms - GATHER_MINING_ALLOWANCE_MS) / GATHER_DURATION_PER_HEX_MS);
  return Number.isFinite(route) ? Math.max(0, route) : 0;
}

// Captain XP for completing `offer` with the verified `claim`: a claim paid above the offer's reward
// earned the speed bonus. A type without an XP row earns nothing.
export function missionXp(offer, claim) {
  const row = MISSION_XP[offer.type];
  if (!row) return 0;
  const hexes = offer.type === 'MISSION_TYPE_GATHER' ? gatherRouteHexes(offer) : offer.distance_hexes;
  const base = row.base + row.perHex * hexes + row.perBerth * offer.required_berths;
  return claim.rewardCredits > offer.reward_credits ? Math.floor(base * SPEED_BONUS_XP_MULT) : base;
}

const roundTo50 = (value) => Math.round(value / 50) * 50;

// Cumulative XP needed to reach `level` (1..MAX_CAPTAIN_LEVEL): round_to_50(180 x (L - 1)^1.75).
export function xpRequiredForLevel(level) {
  return roundTo50(180 * (level - 1) ** 1.75);
}

export const LEVEL_XP = Object.freeze(
  Array.from({ length: MAX_CAPTAIN_LEVEL }, (_, i) => xpRequiredForLevel(i + 1))
);

// The level `xp` has reached, never above the cap.
export function levelForXp(xp) {
  let level = 1;
  while (level < MAX_CAPTAIN_LEVEL && xp >= LEVEL_XP[level]) level++;
  return level;
}

// One trait point per level from 2 to MAX_CAPTAIN_LEVEL.
export const traitPointsForLevel = (level) => Math.max(0, Math.min(level, MAX_CAPTAIN_LEVEL) - 1);

export const BRANCHES = Object.freeze(['HELMSMAN', 'ASTROGATION', 'COMMAND']);

// `ship` lists the ship attribute effects computeShipAttributes folds in (`mult` multiplies, `add`
// adds); `hullBudgetBonus` raises the hull subsystem budget. A trait with neither acts in meta-service
// systems of later phases (payouts, crew, factions); its effect is described in `summary` only.
const trait = (id, name, branch, tier, summary, effects = {}) =>
  Object.freeze({ id, name, branch, tier, summary, ship: Object.freeze(effects.ship ?? {}), hullBudgetBonus: effects.hullBudgetBonus ?? 0 });

export const TRAITS = Object.freeze(Object.fromEntries([
  trait('H1_TRIM_THRUSTERS', 'Trim Thrusters', 'HELMSMAN', 1, '+8% max speed',
    { ship: { max_speed_mps: { mult: 1.08 } } }),
  trait('H2_HARBOR_PILOT', 'Harbor Pilot', 'HELMSMAN', 1, '-20% docking and undocking duration',
    { ship: { docking_time_mult: { mult: 0.8 } } }),
  trait('H3_BULKHEAD_PACKING', 'Bulkhead Packing', 'HELMSMAN', 1, '+15% cargo capacity',
    { ship: { cargo_capacity_m3: { mult: 1.15 } } }),
  trait('H4_MODULAR_CABINS', 'Modular Cabins', 'HELMSMAN', 2, '+2 passenger berths',
    { ship: { passenger_capacity: { add: 2 } } }),
  trait('H5_DEAD_RECKONING', 'Dead Reckoning', 'HELMSMAN', 2, '+15% mission time limits; speed bonus threshold 55%'),
  trait('H6_FLEET_CAPTAIN', 'Fleet Quartermaster', 'HELMSMAN', 3, '+1 hull subsystem budget point and +1 active crew slot',
    { hullBudgetBonus: 1 }),
  trait('S1_LONG_BASELINE', 'Long-Baseline Array', 'ASTROGATION', 1, '+20% radar and identification range',
    { ship: { radar_range_m: { mult: 1.2 }, identification_range_m: { mult: 1.2 } } }),
  trait('S2_PULSE_CYCLING', 'Pulse Cycling', 'ASTROGATION', 1, '-15% sensor cooldown and +20% sensor range',
    { ship: { sensor_cooldown_mult: { mult: 0.85 }, sensor_range_m: { mult: 1.2 } } }),
  trait('S3_RESONANCE_EAR', 'Resonance Ear', 'ASTROGATION', 1, '+25 Hz tuning tolerance and +10% extraction rate',
    { ship: { tuning_tolerance_hz: { add: 25 }, extraction_rate_mult: { mult: 1.1 } } }),
  trait('S4_DEEP_SURVEYOR', 'Deep Surveyor', 'ASTROGATION', 2, '+25% research mission and chart sale payouts'),
  trait('S5_PROSPECTOR_EYE', "Prospector's Eye", 'ASTROGATION', 2, '+15% gather mission and +10% ore sale payouts'),
  trait('S6_ASTROGATOR_PRIME', 'Astrogator Prime', 'ASTROGATION', 3, '+1 research or gather mission slot and -35% station mission cooldown'),
  trait('C1_HARD_BARGAINER', 'Hard Bargainer', 'COMMAND', 1, '-15% crew wage shares and -25% signing bonuses'),
  trait('C2_SHORE_CONTACTS', 'Shore Contacts', 'COMMAND', 1, '+10 starting crew morale and -25% morale decay'),
  trait('C3_COLD_RUNNING', 'Cold Running', 'COMMAND', 1, '+0.15 stealth rating',
    { ship: { stealth_rating: { add: 0.15 } } }),
  trait('C4_FACTION_ENVOY', 'Faction Envoy', 'COMMAND', 2, '+25% overt reputation gains and -20% rival reputation losses'),
  trait('C5_SMUGGLER_HOLD', "Smuggler's Compartment", 'COMMAND', 2, '-18% inspection detection; shields 10 m3 or 1 passenger'),
  trait('C6_SHADOW_BROKER', 'Shadow Broker', 'COMMAND', 3, '+20% covert payouts, frontier Master hires, no crew intel leaks')
].map((t) => [t.id, t])));

export const TRAIT_IDS = Object.freeze(Object.keys(TRAITS));

// Trait ids from a stored `unlockedTraits` value, unknown or repeated entries dropped.
export function knownTraits(value) {
  return Array.isArray(value) ? [...new Set(value.filter((id) => Object.hasOwn(TRAITS, id)))] : [];
}

export const pointsInBranch = (traitIds, branch) => traitIds.filter((id) => TRAITS[id]?.branch === branch).length;

// Points that must already be spent in the trait's branch before it can be unlocked.
export const requiredPointsInBranch = (tier) => (tier >= 3 ? TIER_3_BRANCH_PREREQ : tier === 2 ? TIER_2_BRANCH_PREREQ : 0);

// Why a captain at `level` holding `traitIds` cannot unlock `traitId`, as `{ code, ...details }`, or
// null when it can.
export function traitUnlockRefusal(traitId, { level, traitIds }) {
  const t = TRAITS[traitId];
  if (!t) return { code: 'unknown_trait' };
  if (traitIds.includes(traitId)) return { code: 'trait_already_unlocked' };
  const required = requiredPointsInBranch(t.tier);
  const current = pointsInBranch(traitIds, t.branch);
  if (current < required) return { code: 'prerequisite_not_met', requiredPointsInBranch: required, currentPoints: current };
  const available = traitPointsForLevel(level) - traitIds.length;
  if (available < 1) return { code: 'no_trait_points', traitPointsAvailable: Math.max(0, available) };
  return null;
}

// The hull subsystem budget points the traits add.
export const traitHullBudgetBonus = (traitIds) => traitIds.reduce((sum, id) => sum + (TRAITS[id]?.hullBudgetBonus ?? 0), 0);

// Ceilings on trait-raised attributes: Mach 1 is the engine's top speed, and stealth is a fraction.
const ATTRIBUTE_CEILINGS = { max_speed_mps: 343, stealth_rating: 1 };

// Trait arithmetic is rounded to this many decimals so 0.8 + 0.15 signs as 0.95.
const round6 = (value) => Math.round(value * 1e6) / 1e6;

// Folds the traits' ship effects into `attributes` (mutated and returned), multipliers before
// additions so an addition is never scaled.
export function applyTraitEffects(attributes, traitIds) {
  const effects = traitIds.flatMap((id) => Object.entries(TRAITS[id]?.ship ?? {}));
  const touched = new Set();
  for (const [attr, { mult }] of effects) {
    if (mult !== undefined) { attributes[attr] *= mult; touched.add(attr); }
  }
  for (const [attr, { add }] of effects) {
    if (add !== undefined) { attributes[attr] += add; touched.add(attr); }
  }
  for (const attr of touched) {
    attributes[attr] = round6(Math.min(attributes[attr], ATTRIBUTE_CEILINGS[attr] ?? Infinity));
  }
  return attributes;
}
