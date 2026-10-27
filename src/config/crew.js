// Crew: the berth and hull limits, the classes and what each rank adds to the ship, the wage and
// signing terms, and the twenty personality quirks. Pure data and functions; the database side is
// src/lib/crew.js and the station boards are src/lib/crew-generator.js.
import { traitCrewTerms } from './captain.js';

// The bits of ShipAttributes.crew_capability_flags (eotha-contracts src/crew_capabilities.ts). Only the
// bits the contracts assigned are ever set. No class signs 0x08 (Comms Officer, Transponder Spoof) or
// 0x10 (Smuggler, Stealth Floor) yet: both belong to customs, which is dormant, and 0x20 is unassigned.
export const CREW_CAPABILITY = Object.freeze({
  HOT_CASTOFF: 0x01,
  COLD_DRIFT: 0x02,
  COARSE_GRADE_REVEAL: 0x04,
  HARMONIC_AUTOTRIM: 0x40,
  BELT_CLEARANCE: 0x80
});

// Confirmed passenger_capacity of LIFE_SUPPORT Tiers 1-5; active crew share these berths with passengers.
export const LIFE_SUPPORT_BERTHS_BY_TIER = Object.freeze([3, 6, 12, 22, 50]);
// Most active crew a ship carries, by hull tier (H6_FLEET_CAPTAIN adds a slot).
export const MAX_CREW_BY_HULL_TIER = Object.freeze([1, 2, 3, 5, 7]);
export const MAX_ACTIVE_CREW_PER_CLASS = 1;
export const MAX_STANDBY_CREW = 2;
export const STANDBY_TRANSFER_FEE_CREDITS = 50;

export const RANKS = Object.freeze(['NOVICE', 'ADEPT', 'MASTER']);
// Each crew member's share of every payout, in basis points (100 bp = 1%), before quirk and captain
// terms, and what hiring one costs up front.
export const CREW_WAGE_SHARE_BP = Object.freeze({ NOVICE: 500, ADEPT: 800, MASTER: 1200 });
export const CREW_SIGNING_BONUS_CREDITS = Object.freeze({ NOVICE: 500, ADEPT: 1500, MASTER: 4000 });
// No quirk or captain trait lowers one crew member's share below this, and the crew together never
// take more than MAX_TOTAL_WAGE_BP of a payout.
export const MIN_CREW_WAGE_BP = 250;
export const MAX_TOTAL_WAGE_BP = 5000;
const BP = 10_000;

// A station's board offers this many candidates per window: slots 0 to 2 are standard and the last
// is the hub specialist, always an Adept or a Master.
export const CREW_BOARD_OFFER_COUNT = 4;
export const CREW_BOARD_WINDOW_MS = 30 * 60 * 1000;
export const HUB_SLOT_INDEX = CREW_BOARD_OFFER_COUNT - 1;

// The standing with the station's governing faction a candidate of each rank asks of the pilot before
// hiring: Unfriendly or better for a Novice, Neutral for an Adept, Trusted for a Master.
export const CREW_REP_REQ_SCORE = Object.freeze({ NOVICE: -499, ADEPT: -149, MASTER: 450 });
// An independent station (a Free Port) has no faction to earn standing with: the pilot counts as neutral
// there, and a Master asks only for that neutral standing.
export const INDEPENDENT_STATION_STANDING = 0;
export const INDEPENDENT_STATION_REP_REQ_SCORE = Object.freeze({ ...CREW_REP_REQ_SCORE, MASTER: 0 });

export const INITIAL_CREW_MORALE = 75;
export const MAX_CREW_MORALE = 100;
// Morale bands and the multiplier each puts on a crew member's class modifiers.
export const INSPIRED_MORALE_THRESHOLD = 85;
export const NOMINAL_MORALE_THRESHOLD = 50;
export const DISGRUNTLED_MORALE_THRESHOLD = 25;
export const MORALE_MULT = Object.freeze({ INSPIRED: 1.15, NOMINAL: 1.0, DISGRUNTLED: 0.6, MUTINOUS: 0 });

