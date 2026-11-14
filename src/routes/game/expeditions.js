import { randomUUID } from 'node:crypto';
import { CARGO_MAX_LOTS } from '../../config/cargo.js';
import { MAX_CREW_MORALE } from '../../config/crew.js';
import { addSeniorityXp, moraleBand } from '../../config/crew-morale.js';
import {
  EXPEDITION_MAX_CREW,
  EXPEDITION_MAX_FUTURE_SKEW_MS,
  EXPEDITION_MAX_ID_LENGTH,
  EXPEDITION_MAX_LABEL_LENGTH,
  EXPEDITION_TRAUMA_DURATION_MS
} from '../../config/expedition.js';
import { MAX_REWARD_CREDITS } from '../../config/missions.js';
import { H3_PATTERN } from '../../config/patterns.js';
import { awardCaptainXp } from '../../lib/captain.js';
import { currentLease, toStoredLots, cargoLotSchema } from '../../lib/cargo.js';
import { activeCrewOf, deductCrewRevenueShare } from '../../lib/crew.js';
import { awayTeamClaimNonceKey, verifyAwayTeamClaim } from '../../lib/expedition.js';
import { LEDGER_REASONS, adjustMissionReputation, factionsClaim, missionFaction, standingsOf } from '../../lib/reputation.js';
import { lockActiveShip, reissueToken, toLoadout } from '../../lib/ship.js';

const uint32 = { type: 'integer', minimum: 0, maximum: 4_294_967_295 };
const int32 = { type: 'integer', minimum: -2_147_483_648, maximum: 2_147_483_647 };
const NONCE_B64_PATTERN = '^[A-Za-z0-9+/]{22}==$';
const SIGNATURE_B64_PATTERN = '^[A-Za-z0-9+/]{86}==$';

// The `claim` of a request body: an `AwayTeamClaim` (eotha-contracts `rtse/v1/expedition.proto`) as camelCase
// proto-JSON, which omits a field holding its zero value. The shape is checked here and the bounds and the signature by
// `verifyAwayTeamClaim`. A crew state's `classId` and `rankId` are display only: allowed, never read.
const awayTeamClaimSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['pilotId', 'systemH3', 'planetId', 'siteNodeH3', 'outcomeTier', 'completedAtMs', 'nonce', 'signature'],
  properties: {
    pilotId: { type: 'string', minLength: 1, maxLength: EXPEDITION_MAX_ID_LENGTH },
    systemH3: { type: 'string', pattern: H3_PATTERN },
    planetId: { type: 'string', minLength: 1, maxLength: EXPEDITION_MAX_ID_LENGTH },
    siteNodeH3: { type: 'string', pattern: H3_PATTERN },
    missionId: { type: 'string', maxLength: EXPEDITION_MAX_ID_LENGTH, default: '' },
    outcomeTier: { type: 'integer', minimum: 1, maximum: 5 },
    rewardCredits: { ...uint32, default: 0 },
    captainXp: { ...uint32, default: 0 },
    sponsorReputationDelta: { ...int32, default: 0 },
    rivalReputationDelta: { ...int32, default: 0 },
    crewStates: {
      type: 'array',
      minItems: 1,
      maxItems: EXPEDITION_MAX_CREW,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['crewId'],
        properties: {
          crewId: { type: 'string', minLength: 1, maxLength: EXPEDITION_MAX_ID_LENGTH },
          classId: { type: 'string', maxLength: EXPEDITION_MAX_LABEL_LENGTH },
          rankId: { type: 'string', maxLength: EXPEDITION_MAX_LABEL_LENGTH },
          moraleDelta: { ...int32, default: 0 },
          seniorityXpEarned: { ...uint32, default: 0 },
          sufferedTrauma: { type: 'boolean', default: false },
          traumaType: { type: 'string', maxLength: EXPEDITION_MAX_LABEL_LENGTH, default: '' }
        }
      }
    },
    recoveredLots: { type: 'array', maxItems: CARGO_MAX_LOTS, items: cargoLotSchema, default: [] },
    completedAtMs: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    nonce: { type: 'string', pattern: NONCE_B64_PATTERN },
    signature: { type: 'string', pattern: SIGNATURE_B64_PATTERN }
  }
};

const settleSchema = {
  body: { type: 'object', required: ['claim'], additionalProperties: false, properties: { claim: awayTeamClaimSchema } }
};

const OVERFLOW = Symbol('credit-overflow');

const clampMorale = (morale) => Math.min(MAX_CREW_MORALE, Math.max(0, morale));

