// Customs (Factions stage F4, design-factions §6): what a capture costs, how damaged components degrade the
// ship, and what the crew do to the engine's customs rolls. Pure data and functions; the database side is
// src/lib/customs.js. The engine rolls the inspection and signs the capture; everything below is the
// meta-service's side of it.
import { CREW_CLASSES, DISGRUNTLED_MORALE_THRESHOLD, NOMINAL_MORALE_THRESHOLD, QUIRKS, RANKS, effectiveMoraleMult } from './crew.js';

const round6 = (value) => Math.round(value * 1e6) / 1e6;
const MINUTE_MS = 60_000;

// --- The bribe (design-factions §6.2) -----------------------------------------------------------------

// A paid bribe saves the mission: full Captain and crew XP, but the sponsor's reputation gain at 75%
// (BRIBE_SAVED_REP_MULTIPLIER) and none of the rival or inspecting-station harm.
export const BRIBE_SAVED_REP_MULTIPLIER = 0.75;

// --- Captures (design-factions §6.3) ------------------------------------------------------------------

// What each capture tier (CustomsCaptureTier) costs. `fineRate` is the share of the mission's offered
// reward fined. `sponsorRepMult` and `stationRepMult` multiply ΔR_base, the reputation the mission would
// have gained (`offer.reputation_change`), as the loss to the sponsor and to the faction governing the
// inspecting station. `moraleLoss` is taken off every working crew member. `lockoutMs` is how long the
// station refuses the pilot (docking, its mission board and its services); tier 1 has none. `damage` lists
// the components hurt, each `[types, min, max]` percentage points of healthPct: tier 2 clamps one of CARGO
// or COMMS; tier 3 breaching charges hit HULL and SHIELDS; tier 4 a firefight HULL, SHIELDS and WEAPONS.
// `detainedCrew` is how many crew members are held for DETENTION_MS.
export const CAPTURE_TIERS = Object.freeze({
  1: Object.freeze({ fineRate: 0.15, sponsorRepMult: 0.6, stationRepMult: 0.6, moraleLoss: 4, lockoutMs: 0, damage: [], detainedCrew: 0 }),
  2: Object.freeze({
    fineRate: 0.25, sponsorRepMult: 0.8, stationRepMult: 1.0, moraleLoss: 8, lockoutMs: 15 * MINUTE_MS,
    damage: [[['CARGO', 'COMMS'], 5, 5]], detainedCrew: 0
  }),
  3: Object.freeze({
    fineRate: 0.3, sponsorRepMult: 0.8, stationRepMult: 1.2, moraleLoss: 12, lockoutMs: 30 * MINUTE_MS,
    damage: [[['HULL'], 15, 25], [['SHIELDS'], 15, 25]], detainedCrew: 0
  }),
  4: Object.freeze({
    fineRate: 0.35, sponsorRepMult: 1.0, stationRepMult: 1.5, moraleLoss: 18, lockoutMs: 30 * MINUTE_MS,
    damage: [[['HULL'], 20, 35], [['SHIELDS'], 20, 35], [['WEAPONS'], 20, 35]], detainedCrew: 1
  })
});
export const isCaptureTier = (tier) => Number.isInteger(tier) && tier in CAPTURE_TIERS;

// A crew member caught in a tier 4 firefight is held this long.
export const DETENTION_MS = 30 * MINUTE_MS;

// The engine signs the capture, so a claim from further ahead than this of our clock is refused.
export const MAX_SEIZURE_FUTURE_SKEW_MS = 60_000;

// --- Component health ---------------------------------------------------------------------------------

// Damage never takes a component below this, so a wrecked subsystem still works at a trickle and a
// repair always has something to restore.
export const MIN_COMPONENT_HEALTH_PCT = 10;
// Repair: credits per missing healthPct point, restoring a component to 100.
export const REPAIR_CREDITS_PER_PCT = 5;

