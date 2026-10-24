// Crew morale, utilization, seniority and promotion: the rules that move a crew member's morale and
// rank. Pure functions over `member` rows ({ crewClass, rank, morale, quirkId, ... }); the database
// side is src/lib/crew.js. The constants are in src/config/crew.js.
import { traitCrewTerms } from './captain.js';
import {
  CREW_TRAINING_FEE_CREDITS,
  CREW_TRAINING_XP_REQ,
  DISGRUNTLED_MORALE_THRESHOLD,
  DOCTOR_COOLDOWN_REDUCTION,
  INSPIRED_MORALE_THRESHOLD,
  MASTER_CHEF_RESTED_MORALE_CAP,
  MAX_CREW_MORALE,
  MAX_SENIORITY_XP,
  MORALE_DECAY_UNUTILIZED,
  MORALE_GAIN_UTILIZED_PAID,
  NOMINAL_MORALE_THRESHOLD,
  QUIRKS,
  RANKS,
  RESTED_MORALE_CAP,
  UNUTILIZED_GRACE_MISSIONS
} from './crew.js';

export const MORALE_BANDS = Object.freeze({
  INSPIRED: 'INSPIRED',
  NOMINAL: 'NOMINAL',
  DISGRUNTLED: 'DISGRUNTLED',
  MUTINOUS: 'MUTINOUS',
  RESIGNED: 'RESIGNED'
});

/** The band a member of `quirkId` at `morale` is in (PERFECTIONIST is Inspired from 88, not 85). */
export function moraleBand(morale, quirkId) {
  if (morale >= (QUIRKS[quirkId]?.inspiredAt ?? INSPIRED_MORALE_THRESHOLD)) return MORALE_BANDS.INSPIRED;
  if (morale >= NOMINAL_MORALE_THRESHOLD) return MORALE_BANDS.NOMINAL;
  if (morale >= DISGRUNTLED_MORALE_THRESHOLD) return MORALE_BANDS.DISGRUNTLED;
  return morale > 0 ? MORALE_BANDS.MUTINOUS : MORALE_BANDS.RESIGNED;
}

const clampMorale = (morale) => Math.min(MAX_CREW_MORALE, Math.max(0, morale));

/** `morale` after a gain of `raw`: the member's quirk adds to every gain (GOOD_NATURED +1). */
export const moraleAfterGain = (member, raw) => clampMorale(member.morale + raw + (QUIRKS[member.quirkId]?.moraleShift ?? 0));

/**
 * `morale` after a loss of `raw`: the captain's traits scale it (C2_SHORE_CONTACTS x0.75) and the
 * quirk takes a point off it (GOOD_NATURED), but a loss is never less than 1.
 */
export function moraleAfterLoss(member, raw, traits = []) {
  const loss = Math.max(1, Math.round(raw * traitCrewTerms(traits).moraleDecayMult) - (QUIRKS[member.quirkId]?.moraleShift ?? 0));
  return clampMorale(member.morale - loss);
}

/**
 * `morale` after a gain of `raw` that stops at `cap`: a member already at or above the cap keeps what
 * they have, and the quirk's gain bonus counts.
 */
export function moraleAfterCappedGain(member, raw, cap) {
  if (member.morale >= cap) return member.morale;
  return Math.min(cap, moraleAfterGain(member, raw));
}

// What a settlement is, for the utilization predicates: a mission (`{ kind, type, distanceHexes,
// requiredBerths, covert }`, from its signed offer), a cargo sale (an ore sale) or a chart sale
// (`{ kind, chart: 'PLANET' | 'SYSTEM' }`).
export const SETTLEMENT = Object.freeze({
  MISSION: 'MISSION',
  CARGO_SALE: 'CARGO_SALE',
  CHART_SALE: 'CHART_SALE'
});

const isMission = (settlement) => settlement.kind === SETTLEMENT.MISSION;
const missionTypeIs = (settlement, type) => isMission(settlement) && settlement.type === type;
const berths = (settlement) => (isMission(settlement) ? settlement.requiredBerths : 0);

// Each class's utilization predicate: whether the settlement used the member's skills. `ctx` is
// { weaponsTier, subsystemUse (installed subsystem points / hull budget), activeCrew }. Where the
// design asks about a system's security or nebula, or about faction enforcement, the meta-service has
// no data to answer from, so those clauses are not evaluated.
const UTILIZED_BY = Object.freeze({
  PILOT: (s) => isMission(s) && s.distanceHexes >= 1,
  NAVIGATOR: (s) => (isMission(s) && (s.distanceHexes >= 2 || s.covert))
    || (s.kind === SETTLEMENT.CHART_SALE && s.chart === 'SYSTEM'),
  SCIENCE: (s) => missionTypeIs(s, 'MISSION_TYPE_RESEARCH') || s.kind === SETTLEMENT.CHART_SALE,
  ENGINEER: (s, ctx) => missionTypeIs(s, 'MISSION_TYPE_GATHER') || s.kind === SETTLEMENT.CARGO_SALE || ctx.subsystemUse >= 0.8,
  CHEF: (s, ctx) => berths(s) >= 1 || ctx.activeCrew >= 2,
  DOCTOR: (s) => berths(s) >= 1 || (isMission(s) && s.covert),
  GUNNER: (s, ctx) => (missionTypeIs(s, 'MISSION_TYPE_GATHER') || s.kind === SETTLEMENT.CARGO_SALE) && ctx.weaponsTier >= 1
});