// What moves morale. A paid, utilized mission lifts it by MORALE_GAIN_UTILIZED_PAID; a crew member left
// unutilized for more than UNUTILIZED_GRACE_MISSIONS missions running loses MORALE_DECAY_UNUTILIZED per
// mission; a deferred payout costs MORALE_DECAY_DEFERRED_PAY and paying the arrears gives back
// MORALE_GAIN_PAY_ARREARS (up to the rested cap).
export const RESTED_MORALE_CAP = 80;
export const MASTER_CHEF_RESTED_MORALE_CAP = 90;
export const MORALE_GAIN_UTILIZED_PAID = 4;
export const UNUTILIZED_GRACE_MISSIONS = 2;
export const MORALE_DECAY_UNUTILIZED = 6;
export const MORALE_DECAY_DEFERRED_PAY = 25;
export const MORALE_GAIN_PAY_ARREARS = 15;
export const SHORE_LEAVE_GRACE_MS = 2_700_000;
export const SHORE_LEAVE_DECAY_INTERVAL_MS = 900_000;
export const SHORE_LEAVE_STATION_GAIN = 15;
export const SHORE_LEAVE_OUTPOST_GAIN = 5;
export const SHORE_LEAVE_COOLDOWN_MS = 900_000;
export const FLIGHT_STIPEND_AFTER_MS = 3_600_000;
// Captain ruling: bound offline/dwell-inclusive consecutive-receipt gaps to two hours per leg.
export const MAX_COUNTED_FLIGHT_LEG_MS = 7_200_000;
export const FLIGHT_STIPEND_CREDITS = Object.freeze({ NOVICE: 40, ADEPT: 80, MASTER: 150 });
export const FLAKY_UNDOCK_LEAVE_CHANCE = 0.10;

// Seniority XP a crew member needs to be promoted into a rank, and the training fee at a station.
export const CREW_TRAINING_XP_REQ = Object.freeze({ ADEPT: 1500, MASTER: 5000 });
export const CREW_TRAINING_FEE_CREDITS = Object.freeze({ ADEPT: 800, MASTER: 2500 });
export const MAX_SENIORITY_XP = 2_147_483_647; // CrewMember.seniorityXp is a 32-bit Int
export const MAX_ARREARS_CREDITS = 2_147_483_647; // so is unpaidArrearsCredits

// The share of MISSION_COOLDOWN_MS an active Doctor of each rank takes off (index 0 Novice).
export const DOCTOR_COOLDOWN_REDUCTION = Object.freeze([0.2, 0.35, 0.5]);

export const CREW_STATUS = Object.freeze({ ACTIVE: 'ACTIVE', STANDBY: 'STANDBY' });

// The factions a candidate calls home: its standing with the pilot gates hiring (CREW_REP_REQ_SCORE).
// Weights are out of 1000.
export const HOME_FACTION_WEIGHTS = Object.freeze([
  Object.freeze(['alpha', 300]),
  Object.freeze(['beta', 300]),
  Object.freeze(['gamma', 200]),
  Object.freeze(['independent', 200])
]);

// Rank odds out of 1000: a standard slot is mostly Novices, the hub specialist never one.
export const STANDARD_RANK_WEIGHTS = Object.freeze([['NOVICE', 650], ['ADEPT', 300], ['MASTER', 50]]);
export const HUB_RANK_WEIGHTS = Object.freeze([['ADEPT', 750], ['MASTER', 250]]);

