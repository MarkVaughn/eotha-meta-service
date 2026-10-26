import {
  CREW_STATUS,
  CREW_WAGE_SHARE_BP,
  ENGINEER_JURY_RIG_TYPES,
  engineerJuryRigSlots,
  MAX_STANDBY_CREW,
  MORALE_GAIN_PAY_ARREARS,
  STANDBY_TRANSFER_FEE_CREDITS,
  signingBonusCredits,
  startingMorale
} from '../../config/crew.js';
import { moraleAfterCappedGain, moraleBand, promotionRefusal, promotionTerms, restedMoraleCap } from '../../config/crew-morale.js';
import { UUID_PATTERN } from '../../config/patterns.js';
import { candidateView, findCandidate, generateCrewBoard, unavailableReasons } from '../../lib/crew-generator.js';
import { activeCrewOf, boardingReasons, crewLimits, crewMemberView, hiredCandidateIdsOf, primaryReason, standbyCrewOf } from '../../lib/crew.js';
import { DOCKED_ENTITY_ID_PATTERN, dockedReceiptRefusal, dockedReceiptSchema } from '../../lib/docked-receipt.js';
import { isLegacyRow } from '../../lib/mission-offer.js';
import { standingsOf } from '../../lib/reputation.js';
import { lockActiveShip, reissueToken, toLoadout } from '../../lib/ship.js';
import { recordCrewDock } from '../../lib/crew-docking.js';

// `dockedReceipt` is optional in the schema on purpose, like the captain trait route: its absence is
// answered with the coded 403 `docked_receipt_required` rather than a generic schema 400.
const receiptProperties = {
  stationId: { type: 'string', pattern: DOCKED_ENTITY_ID_PATTERN },
  dockedReceipt: dockedReceiptSchema
};
const crewIdProperty = { type: 'string', pattern: UUID_PATTERN.source };

const boardSchema = {
  querystring: {
    type: 'object',
    required: ['stationId'],
    additionalProperties: false,
    properties: { stationId: { type: 'string', pattern: DOCKED_ENTITY_ID_PATTERN } }
  }
};
const hireSchema = {
  body: {
    type: 'object',
    required: ['candidateId'],
    additionalProperties: false,
    properties: { candidateId: { type: 'string', pattern: '^cand-[0-3]-[0-9a-f]{8}$' }, ...receiptProperties }
  }
};
const crewActionSchema = {
  body: {
    type: 'object',
    required: ['crewId'],
    additionalProperties: false,
    properties: { crewId: crewIdProperty, ...receiptProperties }
  }
};

const juryRigSchema = {
  body: {
    type: 'object', required: ['crewId', 'componentTypes'], additionalProperties: false,
    properties: {
      crewId: crewIdProperty,
      componentTypes: { type: 'array', uniqueItems: true, maxItems: 2, items: { type: 'string', enum: ENGINEER_JURY_RIG_TYPES } },
      ...receiptProperties
    }
  }
};

const payArrearsSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: { crewId: crewIdProperty, ...receiptProperties }
  }
};
const shoreLeaveSchema = {
  body: { type: 'object', additionalProperties: false, properties: {
    ...receiptProperties, payResignedArrears: { type: 'boolean', default: false }
  } }
};

