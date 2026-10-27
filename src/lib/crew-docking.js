import { createHash } from 'node:crypto';
import {
  FLAKY_UNDOCK_LEAVE_CHANCE, FLIGHT_STIPEND_AFTER_MS, FLIGHT_STIPEND_CREDITS,
  MAX_ARREARS_CREDITS, MAX_COUNTED_FLIGHT_LEG_MS, MORALE_DECAY_DEFERRED_PAY, MORALE_GAIN_PAY_ARREARS,
  NOMINAL_MORALE_THRESHOLD, QUIRKS, RANKS, SHORE_LEAVE_COOLDOWN_MS, SHORE_LEAVE_DECAY_INTERVAL_MS,
  SHORE_LEAVE_GRACE_MS, SHORE_LEAVE_OUTPOST_GAIN, SHORE_LEAVE_STATION_GAIN, inHomeSpace
} from '../config/crew.js';
import { moraleAfterCappedGain, moraleAfterLoss, restedMoraleCap } from '../config/crew-morale.js';
import { activeCrewOf, standbyCrewOf } from './crew.js';

// The fatigue intervals `ms` of flight amounts to for `member`. A HOME_BOUND one tires faster (its
// `awayFatigueMult` on the flight time) while the dock it ends at, the one governed by
// `controllingFactionId`, is outside its home faction's space.
export const fatigueIntervals = (ms, member = {}, controllingFactionId = '') => {
  const quirk = QUIRKS[member.quirkId];
  const flightMs = quirk?.awayFatigueMult && !inHomeSpace(member, controllingFactionId) ? ms * quirk.awayFatigueMult : ms;
  return Math.floor(Math.max(0, flightMs - SHORE_LEAVE_GRACE_MS * (quirk?.enduranceMult ?? 1)) / SHORE_LEAVE_DECAY_INTERVAL_MS);
};

// Outpost rules await a signed dock-kind protocol: EVERY signed dock is currently a station. A HOME_BOUND
// member's gain and rested cap depend on whether `controllingFactionId`, the faction the docked receipt
// signs as governing the dock ('' for an independent system), is its home faction.
export function shoreLeaveTerms(crew, kind = 'STATION', member = {}, controllingFactionId = '') {
  const galley = crew.some((m) => m.crewClass === 'CHEF' && RANKS.indexOf(m.rank) >= 1 && m.morale >= NOMINAL_MORALE_THRESHOLD);
  const quirk = QUIRKS[member.quirkId];
  const stationLeave = kind === 'STATION' || galley;
  const territorial = quirk?.homeStationGain !== undefined;
  const home = territorial && inHomeSpace(member, controllingFactionId);
  const base = territorial
    ? (stationLeave ? (home ? quirk.homeStationGain : quirk.awayStationGain) : (home ? quirk.homeOutpostGain : quirk.awayOutpostGain))
    : stationLeave ? SHORE_LEAVE_STATION_GAIN : quirk?.outpostGain ?? SHORE_LEAVE_OUTPOST_GAIN;
  return {
    gain: base + (quirk?.shoreLeaveDelta ?? 0),
    flightMult: stationLeave ? 0 : 0.5,
    cap: home ? Math.max(restedMoraleCap(crew), quirk.homeRestedCap) : restedMoraleCap(crew)
  };
}