/** Whether `settlement` used the skills of a `crewClass` member. */
export const isUtilized = (crewClass, settlement, ctx) => Boolean(UTILIZED_BY[crewClass]?.(settlement, ctx));

/**
 * What a settlement does to one active crew member: `{ utilized, morale, unutilizedStreak }`. A utilized
 * member resets the idle streak and, paid in full, gains MORALE_GAIN_UTILIZED_PAID (up to 100, not the
 * rested cap). One that was not used adds to the streak and, past the quirk's grace (LAZY one more,
 * AMBITIOUS one fewer), loses MORALE_DECAY_UNUTILIZED (AMBITIOUS 9) per settlement. `deferred` means the
 * pay was deferred, so a utilized member gains nothing.
 */
export function settleUtilization(member, settlement, ctx, { deferred, traits }) {
  const utilized = isUtilized(member.crewClass, settlement, ctx);
  if (utilized) {
    return {
      utilized,
      unutilizedStreak: 0,
      morale: deferred ? member.morale : moraleAfterGain(member, MORALE_GAIN_UTILIZED_PAID)
    };
  }
  const quirk = QUIRKS[member.quirkId];
  const unutilizedStreak = member.unutilizedStreak + 1;
  const grace = UNUTILIZED_GRACE_MISSIONS + (quirk?.idleGrace ?? 0);
  return {
    utilized,
    unutilizedStreak,
    morale: unutilizedStreak > grace ? moraleAfterLoss(member, quirk?.idleDecay ?? MORALE_DECAY_UNUTILIZED, traits) : member.morale
  };
}

/** The seniority XP a utilized member earns from a mission that awarded the Captain `captainXp`. */
export const seniorityXpGain = (member, captainXp) => Math.round(captainXp * (QUIRKS[member.quirkId]?.xpMult ?? 1));

/** `xp` plus `gain`, never beyond what the column holds. */
export const addSeniorityXp = (xp, gain) => Math.min(MAX_SENIORITY_XP, xp + gain);

/** The rank above `rank`, or null for a Master. */
export const nextRank = (rank) => RANKS[RANKS.indexOf(rank) + 1] ?? null;

/** What promoting `member` into the next rank costs at a station lounge (the quirk moves the fee), or null. */
export function promotionTerms(member) {
  const to = nextRank(member.rank);
  if (!to) return null;
  return {
    toRank: to,
    requiredXp: CREW_TRAINING_XP_REQ[to],
    feeCredits: Math.round(CREW_TRAINING_FEE_CREDITS[to] * (QUIRKS[member.quirkId]?.feeMult ?? 1))
  };
}

/**
 * Why `member` cannot be promoted now, as `{ code, ...details }`, or null: already a Master, not enough
 * Seniority XP yet, or Mutinous or worse, who refuse.
 */
export function promotionRefusal(member) {
  const terms = promotionTerms(member);
  if (!terms) return { code: 'already_master' };
  if (member.morale < DISGRUNTLED_MORALE_THRESHOLD) return { code: 'crew_refuses_promotion', morale: member.morale };
  if (member.seniorityXp < terms.requiredXp) {
    return { code: 'insufficient_seniority_xp', requiredXp: terms.requiredXp, seniorityXp: member.seniorityXp };
  }
  return null;
}

const hasMasterChef = (crew) => crew.some((member) => member.crewClass === 'CHEF' && member.rank === 'MASTER' && member.morale >= NOMINAL_MORALE_THRESHOLD);

/** The morale shore leave and paid arrears bring the crew up to: 80, or 90 with an active Master Chef (Captain's Table). */
export const restedMoraleCap = (crew) => (hasMasterChef(crew) ? MASTER_CHEF_RESTED_MORALE_CAP : RESTED_MORALE_CAP);

/** The share of the station mission cooldown an active Doctor (at Nominal morale or better) takes off, 0 to 0.5. */
export function doctorCooldownReduction(crew) {
  return crew
    .filter((member) => member.crewClass === 'DOCTOR' && member.morale >= NOMINAL_MORALE_THRESHOLD && RANKS.includes(member.rank))
    .reduce((best, member) => Math.max(best, DOCTOR_COOLDOWN_REDUCTION[RANKS.indexOf(member.rank)]), 0);
}
