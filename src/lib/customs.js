import { createHash } from 'node:crypto';
import {
  CAPTURE_TIERS,
  DETENTION_MS,
  MIN_COMPONENT_HEALTH_PCT
} from '../config/customs.js';
import { isFactionId } from '../config/factions.js';
import { abandonPenalty, moraleBand, moraleAfterLoss } from '../config/crew-morale.js';
import { fromStoredOffer } from './active-mission.js';
import { activeCrewOf } from './crew.js';
import { isLegacyRow } from './mission-offer.js';
import { LEDGER_REASONS, adjustMissionReputation, factionsClaim, missionFaction, standingsOf } from './reputation.js';

// A number in [0, 1) that depends only on the claim's nonce and `label`: the damage and the detainee a capture
// picks are not the pilot's to reroll, and a replayed claim would pick the same.
const roll = (nonceHex, label) => createHash('sha256').update(`${nonceHex}:${label}`).digest().readUInt32BE(0) / 2 ** 32;

/**
 * The component damage a capture of `tier` does to a ship with `components` (rows with `type`, `tier` and
 * `healthPct`), as `[{ type, points, healthBefore, healthAfter }]`. Only installed components are hurt, none
 * is taken below MIN_COMPONENT_HEALTH_PCT, and one already at or under it is left alone.
 */
export function planComponentDamage(tier, components, nonceHex) {
  const damage = [];
  CAPTURE_TIERS[tier].damage.forEach(([types, min, max], i) => {
    const installed = components.filter((c) => types.includes(c.type) && c.tier > 0);
    if (installed.length === 0) return;
    const target = installed[Math.floor(roll(nonceHex, `type:${i}`) * installed.length)];
    const points = min + Math.round(roll(nonceHex, `points:${i}`) * (max - min));
    const healthAfter = Math.min(target.healthPct, Math.max(MIN_COMPONENT_HEALTH_PCT, target.healthPct - points));
    if (healthAfter < target.healthPct) {
      damage.push({ type: target.type, points: target.healthPct - healthAfter, healthBefore: target.healthPct, healthAfter });
    }
  });
  return damage;
}

// Inside a transaction holding the pilot's lock: takes `wanted` credits from the pilot, or all they have if
// that is less (a balance never goes below zero), and returns what was taken.
async function takeCredits(tx, playerId, wanted) {
  for (;;) {
    const player = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
    const take = Math.min(wanted, player?.credits ?? 0);
    if (take <= 0) return 0;
    const { count } = await tx.player.updateMany({ where: { id: playerId, credits: { gte: take } }, data: { credits: { decrement: take } } });
    if (count === 1) return take;
  }
}

/**
 * `db` is the Prisma client or an open transaction. The 403 body refusing `playerId` the services of
 * `stationId` while a customs lockout stands there at `nowMs`, or null.
 */
export async function stationLockoutRefusal(db, playerId, rawStationId, nowMs) {
  const stationId = String(rawStationId ?? '').toLowerCase();
  const row = await db.stationLockout.findUnique({ where: { playerId_stationId: { playerId, stationId } } });
  if (!row || row.until.getTime() <= nowMs) return null;
  return {
    error: 'This station has locked you out after a customs capture.',
    code: 'station_locked_out',
    station_id: stationId,
    until_ms: row.until.getTime(),
    remaining_ms: row.until.getTime() - nowMs
  };
}

/** `db` is the Prisma client or an open transaction. The pilot's customs lockouts still running at `nowMs`. */
export async function activeLockouts(db, playerId, nowMs) {
  const rows = await db.stationLockout.findMany({ where: { playerId, until: { gt: new Date(nowMs) } }, orderBy: { until: 'asc' } });
  return rows.map((row) => ({ station_id: row.stationId, tier: row.tier, until_ms: row.until.getTime(), remaining_ms: row.until.getTime() - nowMs }));
}

const failure = (status, error, code) => ({ failure: { status, body: { error, code } } });