// What a crew member of each class adds to the ship's signed attributes, by rank (index 0 Novice).
// `pct` is a fractional change to the attribute and `add` an addition, both scaled by the member's
// morale multiplier (effectiveMoraleMult); `juryRigSlots` is the number of selected installed
// components an Engineer may operate one tier higher while at NOMINAL_MORALE_THRESHOLD. `capabilities` lists the CREW_CAPABILITY bits
// the class signs into the ship, each `[bit, rank it unlocks at]` (a higher rank keeps the lower ranks'),
// and `resists` the 0 to 1 attributes (ion_fog_shield_resist, node_interference_resist) it raises by
// rank, scaled by the morale multiplier; both need the member's morale at NOMINAL_MORALE_THRESHOLD or
// better. `perks` are the effects no ship attribute carries, each by rank (the CREW_PERK keys), which
// the meta-service applies where the credit or reputation moves (crewPerk). Chef and Doctor change no
// ship attribute; their effects (morale, cooldowns) are meta-service rules (shoreLeaveRestedCap,
// doctorCooldownReduction).
const pct = (attr, values) => Object.freeze({ attr, pct: Object.freeze(values) });
const add = (attr, values) => Object.freeze({ attr, add: Object.freeze(values) });
const crewClass = (name, effects = [], juryRigSlots = [0, 0, 0], { capabilities = [], resists = {}, perks = {} } = {}) =>
  Object.freeze({
    name,
    effects: Object.freeze(effects),
    juryRigSlots: Object.freeze(juryRigSlots),
    capabilities: Object.freeze(capabilities.map((c) => Object.freeze(c))),
    resists: Object.freeze(resists),
    perks: Object.freeze(Object.fromEntries(Object.entries(perks).map(([perk, values]) => [perk, Object.freeze(values)])))
  });

// The perks a class carries (crewClass `perks`): the Quartermaster's gain on an ore sale, the Diplomat's
// gain on positive reputation and cut to the rival's harm, and the rate the Smuggler's clean covert
// bonus pays at (CLANDESTINE_BASE_BONUS_RATE without one).
export const CREW_PERK = Object.freeze({
  ORE_SALE_BONUS: 'ore_sale_bonus',
  REPUTATION_GAIN_BONUS: 'reputation_gain_bonus',
  RIVAL_HARM_REDUCTION: 'rival_harm_reduction',
  CLANDESTINE_BONUS_RATE: 'clandestine_bonus_rate'
});
// The clean covert bonus an offer signs in clandestine_bonus_credits, as a share of its reward (+25%,
// design-factions §6; the offers the tests sign pay 625 on 2500).
export const CLANDESTINE_BASE_BONUS_RATE = 0.25;