const MESSAGES = {
  docked_receipt_required: 'Crew can only be hired or moved in port, which needs a current docked receipt from the engine.',
  docked_receipt_invalid: 'The docked receipt is not valid for this pilot.',
  docked_receipt_wrong_station: 'The docked receipt is for a different station.',
  candidate_not_found: 'This station is not offering that candidate; its board may have refreshed.',
  candidate_already_hired: 'That candidate is already on your roster.',
  crew_not_found: 'No such crew member on your roster.',
  hull_crew_cap_reached: "The hull cannot take more active crew.",
  insufficient_free_berths: 'There is no free life support berth for another crew member.',
  class_already_active: 'A crew member of that class is already aboard.',
  insufficient_faction_rep: "Your standing with the candidate's home faction is too low to hire them.",
  insufficient_credits: 'Not enough credits for the signing bonus.',
  crew_locked_by_active_mission: 'Crew cannot be dismissed or moved while you hold a mission.',
  crew_not_engineer: 'Only an Engineer can configure component overdrive.',
  jury_rig_slots_exceeded: 'That Engineer cannot overdrive that many components.',
  COMPONENT_NOT_INSTALLED: 'Overdrive requires an installed component; Tier 0 is unequipped.',
  jury_rig_already_max_tier: 'Tier 5 cannot be overdriven to Tier 6; select a lower-tier component.',
  standby_full: `Harbor Standby holds at most ${MAX_STANDBY_CREW} crew members.`,
  crew_not_on_standby: 'That crew member is not on Harbor Standby.',
  crew_not_active: 'That crew member is not aboard.',
  crew_resigned: 'A resigned crew member must be recovered through shore leave before returning aboard.',
  already_master: 'That crew member is already a Master.',
  insufficient_seniority_xp: 'That crew member has not earned enough Seniority XP for the next rank.',
  crew_refuses_promotion: 'A Mutinous crew member refuses training until their morale recovers.',
  no_arrears: 'No crew pay is owed.',
  resignation_requires_new_dock: 'Resigned crew require a new signed docking receipt and twice their arrears to stay.'
};
const STATUS = {
  candidate_not_found: 404,
  candidate_already_hired: 409,
  crew_not_found: 404,
  hull_crew_cap_reached: 400,
  insufficient_free_berths: 400,
  class_already_active: 409,
  insufficient_faction_rep: 403,
  insufficient_credits: 402,
  crew_locked_by_active_mission: 409,
  crew_not_engineer: 409,
  jury_rig_slots_exceeded: 409,
  COMPONENT_NOT_INSTALLED: 409,
  jury_rig_already_max_tier: 409,
  standby_full: 409,
  crew_not_on_standby: 409,
  crew_not_active: 409,
  crew_resigned: 409,
  already_master: 409,
  insufficient_seniority_xp: 409,
  crew_refuses_promotion: 409,
  no_arrears: 409,
  resignation_requires_new_dock: 409
};

// `{ error: <code>, message, ...details }`, the shape the crew routes answer refusals with.
const refusal = ({ code, ...details }) => ({ error: code, message: MESSAGES[code], ...details });
// A reason from the board (`INSUFFICIENT_CREDITS`, ...) as the refusal of a hire or activation.
const reasonRefusal = (reason, reasons) => {
  const { code, label, ...details } = reason;
  return { code: code.toLowerCase(), ...details, label, unavailableReasons: reasons };
};