/**
 * Inside the transaction that holds the pilot's lock (`ship` is lockActiveShip's result), applies the engine-signed
 * customs capture `claim` (already verified, camelCase) once per nonce, and returns `{ body, ship,
 * passengersAboard }` (`body` less its token, `ship` as it now stands), or `{ failure }` when it cannot apply. A
 * claim that was applied before returns `{ replayed: true }` and that first body, changing nothing.
 *
 * The capture's tier (CAPTURE_TIERS) decides the rest. The mission it names, if the pilot still holds it,
 * fails: it is removed with its passengers and the pilot is fined a share of its offered reward (never more
 * than the balance), the sponsor and the faction governing the station lose reputation, and the crew
 * lose morale. Armed boardings also damage components and tier 4 detains a crew member; tiers 2 to 4
 * lock the pilot out of the station. A capture not tied to a held mission still does everything but the
 * fine and reputation, which are figured on the mission's offer.
 */
export async function applyCustomsSeizure(tx, { playerId, ship, claim, nowMs }) {
  const nonce = Buffer.from(claim.nonce, 'base64').toString('hex');
  const previous = await tx.customsSeizure.findUnique({ where: { playerId_nonce: { playerId, nonce } } });
  if (previous) return { replayed: true, body: previous.result, ship, passengersAboard: ship.passengersAboard };

  const tier = CAPTURE_TIERS[claim.captureTier];
  const row = claim.missionId
    ? await tx.playerMission.findFirst({ where: { playerId, missionId: claim.missionId } })
    : null;
  const held = row && !isLegacyRow(row) ? row : null;
  const offer = held ? fromStoredOffer(held.offer) : null;
  if (offer && !offer.carries_contraband_or_operative) {
    return failure(409, 'The mission carries nothing customs could seize.', 'mission_not_inspectable');
  }

  // The mission fails: gone, with its passengers.
  let passengersAboard = ship.passengersAboard;
  if (held) {
    await tx.playerMission.delete({ where: { id: held.id } });
    passengersAboard = Math.max(0, ship.passengersAboard - (offer.required_berths ?? 0));
    await tx.spaceship.update({ where: { id: ship.id }, data: { passengersAboard } });
  }

  // The fine, a share of the offered reward, and the reputation: -mult × ΔR_base for the sponsor and the
  // faction governing the station (one loss, their sum, when they are the same).
  const fineDue = offer ? Math.round(tier.fineRate * (offer.reward_credits ?? 0)) : 0;
  const fine = fineDue > 0 ? await takeCredits(tx, playerId, fineDue) : 0;
  const reputationChanges = [];
  if (offer) {
    const sponsor = missionFaction(offer);
    const base = Math.max(0, offer.reputation_change ?? 0);
    const station = isFactionId(claim.controllingFactionId) ? claim.controllingFactionId : null;
    const losses = new Map([[sponsor, -Math.round(tier.sponsorRepMult * base)]]);
    if (station) losses.set(station, (losses.get(station) ?? 0) - Math.round(tier.stationRepMult * base));
    const [[sponsorId, sponsorDelta], second] = [...losses.entries()];
    await adjustMissionReputation(tx, playerId, sponsorId, sponsorDelta, second?.[0] ?? null, second?.[1] ?? 0, {
      reason: LEDGER_REASONS.CUSTOMS_CAUGHT, missionId: held.missionId
    });
    for (const [factionId, delta] of losses) reputationChanges.push({ faction_id: factionId, delta });
  }

  // Breaching charges and firefights wear the ship's components.
  const componentDamage = planComponentDamage(claim.captureTier, ship.components, nonce);
  for (const hit of componentDamage) {
    const component = ship.components.find((c) => c.type === hit.type);
    await tx.shipComponentRecord.update({ where: { id: component.id }, data: { healthPct: hit.healthAfter } });
  }

  // The crew who are working lose morale for the capture, and the quirks that mind a failed mission lose more.
  const crewMorale = [];
  for (const member of ship.crew.filter((m) => m.morale > 0 && !m.detained)) {
    const quirkEffects = [];
    let morale = moraleAfterLoss(member, tier.moraleLoss, ship.traits);
    const penalty = offer ? abandonPenalty(member, missionFaction(offer)) : null;
    if (penalty) {
      morale = moraleAfterLoss({ ...member, morale }, penalty.moraleLoss, ship.traits);
      quirkEffects.push({ quirk: penalty.quirk, effect: 'MISSION_FAILED_INSPECTION', moraleLoss: penalty.moraleLoss });
    }
    if (morale === member.morale) continue;
    await tx.crewMember.update({ where: { id: member.id }, data: { morale } });
    crewMorale.push({
      crewId: member.id,
      crewClass: member.crewClass,
      moraleBefore: member.morale,
      morale,
      moraleBand: moraleBand(morale, member.quirkId),
      moraleLoss: tier.moraleLoss,
      ...(quirkEffects.length > 0 && { quirkEffects })
    });
  }

  // A firefight leaves a crew member in custody.
  let detained = null;
  const detainable = ship.crew.filter((m) => m.morale > 0 && !m.detained);
  const detainedUntilMs = claim.seizedAtMs + DETENTION_MS;
  if (tier.detainedCrew > 0 && detainable.length > 0 && detainedUntilMs > nowMs) {
    const member = detainable[Math.floor(roll(nonce, 'detain') * detainable.length)];
    await tx.crewMember.update({ where: { id: member.id }, data: { detainedUntil: new Date(detainedUntilMs) } });
    detained = { crew_id: member.id, crew_class: member.crewClass, until_ms: detainedUntilMs };
  }

  // The station shuts the pilot out for a time counted from the capture, so holding the claim back does not shorten it.
  let lockout = null;
  const lockoutUntilMs = claim.seizedAtMs + tier.lockoutMs;
  if (tier.lockoutMs > 0 && lockoutUntilMs > nowMs) {
    const stationId = claim.stationEntityId.toLowerCase();
    const where = { playerId_stationId: { playerId, stationId } };
    const existing = await tx.stationLockout.findUnique({ where });
    const until = new Date(Math.max(lockoutUntilMs, existing?.until.getTime() ?? 0));
    await tx.stationLockout.upsert({
      where,
      update: { until, tier: Math.max(claim.captureTier, existing?.tier ?? 0) },
      create: { playerId, stationId, until, tier: claim.captureTier }
    });
    lockout = { station_id: stationId, until_ms: until.getTime() };
  }

  const player = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
  const body = {
    success: true,
    capture_tier: claim.captureTier,
    inspection_outcome: claim.inspectionOutcome,
    mission_id: claim.missionId || null,
    mission_failed: Boolean(held),
    fine_credits: fine,
    ...(fine < fineDue && { fine_unpaid_credits: fineDue - fine }),
    credits: player.credits,
    reputation_changes: reputationChanges,
    standings: await standingsOf(tx, playerId),
    component_damage: componentDamage,
    crew_morale: crewMorale,
    detained_crew: detained,
    lockout,
    passengers_removed: ship.passengersAboard - passengersAboard,
    ...(offer?.resource_type && { contraband: { resource_type: offer.resource_type, quantity_m3: offer.quantity_m3 ?? 0 } })
  };
  await tx.customsSeizure.create({
    data: {
      playerId,
      nonce,
      missionId: claim.missionId || null,
      stationEntityId: claim.stationEntityId,
      systemH3: claim.systemH3,
      controllingFactionId: claim.controllingFactionId,
      captureTier: claim.captureTier,
      inspectionOutcome: claim.inspectionOutcome,
      exposureScoreMilli: claim.exposureScoreMilli,
      seizedAtMs: BigInt(claim.seizedAtMs),
      fineCredits: fine,
      result: body
    }
  });

  const current = {
    ...ship,
    components: await tx.shipComponentRecord.findMany({ where: { spaceshipId: ship.id } }),
    crew: await activeCrewOf(tx, ship.id),
    factions: await factionsClaim(tx, playerId)
  };
  return { body, ship: current, passengersAboard };
}