// The attributes each component's healthPct scales (linearly: 60% health, 60% of the value). Tiers, masses,
// berths and cooldown/dissipation multipliers are structural and do not change with wear.
export const HEALTH_SCALED_ATTRIBUTES = Object.freeze({
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

/** The fraction (0 to 1) of its value a component of `healthPct` delivers; a missing or invalid one is whole. */
export const healthFactor = (healthPct) =>
  Number.isFinite(healthPct) ? Math.min(100, Math.max(0, healthPct)) / 100 : 1;

/** The credits repairing a component at `healthPct` costs. */
export const repairCost = (healthPct) => REPAIR_CREDITS_PER_PCT * Math.max(0, 100 - Math.min(100, Math.max(0, healthPct)));

// --- Crew mitigation (design-crew report §6.3, design-factions §8.4) ----------------------------------

// What each crew class takes off the chance customs inspect and catch the ship (M_inspect), by rank (index
// 0 Novice), scaled by the member's morale multiplier. The classes' payload specialities (a Doctor's
// quarantine seal is best against passengers, an Engineer's baffles against cargo) are not modelled: the
// signed attribute holds for whatever the pilot carries.
export const INSPECT_SHIELD = Object.freeze({
  DOCTOR: [0.12, 0.18, 0.25],
  ENGINEER: [0.1, 0.16, 0.22],
  NAVIGATOR: [0.08, 0.13, 0.18],
  SCIENCE: [0.08, 0.13, 0.18],
  PILOT: [0.05, 0.08, 0.12],
  CHEF: [0.05, 0.08, 0.1],
  QUARTERMASTER: [0.1, 0.18, 0.25],
  COMMS_OFFICER: [0.1, 0.18, 0.28],
  DIPLOMAT: [0.12, 0.2, 0.3]
});

// The quirks' flat share of it (by quirk key), unscaled by morale: a nervous crew member is nervous at any
// morale. The site-specific terms (BY_THE_BOOK's high-security discount, SYNDICATE_TIES's high-security
// penalty) cannot be signed into a ship attribute and are not applied.
export const QUIRK_INSPECT_SHIELD = Object.freeze({
  COOL_HEADED: 0.05, CHARMING: 0.08, DISCREET: 0.1, SYNDICATE_TIES: 0.15, NERVOUS_TELL: -0.06
});

// A BY_THE_BOOK member refuses to help conceal anything, so its class shield counts for nothing.
const REFUSES_CONCEALMENT = 'BY_THE_BOOK';

// What each class takes off a bribe demand (η_bribe), by rank, scaled by morale; together at most
// MAX_BRIBE_DISCOUNT (design-factions §8.4: η ∈ [0.05, 0.25]).
export const BRIBE_DISCOUNT = Object.freeze({
  DOCTOR: [0.05, 0.1, 0.15],
  DIPLOMAT: [0.05, 0.1, 0.15],
  SMUGGLER: [0.1, 0.18, 0.25]
});
export const MAX_BRIBE_DISCOUNT = 0.25;

// The customs tip-off a Disgruntled (25 to 49) or Mutinous (1 to 24) member adds to the chance of being
// found (L_leak); NERVOUS_TELL adds more, a LOYALIST flying against its home faction doubles it, and a
// DISCREET member, the C6_SHADOW_BROKER captain or a Master Chef aboard stop it.
export const LEAK_DISGRUNTLED = 0.1;
export const LEAK_MUTINOUS = 0.25;
export const LEAK_NERVOUS_TELL = 0.05;
export const CAPTAIN_INSPECT_SHIELD = Object.freeze({ C5_SMUGGLER_HOLD: 0.18 });
export const NO_LEAK_TRAIT = 'C6_SHADOW_BROKER';

// customs_evasion_mult is 1 - ΣM_inspect + ΣL_leak, held to these bounds (the engine also clamps its
// probabilities, so this only stops the signed attribute running away).
export const EVASION_MULT_RANGE = Object.freeze([0.25, 1.5]);

const rankIndex = (rank) => RANKS.indexOf(rank);
// A member held by customs (detainedUntil in the future, marked `detained` by activeCrewOf) is not aboard to help or talk.
const working = (member) => member.morale > 0 && !member.detained;

function leakOf(member) {
  if (member.morale >= NOMINAL_MORALE_THRESHOLD) return 0;
  const quirk = QUIRKS[member.quirkId];
  if (quirk?.key === 'DISCREET') return 0;
  const base = (member.morale >= DISGRUNTLED_MORALE_THRESHOLD ? LEAK_DISGRUNTLED : LEAK_MUTINOUS)
    + (quirk?.key === 'NERVOUS_TELL' ? LEAK_NERVOUS_TELL : 0);
  return base * (quirk?.key === 'LOYALIST' && member.flyingAgainstHome ? 2 : 1);
}

/**
 * The two customs multipliers `crew` (the active members) and the captain's `traits` sign into the ship:
 * `customs_evasion_mult` (what the engine multiplies P_inspect and P_caught by) and `bribe_cost_mult` (what it
 * multiplies a bribe demand by). Both are 1.0 for a ship with neither.
 */
export function crewCustomsMults(crew = [], traits = []) {
  const members = crew.filter(working);
  let shield = traits.reduce((sum, id) => sum + (CAPTAIN_INSPECT_SHIELD[id] ?? 0), 0);
  let discount = 0;
  for (const member of members) {
    const quirkKey = QUIRKS[member.quirkId]?.key;
    shield += QUIRK_INSPECT_SHIELD[quirkKey] ?? 0;
    const def = CREW_CLASSES[member.crewClass];
    if (!def || rankIndex(member.rank) < 0) continue;
    const scale = effectiveMoraleMult(member);
    if (quirkKey !== REFUSES_CONCEALMENT) shield += (INSPECT_SHIELD[member.crewClass]?.[rankIndex(member.rank)] ?? 0) * scale;
    discount += (BRIBE_DISCOUNT[member.crewClass]?.[rankIndex(member.rank)] ?? 0) * scale;
  }
  const silenced = traits.includes(NO_LEAK_TRAIT)
    || members.some((member) => member.crewClass === 'CHEF' && member.rank === 'MASTER' && member.morale >= NOMINAL_MORALE_THRESHOLD);
  const leak = silenced ? 0 : members.reduce((sum, member) => sum + leakOf(member), 0);
  const [lo, hi] = EVASION_MULT_RANGE;
  return {
    customs_evasion_mult: round6(Math.min(hi, Math.max(lo, 1 - shield + leak))),
    bribe_cost_mult: round6(1 - Math.min(MAX_BRIBE_DISCOUNT, discount))
  };
}