export default async function crewRoutes(fastify) {
  const prisma = fastify.prisma;
  fastify.addHook('onRequest', fastify.authenticate);

  // The station the receipt is for, or the reply that refuses it. Stateless, so it runs before any
  // write. An expired receipt is answered like a missing one: either way the client must fetch a
  // fresh one.
  function dockedStation(request, reply) {
    const { stationId, dockedReceipt } = request.body;
    if (!dockedReceipt) return void reply.code(403).send(refusal({ code: 'docked_receipt_required' }));
    const receiptRefusal = dockedReceiptRefusal(dockedReceipt, {
      pilotId: request.user.sub,
      publicKey: fastify.claimKey.key,
      nowMs: Date.now(),
      log: request.log
    });
    if (receiptRefusal) {
      const code = receiptRefusal.code === 'docked_receipt_expired' ? 'docked_receipt_required' : receiptRefusal.code;
      return void reply.code(403).send(refusal({ code }));
    }
    if (stationId !== undefined && stationId !== dockedReceipt.dockedEntityId) {
      return void reply.code(403).send(refusal({ code: 'docked_receipt_wrong_station' }));
    }
    return dockedReceipt.dockedEntityId;
  }

  // Re-signs the token with the ship's attributes after `ship.crew` changed to `crew`.
  async function respondWithShip(request, ship, crew, body) {
    const loadout = toLoadout(ship.id, ship.components, ship.passengersAboard, ship.traits, crew);
    return { ...body, ship_attributes: loadout.ship_attributes, token: await reissueToken(fastify, request, loadout.ship_attributes, ship.factions) };
  }

  // The pilot's roster and the limits the lounge shows.
  fastify.get('/crew', async (request) => {
    return prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const standby = await standbyCrewOf(tx, request.user.sub);
      return {
        active: ship.crew.map((member) => crewMemberView(member, ship.traits)),
        standby: standby.map((member) => crewMemberView(member, ship.traits)),
        limits: crewLimits(ship)
      };
    });
  });

  // The station's candidates this window, each with whether this pilot can hire them. The board is the
  // same for every pilot and cannot be rerolled by refreshing, so it needs no receipt. Only a candidate
  // already on this pilot's roster is left out, so the others keep their places and the board may show
  // fewer than four.
  fastify.get('/crew/board', { schema: boardSchema }, async (request) => {
    const { stationId } = request.query;
    const nowMs = Date.now();
    const { window, candidates } = generateCrewBoard(stationId, nowMs);
    const ctx = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const player = await tx.player.findUnique({ where: { id: request.user.sub }, select: { credits: true } });
      return {
        ship,
        credits: player.credits,
        standings: await standingsOf(tx, request.user.sub),
        hired: await hiredCandidateIdsOf(tx, request.user.sub)
      };
    });
    return {
      stationId,
      window: { startsAt: new Date(window.startsAtMs).toISOString(), expiresAt: new Date(window.expiresAtMs).toISOString() },
      candidates: candidates.filter((candidate) => !ctx.hired.has(candidate.candidateId)).map((candidate) => candidateView(candidate, ctx)),
      credits: ctx.credits
    };
  });

  // Hires a candidate from the docked station's board: checks, signing bonus and the new crew member
  // commit together under the pilot's lock, so berths, the class slot and credits are never over-spent.
  fastify.post('/crew/hire', { schema: hireSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    const stationId = dockedStation(request, reply);
    if (!stationId) return reply;
    const candidate = findCandidate(stationId, request.body.candidateId, Date.now());
    if (!candidate) return reply.code(404).send(refusal({ code: 'candidate_not_found' }));

    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const playerId = request.user.sub;
      if ((await hiredCandidateIdsOf(tx, playerId)).has(candidate.candidateId)) return { refused: { code: 'candidate_already_hired' } };
      const player = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
      const reasons = unavailableReasons(candidate, { ship, credits: player.credits, standings: await standingsOf(tx, playerId) });
      if (reasons.length > 0) return { refused: reasonRefusal(primaryReason(reasons), reasons) };

      const bonus = signingBonusCredits(candidate.rank, candidate.quirkId, ship.traits);
      // Guarded decrement: only succeeds while the stored balance still covers the bonus.
      const paid = await tx.player.updateMany({ where: { id: playerId, credits: { gte: bonus } }, data: { credits: { decrement: bonus } } });
      if (paid.count !== 1) return { refused: { code: 'insufficient_credits', requiredCredits: bonus } };
      // Settle the old crew's leg before this candidate joins it.
      const dock = await recordCrewDock(tx, ship, request.body.dockedReceipt);
      const member = await tx.crewMember.create({
        data: {
          playerId,
          spaceshipId: ship.id,
          name: candidate.name,
          crewClass: candidate.crewClass,
          rank: candidate.rank,
          quirkId: candidate.quirkId,
          status: CREW_STATUS.ACTIVE,
          morale: startingMorale(candidate.quirkId, ship.traits),
          wageShareBp: CREW_WAGE_SHARE_BP[candidate.rank],
          homeFactionId: candidate.homeFactionId,
          hiredAtStationId: stationId,
          sourceCandidateId: candidate.candidateId
        }
      });
      const balance = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
      return { ship: dock.ship, docking: dock.docking, member, credits: balance.credits, crew: await activeCrewOf(tx, ship.id) };
    });
    if (outcome.refused) return reply.code(STATUS[outcome.refused.code]).send(refusal(outcome.refused));

    const { ship, member, credits, crew } = outcome;
    return respondWithShip(request, ship, crew, { crew: crewMemberView(member, ship.traits), credits,
      ...(outcome.docking.applied && { docking: outcome.docking }) });
  });

  // Keep the phase-2 mission wage-dodging guard. Engineer removal needs no loadout guard:
  // only effective operation falls back; stored components, credits and hull budget never change.
  async function leaveRefusal(tx, ship) {
    const held = await tx.playerMission.findMany({ where: { playerId: ship.playerId } });
    if (held.some((row) => !isLegacyRow(row))) return { code: 'crew_locked_by_active_mission' };
    return undefined;
  }

  // Lets a crew member go. The signing bonus is not refunded.
  fastify.post('/crew/dismiss', { schema: crewActionSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    if (!dockedStation(request, reply)) return reply;
    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const member = await tx.crewMember.findFirst({ where: { id: request.body.crewId, playerId: request.user.sub } });
      if (!member) return { refused: { code: 'crew_not_found' } };
      const refused = await leaveRefusal(tx, ship);
      if (refused) return { refused };
      await tx.crewMember.delete({ where: { id: member.id } });
      return { ship, crew: await activeCrewOf(tx, ship.id) };
    });
    if (outcome.refused) return reply.code(STATUS[outcome.refused.code]).send(refusal(outcome.refused));
    return respondWithShip(request, outcome.ship, outcome.crew, { dismissed: request.body.crewId });
  });

  // Moves an active crew member to Harbor Standby for a fee: off the ship's berths, still on the roster.
  fastify.post('/crew/standby', { schema: crewActionSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    if (!dockedStation(request, reply)) return reply;
    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const playerId = request.user.sub;
      const member = await tx.crewMember.findFirst({ where: { id: request.body.crewId, playerId } });
      if (!member) return { refused: { code: 'crew_not_found' } };
      if (member.status !== CREW_STATUS.ACTIVE || member.spaceshipId !== ship.id) return { refused: { code: 'crew_not_active' } };
      const refused = await leaveRefusal(tx, ship);
      if (refused) return { refused };
      if ((await standbyCrewOf(tx, playerId)).length >= MAX_STANDBY_CREW) return { refused: { code: 'standby_full', maxStandbyCrew: MAX_STANDBY_CREW } };
      const paid = await tx.player.updateMany({
        where: { id: playerId, credits: { gte: STANDBY_TRANSFER_FEE_CREDITS } },
        data: { credits: { decrement: STANDBY_TRANSFER_FEE_CREDITS } }
      });
      if (paid.count !== 1) return { refused: { code: 'insufficient_credits', requiredCredits: STANDBY_TRANSFER_FEE_CREDITS } };
      const moved = await tx.crewMember.update({ where: { id: member.id }, data: { status: CREW_STATUS.STANDBY, spaceshipId: null } });
      const player = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
      return { ship, member: moved, credits: player.credits, crew: await activeCrewOf(tx, ship.id) };
    });
    if (outcome.refused) return reply.code(STATUS[outcome.refused.code]).send(refusal(outcome.refused));
    const { ship, member, credits, crew } = outcome;
    return respondWithShip(request, ship, crew, { crew: crewMemberView(member, ship.traits), credits, feeCredits: STANDBY_TRANSFER_FEE_CREDITS });
  });

  // Brings a crew member from Harbor Standby back aboard, subject to the same class, hull and berth
  // limits as a hire. No fee and no new signing bonus.
  fastify.post('/crew/activate', { schema: crewActionSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    if (!dockedStation(request, reply)) return reply;
    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const member = await tx.crewMember.findFirst({ where: { id: request.body.crewId, playerId: request.user.sub } });
      if (!member) return { refused: { code: 'crew_not_found' } };
      if (member.status !== CREW_STATUS.STANDBY) return { refused: { code: 'crew_not_on_standby' } };
      if (member.morale === 0) return { refused: { code: 'crew_resigned' } };
      const reasons = boardingReasons(ship, member.crewClass);
      if (reasons.length > 0) return { refused: reasonRefusal(primaryReason(reasons), reasons) };
      const dock = await recordCrewDock(tx, ship, request.body.dockedReceipt);
      const moved = await tx.crewMember.update({ where: { id: member.id }, data: { status: CREW_STATUS.ACTIVE, spaceshipId: ship.id } });
      return { ship: dock.ship, docking: dock.docking, member: moved, crew: await activeCrewOf(tx, ship.id) };
    });
    if (outcome.refused) return reply.code(STATUS[outcome.refused.code]).send(refusal(outcome.refused));
    const { ship, member, crew } = outcome;
    return respondWithShip(request, ship, crew, { crew: crewMemberView(member, ship.traits),
      ...(outcome.docking.applied && { docking: outcome.docking }) });
  });

  // Configure an active Engineer's operation-only overdrive. Nothing purchases or mutates a stored
  // component tier; the next signed attributes use selected components one tier higher while Nominal.
  fastify.post('/crew/jury-rig', { schema: juryRigSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    if (!dockedStation(request, reply)) return reply;
    const { crewId, componentTypes, dockedReceipt } = request.body;
    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const member = await tx.crewMember.findFirst({ where: { id: crewId, playerId: request.user.sub } });
      if (!member) return { refused: { code: 'crew_not_found' } };
      if (member.crewClass !== 'ENGINEER') return { refused: { code: 'crew_not_engineer' } };
      if (member.status !== CREW_STATUS.ACTIVE || member.spaceshipId !== ship.id) return { refused: { code: 'crew_not_active' } };
      const slots = engineerJuryRigSlots(member);
      if (componentTypes.length > slots) return { refused: { code: 'jury_rig_slots_exceeded', slots } };
      for (const type of componentTypes) {
        const tier = ship.components.find((c) => c.type === type)?.tier ?? 0;
        if (tier === 0) return { refused: { code: 'COMPONENT_NOT_INSTALLED', componentType: type } };
        if (tier >= 5) return { refused: { code: 'jury_rig_already_max_tier', componentType: type } };
      }
      const dock = await recordCrewDock(tx, ship, dockedReceipt);
      const updated = await tx.crewMember.update({ where: { id: crewId }, data: { juryRigComponentTypes: componentTypes } });
      const player = await tx.player.findUnique({ where: { id: request.user.sub }, select: { credits: true } });
      return { ship: dock.ship, member: updated, credits: player.credits, docking: dock.docking, crew: await activeCrewOf(tx, ship.id) };
    });
    if (outcome.refused) return reply.code(STATUS[outcome.refused.code]).send(refusal(outcome.refused));
    return respondWithShip(request, outcome.ship, outcome.crew, {
      crew: crewMemberView(outcome.member, outcome.ship.traits), credits: outcome.credits,
      ...(outcome.docking.applied && { docking: outcome.docking })
    });
  });

  // Trains a crew member into the next rank at a station lounge: needs the Seniority XP for it and its
  // fee, and a morale that has not fallen to Mutinous. Their wage share steps up with the rank.
  fastify.post('/crew/promote', { schema: crewActionSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    if (!dockedStation(request, reply)) return reply;
    const playerId = request.user.sub;
    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const member = await tx.crewMember.findFirst({ where: { id: request.body.crewId, playerId } });
      if (!member) return { refused: { code: 'crew_not_found' } };
      const refused = promotionRefusal(member);
      if (refused) return { refused };
      const { toRank, feeCredits } = promotionTerms(member);
      // Guarded decrement, so concurrent spends cannot overdraw; the rank change rolls back with it.
      const paid = await tx.player.updateMany({
        where: { id: playerId, credits: { gte: feeCredits } },
        data: { credits: { decrement: feeCredits } }
      });
      if (paid.count !== 1) return { refused: { code: 'insufficient_credits', requiredCredits: feeCredits } };
      const promoted = await tx.crewMember.update({
        where: { id: member.id },
        data: { rank: toRank, wageShareBp: CREW_WAGE_SHARE_BP[toRank] }
      });
      const player = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
      return { ship, member: promoted, credits: player.credits, feeCredits, crew: await activeCrewOf(tx, ship.id) };
    });
    if (outcome.refused) return reply.code(STATUS[outcome.refused.code]).send(refusal(outcome.refused));
    const { ship, member, credits, feeCredits, crew } = outcome;
    return respondWithShip(request, ship, crew, { crew: crewMemberView(member, ship.traits), credits, feeCredits });
  });

  fastify.post('/crew/shore-leave', { schema: shoreLeaveSchema, preHandler: fastify.requireClaimKey }, async (request, reply) => {
    if (!dockedStation(request, reply)) return reply;
    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const result = await recordCrewDock(tx, ship, request.body.dockedReceipt, { ...request.body, allowDeparture: true });
      const player = await tx.player.findUnique({ where: { id: request.user.sub }, select: { credits: true } });
      return { ...result, credits: player.credits };
    });
    return respondWithShip(request, outcome.ship, outcome.ship.crew, {
      docking: outcome.docking, credits: outcome.credits,
      crew: outcome.ship.crew.map((m) => crewMemberView(m, outcome.ship.traits))
    });
  });

  // Pays the wages a deferred settlement left owing, for one crew member or, without `crewId`, all of
  // them, from the pilot's credits. Each paid member's morale recovers MORALE_GAIN_PAY_ARREARS, up to
  // the rested cap. Working crew need no receipt; resigned crew need a new dock and twice back pay.
  // Bulk requests without that proof pay working members and explicitly list skipped resignations.
  fastify.post('/crew/pay-arrears', { schema: payArrearsSchema }, async (request, reply) => {
    const playerId = request.user.sub;
    if (request.body.dockedReceipt) {
      if (!fastify.claimKey) return fastify.requireClaimKey(request, reply);
      if (!dockedStation(request, reply)) return reply;
    }
    const outcome = await prisma.$transaction(async (tx) => {
      const ship = await lockActiveShip(tx, request.user);
      const roster = [...ship.crew, ...(await standbyCrewOf(tx, playerId))];
      const { crewId } = request.body;
      if (crewId !== undefined && !roster.some((member) => member.id === crewId)) return { refused: { code: 'crew_not_found' } };
      const receipt = request.body.dockedReceipt;
      const newReceipt = receipt && (ship.lastCrewDockedAtMs == null || BigInt(receipt.dockedAtMs) > ship.lastCrewDockedAtMs);
      const selected = roster.filter((member) => (member.unpaidArrearsCredits > 0 || member.morale === 0) && (crewId === undefined || member.id === crewId));
      if (selected.length === 0) return { refused: { code: 'no_arrears' } };
      const skipped = selected.filter((m) => m.morale === 0 && !newReceipt)
        .map((m) => ({ crewId: m.id, reason: 'resignation_requires_new_dock' }));
      if (crewId !== undefined && skipped.length) return { refused: { code: 'resignation_requires_new_dock' } };
      const owed = selected.filter((m) => m.morale > 0 || newReceipt);
      const cost = (m) => m.unpaidArrearsCredits * (m.morale === 0 ? 2 : 1);
      const totalCredits = owed.reduce((sum, member) => sum + cost(member), 0);
      if (totalCredits > 2_147_483_647) return { refused: { code: 'insufficient_credits', requiredCredits: totalCredits } };
      const paid = await tx.player.updateMany({
        where: { id: playerId, credits: { gte: totalCredits } },
        data: { credits: { decrement: totalCredits } }
      });
      if (paid.count !== 1) return { refused: { code: 'insufficient_credits', requiredCredits: totalCredits } };
      const cap = restedMoraleCap(ship.crew);
      const settled = [];
      for (const member of owed) {
        const morale = moraleAfterCappedGain(member, MORALE_GAIN_PAY_ARREARS, cap);
        await tx.crewMember.update({ where: { id: member.id }, data: { morale, unpaidArrearsCredits: 0 } });
        settled.push({ crewId: member.id, paidCredits: cost(member), morale, moraleBand: moraleBand(morale, member.quirkId) });
      }
      const player = await tx.player.findUnique({ where: { id: playerId }, select: { credits: true } });
      return { ship, settled, skipped, totalCredits, credits: player.credits, crew: await activeCrewOf(tx, ship.id) };
    });
    if (outcome.refused) return reply.code(STATUS[outcome.refused.code]).send(refusal(outcome.refused));
    const { ship, settled, totalCredits, credits, crew } = outcome;
    return respondWithShip(request, ship, crew, { paid: settled, paidCredits: totalCredits, credits,
      ...(outcome.skipped.length && { skipped: outcome.skipped }) });
  });
}
