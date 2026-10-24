import { computeShipAttributes, freeBerths } from '../config/components.js';
import {
  CREW_CLASSES,
  CREW_STATUS,
  MAX_ACTIVE_CREW_PER_CLASS,
  MAX_STANDBY_CREW,
  MAX_TOTAL_WAGE_BP,
  STANDBY_TRANSFER_FEE_CREDITS,
  classEffectsView,
  effectiveWageShareBp,
  maxActiveCrew,
  quirkView
} from '../config/crew.js';

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

// `db` is the Prisma client or an open transaction. Everyone on the pilot's payroll: the crew aboard
// `ship` plus the crew on standby, who still take their share of a payout.
export const payrollCrewOf = async (db, playerId, ship) => [...ship.crew, ...(await standbyCrewOf(db, playerId))];

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
 * netCredits, crewPayouts }`, `crewPayouts` listing what each member took.
 */
export function deductCrewRevenueShare(crew, traits, grossCredits) {
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
  return { grossCredits, crewShareCredits, netCredits: grossCredits - crewShareCredits, crewPayouts };
}
