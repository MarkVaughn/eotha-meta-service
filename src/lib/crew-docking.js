import { createHash } from 'node:crypto';
import {
  FLAKY_UNDOCK_LEAVE_CHANCE, FLIGHT_STIPEND_AFTER_MS, FLIGHT_STIPEND_CREDITS,
  MAX_ARREARS_CREDITS, MORALE_DECAY_DEFERRED_PAY, MORALE_GAIN_PAY_ARREARS,
  NOMINAL_MORALE_THRESHOLD, QUIRKS, RANKS, SHORE_LEAVE_COOLDOWN_MS, SHORE_LEAVE_DECAY_INTERVAL_MS,
  SHORE_LEAVE_GRACE_MS, SHORE_LEAVE_OUTPOST_GAIN, SHORE_LEAVE_STATION_GAIN
} from '../config/crew.js';
import { moraleAfterCappedGain, moraleAfterLoss, restedMoraleCap } from '../config/crew-morale.js';
import { activeCrewOf } from './crew.js';

export const fatigueIntervals = (ms, member = {}) => Math.floor(Math.max(0,
  ms - SHORE_LEAVE_GRACE_MS * (QUIRKS[member.quirkId]?.enduranceMult ?? 1)) / SHORE_LEAVE_DECAY_INTERVAL_MS);

// Outpost rules are kept here for the future signed dock-kind protocol. No route accepts an unsigned
// kind: the current captain ruling treats EVERY signed dock as a station.
export function shoreLeaveTerms(crew, kind = 'STATION', member = {}) {
  const galley = crew.some((m) => m.crewClass === 'CHEF' && RANKS.indexOf(m.rank) >= 1 && m.morale >= NOMINAL_MORALE_THRESHOLD);
  const quirk = QUIRKS[member.quirkId];
  const stationLeave = kind === 'STATION' || galley;
  return {
    gain: (stationLeave ? SHORE_LEAVE_STATION_GAIN : quirk?.outpostGain ?? SHORE_LEAVE_OUTPOST_GAIN) + (quirk?.shoreLeaveDelta ?? 0),
    flightMult: stationLeave ? 0 : 0.5,
    cap: restedMoraleCap(crew)
  };
}