export const CREW_CLASSES = Object.freeze({
  PILOT: crewClass('Pilot', [
    pct('max_speed_mps', [0.08, 0.15, 0.25]),
    pct('docking_time_mult', [-0.15, -0.25, -0.4])
  ], [0, 0, 0], {
    capabilities: [[CREW_CAPABILITY.HOT_CASTOFF, 'ADEPT'], [CREW_CAPABILITY.COLD_DRIFT, 'MASTER']]
  }),
  NAVIGATOR: crewClass('Navigator', [
    pct('radar_range_m', [0.15, 0.3, 0.5]),
    pct('identification_range_m', [0.15, 0.3, 0.5])
  ], [0, 0, 0], {
    capabilities: [[CREW_CAPABILITY.COARSE_GRADE_REVEAL, 'ADEPT']],
    resists: { node_interference_resist: [0.2, 0.35, 0.5] }
  }),
  SCIENCE: crewClass('Science', [
    pct('sensor_cooldown_mult', [-0.12, -0.22, -0.35]),
    pct('sensor_range_m', [0.15, 0.3, 0.5])
  ]),
  ENGINEER: crewClass('Engineer', [
    add('tuning_tolerance_hz', [15, 30, 50]),
    pct('extraction_rate_mult', [0.1, 0.2, 0.35]),
    pct('shield_regen_rate', [0.2, 0.4, 0.65]),
    pct('energy_regen_rate', [0.2, 0.4, 0.65])
  ], [0, 1, 2], {
    capabilities: [[CREW_CAPABILITY.HARMONIC_AUTOTRIM, 'MASTER']],
    resists: { ion_fog_shield_resist: [0.25, 0.5, 0.75] }
  }),
  CHEF: crewClass('Chef'),
  DOCTOR: crewClass('Doctor'),
  GUNNER: crewClass('Gunner', [
    pct('weapon_dps', [0.15, 0.3, 0.5]),
    pct('weapon_range_m', [0.1, 0.2, 0.35])
  ], [0, 0, 0], { capabilities: [[CREW_CAPABILITY.BELT_CLEARANCE, 'ADEPT']] }),
  // The expansion classes (design-crew classes.md 2.1). Their customs effects (inspection chance,
  // consular seals, bribes, the stealth floor) wait for the customs stage and are not applied here.
  QUARTERMASTER: crewClass('Quartermaster', [
    pct('cargo_capacity_m3', [0.1, 0.17, 0.25])
  ], [0, 0, 0], { perks: { [CREW_PERK.ORE_SALE_BONUS]: [0.08, 0.14, 0.2] } }),
  COMMS_OFFICER: crewClass('Comms Officer', [
    pct('comms_range_m', [0.25, 0.4, 0.6]),
    pct('covert_exposure_mult', [-0.12, -0.22, -0.35])
  ]),
  DIPLOMAT: crewClass('Diplomat', [], [0, 0, 0], { perks: {
    [CREW_PERK.REPUTATION_GAIN_BONUS]: [0.15, 0.25, 0.35],
    [CREW_PERK.RIVAL_HARM_REDUCTION]: [0.15, 0.25, 0.4]
  } }),
  SMUGGLER: crewClass('Smuggler', [], [0, 0, 0], { perks: { [CREW_PERK.CLANDESTINE_BONUS_RATE]: [0.32, 0.4, 0.5] } })
});
export const CREW_CLASS_IDS = Object.freeze(Object.keys(CREW_CLASSES));

// Quirks, Q01 to Q20. `weight` is the roll odds out of 1000 (they sum to 1000). `summary` is the whole
// design effect, shown on the board before hiring. The numeric fields are the effects enforced today:
// `wageBp` (added to the rank's share), `signingMult`, `startMorale` (added to the starting morale),
// `stat` (terms added to the morale multiplier: `delta`, only at `rank` and/or from `minMorale`),
// `zeroWhenDisgruntled` and `inspiredAt`; `moraleShift` (added to every morale gain, taken off every
// loss), `xpMult` and `feeMult` (seniority XP earned, promotion fee), `idleGrace` (added to the idle
// missions allowed before morale decays), `idleDecay` (the morale lost per idle mission instead of
// MORALE_DECAY_UNUTILIZED), `shoreLeaveDelta` (added to the morale a dock restores), `enduranceMult`
// (on the flight time before fatigue) and `outpostGain` (the morale an outpost restores instead of
// SHORE_LEAVE_OUTPOST_GAIN). The rest (customs, factions, retirement) act in later phases.
const quirk = (id, key, name, category, weight, summary, effects = {}) =>
  Object.freeze({ id, key, name, category, weight, summary, ...effects });

