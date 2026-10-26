import { computeShipAttributes, freeBerths, hullBudget, totalSubsystemPoints } from '../config/components.js';
import {
  CREW_CAPABILITY,
  CREW_CLASSES,
  CREW_STATUS,
  MAX_ACTIVE_CREW_PER_CLASS,
  MAX_ARREARS_CREDITS,
  MAX_STANDBY_CREW,
  MAX_TOTAL_WAGE_BP,
  MORALE_DECAY_DEFERRED_PAY,
  RANKS,
  STANDBY_TRANSFER_FEE_CREDITS,
  classEffectsView,
  effectiveMoraleMult,
  effectiveWageShareBp,
  maxActiveCrew,
  quirkView
} from '../config/crew.js';
import {
  SETTLEMENT,
  addSeniorityXp,
  moraleAfterLoss,
  moraleBand,
  promotionTerms,
  seniorityXpGain,
  settleUtilization
} from '../config/crew-morale.js';
import { isCovert } from './mission-offer.js';

// Why a ship cannot take a crew member aboard, or a pilot hire one. `code` is the structured reason
// (lowercased, it is also the `error` of a refused request).
export const UNAVAILABLE = Object.freeze({
  INSUFFICIENT_FACTION_REP: 'INSUFFICIENT_FACTION_REP',
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  CLASS_ALREADY_ACTIVE: 'CLASS_ALREADY_ACTIVE',
  HULL_CREW_CAP_REACHED: 'HULL_CREW_CAP_REACHED',
  INSUFFICIENT_FREE_BERTHS: 'INSUFFICIENT_FREE_BERTHS'
});

// The order a refused request reports its reasons in: what the ship cannot take at all before what
// only this crew member lacks.
export const REFUSAL_PRIORITY = Object.freeze([
  UNAVAILABLE.HULL_CREW_CAP_REACHED,
  UNAVAILABLE.INSUFFICIENT_FREE_BERTHS,
  UNAVAILABLE.CLASS_ALREADY_ACTIVE,
  UNAVAILABLE.INSUFFICIENT_FACTION_REP,
  UNAVAILABLE.INSUFFICIENT_CREDITS
]);

/** The reason to refuse with among `reasons` (non-empty): the first in REFUSAL_PRIORITY. */
export const primaryReason = (reasons) =>
  reasons.reduce((best, reason) => (REFUSAL_PRIORITY.indexOf(reason.code) < REFUSAL_PRIORITY.indexOf(best.code) ? reason : best));

// `db` is the Prisma client or an open transaction. Working active and standby crew share payouts;
// morale-zero members earn neither wages nor deferred wage arrears while awaiting resignation.
export const payrollCrewOf = async (db, playerId, ship) =>
  [...ship.crew, ...(await standbyCrewOf(db, playerId))].filter((member) => member.morale > 0);

/**
 * What stops `ship` (lockActiveShip's result) taking aboard one more crew member of `crewClass`, as
 * `{ code, label, ...details }`: a class already aboard, the hull's crew limit, no free berth.
 */
export function boardingReasons(ship, crewClass) {
  const attributes = computeShipAttributes(ship.components, ship.passengersAboard, ship.traits, ship.crew);
  const maxCrew = maxActiveCrew(attributes.hull_tier, ship.traits);
  const capacity = Math.floor(attributes.passenger_capacity);
  const reasons = [];
  if (ship.crew.filter((member) => member.crewClass === crewClass).length >= MAX_ACTIVE_CREW_PER_CLASS) {
    reasons.push({
      code: UNAVAILABLE.CLASS_ALREADY_ACTIVE,
      label: `Active ${CREW_CLASSES[crewClass].name} already aboard (max ${MAX_ACTIVE_CREW_PER_CLASS} per class: dismiss or move to standby first)`,
      crewClass
    });
  }
  if (ship.crew.length >= maxCrew) {
    reasons.push({
      code: UNAVAILABLE.HULL_CREW_CAP_REACHED,
      label: `Hull Tier ${attributes.hull_tier} crew limit reached (${ship.crew.length}/${maxCrew} active crew)`,
      maxCrew,
      activeCrew: ship.crew.length
    });
  }
  if (freeBerths(attributes) < 1) {
    reasons.push({
      code: UNAVAILABLE.INSUFFICIENT_FREE_BERTHS,
      label: `No free life support berths (${capacity}/${capacity} occupied by crew and passengers)`,
      freeBerths: 0
    });
  }
  return reasons;
}