/** Stable 10% roll: UUID strings and the decimal 15-minute window, concatenated in plan order. */
export function flakyDeparture(member, stationId, nowMs) {
  if (member.quirkId !== 'Q12' || member.morale >= 85) return false;
  const digest = createHash('sha256').update(`flaky_undock_v1${member.id}${stationId}${Math.floor(nowMs / 900_000)}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000 < FLAKY_UNDOCK_LEAVE_CHANCE;
}

// Phase 3 evaluates departure only at mission acceptance, NOT at a mining-only undock. The latter
// needs a signed undock event from contracts/engine; an unsigned client notification is not trusted.
export async function recordFlakyDeparture(tx, ship, receipt, nowMs) {
  const departed = ship.crew.filter((m) => flakyDeparture(m, receipt.dockedEntityId, nowMs));
  if (departed.length) await tx.crewMember.deleteMany({ where: { id: { in: departed.map((m) => m.id) } } });
  return { ship: { ...ship, crew: ship.crew.filter((m) => !departed.includes(m)) }, departed: departed.map((m) => m.id) };
}

/**
 * Holding the pilot lock, after verifying the receipt. A newer dock is consumed ONCE across every
 * route, even if a fresh nonce/issuedAt is used for the same docking. Old/equal docking times are
 * no-ops. First receipt establishes the flight baseline. Per captain ruling, time BETWEEN signed
 * docks counts as flight (including dwell, until the protocol gains an undock timestamp).
 * `payResignedArrears` is explicit consent to rescue morale-zero crew at 2x debt, paid atomically per
 * member when affordable; otherwise they leave before station recovery can resurrect them.
 */
export async function recordCrewDock(tx, ship, receipt, { payResignedArrears = false } = {}) {
  const at = BigInt(receipt.dockedAtMs);
  if (ship.lastCrewDockedAtMs != null && at <= ship.lastCrewDockedAtMs) return { ship, docking: { applied: false } };
  const elapsed = ship.lastCrewDockedAtMs == null ? 0 : Number(at - ship.lastCrewDockedAtMs);
  const flight = Math.min(2_147_483_647, ship.flightMsSinceLeave + elapsed);
  const stipendDue = elapsed > FLIGHT_STIPEND_AFTER_MS && !ship.crewPayoutSinceDock;
  const effects = [];
  const departed = [];
  let crew = [];
  for (const original of ship.crew) {
    const member = { ...original };
    const fatigue = fatigueIntervals(flight, member) - fatigueIntervals(ship.flightMsSinceLeave, member);
    let stipendCredits = 0;
    let stipendPaid = false;
    if (stipendDue) {
      stipendCredits = FLIGHT_STIPEND_CREDITS[member.rank];
      const paid = await tx.player.updateMany({
        where: { id: ship.playerId, credits: { gte: stipendCredits } },
        data: { credits: { decrement: stipendCredits } }
      });
      stipendPaid = paid.count === 1;
      if (!stipendPaid) {
        member.unpaidArrearsCredits = Math.min(MAX_ARREARS_CREDITS, member.unpaidArrearsCredits + stipendCredits);
        member.morale = moraleAfterLoss(member, MORALE_DECAY_DEFERRED_PAY, ship.traits);
      }
    }
    // Each interval applies quirks/traits independently. 100 losses suffice to reach zero.
    for (let i = 0; i < Math.min(100, fatigue); i++) member.morale = moraleAfterLoss(member, 5, ship.traits);
    let rescueCredits = 0;
    if (member.morale === 0) {
      rescueCredits = 2 * member.unpaidArrearsCredits;
      const paid = payResignedArrears && rescueCredits <= 2_147_483_647 && await tx.player.updateMany({
        where: { id: ship.playerId, credits: { gte: rescueCredits } },
        data: { credits: { decrement: rescueCredits } }
      });
      if (!paid || paid.count !== 1) {
        await tx.crewMember.delete({ where: { id: member.id } });
        departed.push(member.id);
        continue;
      }
      member.unpaidArrearsCredits = 0;
      member.morale = moraleAfterCappedGain(member, MORALE_GAIN_PAY_ARREARS, restedMoraleCap(ship.crew));
    }
    crew.push(member);
    effects.push({ crewId: member.id, moraleBefore: original.morale, fatigueIntervals: fatigue,
      ...(stipendDue && { stipendCredits, stipendPaid }), ...(rescueCredits > 0 && { rescueCredits }) });
  }
  const where = { spaceshipId_stationId: { spaceshipId: ship.id, stationId: receipt.dockedEntityId } };
  const previous = await tx.crewShoreLeave.findUnique({ where });
  const recovery = !previous || at - previous.lastLeaveAtMs >= BigInt(SHORE_LEAVE_COOLDOWN_MS);
  // Evaluate signature overrides on one pre-recovery snapshot, independent of hiring order.
  const leaveTerms = new Map(crew.map((member) => [member.id, shoreLeaveTerms(crew, 'STATION', member)]));
  for (const member of crew) {
    const terms = leaveTerms.get(member.id);
    if (recovery) member.morale = moraleAfterCappedGain(member, terms.gain, terms.cap);
    await tx.crewMember.update({ where: { id: member.id }, data: { morale: member.morale, unpaidArrearsCredits: member.unpaidArrearsCredits } });
    effects.find((effect) => effect.crewId === member.id).morale = member.morale;
  }
  if (recovery) await tx.crewShoreLeave.upsert({ where,
    create: { spaceshipId: ship.id, stationId: receipt.dockedEntityId, lastLeaveAtMs: at }, update: { lastLeaveAtMs: at } });
  const data = { lastCrewDockedAtMs: at, crewPayoutSinceDock: false, flightMsSinceLeave: recovery ? 0 : flight,
    ...(recovery && { lastLeaveStationId: receipt.dockedEntityId, lastLeaveAt: new Date(receipt.dockedAtMs) }) };
  await tx.spaceship.update({ where: { id: ship.id }, data });
  crew = await activeCrewOf(tx, ship.id);
  return { ship: { ...ship, ...data, crew }, docking: { applied: true, flightMs: elapsed, recovery, effects, departed } };
}