export const QUIRKS = Object.freeze(Object.fromEntries([
  quirk('Q01', 'GOOD_NATURED', 'Good-Natured', 'POSITIVE', 50,
    '+1 morale on every morale gain and 1 less on every loss', { moraleShift: 1 }),
  quirk('Q02', 'MODEST', 'Modest', 'POSITIVE', 50,
    '-0.5% wage share and -15% signing bonus', { wageBp: -50, signingMult: 0.85 }),
  quirk('Q03', 'QUICK_STUDY', 'Quick Study', 'POSITIVE', 40,
    '+15% seniority XP and -15% promotion fee', { xpMult: 1.15, feeMult: 0.85 }),
  quirk('Q04', 'COOL_HEADED', 'Cool-Headed', 'POSITIVE', 40,
    '+3% class modifiers and -5% customs catch chance', { stat: [{ delta: 0.03 }] }),
  quirk('Q05', 'MERCENARY_MINDED', 'Mercenary', 'NEGATIVE', 50,
    '+0.5% wage share and +15% signing bonus', { wageBp: 50, signingMult: 1.15 }),
  quirk('Q06', 'GROUCHY', 'Grouchy', 'NEGATIVE', 50,
    'Starts at 70 morale; shore leave restores 2 less', { startMorale: -5, shoreLeaveDelta: -2 }),
  quirk('Q07', 'RUSTY', 'Rusty', 'NEGATIVE', 40,
    '-15% seniority XP and +15% promotion fee', { xpMult: 0.85, feeMult: 1.15 }),
  quirk('Q08', 'NERVOUS_TELL', 'Nervous Tell', 'NEGATIVE', 40,
    '+6% customs inspection chance with contraband or operatives aboard; +5% leak risk when Disgruntled'),
  quirk('Q09', 'EAGER', 'Eager', 'CORE', 65,
    '+10% class modifiers, but none at all when Disgruntled (morale below 50)',
    { stat: [{ delta: 0.1 }], zeroWhenDisgruntled: true }),
  quirk('Q10', 'LAZY', 'Lazy', 'CORE', 65,
    '-1.0% wage share and 1 more idle mission before morale decays; -10% class modifiers and -15% seniority XP',
    { wageBp: -100, stat: [{ delta: -0.1 }], xpMult: 0.85, idleGrace: 1 }),
  quirk('Q11', 'AMBITIOUS', 'Ambitious', 'CORE', 55,
    '+35% seniority XP and +5% class modifiers at Master; -9 morale per idle mission past the first; a Master resigns if passed over when the Captain retires',
    { stat: [{ delta: 0.05, rank: 'MASTER' }], xpMult: 1.35, idleGrace: -1, idleDecay: 9 }),
  quirk('Q12', 'FLAKY', 'Flaky', 'CORE', 55,
    '-1.0% wage share and -30% signing bonus; 10% chance to leave at undocking while morale is below 85',
    { wageBp: -100, signingMult: 0.7 }),
  quirk('Q13', 'CHARMING', 'Charming', 'CORE', 55,
    '+6% client mission payouts and -8% customs inspection chance; +1.5% wage share', { wageBp: 150 }),
  quirk('Q14', 'SPARTAN', 'Spartan', 'CORE', 45,
    '+50% shore-leave endurance and +10 morale at outposts; +0.5% wage share and -10% passage payouts with VIPs aboard',
    { wageBp: 50, enduranceMult: 1.5, outpostGain: 10 }),
  quirk('Q15', 'PERFECTIONIST', 'Perfectionist', 'CORE', 40,
    '+12% class modifiers and +10 Hz tuning tolerance when Inspired, which takes 88 morale; -8 morale on a failed or abandoned mission',
    { stat: [{ delta: 0.12, minMorale: 88 }], inspiredAt: 88 }),
  quirk('Q16', 'LOYALIST', 'Faction Loyalist', 'FACTION', 60,
    'For its home faction: +6 morale, +40% seniority XP, +10% class modifiers and +10% reputation gain; against it: -12 morale, capabilities off and double leak risk'),
  quirk('Q17', 'HOME_BOUND', 'Home-Bound', 'FACTION', 55,
    'In home-faction space shore leave restores +25 at stations and +12 at outposts, and rested morale reaches 86; elsewhere +8 and +2, with fatigue 20% faster'),
  quirk('Q18', 'DISCREET', 'Discreet', 'FACTION', 50,
    '-12% covert exposure, -10% customs catch chance and no intel leaks; +1.0% wage share and -15% overt reputation gain', { wageBp: 100 }),
  quirk('Q19', 'BY_THE_BOOK', 'By-the-Book', 'FACTION', 50,
    '-15% customs inspection chance at high-security docks and +10% overt reputation gain; -0.5% wage share; refuses to conceal contraband and loses 8 morale on covert contracts',
    { wageBp: -50 }),
  quirk('Q20', 'SYNDICATE_TIES', 'Underworld Ties', 'FACTION', 45,
    '+12% covert and gamma payouts and -15% customs catch chance; +12% inspection chance at high-security alpha and beta docks and +1.0% wage share', { wageBp: 100 })
].map((q) => [q.id, q])));
export const QUIRK_IDS = Object.freeze(Object.keys(QUIRKS));