/** The limits the crew lounge shows for `ship`: hull tier, crew slots, berths and standby. */
export function crewLimits(ship) {
  const attributes = computeShipAttributes(ship.components, ship.passengersAboard, ship.traits, ship.crew);
  return {
    hullTier: attributes.hull_tier,
    activeCrew: ship.crew.length,
    maxActiveCrew: maxActiveCrew(attributes.hull_tier, ship.traits),
    passengerCapacity: Math.floor(attributes.passenger_capacity),
    passengersAboard: attributes.passengers_aboard,
    freeBerths: freeBerths(attributes),
    maxStandbyCrew: MAX_STANDBY_CREW,
    standbyTransferFeeCredits: STANDBY_TRANSFER_FEE_CREDITS
  };
}

// `db` is the Prisma client or an open transaction. The crew aboard `shipId`, in the order they were hired.
export const activeCrewOf = (db, shipId) =>
  db.crewMember.findMany({
    where: { spaceshipId: shipId, status: CREW_STATUS.ACTIVE },
    orderBy: [{ hiredAt: 'asc' }, { id: 'asc' }]
  });

// `db` is the Prisma client or an open transaction. The pilot's crew on standby, in the order they were hired.
export const standbyCrewOf = (db, playerId) =>
  db.crewMember.findMany({
    where: { playerId, status: CREW_STATUS.STANDBY },
    orderBy: [{ hiredAt: 'asc' }, { id: 'asc' }]
  });

// `db` is the Prisma client or an open transaction. The ids of the board candidates the pilot's roster
// (active and standby) was hired as; members hired before the id was stored have none.
export const hiredCandidateIdsOf = async (db, playerId) =>
  new Set(
    (await db.crewMember.findMany({ where: { playerId, sourceCandidateId: { not: null } }, select: { sourceCandidateId: true } }))
      .map((member) => member.sourceCandidateId)
  );

const CAPABILITY_NAMES = Object.fromEntries(Object.entries(CREW_CAPABILITY).map(([name, bit]) => [bit, name]));

// The unique capabilities of a member's class, each `{ capability, rank, unlocked, active }`: unlocked
// by rank, active while the member's morale is Nominal or better.
function capabilitiesView(member) {
  const flags = computeShipAttributes([], 0, [], [member]).crew_capability_flags;
  return (CREW_CLASSES[member.crewClass]?.capabilities ?? []).map(([bit, rank]) => ({
    capability: CAPABILITY_NAMES[bit],
    rank,
    unlocked: RANKS.indexOf(member.rank) >= RANKS.indexOf(rank),
    active: (flags & bit) !== 0
  }));
}

/** What the client shows of a crew member; `traits` are the captain's, which move the wage share. */
export function crewMemberView(member, traits = []) {
  return {
    id: member.id,
    name: member.name,
    crewClass: member.crewClass,
    className: CREW_CLASSES[member.crewClass]?.name ?? member.crewClass,
    rank: member.rank,
    quirk: quirkView(member.quirkId),
    status: member.status,
    morale: member.morale,
    moraleBand: moraleBand(member.morale, member.quirkId),
    moraleMult: effectiveMoraleMult(member),
    seniorityXp: member.seniorityXp,
    unutilizedStreak: member.unutilizedStreak,
    unpaidArrearsCredits: member.unpaidArrearsCredits,
    pendingStipendCredits: member.pendingStipendCredits,
    promotion: promotionTerms(member),
    capabilities: capabilitiesView(member),
    homeFactionId: member.homeFactionId,
    hiredAtStationId: member.hiredAtStationId,
    hiredAt: member.hiredAt.toISOString(),
    effects: classEffectsView(member.crewClass, member.rank),
    baseWageShareBp: member.wageShareBp,
    effectiveWageShareBp: effectiveWageShareBp(member.wageShareBp, member.quirkId, traits)
  };
}

/**
 * Splits a payout of `grossCredits` between the pilot and the active `crew` (lockActiveShip's
 * `ship.crew`, read under the pilot's lock, with the captain's `traits`). Each member takes its
 * effective wage share, rounded down; together they take at most MAX_TOTAL_WAGE_BP, each scaled down
 * in proportion when their shares would exceed it. Returns `{ grossCredits, crewShareCredits,
 * netCredits, crewPayouts }`, `crewPayouts` listing what each member took. With `deferred` the pilot
 * keeps the whole payout and the crew take nothing now: `crewShareCredits` is 0, each of `crewPayouts`
 * lists the `deferredCredits` it is owed beside a `shareCredits` of 0, and `deferredCrewShareCredits`
 * is the total owed.
 */