/** Stable 10% roll: UUID strings and the decimal 15-minute window, concatenated in plan order. */
export function flakyDeparture(member, stationId, nowMs) {
  if (member.quirkId !== 'Q12' || member.morale >= 85) return false;
  const digest = createHash('sha256').update(`flaky_undock_v1${member.id}${stationId}${Math.floor(nowMs / 900_000)}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000 < FLAKY_UNDOCK_LEAVE_CHANCE;
}

// Only working crew roll at mission acceptance. Resigned members await explicit shore leave;
// mining-only undocks still need a signed contracts/engine event. The approved roll is unchanged.
export async function recordFlakyDeparture(tx, ship, receipt, nowMs, docking) {
  const departed = [];
  for (const m of ship.crew) {
    if (m.morale <= 0 || !flakyDeparture(m, receipt.dockedEntityId, nowMs)) continue;
    departed.push(m);
  }
  if (departed.length) {
    const ids = departed.map((m) => m.id);
    await tx.crewMember.deleteMany({ where: { id: { in: ids } } });
    const charged = (docking?.effects ?? []).filter((effect) => ids.includes(effect.crewId) && effect.stipendPaid);
    const refund = charged.reduce((sum, effect) => sum + effect.stipendCredits, 0);
    // These amounts were deducted moments ago in this same transaction, so refund cannot overflow.
    if (refund) await tx.player.update({ where: { id: ship.playerId }, data: { credits: { increment: refund } } });
    for (const effect of charged) effect.stipendRefundedCredits = effect.stipendCredits;
  }
  return { ship: { ...ship, crew: ship.crew.filter((m) => !departed.includes(m)) }, departed: departed.map((m) => m.id) };
}

/**
 * Under the pilot lock, after receipt verification. New docks consume flight/fatigue/recovery once.
 * The captain caps counted flight at two hours per leg (the raw signed baseline still advances).
 * Implicit docks NEVER delete resigned crew or restore their morale. Only explicit shore leave,
 * with allowDeparture, resolves active AND standby resignations. It may resolve pending zeros at
 * the already consumed current dock without replaying flight/recovery. Old docks remain no-ops.
 * A pending stipend is not charged until the member stays, making rescue independent of route order.
 */
export async function recordCrewDock(tx, ship, receipt, {
  payResignedArrears = false, allowDeparture = false, payoutSettled = false
} = {}) {
  const at = BigInt(receipt.dockedAtMs);
  const last = ship.lastCrewDockedAtMs;
  if (last != null && at < last) return { ship, docking: { applied: false } };
  const newDock = last == null || at > last;
  const standby = allowDeparture ? (await standbyCrewOf(tx, ship.playerId)).filter((m) => m.morale === 0) : [];
  if (!newDock && (!allowDeparture || (!ship.crew.some((m) => m.morale === 0) && !standby.length))) {
    return { ship, docking: { applied: false } };
  }
  const gap = last == null || !newDock ? 0 : Number(at - last);
  const elapsed = Math.min(MAX_COUNTED_FLIGHT_LEG_MS, gap);
  const flight = Math.min(2_147_483_647, ship.flightMsSinceLeave + elapsed);
  const paidDuringLeg = last != null && ship.lastCrewPayoutAtMs != null
    && ship.lastCrewPayoutAtMs > last && ship.lastCrewPayoutAtMs <= at;
  const stipendDue = newDock && elapsed > FLIGHT_STIPEND_AFTER_MS && !payoutSettled && !paidDuringLeg;
  const effects = [];
  const departed = [];
  const rescued = new Set();
  const aboard = new Set(ship.crew.map((m) => m.id));
  const survivors = [];
  const spend = async (amount) => amount <= MAX_ARREARS_CREDITS && (await tx.player.updateMany({
    where: { id: ship.playerId, credits: { gte: amount } }, data: { credits: { decrement: amount } }
  })).count === 1;

  for (const original of [...ship.crew, ...standby]) {
    const member = { ...original };
    const active = aboard.has(member.id);
    const fatigue = newDock && active
      ? fatigueIntervals(flight, member, receipt.controllingFactionId) - fatigueIntervals(ship.flightMsSinceLeave, member, receipt.controllingFactionId) : 0;
    for (let i = 0; i < Math.min(100, fatigue); i++) member.morale = moraleAfterLoss(member, 5, ship.traits);
    const effect = { crewId: member.id, moraleBefore: original.morale, fatigueIntervals: fatigue };
    // Resigned crew earn no fresh wages/stipends; retain an already pending flight stipend.
    let stipend = member.pendingStipendCredits || (stipendDue && active && original.morale > 0 ? FLIGHT_STIPEND_CREDITS[member.rank] : 0);
    member.pendingStipendCredits = 0;
    if (member.morale > 0 && stipend) {
      effect.stipendCredits = stipend;
      effect.stipendPaid = await spend(stipend);
      if (!effect.stipendPaid) {
        member.unpaidArrearsCredits = Math.min(MAX_ARREARS_CREDITS, member.unpaidArrearsCredits + stipend);
        member.morale = moraleAfterLoss(member, MORALE_DECAY_DEFERRED_PAY, ship.traits);
      }
      stipend = 0;
    }
    if (member.morale === 0) {
      if (!allowDeparture) {
        member.pendingStipendCredits = stipend;
        effect.resignationPending = true;
      } else {
        let saved = false;
        if (payResignedArrears) {
          const player = await tx.player.findUnique({ where: { id: ship.playerId }, select: { credits: true } });
          const stipendPaid = player.credits >= stipend;
          const arrears = Math.min(MAX_ARREARS_CREDITS, member.unpaidArrearsCredits + (stipendPaid ? 0 : stipend));
          const rescueCredits = 2 * arrears;
          const cost = rescueCredits + (stipendPaid ? stipend : 0);
          saved = await spend(cost);
          if (saved) {
            effect.rescueCredits = rescueCredits;
            if (stipend) Object.assign(effect, { stipendCredits: stipend, stipendPaid });
            member.unpaidArrearsCredits = 0;
            rescued.add(member.id);
          }
        }
        if (!saved) {
          await tx.crewMember.delete({ where: { id: member.id } });
          departed.push(member.id);
          effects.push({ ...effect, morale: 0, departed: true });
          continue;
        }
      }
    }
    survivors.push(member);
    effects.push(effect);
  }

  const currentCrew = survivors.filter((m) => aboard.has(m.id));
  const cap = restedMoraleCap(currentCrew);
  const where = { spaceshipId_stationId: { spaceshipId: ship.id, stationId: receipt.dockedEntityId } };
  const previous = newDock ? await tx.crewShoreLeave.findUnique({ where }) : null;
  const recovery = newDock && (!previous || at - previous.lastLeaveAtMs >= BigInt(SHORE_LEAVE_COOLDOWN_MS));
  // Freeze overrides before recovery; a recovering Chef cannot raise later members' caps by order.
  const leaveTerms = new Map(currentCrew.map((m) => [m.id, shoreLeaveTerms(currentCrew, 'STATION', m, receipt.controllingFactionId)]));
  for (const member of survivors) {
    if (rescued.has(member.id)) {
      // Exactly one arrears recovery gain, never an additional station gain at the same dock.
      member.morale = moraleAfterCappedGain(member, MORALE_GAIN_PAY_ARREARS, leaveTerms.get(member.id)?.cap ?? cap);
    } else if (recovery && aboard.has(member.id) && member.morale > 0) {
      const terms = leaveTerms.get(member.id);
      member.morale = moraleAfterCappedGain(member, terms.gain, terms.cap);
    }
    await tx.crewMember.update({ where: { id: member.id }, data: {
      morale: member.morale, unpaidArrearsCredits: member.unpaidArrearsCredits, pendingStipendCredits: member.pendingStipendCredits
    } });
    effects.find((e) => e.crewId === member.id).morale = member.morale;
  }
  let data = {};
  if (newDock) {
    if (recovery) await tx.crewShoreLeave.upsert({ where,
      create: { spaceshipId: ship.id, stationId: receipt.dockedEntityId, lastLeaveAtMs: at }, update: { lastLeaveAtMs: at } });
    data = { lastCrewDockedAtMs: at, crewPayoutSinceDock: false, flightMsSinceLeave: recovery ? 0 : flight,
      ...(recovery && { lastLeaveStationId: receipt.dockedEntityId, lastLeaveAt: new Date(receipt.dockedAtMs) }) };
    await tx.spaceship.update({ where: { id: ship.id }, data });
  }
  return { ship: { ...ship, ...data, crew: await activeCrewOf(tx, ship.id) }, docking: {
    applied: true, flightMs: elapsed, receiptGapMs: gap, recovery, effects, departed
  } };
}