export const QUIRK_WEIGHT_TOTAL = 1000;

const isRank = (rank) => RANKS.includes(rank);
const rankIndex = (rank) => RANKS.indexOf(rank);

/** What the client shows of a quirk: the full effect, and the numbers enforced today. */
export function quirkView(quirkId) {
  const q = QUIRKS[quirkId];
  return {
    id: q.id,
    key: q.key,
    name: q.name,
    category: q.category,
    summary: q.summary,
    modifiers: {
      wageShareBp: q.wageBp ?? 0,
      signingBonusPct: Math.round(((q.signingMult ?? 1) - 1) * 100),
      startingMorale: q.startMorale ?? 0,
      classModifier: Math.round((q.stat ?? []).reduce((sum, term) => sum + term.delta, 0) * 100) / 100
    }
  };
}

/**
 * The multiplier a crew member's class modifiers are scaled by: its morale band (Inspired 1.15,
 * Nominal 1.0, Disgruntled 0.6, Mutinous 0) plus the quirk's additive terms, which a member whose band
 * is 0 does not get. Disgruntled is 0 for EAGER, and PERFECTIONIST is only Inspired from 88.
 * `member` carries { rank, morale, quirkId }.
 */
export function effectiveMoraleMult({ rank, morale, quirkId }) {
  const q = QUIRKS[quirkId];
  let band;
  if (morale >= (q?.inspiredAt ?? INSPIRED_MORALE_THRESHOLD)) band = MORALE_MULT.INSPIRED;
  else if (morale >= NOMINAL_MORALE_THRESHOLD) band = MORALE_MULT.NOMINAL;
  else if (morale >= DISGRUNTLED_MORALE_THRESHOLD) band = q?.zeroWhenDisgruntled ? 0 : MORALE_MULT.DISGRUNTLED;
  else band = MORALE_MULT.MUTINOUS;
  if (band === 0) return 0;
  const delta = (q?.stat ?? [])
    .filter((term) => (term.rank === undefined || term.rank === rank) && morale >= (term.minMorale ?? 0))
    .reduce((sum, term) => sum + term.delta, 0);
  return Math.max(0, band + delta);
}

const round6 = (value) => Math.round(value * 1e6) / 1e6;

/**
 * The ship attribute effects of `crew` (active members), as `[attribute, { mult } | { add }]` entries
 * applyShipEffects folds in beside the captain's traits.
 */
export function crewShipEffects(crew = []) {
  return crew.flatMap((member) => {
    const def = CREW_CLASSES[member.crewClass];
    if (!def || !isRank(member.rank)) return [];
    const scale = effectiveMoraleMult(member);
    return def.effects.map((effect) =>
      effect.add
        ? [effect.attr, { add: round6(effect.add[rankIndex(member.rank)] * scale) }]
        : [effect.attr, { mult: round6(1 + effect.pct[rankIndex(member.rank)] * scale) }]);
  });
}

// A crew member promoted to Captain keeps its class: the ship effects of its class at its rank, scaled
// as if at INNATE_MORALE (a captain has no morale, so its quirk's additive class terms apply on top of
// the Nominal band), with no wage share, berth, capability bit or resistance. The Captain carries it as
// `innateClass`, `innateRank` and `quirkId`; computeShipAttributes receives it as the effect id
// innateEffectId builds, next to the captain's trait ids. An innate Engineer also carries the
// components the captain overdrives (`juryRigComponentTypes`, the Phase 3 Engineer rule: see
// innateJuryRigTypes), as the last part of the id.
export const INNATE_MORALE = INITIAL_CREW_MORALE;
const INNATE_PREFIX = 'INNATE:';

