export const COMPONENT_TYPES = [
  'HULL', 'RADAR', 'CARGO', 'STEALTH', 'SHIELDS', 'WEAPONS', 'ENERGY', 'COMMS', 'ENGINES'
];

export const MIN_TIER = 1;
export const MAX_TIER = 5;

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
  CARGO: { cargo_capacity_m3: [10, 25, 50, 100, 200] },
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
  ENGINES: { max_speed_mps: [20, 35, 50, 75, 100] }
};

export function isValidTier(tier) {
  return Number.isInteger(tier) && tier >= MIN_TIER && tier <= MAX_TIER;
}

export function defaultComponents() {
  return COMPONENT_TYPES.map((type) => ({ type, tier: MIN_TIER, healthPct: 100 }));
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
    const tier = isValidTier(tiers[type]) ? tiers[type] : MIN_TIER;
    for (const [attr, values] of Object.entries(TIER_TABLE[type])) {
      attributes[attr] = values[tier - 1];
    }
  }
  return attributes;
}
