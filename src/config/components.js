export const COMPONENT_TYPES = [
  'HULL', 'RADAR', 'CARGO', 'STEALTH', 'SHIELDS', 'WEAPONS', 'ENERGY', 'COMMS', 'ENGINES', 'LIFE_SUPPORT', 'SENSORS'
];

// Essential components have a minimum tier of 1 (cannot be unequipped); optional
// components may be set to Tier 0 (unequipped, costing 0 hull budget points).
export const ESSENTIAL_COMPONENTS = ['HULL', 'ENGINES', 'ENERGY', 'RADAR', 'LIFE_SUPPORT', 'SENSORS'];
export const OPTIONAL_COMPONENTS = ['SHIELDS', 'WEAPONS', 'CARGO', 'STEALTH', 'COMMS'];

export const MIN_TIER = 1;
export const MAX_TIER = 5;

// Credits charged to reach a tier from the one below it, for every component type.
// Upgrading across several tiers costs the sum of each step (e.g. 1 -> 3 = 750 + 2000).
// Design assumption: a single flat table, not per-component pricing.
export const TIER_UPGRADE_COST = { 1: 250, 2: 750, 3: 2000, 4: 5000, 5: 12000 };

export function upgradeCost(fromTier, toTier) {
  let cost = 0;
  for (let tier = fromTier + 1; tier <= toTier; tier++) cost += TIER_UPGRADE_COST[tier];
  return cost;
}

// Nominal/baseline values used for optional components at Tier 0 (unequipped);
// any attribute not listed here defaults to 0 when its component is Tier 0.
const ZERO_TIER_OVERRIDES = {
  signature_dissipation_rate: 1.0,
  sensor_cooldown_mult: 1.0
};

// Attribute values indexed by tier (index 0 = Tier 1)
const TIER_TABLE = {
  HULL: {
    max_hull_hp: [100, 250, 500, 1000, 2000],
    dry_mass_kg: [1000, 1500, 2200, 3000, 4000]
  },
  SHIELDS: {
    max_shield_hp: [50, 120, 250, 500, 1000],
    shield_regen_rate: [5, 10, 20, 35, 50]
  },
  RADAR: {
    radar_range_m: [500, 1000, 1800, 2500, 4000],
    identification_range_m: [150, 350, 700, 1100, 2000]
  },
  CARGO: { cargo_capacity_m3: [20.0, 40.0, 80.0, 160.0, 320.0] },
  STEALTH: {
    stealth_rating: [0.0, 0.2, 0.4, 0.6, 0.8],
    signature_dissipation_rate: [1.0, 1.25, 1.5, 1.8, 2.2]
  },
  WEAPONS: {
    weapon_dps: [10, 25, 50, 100, 200],
    weapon_range_m: [300, 450, 600, 800, 1000]
  },
  ENERGY: {
    energy_capacity: [100, 200, 400, 800, 1500],
    energy_regen_rate: [10, 20, 35, 50, 75]
  },
  COMMS: { comms_range_m: [1000, 2500, 5000, 10000, 25000] },
  ENGINES: { max_speed_mps: [20, 35, 50, 75, 100] },
  LIFE_SUPPORT: { passenger_capacity: [2, 5, 10, 20, 50] },
  SENSORS: {
    sensor_range_m: [1500, 3000, 4500, 6000, 7500],
    sensor_cooldown_mult: [1.0, 0.85, 0.7, 0.55, 0.4],
    sensor_tier: [1, 2, 3, 4, 5]
  }
};

export function isValidTier(tier) {
  return Number.isInteger(tier) && tier >= 0 && tier <= MAX_TIER;
}

export function defaultComponents() {
  const defaultTiers = {
    HULL: 1, ENGINES: 1, ENERGY: 1, RADAR: 1, LIFE_SUPPORT: 1, SENSORS: 1, CARGO: 1,
    SHIELDS: 0, WEAPONS: 0, STEALTH: 0, COMMS: 0
  };
  return COMPONENT_TYPES.map((type) => ({ type, tier: defaultTiers[type], healthPct: 100 }));
}

// Hull tier caps the combined tier points of all other installed subsystems.
// Explicit table (not derived from the component count) so adding a component cannot
// silently change balance; Tier 1 fits the default loadout (6 Tier 1 subsystems).
const HULL_BUDGETS = [6, 10, 18, 27, 36];

export function hullBudget(hullTier) {
  const tier = Math.min(5, Math.max(1, Math.round(hullTier || 1)));
  return HULL_BUDGETS[tier - 1];
}

export function totalSubsystemPoints(components = []) {
  return components
    .filter((c) => COMPONENT_TYPES.includes(c?.type) && c.type !== 'HULL')
    .reduce((sum, c) => sum + (Number.isInteger(c.tier) ? c.tier : 0), 0);
}

/**
 * Deterministically derive ship attributes from a list of `{ type, tier }`
 * components. Missing components (and invalid tiers) default to Tier 1.
 */
export function computeShipAttributes(components = []) {
  const tiers = {};
  for (const c of components) {
    if (COMPONENT_TYPES.includes(c?.type)) tiers[c.type] = c.tier;
  }

  const attributes = {};
  for (const type of COMPONENT_TYPES) {
    const floor = OPTIONAL_COMPONENTS.includes(type) ? 0 : MIN_TIER;
    const raw = tiers[type];
    const tier = Number.isInteger(raw) && raw >= floor && raw <= MAX_TIER ? raw : MIN_TIER;
    for (const [attr, values] of Object.entries(TIER_TABLE[type])) {
      attributes[attr] = tier === 0 ? (ZERO_TIER_OVERRIDES[attr] ?? 0) : values[tier - 1];
    }
  }
  return attributes;
}