export const innateEffectId = ({ innateClass, innateRank, quirkId, juryRigComponentTypes } = {}) => {
  if (!CREW_CLASSES[innateClass] || !isRank(innateRank)) return null;
  const overdriven = innateClass === 'ENGINEER' && Array.isArray(juryRigComponentTypes) ? juryRigComponentTypes.join('+') : '';
  return `${INNATE_PREFIX}${innateClass}:${innateRank}:${quirkId ?? ''}:${overdriven}`;
};

const innateMember = (effectId) => {
  if (!effectId.startsWith(INNATE_PREFIX)) return null;
  const [crewClass, rank, quirkId, overdriven = ''] = effectId.slice(INNATE_PREFIX.length).split(':');
  return CREW_CLASSES[crewClass] && isRank(rank)
    ? { crewClass, rank, quirkId, morale: INNATE_MORALE, juryRigComponentTypes: overdriven ? overdriven.split('+') : [] }
    : null;
};

/** The ship attribute effects of the innate class among `effectIds` (a captain's trait and doctrine ids too). */
export const innateShipEffects = (effectIds = []) => crewShipEffects(effectIds.map(innateMember).filter(Boolean));

export const ENGINEER_JURY_RIG_TYPES = Object.freeze(['ENGINES', 'ENERGY', 'RADAR', 'SHIELDS']);

/** Stored selections belong to the Engineer; standby/morale loss disables effects without erasing them. */
export const engineerJuryRigSlots = (member) => member?.crewClass === 'ENGINEER' && isRank(member.rank)
  ? CREW_CLASSES.ENGINEER.juryRigSlots[rankIndex(member.rank)] : 0;

export function engineerJuryRigTypes(crew = []) {
  const engineer = crew.find((m) => m.crewClass === 'ENGINEER' && m.status !== CREW_STATUS.STANDBY);
  if (!engineer || engineer.morale < NOMINAL_MORALE_THRESHOLD) return new Set();
  const selected = Array.isArray(engineer.juryRigComponentTypes) ? engineer.juryRigComponentTypes : [];
  return new Set([...new Set(selected.filter((type) => ENGINEER_JURY_RIG_TYPES.includes(type)))].slice(0, engineerJuryRigSlots(engineer)));
}

/**
 * The components a promoted Engineer captain overdrives: the Phase 3 Engineer rule applied to the
 * innate rank, so the selection is cut to `engineerJuryRigSlots` (a Master's 2) and, like a crew
 * Engineer's, works at INNATE_MORALE, which is Nominal. It is a set of component types, so it joins an
 * Engineer crew member's: a component is raised one tier at most, never one per source.
 */
export function innateJuryRigTypes(effectIds = []) {
  const types = new Set();
  for (const member of effectIds.map(innateMember)) {
    if (member?.crewClass !== 'ENGINEER') continue;
    const selected = [...new Set(member.juryRigComponentTypes.filter((type) => ENGINEER_JURY_RIG_TYPES.includes(type)))];
    for (const type of selected.slice(0, engineerJuryRigSlots(member))) types.add(type);
  }
  return types;
}

// Whether `member`'s unique capabilities are on: morale at NOMINAL_MORALE_THRESHOLD or better.
const capabilitiesOn = (member) => member.morale >= NOMINAL_MORALE_THRESHOLD;

/**
 * The ShipAttributes.crew_capability_flags `crew` (active members) signs into the ship: the bits of every
 * member whose morale is at least NOMINAL_MORALE_THRESHOLD and whose rank has unlocked them.
 */
export function crewCapabilityFlags(crew = []) {
  let flags = 0;
  for (const member of crew) {
    const def = CREW_CLASSES[member.crewClass];
    if (!def || !isRank(member.rank) || !capabilitiesOn(member)) continue;
    for (const [bit, rank] of def.capabilities) if (rankIndex(member.rank) >= rankIndex(rank)) flags |= bit;
  }
  return flags;
}