// The sponsor and rival of an expedition: those of the mission it was flown for, as the pilot still holds it. A
// free-roam discovery (no mission), or a mission already completed or abandoned, names no faction: the claim carries
// reputation deltas but not whose, so there is nothing to apply them to. Null then.
async function expeditionFactions(tx, playerId, missionId) {
  if (!missionId) return null;
  const held = await tx.playerMission.findUnique({ where: { playerId_missionId: { playerId, missionId } } });
  if (!held) return null;
  return { sponsorId: missionFaction(held.offer), rivalId: held.offer.opposed_faction_id || null };
}

// What a replayed claim is answered with: the first settlement, as its record kept it.
const settlementOf = (record) => ({
  expedition_id: record.id,
  outcome_tier: record.outcomeTier,
  gross_credits: record.grossCredits,
  crew_share_credits: record.crewWageShareCredits,
  net_credits: record.netCredits,
  captain_xp: record.captainXp,
  settled_at: record.createdAt.toISOString()
});

/**
 * Settles an away-team expedition: the engine's signed AwayTeamClaim becomes credits, experience, morale, trauma, cargo
 * and standing in one transaction under the pilot's lock, once per claim nonce. A replay changes nothing and is
 * refused with the first settlement.
 */
export default async function expeditionRoutes(fastify) {
  const prisma = fastify.prisma;
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.post('/expeditions/settle', { schema: settleSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const { claim } = request.body;
    const playerId = request.user.sub;
    const nowMs = Date.now();

    // Stateless checks first, so a refused claim touches nothing.
    if (claim.pilotId !== playerId || !verifyAwayTeamClaim(claim, fastify.claimKey.key)) {
      return reply.code(403).send({ error: 'The away team claim is not valid for this pilot.', code: 'away_team_claim_invalid' });
    }
    if (claim.completedAtMs > nowMs + EXPEDITION_MAX_FUTURE_SKEW_MS) {
      return reply.code(400).send({ error: 'The away team claim is dated in the future.', code: 'away_team_claim_from_future' });
    }
    // ExpeditionRecord keeps the gross as a 32-bit Int, as the balance is; a claim beyond it could never be credited.
    if (claim.rewardCredits > MAX_REWARD_CREDITS) {
      return reply.code(409).send({ error: 'The expedition would overflow the credit balance.', code: 'credit_overflow' });
    }
    const nonceHex = awayTeamClaimNonceKey(claim);

    let outcome;
    try {
      outcome = await prisma.$transaction(async (tx) => {
        let ship = await lockActiveShip(tx, request.user);
        // The pilot lock serialises this lookup with every other apply of the pilot's, so a nonce is applied once.
        const previous = await tx.expeditionRecord.findUnique({ where: { nonceHex } });
        if (previous) return { replayed: previous };

        // The engine cannot know who is aboard or injured, so the away team is checked here: every member the claim
        // names must be active crew of this ship and not still incapacitated by an earlier trauma. One that is not
        // refuses the claim whole, which stays redeemable should the roster change back.
        const aboard = new Map(ship.crew.map((member) => [member.id, member]));
        const notAboard = claim.crewStates.filter((state) => !aboard.has(state.crewId)).map((state) => state.crewId);
        if (notAboard.length > 0) {
          return {
            refusal: { error: 'The away team names crew who are not active crew of this ship.', code: 'away_team_crew_not_aboard', crew_ids: notAboard }
          };
        }
        const traumatized = claim.crewStates.filter((state) => aboard.get(state.crewId).traumaUntil?.getTime() > nowMs).map((state) => state.crewId);
        if (traumatized.length > 0) {
          return {
            refusal: { error: 'The away team names crew who are still recovering from trauma.', code: 'away_team_crew_traumatized', crew_ids: traumatized }
          };
        }
        const team = claim.crewStates;

        // The recovered lots join the pilot's current hold, which the lease token carries and so keeps small.
        const lots = toStoredLots(claim.recoveredLots);
        const lease = await currentLease(tx, playerId);
        if ((lease?.lots.length ?? 0) + lots.length > CARGO_MAX_LOTS) {
          return { refusal: { error: 'The hold has no room for the recovered cargo.', code: 'cargo_hold_full' } };
        }

        // Only the away team earns a wage from the expedition, as the working crew do from a mission: each takes its
        // effective share, together at most MAX_TOTAL_WAGE_BP, a member at morale 0 (resigned) none.
        const payroll = team.map((state) => aboard.get(state.crewId)).filter((member) => member.morale > 0);
        const payout = deductCrewRevenueShare(payroll, ship.traits, claim.rewardCredits);
        // Guarded increment; throwing rolls the whole settlement back, so the claim stays redeemable once the
        // balance allows.
        const { count } = await tx.player.updateMany({
          where: { id: playerId, credits: { lte: MAX_REWARD_CREDITS - payout.netCredits } },
          data: { credits: { increment: payout.netCredits } }
        });
        if (count !== 1) throw OVERFLOW;

        const captain = claim.captainXp > 0
          ? await awardCaptainXp(tx, ship.captain, claim.captainXp, { traits: ship.traits })
          : { xpGained: 0, currentLevel: ship.captain.level };

        // Each deployed member's morale and seniority move by what the engine signed; a member who suffered trauma is
        // incapacitated for EXPEDITION_TRAUMA_DURATION_MS.
        const traumaUntil = new Date(nowMs + EXPEDITION_TRAUMA_DURATION_MS);
        const crewEffects = [];
        for (const state of team) {
          const member = aboard.get(state.crewId);
          // A resigned member (morale 0) is not lifted out of it by an expedition.
          const morale = member.morale > 0 ? clampMorale(member.morale + state.moraleDelta) : 0;
          const seniorityXp = addSeniorityXp(member.seniorityXp, state.seniorityXpEarned);
          const data = { morale, seniorityXp };
          if (state.sufferedTrauma) {
            Object.assign(data, { traumaUntil, traumaType: state.traumaType });
          }
          await tx.crewMember.update({ where: { id: member.id }, data });
          crewEffects.push({
            crew_id: member.id,
            crew_class: member.crewClass,
            morale_before: member.morale,
            morale,
            morale_band: moraleBand(morale, member.quirkId),
            seniority_xp_earned: seniorityXp - member.seniorityXp,
            seniority_xp: seniorityXp,
            ...(state.sufferedTrauma && { trauma: { type: state.traumaType, until: data.traumaUntil.toISOString() } }),
            wage_share_credits: payout.crewPayouts.find((entry) => entry.crewId === member.id)?.shareCredits ?? 0
          });
        }

        // The sponsor's and the rival's standing move together, as a mission completion moves them.
        const factions = await expeditionFactions(tx, playerId, claim.missionId ?? '');
        if (factions && (claim.sponsorReputationDelta !== 0 || claim.rivalReputationDelta !== 0)) {
          await adjustMissionReputation(
            tx, playerId, factions.sponsorId, claim.sponsorReputationDelta, factions.rivalId, claim.rivalReputationDelta,
            { reason: LEDGER_REASONS.EXPEDITION_SETTLED, missionId: claim.missionId || null }
          );
        }

        if (lots.length > 0) {
          if (lease) {
            await tx.cargoLease.update({ where: { id: lease.id }, data: { lots: [...lease.lots, ...lots] } });
          } else {
            await tx.cargoLease.create({ data: { id: randomUUID(), playerId, generation: 1, lots } });
          }
        }

        const record = await tx.expeditionRecord.create({
          data: {
            playerId,
            spaceshipId: ship.id,
            systemH3: claim.systemH3,
            planetId: claim.planetId,
            siteNodeH3: claim.siteNodeH3,
            missionId: claim.missionId || null,
            outcomeTier: claim.outcomeTier,
            grossCredits: claim.rewardCredits,
            crewWageShareCredits: payout.crewShareCredits,
            netCredits: payout.netCredits,
            // The XP the captain was awarded (after doctrines and the cap), which always fits the column.
            captainXp: captain.xpGained,
            sponsorRepChange: claim.sponsorReputationDelta,
            rivalRepChange: claim.rivalReputationDelta,
            nonceHex,
            completedAt: new Date(claim.completedAtMs)
          }
        });

        // The token carries the crew and standings as they now stand.
        ship = { ...ship, crew: await activeCrewOf(tx, ship.id), factions: await factionsClaim(tx, playerId) };
        const { credits } = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
        const held = await currentLease(tx, playerId);
        return {
          ship,
          body: {
            ...settlementOf(record),
            credits,
            crew_payouts: payout.crewPayouts,
            xp_awarded: captain.xpGained,
            captain_level: captain.currentLevel,
            crew: crewEffects,
            reputation: factions
              ? { sponsor_faction_id: factions.sponsorId, rival_faction_id: factions.rivalId, standings: await standingsOf(tx, playerId) }
              : null,
            recovered_lots: lots.length,
            lots: held?.lots ?? [],
            replayed: false
          }
        };
      });
    } catch (err) {
      if (err !== OVERFLOW) throw err;
      return reply.code(409).send({ error: 'The expedition would overflow the credit balance.', code: 'credit_overflow' });
    }

    if (outcome.refusal) return reply.code(409).send(outcome.refusal);
    if (outcome.replayed) {
      return reply.code(409).send({
        error: 'This away team claim was already settled.',
        code: 'away_team_claim_replayed',
        ...settlementOf(outcome.replayed),
        replayed: true
      });
    }
    const { ship, body } = outcome;
    const { ship_attributes: shipAttributes } = toLoadout(ship.id, ship.components, ship.passengersAboard, ship.traits, ship.crew);
    return { ...body, token: await reissueToken(fastify, request, shipAttributes, ship.factions) };
  });
}