export function deductCrewRevenueShare(crew, traits, grossCredits, { deferred = false } = {}) {
  const shares = crew.map((member) => effectiveWageShareBp(member.wageShareBp, member.quirkId, traits));
  const totalBp = shares.reduce((sum, bp) => sum + bp, 0);
  const cappedBp = Math.min(totalBp, MAX_TOTAL_WAGE_BP);
  const crewPayouts = crew.map((member, i) => ({
    crewId: member.id,
    name: member.name,
    crewClass: member.crewClass,
    wageShareBp: shares[i],
    shareCredits: Number((BigInt(grossCredits) * BigInt(shares[i]) * BigInt(cappedBp)) / (BigInt(totalBp) * 10_000n))
  }));
  const crewShareCredits = crewPayouts.reduce((sum, payout) => sum + payout.shareCredits, 0);
  if (deferred) {
    return {
      grossCredits,
      crewShareCredits: 0,
      netCredits: grossCredits,
      deferredCrewShareCredits: crewShareCredits,
      crewPayouts: crewPayouts.map(({ shareCredits, ...payout }) => ({ ...payout, shareCredits: 0, deferredCredits: shareCredits }))
    };
  }
  return { grossCredits, crewShareCredits, netCredits: grossCredits - crewShareCredits, crewPayouts };
}

// What the utilization predicates read of a mission's signed offer.
export const missionSettlement = (offer) => ({
  kind: SETTLEMENT.MISSION,
  type: offer.type,
  distanceHexes: offer.distance_hexes ?? 0,
  requiredBerths: offer.required_berths ?? 0,
  covert: isCovert(offer)
});

/**
 * Inside the settlement transaction, holding the pilot's lock: records what `settlement` (a mission,
 * ore sale or chart sale) does to the crew. Each active member of `ship.crew` is checked against its
 * class's utilization predicate: a utilized one resets its idle streak, gains morale if the pay was
 * not deferred and, when a mission awarded the Captain `captainXp`, the same seniority XP; an idle one
 * counts a missed settlement and loses morale past its grace. When the pay was `deferred`, every
 * member of `payroll` goes into arrears for its cut (`payout.crewPayouts`) and loses
 * MORALE_DECAY_DEFERRED_PAY morale. Returns `{ crew, effects }`: the active crew as stored now (for the
 * token the caller reissues) and what happened to each member who changed.
 */
export async function recordCrewSettlement(tx, ship, payroll, { settlement, payout, deferred, captainXp = 0 }) {
  // Preserve the payout time across dock consumption; a stale/pre-leg payout cannot waive a new leg.
  const lastCrewPayoutAtMs = BigInt(Date.now());
  await tx.spaceship.update({ where: { id: ship.id }, data: { crewPayoutSinceDock: true, lastCrewPayoutAtMs } });
  Object.assign(ship, { crewPayoutSinceDock: true, lastCrewPayoutAtMs });
  if (payroll.length === 0) return { crew: ship.crew, effects: [] };
  const aboard = new Set(ship.crew.map((member) => member.id));
  const attributes = computeShipAttributes(ship.components, ship.passengersAboard, ship.traits, ship.crew);
  const ctx = {
    weaponsTier: ship.components.find((c) => c.type === 'WEAPONS')?.tier ?? 0,
    subsystemUse: totalSubsystemPoints(ship.components) / hullBudget(attributes.hull_tier, ship.traits, ship.crew),
    activeCrew: ship.crew.length
  };
  const owed = new Map(payout.crewPayouts.map((entry) => [entry.crewId, entry.deferredCredits ?? 0]));
  const effects = [];
  for (const member of payroll) {
    let { morale, unutilizedStreak, seniorityXp, unpaidArrearsCredits } = member;
    const effect = { crewId: member.id, crewClass: member.crewClass, moraleBefore: morale };
    if (aboard.has(member.id)) {
      const used = settleUtilization(member, settlement, ctx, { deferred, traits: ship.traits });
      ({ morale, unutilizedStreak } = used);
      effect.utilized = used.utilized;
      effect.unutilizedStreak = unutilizedStreak;
      if (used.utilized && captainXp > 0) {
        seniorityXp = addSeniorityXp(seniorityXp, seniorityXpGain(member, captainXp));
        effect.seniorityXpGained = seniorityXp - member.seniorityXp;
      }
    }
    const deferredCredits = deferred ? owed.get(member.id) ?? 0 : 0;
    if (deferred) {
      morale = moraleAfterLoss({ ...member, morale }, MORALE_DECAY_DEFERRED_PAY, ship.traits);
      unpaidArrearsCredits = Math.min(MAX_ARREARS_CREDITS, unpaidArrearsCredits + deferredCredits);
      effect.deferredCredits = deferredCredits;
      effect.unpaidArrearsCredits = unpaidArrearsCredits;
    }
    if (morale === member.morale && unutilizedStreak === member.unutilizedStreak && seniorityXp === member.seniorityXp
        && unpaidArrearsCredits === member.unpaidArrearsCredits) continue;
    await tx.crewMember.update({ where: { id: member.id }, data: { morale, unutilizedStreak, seniorityXp, unpaidArrearsCredits } });
    effects.push({ ...effect, morale, moraleBand: moraleBand(morale, member.quirkId) });
  }
  return { crew: await activeCrewOf(tx, ship.id), effects };
}