/**
 * The 0 to 1 resistances `crew` signs into the ship, `{ ion_fog_shield_resist, node_interference_resist }`:
 * each active member at NOMINAL_MORALE_THRESHOLD or better adds its rank's value scaled by its morale
 * multiplier, together at most 1.
 */
export function crewResists(crew = []) {
  const resists = { ion_fog_shield_resist: 0, node_interference_resist: 0 };
  for (const member of crew) {
    const def = CREW_CLASSES[member.crewClass];
    if (!def || !isRank(member.rank) || !capabilitiesOn(member)) continue;
    for (const [attr, values] of Object.entries(def.resists)) resists[attr] += values[rankIndex(member.rank)] * effectiveMoraleMult(member);
  }
  for (const attr of Object.keys(resists)) resists[attr] = round6(Math.min(1, Math.max(0, resists[attr])));
  return resists;
}

/**
 * The total of `perk` that `crew` (active members) adds, as a fraction: each member's value for its
 * rank less `base`, scaled by its morale multiplier (so a Disgruntled member gives 0.6 of it and a
 * Mutinous one none). `base` is what the perk is without crew, for a rate (CLANDESTINE_BASE_BONUS_RATE).
 */
export function crewPerk(crew = [], perk, base = 0) {
  let total = 0;
  for (const member of crew) {
    const values = CREW_CLASSES[member.crewClass]?.perks[perk];
    if (values && isRank(member.rank)) total += (values[rankIndex(member.rank)] - base) * effectiveMoraleMult(member);
  }
  return round6(total);
}

/** Most active crew a ship of `hullTier` carries when its captain holds `traits`. */
export function maxActiveCrew(hullTier, traits = []) {
  const tier = Math.min(MAX_CREW_BY_HULL_TIER.length, Math.max(1, Math.round(hullTier || 1)));
  return MAX_CREW_BY_HULL_TIER[tier - 1] + traitCrewTerms(traits).crewSlots;
}

/** The wage share, in basis points, a crew member of base share `baseBp` and `quirkId` takes. */
export function effectiveWageShareBp(baseBp, quirkId, traits = []) {
  const shifted = baseBp + (QUIRKS[quirkId]?.wageBp ?? 0);
  return Math.max(MIN_CREW_WAGE_BP, Math.round(shifted * traitCrewTerms(traits).wageMult));
}

/** What hiring a crew member of `rank` and `quirkId` costs a captain holding `traits`. */
export function signingBonusCredits(rank, quirkId, traits = []) {
  return Math.round(CREW_SIGNING_BONUS_CREDITS[rank] * (QUIRKS[quirkId]?.signingMult ?? 1) * traitCrewTerms(traits).signingMult);
}

/** The morale a new crew member of `quirkId` starts at under a captain holding `traits`. */
export function startingMorale(quirkId, traits = []) {
  return Math.min(MAX_CREW_MORALE, INITIAL_CREW_MORALE + (QUIRKS[quirkId]?.startMorale ?? 0) + traitCrewTerms(traits).startMorale);
}

/** The attribute effects of one class and rank, as the board shows them: `[{ attribute, kind, value }]`. */
export function classEffectsView(crewClassId, rank) {
  const def = CREW_CLASSES[crewClassId];
  if (!def || !isRank(rank)) return [];
  const i = rankIndex(rank);
  return [
    ...def.effects.map((e) => (e.add
      ? { attribute: e.attr, kind: 'add', value: e.add[i] }
      : { attribute: e.attr, kind: 'pct', value: e.pct[i] })),
    ...(def.juryRigSlots[i] ? [{ attribute: 'jury_rig_slots', kind: 'add', value: def.juryRigSlots[i] }] : []),
    ...Object.entries(def.perks).map(([perk, values]) => ({ attribute: perk, kind: 'pct', value: values[i] }))
  ];
}
